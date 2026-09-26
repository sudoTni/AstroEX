//! Stage 7: generate tailored resume materials from judged passing jobs.

use crate::artifact_manifest::{write_artifact_manifest, write_private_file};
use crate::context::{abortable_delay, RunContext};
use crate::error::{AppError, Result};
use crate::jobrepo::stage_checkpoint::{compute_content_hash, init_stage_checkpoint};
use crate::jobrepo::{JobRepository, JobRepositoryConfig};
use crate::llm::service::{ChatMessage, LlmRequest, LlmService, ProviderConfig};
use crate::models::JobInterface;
use crate::presets::{
    get_preset, load_and_replace_prompt_template, load_presets, load_veritas_system_prompt,
};
use crate::statistics::create_statistics_collector;
use crate::types::{LogLevel, ProviderRouting};
use crate::utils::progress::{CompleteOptions, ProgressOptions, ProgressReporter};
use crate::utils::shared::load_application_data;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct MakeMaterialsOptions {
    pub preset: String,
    pub targ_jd: Option<String>,
    pub cover_length: u32,
    pub sleep_min_ms: u64,
    pub sleep_max_ms: u64,
    pub jitter: bool,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_tokens: Option<u32>,
    pub reasoning_effort: Option<String>,
    pub provider_routing: Option<ProviderRouting>,
    pub resume: Option<String>,
    pub testimonials: Option<String>,
    pub professional_title: Option<String>,
    pub professional_summary: Option<String>,
    pub key_skills: Option<String>,
    /// Node `showReasoningTokens` (standalone default false; pipeline default true).
    pub show_reasoning: bool,
    /// Node `showResponseStream` (standalone default false; pipeline default true).
    pub show_stream: bool,
    /// Node's `runResumeOptimizationMode` catches non-cancellation errors and
    /// returns `{content: [], error}`; the pipeline ignores that error and
    /// reports success. Standalone commands rethrow it. When true, errors are
    /// swallowed (and the stats export is skipped, matching the pipeline).
    pub suppress_errors: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MakeMaterialsResult {
    pub generated: usize,
    pub materials_dir: PathBuf,
}
#[derive(Debug, Clone)]
pub struct MaterialsResponse {
    pub resume_filename: String,
    pub cover_letter_filename: Option<String>,
    pub professional_title: String,
    pub professional_summary: String,
    pub key_skills: String,
    pub cover_letter: String,
}

pub fn parse_materials_response(text: &str) -> Result<MaterialsResponse> {
    // Node: `line.match(/^#{1,3}\s+(.+)$/)` — one to three hashes, at least one
    // whitespace, then non-empty heading text.
    let heading_re = regex::Regex::new(r"^#{1,3}\s+(.+)$").unwrap();
    let mut sections = HashMap::<String, String>::new();
    let mut header: Option<String> = None;
    let mut body = Vec::new();
    for line in text.lines() {
        if let Some(captures) = heading_re.captures(line) {
            let heading = captures[1].trim().to_string();
            if let Some(previous) = header.replace(heading) {
                sections.insert(previous, body.join("\n").trim().to_string());
            }
            body.clear();
        } else if header.is_some() {
            body.push(line);
        }
    }
    if let Some(previous) = header {
        sections.insert(previous, body.join("\n").trim().to_string());
    }
    let required = |name: &str| {
        sections
            .get(name)
            .filter(|v| !v.trim().is_empty())
            .cloned()
            .ok_or_else(|| {
                AppError::message(format!("makeMaterials response requires section: {name}"))
            })
    };
    Ok(MaterialsResponse {
        resume_filename: required("Resume Filename")?,
        cover_letter_filename: sections
            .get("Cover Letter Filename")
            .filter(|v| !v.trim().is_empty())
            .cloned(),
        professional_title: required("Optimized & Tailored Professional Title")?,
        professional_summary: required("Optimized & Tailored Professional Summary")?,
        key_skills: required("Optimized & Tailored Key Skills")?,
        cover_letter: required("Optimized & Tailored Cover Letter")?,
    })
}
fn sanitize_job(job: &JobInterface) -> JobInterface {
    let mut job = job.clone();
    job.is_remote = None;
    job
}
fn passing_files(data: &Path) -> Result<Vec<PathBuf>> {
    let dir = data.join("astroapply_eval_pass");
    let files: Vec<_> = std::fs::read_dir(&dir).map_err(|_| AppError::message("No job descriptions found. Please provide a --targ-jd or ensure JSON files exist in ./data/astroapply_eval_pass/"))?.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "json") && !p.to_string_lossy().ends_with(".manifest.json")).collect();
    // Node consumes `fs.readdir` order without sorting; the batch signature and
    // per-job order therefore depend on directory order.
    if files.is_empty() {
        return Err(AppError::message("No job descriptions found. Please provide a --targ-jd or ensure JSON files exist in ./data/astroapply_eval_pass/"));
    }
    Ok(files)
}
fn safe(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// Directory-name component for the job title, falling back to a stable
/// placeholder so an empty title can never produce a bare-underscore name.
fn body_title_candidate(job: &JobInterface) -> &str {
    job.title
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or("Untitled")
}

fn body_company_candidate(job: &JobInterface) -> &str {
    job.company
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or("UnknownCompany")
}

pub async fn run(ctx: &RunContext, options: &MakeMaterialsOptions) -> Result<MakeMaterialsResult> {
    match run_core(ctx, options).await {
        Ok(result) => Ok(result),
        Err(error) => {
            if options.suppress_errors && !ctx.cancellation.is_cancelled() {
                crate::logging::log(
                    "MakeMaterials",
                    &format!("makeMaterials failed: {}", error.message),
                    LogLevel::Error,
                );
                Ok(MakeMaterialsResult {
                    generated: 0,
                    materials_dir: ctx.paths.materials_dir.clone(),
                })
            } else {
                Err(error)
            }
        }
    }
}

async fn run_core(ctx: &RunContext, options: &MakeMaterialsOptions) -> Result<MakeMaterialsResult> {
    let mut stats = create_statistics_collector("makeMaterials");
    stats.start();
    let result = run_inner(ctx, options, &mut stats).await;
    if result.is_err() {
        let message = result
            .as_ref()
            .err()
            .map(|error| error.message.clone())
            .unwrap_or_default();
        stats.record_error("other", &message);
    }
    // Node's `finally` logs this under the stage component (rather than the
    // shared statistics collector) after any catch-path error was recorded.
    let summary = stats.finalize();
    crate::logging::log_kv(
        "MakeMaterials",
        "Final statistics:",
        LogLevel::Info,
        &[("summary", summary)],
    );
    // Node's standalone handler throws before exporting on failure, so a failed
    // run writes no statistics file.
    if !options.suppress_errors && result.is_ok() {
        let stats_file = ctx.paths.materials_dir.join(format!(
            "make-materials-stats_{}.json",
            chrono::Local::now().format(crate::constants::FILE_DATE_FORMAT)
        ));
        stats.export_to_file(&stats_file)?;
        crate::logging::log(
            "MakeMaterials",
            &format!("Statistics exported to: {}", stats_file.display()),
            LogLevel::Info,
        );
    }
    result
}

async fn run_inner(
    ctx: &RunContext,
    options: &MakeMaterialsOptions,
    stats: &mut crate::statistics::StatisticsCollector,
) -> Result<MakeMaterialsResult> {
    let api_key = ctx
        .api_key
        .clone()
        .ok_or_else(|| AppError::message("--api-key is required for makeMaterials"))?;
    let presets = load_presets()?;
    let preset = get_preset("makeMaterials", &options.preset, &presets)?;
    let provider = preset.provider()?;
    let app = load_application_data(ctx);
    let resume = options.resume.clone().unwrap_or(app.resume);
    let testimonials = options.testimonials.clone().unwrap_or(app.testimonials);
    let title = options
        .professional_title
        .clone()
        .unwrap_or(app.professional_title);
    let summary = options
        .professional_summary
        .clone()
        .unwrap_or(app.professional_summary);
    let skills = options.key_skills.clone().unwrap_or(app.key_skills);
    let mut jobs: Vec<JobInterface> = Vec::new();
    let mut job_payloads: Vec<String> = Vec::new();
    let mut job_keys: Vec<String> = Vec::new();
    if let Some(text) = &options.targ_jd {
        let parsed: Option<Value> = serde_json::from_str(text).ok();
        let job = parsed
            .as_ref()
            .and_then(|value| serde_json::from_value::<JobInterface>(value.clone()).ok())
            .unwrap_or_default();
        // Node sanitizeDirectJobDescriptionForMaterials: only objects that
        // carry `isRemote` are re-serialized (without it); everything else is
        // passed through verbatim.
        let payload = match parsed {
            Some(Value::Object(mut object)) if object.contains_key("isRemote") => {
                object.remove("isRemote");
                serde_json::to_string_pretty(&Value::Object(object))
                    .unwrap_or_else(|_| text.clone())
            }
            _ => text.clone(),
        };
        let key = job
            .id
            .clone()
            .unwrap_or_else(|| format!("{}:{}", job.company_display(), job.title_display()));
        jobs.push(job);
        job_payloads.push(payload);
        job_keys.push(key);
    } else {
        for path in passing_files(&ctx.paths.data_dir)? {
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            stats.record_file_activity(crate::statistics::FileKind::Opened);
            stats.record_file_activity(crate::statistics::FileKind::Read);
            stats.increment_counter("data.filesProcessed");
            let Ok(job) = serde_json::from_str::<JobInterface>(&text) else {
                continue;
            };
            job_payloads.push(
                serde_json::to_string_pretty(&sanitize_job(&job)).unwrap_or_else(|_| text.clone()),
            );
            // Node uses the eval-pass basename as the checkpoint identity for
            // auto-detected files (jobMeta.jobFile), not the job id.
            job_keys.push(
                path.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| {
                        format!("{}:{}", job.company_display(), job.title_display())
                    }),
            );
            jobs.push(job);
        }
    }
    stats.record_data(jobs.len() as u64, 0, 0, 0);
    let signature = compute_content_hash(job_payloads.join("\n"));
    let mut repo = JobRepository::new(JobRepositoryConfig::enabled(
        ctx.paths.data_dir.join("jobDB.sqlite"),
    ));
    repo.initialize()?;
    // The batch signature is content-derived rather than a real input file,
    // so this deliberately queries the durable row directly (the Node stage
    // likewise uses `eval_pass_batch` only as a descriptive input path).
    let existing =
        repo.get_stage_checkpoint("makeMaterials", &signature, &preset.name, &preset.model_id)?;
    let processed_ids: std::collections::HashSet<String> = existing
        .as_ref()
        .map(|row| row.processed_job_ids.iter().cloned().collect())
        .unwrap_or_default();
    if existing
        .as_ref()
        .is_some_and(|row| row.status == "completed")
    {
        repo.close()?;
        return Ok(MakeMaterialsResult {
            generated: 0,
            materials_dir: ctx.paths.materials_dir.clone(),
        });
    }
    std::fs::create_dir_all(&ctx.paths.materials_dir)?;
    init_stage_checkpoint(
        &repo,
        "makeMaterials",
        Path::new("eval_pass_batch"),
        &signature,
        &ctx.paths.materials_dir,
        &preset.name,
        &preset.model_id,
        jobs.len() as i64,
        processed_ids.iter().cloned().collect(),
        ctx.now_ms() as i64,
    )?;
    let mut service = LlmService::new();
    if let Some(tracker) = &ctx.usage_tracker {
        service.set_usage_tracker(tracker.clone());
    }
    service.initialize(
        vec![ProviderConfig {
            name: provider.to_string(),
            api_key,
            base_url: ctx.resolve_llm_base_url(&preset.base_url),
            model: Some(preset.model_id.clone()),
        }],
        provider,
    )?;
    let system = load_veritas_system_prompt()?;
    let timestamp = chrono::Utc::now()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        .replace([':', '.'], "-");
    let mut generated = 0;
    let total_jobs = jobs.len();
    let mut progress = ProgressReporter::new(ProgressOptions {
        label: "Stage 7/8: MakeMaterials".into(),
        unit_label: "job".into(),
        total_units: Some(total_jobs as u64),
        phase: None,
        max_updates: Some(total_jobs.max(1) as u64),
        component: Some("MakeMaterials".into()),
    });
    progress.start_with_context(&[
        ("totalJobs", json!(total_jobs)),
        ("preset", json!(preset.name)),
    ]);
    for (index, (job, payload)) in jobs.iter().zip(job_payloads.iter()).enumerate() {
        crate::pipeline::cancellation::throw_if_cancelled(&ctx.cancellation)?;
        let id = job_keys[index].clone();
        if processed_ids.contains(&id) {
            progress.complete_with_context(
                &[
                    ("jobId", json!(id)),
                    ("jobTitle", json!(job.title)),
                    ("outcome", json!("checkpoint_skip")),
                ],
                CompleteOptions {
                    suffix: Some("already generated from checkpoint".to_string()),
                    ..Default::default()
                },
            );
            continue;
        }
        let mut fields = HashMap::new();
        fields.insert("targJD".into(), payload.clone());
        fields.insert("myResume".into(), resume.clone());
        fields.insert("myProfessionalTitle".into(), title.clone());
        fields.insert("myProfessionalSummary".into(), summary.clone());
        fields.insert("myKeySkills".into(), skills.clone());
        fields.insert("myTestimonials".into(), testimonials.clone());
        fields.insert(
            "cover_length".into(),
            if preset.model_id.contains("gpt-4.1") {
                "280".into()
            } else {
                options.cover_length.to_string()
            },
        );
        let prompt = load_and_replace_prompt_template(&preset.prompt_template, &fields)?;
        let call_progress_str = format!("{}/{}", index + 1, total_jobs);
        crate::logging::log_kv(
            "MakeMaterials",
            &format!(
                "Generating materials for job {}/{}: \"{}\"",
                index + 1,
                total_jobs,
                job.title.as_deref().unwrap_or("Untitled")
            ),
            LogLevel::Info,
            &[
                ("jobIndex", json!(index + 1)),
                ("totalJobs", json!(total_jobs)),
                ("jobId", json!(id)),
                ("jobTitle", json!(job.title)),
                ("company", json!(job.company)),
            ],
        );
        let api_started = std::time::Instant::now();
        let response = service
            .call(
                ctx,
                LlmRequest {
                    provider,
                    model: preset.model_id.clone(),
                    messages: vec![
                        ChatMessage {
                            role: "system".into(),
                            content: system.clone(),
                        },
                        ChatMessage {
                            role: "user".into(),
                            content: prompt,
                        },
                    ],
                    temperature: options.temperature.unwrap_or(preset.temperature),
                    top_p: options.top_p.unwrap_or(preset.top_p),
                    max_tokens: options.max_tokens.or(preset.max_tokens).unwrap_or(16_000),
                    timeout_ms: 30_000,
                    show_reasoning_tokens: !ctx.display.hide_reasoning && options.show_reasoning,
                    show_response_stream: options.show_stream,
                    reasoning_effort: options.reasoning_effort.clone(),
                    provider_routing: options.provider_routing.clone(),
                    json_mode: false,
                    stage: Some("makeMaterials".into()),
                    call_progress: Some(call_progress_str),
                },
            )
            .await;
        let response = match response {
            Ok(response) => {
                stats.record_api_call(true, api_started.elapsed().as_secs_f64() * 1000.0);
                response
            }
            Err(error) => {
                stats.record_api_call(false, api_started.elapsed().as_secs_f64() * 1000.0);
                if error.code == "PATHOLOGICAL_REASONING_REPETITION" {
                    stats.record_repetition_error();
                }
                return Err(error);
            }
        };
        let material = parse_materials_response(&response.content)?;
        // The per-application directory is named from the *job*, never from a
        // candidate-specific filename prefix. The model may legitimately emit
        // any filename it likes (prompts suggest `<Name>_Resume_[JobTitle]`),
        // so the directory must not depend on matching that convention.
        let dir_name = format!(
            "{}_{}_{}",
            safe(body_title_candidate(job)),
            safe(body_company_candidate(job)),
            timestamp
        );
        let dir = ctx.paths.materials_dir.join(dir_name);
        std::fs::create_dir_all(&dir)?;
        let output = dir.join(format!("{}.txt", safe(&material.resume_filename)));
        let body_title = job
            .title
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or("N/A");
        let body_company = job
            .company
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or("N/A");
        let body_url = job
            .url
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or("N/A");
        let body_id = job
            .id
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or("N/A");
        let body_posted_date = job
            .posted_date
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or("N/A");
        let body = format!("# Job Metadata\n\n**Job Title:** {}\n**Company:** {}\n**Job URL:** {}\n**Job ID:** {}\n**Posted Date:** {}\n\n---\n\n# Materials Filename\n\n{}\n\n# Cover Letter Filename\n\n{}\n\n# Optimized & Tailored Professional Title\n\n{}\n\n# Optimized & Tailored Professional Summary\n\n{}\n\n# Optimized & Tailored Key Skills\n\n{}\n\n# Optimized & Tailored Cover Letter\n\n{}", body_title, body_company, body_url, body_id, body_posted_date, material.resume_filename, material.cover_letter_filename.unwrap_or_else(|| "Cover letter filename not generated.".into()), material.professional_title, material.professional_summary, material.key_skills, material.cover_letter);
        write_private_file(&output, body.as_bytes())?;
        write_artifact_manifest(
            &output,
            "makeMaterials",
            serde_json::json!({"preset":preset.name,"model":preset.model_id,"jobTitle":body_title,"company":body_company}),
        )?;
        repo.record_job_in_checkpoint(
            "makeMaterials",
            &signature,
            &preset.name,
            &preset.model_id,
            &id,
        )?;
        stats.increment_counter("files.written");
        stats.increment_counter("materials.generated");
        generated += 1;
        progress.complete_with_context(
            &[
                ("jobId", json!(id)),
                ("jobTitle", json!(job.title)),
                ("company", json!(job.company)),
                ("outcome", json!("generated")),
            ],
            CompleteOptions::default(),
        );
        if index + 1 < jobs.len() {
            let delay = if options.jitter {
                options.sleep_min_ms
                    + rand::random::<u64>()
                        % (options.sleep_max_ms.saturating_sub(options.sleep_min_ms) + 1)
            } else {
                // Node's non-jitter path uses `args.sleep ?? 3`; makeMaterials
                // defines no --sleep option, so it is always 3 seconds.
                3_000
            };
            abortable_delay(delay, &ctx.cancellation).await?;
        }
    }
    // A materials checkpoint represents a batch/directory, not one output
    // file.  Mark it complete directly so the batch signature is reusable.
    repo.complete_stage_checkpoint(
        "makeMaterials",
        &signature,
        &preset.name,
        &preset.model_id,
        "completed",
        jobs.len() as i64,
    )?;
    repo.close()?;
    stats.record_operation("makeMaterials.complete", true);
    crate::logging::log(
        "MakeMaterials",
        &format!("Successfully generated materials for {generated} job(s)"),
        LogLevel::Success,
    );
    Ok(MakeMaterialsResult {
        generated,
        materials_dir: ctx.paths.materials_dir.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_required_markdown_sections() {
        let value = parse_materials_response("# Resume Filename\nA\n# Optimized & Tailored Professional Title\nT\n# Optimized & Tailored Professional Summary\nS\n# Optimized & Tailored Key Skills\nK\n# Optimized & Tailored Cover Letter\nC").unwrap();
        assert_eq!(value.resume_filename, "A");
        assert_eq!(value.cover_letter, "C");
    }
}
