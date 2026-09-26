//! Stage 6: evaluate complete job descriptions and write one artifact per job.

use crate::artifact_manifest::{compute_file_hash, write_artifact_manifest, write_private_file};
use crate::constants::JOB_DB_RETENTION_MS;
use crate::context::{abortable_delay, RunContext};
use crate::error::{AppError, Result};
use crate::jobrepo::stage_checkpoint::{check_stage_checkpoint, init_stage_checkpoint};
use crate::jobrepo::{JobIdentity, JobRepository, JobRepositoryConfig};
use crate::llm::json_repair::try_parse_json;
use crate::llm::service::{ChatMessage, LlmRequest, LlmService, ProviderConfig};
use crate::models::JobInterface;
use crate::presets::{
    get_preset, load_and_replace_prompt_template, load_presets, load_veritas_system_prompt,
};
use crate::statistics::create_statistics_collector;
use crate::types::{LogLevel, ProviderRouting};
use crate::utils::progress::{CompleteOptions, ProgressOptions, ProgressReporter};
use crate::utils::shared::{load_application_data, normalize_job_analysis_record};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Debug, Clone)]
pub struct JobJudgeOptions {
    pub input_file: PathBuf,
    pub output_file: PathBuf,
    pub preset: String,
    pub eval_mode: u32,
    pub sleep_ms: u64,
    pub strict_parsing: bool,
    pub use_jobdb: bool,
    pub max_tokens: Option<u32>,
    pub reasoning_effort: Option<String>,
    pub provider_routing: Option<ProviderRouting>,
    /// Node `showReasoningTokens` (standalone default false; pipeline default true).
    pub show_reasoning: bool,
    /// Node `showResponseStream` (standalone default false; pipeline default true).
    pub show_stream: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobAnalysisResult {
    pub job_title: String,
    pub is_very_highly_aligned: bool,
    pub is_worth_investigating: bool,
    pub is_highly_aligned: bool,
    pub rationale: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobJudgeResult {
    pub jobs: usize,
    pub passed: usize,
}

pub fn find_job_files(input: &Path, base_directory: &Path) -> Result<Vec<PathBuf>> {
    let input = if input.is_absolute() {
        input.to_path_buf()
    } else {
        base_directory.join(input)
    };
    let text = input.to_string_lossy();
    if !text.contains('*') {
        if input.is_file() {
            return Ok(vec![input]);
        }
        let mut files: Vec<_> = std::fs::read_dir(&input)?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                let path = entry.path();
                (path.is_file() && path.extension().is_some_and(|ext| ext == "json"))
                    .then_some(path)
            })
            .collect();
        files.sort();
        return Ok(files);
    }
    let directory = input
        .parent()
        .ok_or_else(|| AppError::message("Invalid jobJudge wildcard path"))?;
    let pattern = input
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let regex = regex::Regex::new(&format!(
        "^{}$",
        regex::escape(pattern).replace(r"\*", ".*")
    ))
    .map_err(|error| AppError::message(error.to_string()))?;
    let mut files: Vec<_> = std::fs::read_dir(directory)?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            (path.is_file()
                && path
                    .file_name()
                    .is_some_and(|n| regex.is_match(&n.to_string_lossy())))
            .then_some(path)
        })
        .collect();
    files.sort();
    Ok(files)
}

fn stable_id(job: &mut JobInterface, file: &Path) {
    if job.id.as_deref().is_some_and(|id| !id.trim().is_empty()) {
        return;
    }
    let key = job
        .url
        .as_deref()
        .and_then(|url| reqwest::Url::parse(url).ok())
        .and_then(|url| {
            url.query_pairs()
                .find(|(k, _)| k == "jk")
                .map(|(_, v)| v.into_owned())
        })
        .unwrap_or_else(|| {
            format!(
                "{}\0{}\0{}\0{}",
                job.url.as_deref().unwrap_or(""),
                job.company.as_deref().unwrap_or(""),
                job.title.as_deref().unwrap_or(""),
                file.display()
            )
        });
    job.id = Some(crate::artifact_manifest::sha256_hex(key.as_bytes())[..16].to_string());
}

fn parse_job_file(path: &Path) -> Result<Vec<JobInterface>> {
    let content = std::fs::read_to_string(path)?;
    let values = match serde_json::from_str::<Value>(&content) {
        Ok(Value::Array(values)) => values,
        Ok(value) => vec![value],
        Err(_) => content
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(serde_json::from_str)
            .collect::<std::result::Result<Vec<Value>, _>>()
            .map_err(|_| {
                AppError::message(format!(
                    "{} is neither a JSON array/object nor newline-delimited JSON.",
                    path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or_default()
                ))
            })?,
    };
    Ok(values
        .into_iter()
        .filter_map(|value| {
            let mut job: JobInterface = serde_json::from_value(value).ok()?;
            (job.title.is_some() && job.company.is_some() && job.url.is_some()).then(|| {
                stable_id(&mut job, path);
                job
            })
        })
        .collect())
}

fn pipeline_job(job: &JobInterface) -> bool {
    matches!(job.source.as_deref(), Some("indeed") | Some("linkedin")) || job.url.as_deref().is_some_and(|url| reqwest::Url::parse(url).ok().is_some_and(|url| matches!(url.host_str(), Some(host) if host.ends_with("indeed.com") || host.ends_with("linkedin.com"))))
}

pub fn sanitize_job_for_evaluation(job: &JobInterface) -> JobInterface {
    let mut result = job.clone();
    result.confidence = None;
    result.rationale = None;
    result.is_worth_investigating = None;
    result.is_very_highly_aligned = None;
    result.is_highly_aligned = None;
    result
}

fn parse_results(content: &str) -> Result<Vec<JobAnalysisResult>> {
    let value = try_parse_json(content)
        .ok_or_else(|| AppError::message("jobJudge LLM response did not contain valid JSON"))?;
    resolve_analysis_values(value)?
        .iter()
        .map(analysis_from_value)
        .collect()
}

/// Mirrors Node's `JobAnalysisResultsSchema` union: a bare array/single object,
/// or an envelope carrying one of the result arrays.
fn resolve_analysis_values(value: Value) -> Result<Vec<Value>> {
    match value {
        Value::Array(values) => resolve_analysis_array(values),
        Value::Object(mut object) => {
            match ["jobs", "results", "evaluations", "data"]
                .iter()
                .find_map(|key| object.remove(*key))
            {
                Some(Value::Array(values)) => resolve_analysis_array(values),
                Some(_) => Err(AppError::message(
                    "jobJudge response envelope must contain an array",
                )),
                None => Ok(vec![Value::Object(object)]),
            }
        }
        _ => Err(AppError::message(
            "jobJudge LLM response must be an object or array",
        )),
    }
}

/// Node tries `z.array(JobAnalysisSchema).min(1)` first; only if that fails does
/// it attempt the split-two-object merge. The merge additionally requires the
/// combined record to carry a title, an alignment key, a rationale, and a
/// confidence key.
fn resolve_analysis_array(values: Vec<Value>) -> Result<Vec<Value>> {
    if values.is_empty() {
        return Err(AppError::message(
            "jobJudge response must contain at least one result",
        ));
    }
    if values
        .iter()
        .all(|value| analysis_from_value(value).is_ok())
    {
        return Ok(values);
    }
    if values.len() == 2 && values.iter().all(Value::is_object) {
        let mut merged = serde_json::Map::new();
        for value in &values {
            merged.extend(value.as_object().unwrap().clone());
        }
        let normalized = normalize_job_analysis_record(&Value::Object(merged));
        let has_title = ["jobTitle", "job_title", "title"].iter().any(|key| {
            normalized
                .get(*key)
                .and_then(Value::as_str)
                .is_some_and(|title| !title.trim().is_empty())
        });
        let has_alignment = [
            "isVeryHighlyAligned",
            "isWorthInvestigating",
            "isHighlyAligned",
        ]
        .iter()
        .any(|key| normalized.get(*key).is_some());
        let has_rationale = normalized.get("rationale").is_some();
        let has_confidence = normalized.get("confidence").is_some();
        if has_title && has_alignment && has_rationale && has_confidence {
            return Ok(vec![normalized]);
        }
    }
    // Surface a representative parse error when no interpretation applies.
    let first_error = values
        .iter()
        .find_map(|value| analysis_from_value(value).err());
    Err(first_error.unwrap_or_else(|| {
        AppError::message("jobJudge response could not be parsed as an analysis result")
    }))
}

fn analysis_from_value(value: &Value) -> Result<JobAnalysisResult> {
    let normalized = normalize_job_analysis_record(value);
    let object = normalized
        .as_object()
        .ok_or_else(|| AppError::message("jobJudge result must be an object"))?;
    let title = ["jobTitle", "job_title", "title"]
        .iter()
        .find_map(|key| {
            object
                .get(*key)?
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned)
        })
        .ok_or_else(|| AppError::message("jobJudge result requires a job title"))?;
    let bool_value = [
        "isVeryHighlyAligned",
        "isWorthInvestigating",
        "isHighlyAligned",
    ]
    .iter()
    .find_map(|key| object.get(*key))
    .and_then(coerce_bool)
    .unwrap_or(false);
    let confidence = object
        .get("confidence")
        .and_then(coerce_number)
        .unwrap_or(0.0);
    Ok(JobAnalysisResult {
        job_title: title,
        is_very_highly_aligned: bool_value,
        is_worth_investigating: bool_value,
        is_highly_aligned: bool_value,
        rationale: object
            .get("rationale")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        confidence,
    })
}

fn coerce_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(v) => Some(*v),
        Value::String(v) => match v.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "y" => Some(true),
            "false" | "0" | "no" | "n" => Some(false),
            _ => None,
        },
        _ => None,
    }
}
fn coerce_number(value: &Value) -> Option<f64> {
    let value = match value {
        Value::Number(v) => v.as_f64(),
        Value::String(v) => v.parse().ok(),
        _ => None,
    }?;
    Some(if value > 1.0 {
        (value / 100.0).min(1.0)
    } else {
        value.clamp(0.0, 1.0)
    })
}

#[allow(clippy::too_many_arguments)] // mirrors the Node stage's request inputs
async fn evaluate(
    ctx: &RunContext,
    service: &LlmService,
    job: &JobInterface,
    preset: &crate::presets::Preset,
    options: &JobJudgeOptions,
    resume: &str,
    testimonials: &str,
    system: &str,
    call_progress: Option<String>,
) -> Result<(JobAnalysisResult, bool, usize)> {
    let mut clean = sanitize_job_for_evaluation(job);
    clean.remote_ok = None;
    let mut fields = HashMap::new();
    fields.insert("targJD".to_string(), serde_json::to_string_pretty(&clean)?);
    fields.insert("myResume".to_string(), resume.to_string());
    fields.insert("myTestimonials".to_string(), testimonials.to_string());
    let prompt = load_and_replace_prompt_template(&preset.prompt_template, &fields)?;
    let provider = preset.provider()?;
    let mut last = None;
    for attempt in 0..3 {
        match service
            .call(
                ctx,
                LlmRequest {
                    provider,
                    model: preset.model_id.clone(),
                    messages: vec![
                        ChatMessage {
                            role: "system".into(),
                            content: system.into(),
                        },
                        ChatMessage {
                            role: "user".into(),
                            content: prompt.clone(),
                        },
                    ],
                    temperature: preset.temperature,
                    top_p: preset.top_p,
                    max_tokens: options.max_tokens.or(preset.max_tokens).unwrap_or(16_000),
                    timeout_ms: 30_000,
                    show_reasoning_tokens: !ctx.display.hide_reasoning && options.show_reasoning,
                    show_response_stream: options.show_stream,
                    reasoning_effort: options.reasoning_effort.clone(),
                    provider_routing: options.provider_routing.clone(),
                    json_mode: true,
                    stage: Some("jobJudge".into()),
                    call_progress: call_progress.clone(),
                },
            )
            .await
            .and_then(|r| parse_results(&r.content))
        {
            Ok(results) => return Ok((results.into_iter().next().unwrap(), false, attempt)),
            Err(error) => {
                if ctx.cancellation.is_cancelled() {
                    return Err(error);
                }
                last = Some(error);
                if attempt < 2 {
                    abortable_delay(2_u64.pow((attempt + 1) as u32) * 1000, &ctx.cancellation)
                        .await?;
                }
            }
        }
    }
    if options.strict_parsing {
        return Err(last.unwrap_or_else(|| AppError::message("jobJudge failed")));
    }
    Ok((
        JobAnalysisResult {
            job_title: job.title.clone().unwrap_or_default(),
            is_very_highly_aligned: false,
            is_worth_investigating: false,
            is_highly_aligned: false,
            rationale: "LLM evaluation failed; recorded a conservative non-passing fallback."
                .into(),
            confidence: 0.0,
        },
        true,
        3,
    ))
}

fn identity(job: &JobInterface) -> JobIdentity {
    // Node coerces every non-`linkedin` source to `indeed` for identity
    // purposes, regardless of the URL.
    JobIdentity {
        id: job.id.clone(),
        source: Some(if job.source.as_deref() == Some("linkedin") {
            "linkedin".into()
        } else {
            "indeed".into()
        }),
        source_job_id: job.source_job_id.clone(),
        title: job.title.clone().unwrap_or_default(),
        company: job.company.clone().unwrap_or_default(),
        url: job.url.clone(),
    }
}
fn filename(job: &JobInterface) -> String {
    job.source_job_id
        .as_deref()
        .or(job.id.as_deref())
        .unwrap_or("job")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        + ".json"
}

pub async fn run(ctx: &RunContext, options: &JobJudgeOptions) -> Result<JobJudgeResult> {
    let api_key = ctx
        .api_key
        .clone()
        .ok_or_else(|| AppError::message("--api-key is required for jobJudge"))?;
    let presets = load_presets()?;
    let preset = get_preset("jobJudge", &options.preset, &presets)?;
    let provider = preset.provider()?;
    let data_dir = if options.output_file == Path::new("./data/astroapply_eval_") {
        ctx.paths.data_dir.clone()
    } else {
        options
            .output_file
            .parent()
            .unwrap_or(&ctx.paths.data_dir)
            .to_path_buf()
    };
    let pass_dir = data_dir.join("astroapply_eval_pass");
    let fail_dir = data_dir.join("astroapply_eval_fail");
    let dupe_dir = data_dir.join("astroapply_eval_dupe");
    for dir in [&pass_dir, &fail_dir, &dupe_dir] {
        std::fs::create_dir_all(dir)?;
    }
    let files = find_job_files(&options.input_file, &ctx.paths.project_root)?;
    if files.is_empty() {
        return Err(AppError::message(format!(
            "No files matched {}",
            options.input_file.display()
        )));
    }
    let mut repo = JobRepository::new(JobRepositoryConfig {
        db_file_path: data_dir.join("jobDB.sqlite"),
        legacy_json_path: Some(data_dir.join("jobDB.json")),
        default_expiration_ms: Some(JOB_DB_RETENTION_MS as i64),
        enable_job_db: options.use_jobdb,
        max_records: None,
        now: None,
    });
    repo.initialize()?;
    repo.cleanup_expired()?;
    let app = load_application_data(ctx);
    let system = load_veritas_system_prompt()?;
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
    let total: usize = files
        .iter()
        .filter_map(|path| parse_job_file(path).ok())
        .flatten()
        .filter(pipeline_job)
        .count();
    let mut progress = ProgressReporter::new(ProgressOptions {
        label: "Stage 6/8: JobJudge".into(),
        unit_label: "job".into(),
        total_units: Some(total as u64),
        phase: None,
        max_updates: Some(total.max(1) as u64),
        component: Some("JobJudge".into()),
    });
    progress.start_with_context(&[("totalJobs", json!(total)), ("preset", json!(preset.name))]);
    let mut stats = create_statistics_collector("jobJudge");
    stats.start();
    let mut jobs = 0;
    let mut passed = 0;
    let mut current_job_index = 0usize;
    for file in files {
        let hash = compute_file_hash(&file).ok();
        let checkpoint = hash
            .as_deref()
            .map(|_| {
                check_stage_checkpoint(
                    &repo,
                    "jobJudge",
                    &file,
                    &pass_dir,
                    &preset.name,
                    &preset.model_id,
                )
            })
            .transpose()?;
        if checkpoint.as_ref().is_some_and(|c| c.is_completed) {
            continue;
        }
        let processed = checkpoint
            .as_ref()
            .map(|c| c.processed_job_ids.clone())
            .unwrap_or_default();
        let entries: Vec<_> = parse_job_file(&file)?
            .into_iter()
            .filter(pipeline_job)
            .collect();
        let file_jobs = entries.len();
        stats.increment_counter("files.read");
        stats.record_data(file_jobs as u64, 0, 0, 0);
        jobs += entries.len();
        if let Some(hash) = &hash {
            init_stage_checkpoint(
                &repo,
                "jobJudge",
                &file,
                hash,
                &pass_dir,
                &preset.name,
                &preset.model_id,
                entries.len() as i64,
                processed.iter().cloned().collect(),
                ctx.now_ms() as i64,
            )?;
        }
        for job in entries {
            current_job_index += 1;
            crate::pipeline::cancellation::throw_if_cancelled(&ctx.cancellation)?;
            let id = job.id.as_deref().unwrap();
            if processed.contains(id) {
                progress.complete_with_context(
                    &[
                        ("jobId", json!(job.id)),
                        ("jobTitle", json!(job.title)),
                        ("outcome", json!("checkpoint_skip")),
                    ],
                    CompleteOptions {
                        suffix: Some("already judged from checkpoint".to_string()),
                        ..Default::default()
                    },
                );
                continue;
            }
            let outcome: &str;
            let mut suffix: Option<&str> = None;
            let mut warn = false;
            let clean = sanitize_job_for_evaluation(&job);
            let file_name = filename(&job);
            let job_identity = identity(&job);
            if repo.is_job_matched(&job_identity)? {
                let mut output = serde_json::to_value(clean)?;
                output
                    .as_object_mut()
                    .unwrap()
                    .insert("evaluationResult".into(), json!({"duplicate": true}));
                write_private_file(
                    &dupe_dir.join(file_name),
                    serde_json::to_string_pretty(&output)?.as_bytes(),
                )?;
                stats.increment_counter("data.duplicatesRemoved");
                outcome = "duplicate";
                suffix = Some("duplicate skipped");
            } else if job
                .description_text
                .as_deref()
                .is_none_or(|text| text.trim().is_empty())
            {
                stats.increment_counter("data.recordsFiltered");
                outcome = "no_description";
                suffix = Some("no description skipped");
                warn = true;
            } else {
                let call_progress_str = format!("{}/{}", current_job_index, total);
                crate::logging::log_kv(
                    "JobJudge",
                    &format!(
                        "Evaluating alignment for job {}/{}: \"{}\"",
                        current_job_index,
                        total,
                        job.title.as_deref().unwrap_or("Untitled")
                    ),
                    LogLevel::Info,
                    &[
                        ("jobIndex", json!(current_job_index)),
                        ("totalJobs", json!(total)),
                        ("jobId", json!(job.id)),
                        ("jobTitle", json!(job.title)),
                        ("company", json!(job.company)),
                    ],
                );
                let started = Instant::now();
                let (analysis, fallback, retries) = evaluate(
                    ctx,
                    &service,
                    &job,
                    &preset,
                    options,
                    &app.resume,
                    &app.testimonials,
                    &system,
                    Some(call_progress_str),
                )
                .await?;
                stats.record_api_call(true, started.elapsed().as_secs_f64() * 1000.0);
                outcome = if fallback { "fallback" } else { "evaluated" };
                if fallback {
                    suffix = Some("conservative fallback");
                    warn = true;
                }
                let is_pass = analysis.is_very_highly_aligned;
                let mut output = serde_json::to_value(clean)?;
                output.as_object_mut().unwrap().insert("evaluationResult".into(), json!({"mode": options.eval_mode, "isPass": is_pass, "timestamp": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "fallbackUsed": fallback, "analysisResult": analysis, "retryCount": retries}));
                let target = if is_pass { &pass_dir } else { &fail_dir };
                let target_file = target.join(file_name);
                write_private_file(
                    &target_file,
                    serde_json::to_string_pretty(&output)?.as_bytes(),
                )?;
                write_artifact_manifest(
                    &target_file,
                    "jobJudge",
                    json!({"preset": preset.name, "model": preset.model_id, "evaluationMode": options.eval_mode, "passed": is_pass, "retries": retries}),
                )?;
                if !fallback {
                    repo.add_job(&job_identity)?;
                }
                stats.increment_counter("files.written");
                if is_pass {
                    passed += 1;
                }
                if options.sleep_ms > 0 {
                    abortable_delay(options.sleep_ms, &ctx.cancellation).await?;
                }
            }
            if let Some(hash) = &hash {
                repo.record_job_in_checkpoint(
                    "jobJudge",
                    hash,
                    &preset.name,
                    &preset.model_id,
                    id,
                )?;
            }
            progress.complete_with_context(
                &[
                    ("jobId", json!(job.id)),
                    ("jobTitle", json!(job.title)),
                    ("outcome", json!(outcome)),
                ],
                CompleteOptions {
                    level: warn.then_some(LogLevel::Warn),
                    suffix: suffix.map(str::to_string),
                },
            );
        }
        // Node stores the literal "completed" output hash for jobJudge (not the
        // artifact's real hash), so whole-file completion never triggers the
        // output-hash shortcut on resume; per-job ids drive resumption.
        if let Some(hash) = &hash {
            repo.complete_stage_checkpoint(
                "jobJudge",
                hash,
                &preset.name,
                &preset.model_id,
                "completed",
                file_jobs as i64,
            )?;
        }
    }
    stats.record_operation("jobJudge.complete", true);
    let stats_dir = data_dir.join("statistics");
    std::fs::create_dir_all(&stats_dir)?;
    stats.export_to_file(&stats_dir.join(format!(
        "jobJudge_stats_{}.json",
        chrono::Local::now().format(crate::constants::FILE_DATE_FORMAT)
    )))?;
    repo.close()?;
    crate::logging::log(
        "JobJudge",
        &format!("Evaluated {jobs} jobs; {passed} passed."),
        LogLevel::Success,
    );
    Ok(JobJudgeResult { jobs, passed })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parser_accepts_split_records_and_aliases() {
        let values = parse_results(
            r#"[{"jobTtitle":"Role","isAligned":"yes"},{"rationale":"good","confidence":80}]"#,
        )
        .unwrap();
        assert_eq!(values.len(), 1);
        assert!(values[0].is_very_highly_aligned);
        assert_eq!(values[0].confidence, 0.8);
    }

    #[test]
    fn parser_prefers_two_complete_records_over_merge() {
        // Node's union tries `z.array(JobAnalysisSchema).min(1)` before the
        // split schema, so two individually-complete objects stay two records.
        let values = parse_results(
            r#"[{"jobTitle":"A","isVeryHighlyAligned":true,"rationale":"a","confidence":1},
                {"jobTitle":"B","isVeryHighlyAligned":false,"rationale":"b","confidence":0.5}]"#,
        )
        .unwrap();
        assert_eq!(values.len(), 2);
        assert_eq!(values[0].job_title, "A");
        assert!(values[0].is_very_highly_aligned);
        assert_eq!(values[1].job_title, "B");
        assert!(!values[1].is_very_highly_aligned);
    }

    #[test]
    fn parser_rejects_split_missing_required_keys() {
        // Neither fragment carries a title, so the array schema fails and the
        // split refine fails too: the whole response is a parse error.
        assert!(parse_results(
            r#"[{"isAligned":"yes","rationale":"r"},{"isAligned":true,"confidence":1}]"#
        )
        .is_err());
    }
    #[test]
    fn sanitizer_keeps_remote_eval_but_drops_prior_alignment() {
        let job = JobInterface {
            is_confirmed_remote: Some(true),
            confidence: Some(1.0),
            rationale: Some("old".into()),
            ..Default::default()
        };
        let clean = sanitize_job_for_evaluation(&job);
        assert_eq!(clean.is_confirmed_remote, Some(true));
        assert!(clean.confidence.is_none());
        assert!(clean.rationale.is_none());
    }
}
