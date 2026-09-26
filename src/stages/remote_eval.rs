//! Stage 5: conservatively confirm that otherwise promising jobs are remote.
//!
//! This stage intentionally has no standalone CLI command.  `run-pipeline`
//! invokes it when `--remote-only` is enabled, matching AstroEX's surface.

use crate::artifact_manifest::{write_artifact_manifest, write_json_atomic_private};
use crate::constants::JOB_DB_RETENTION_MS;
use crate::context::{abortable_delay, RunContext};
use crate::error::{AppError, Result};
use crate::jobrepo::stage_checkpoint::{
    check_stage_checkpoint, complete_stage_checkpoint, init_stage_checkpoint,
};
use crate::jobrepo::{JobRepository, JobRepositoryConfig};
use crate::llm::json_repair::try_parse_json;
use crate::llm::service::{ChatMessage, LlmRequest, LlmService, ProviderConfig};
use crate::models::{JobInterface, RemoteEvalMetadata};
use crate::presets::{
    get_preset, load_and_replace_prompt_template, load_presets, load_prompt_template,
    load_veritas_system_prompt,
};
use crate::statistics::create_statistics_collector;
use crate::types::{LogLevel, ProviderRouting};
use crate::utils::progress::{CompleteOptions, ProgressOptions, ProgressReporter};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Debug, Clone)]
pub struct RemoteEvalOptions {
    pub input_file: PathBuf,
    pub output_file: PathBuf,
    pub preset: String,
    pub sleep_ms: u64,
    /// Explicit retry delay. `None` retains Node's 2/4 second backoff;
    /// `Some(0)` is used by deterministic tests and intentionally disables it.
    pub retry_delay_ms: Option<u64>,
    pub reasoning_effort: Option<String>,
    pub provider_routing: Option<ProviderRouting>,
    pub strict_parsing: bool,
    pub use_checkpoints: bool,
    /// Node `showReasoningTokens` (standalone default false; pipeline default true).
    pub show_reasoning: bool,
    /// Node `showResponseStream` (standalone default false; pipeline default true).
    pub show_stream: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEvalResult {
    pub job_title: String,
    pub is_confirmed_remote: bool,
    pub rationale: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEvalRunResult {
    pub jobs: usize,
    pub evaluated: usize,
    pub passed: usize,
    pub failed: usize,
    pub output_file: PathBuf,
}

/// Removes previous remote and alignment verdicts before an LLM sees a job.
/// The remaining fields, including the job description, are preserved exactly.
pub fn sanitize_job_for_remote_evaluation(job: &JobInterface) -> JobInterface {
    let mut sanitized = job.clone();
    sanitized.confidence = None;
    sanitized.rationale = None;
    sanitized.is_worth_investigating = None;
    sanitized.is_very_highly_aligned = None;
    sanitized.is_highly_aligned = None;
    sanitized.remote_ok = None;
    sanitized.is_remote = None;
    sanitized.is_confirmed_remote = None;
    sanitized.remote_eval_metadata = None;
    sanitized
}

/// Parse the response variants accepted by the Node Zod schema: an array,
/// an object containing a result array, or one result object.
pub fn parse_remote_eval_results(content: &str) -> Result<Vec<RemoteEvalResult>> {
    let value = try_parse_json(content)
        .ok_or_else(|| AppError::message("remoteEval LLM response did not contain valid JSON"))?;
    let records = match value {
        Value::Array(records) => records,
        Value::Object(mut object) => match ["jobs", "results", "evaluations", "data"]
            .iter()
            .find_map(|key| object.remove(*key))
        {
            Some(Value::Array(records)) => records,
            Some(_) => {
                return Err(AppError::message(
                    "remoteEval response envelope must contain an array",
                ));
            }
            None => vec![Value::Object(object)],
        },
        _ => {
            return Err(AppError::message(
                "remoteEval LLM response must be an object or array",
            ));
        }
    };
    if records.is_empty() {
        return Err(AppError::message(
            "remoteEval response must contain at least one result",
        ));
    }
    records.into_iter().map(parse_remote_eval_result).collect()
}

fn parse_remote_eval_result(value: Value) -> Result<RemoteEvalResult> {
    let object = value
        .as_object()
        .ok_or_else(|| AppError::message("remoteEval result must be an object"))?;
    let is_confirmed_remote = object
        .get("isConfirmedRemote")
        .and_then(coerce_required_bool)
        .ok_or_else(|| AppError::message("remoteEval result requires isConfirmedRemote"))?;
    Ok(RemoteEvalResult {
        job_title: first_string(object, &["jobTitle", "job_title", "title"])
            .unwrap_or_else(|| "Not Specified".to_string()),
        is_confirmed_remote,
        rationale: first_string(object, &["rationale"]).unwrap_or_default(),
        confidence: object
            .get("confidence")
            .map(coerce_confidence)
            .unwrap_or(0.0),
    })
}

fn first_string(object: &serde_json::Map<String, Value>, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| object.get(*name)?.as_str().map(str::to_owned))
}

fn coerce_required_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        Value::String(value) => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "y" => Some(true),
            "false" | "0" | "no" | "n" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn coerce_confidence(value: &Value) -> f64 {
    let raw = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(value) => value.parse::<f64>().ok(),
        _ => None,
    }
    .unwrap_or(0.0);
    if raw > 1.0 {
        (raw / 100.0).min(1.0)
    } else {
        raw.clamp(0.0, 1.0)
    }
}

fn stable_id(job: &mut JobInterface) {
    if job.id.as_deref().is_some_and(|id| !id.trim().is_empty()) {
        return;
    }
    let seed = format!(
        "{}\0{}\0{}",
        job.url.as_deref().unwrap_or(""),
        job.company.as_deref().unwrap_or(""),
        job.title.as_deref().unwrap_or("")
    );
    job.id = Some(crate::artifact_manifest::sha256_hex(seed.as_bytes())[..16].to_string());
}

fn read_jobs(input: &Path) -> Result<Vec<JobInterface>> {
    let value: Value = serde_json::from_str(&std::fs::read_to_string(input)?)?;
    let values = match value {
        Value::Array(values) => values,
        value => vec![value],
    };
    Ok(values
        .into_iter()
        .filter_map(|value| {
            let mut job: JobInterface = serde_json::from_value(value).ok()?;
            if job.title.is_none() || job.company.is_none() || job.url.is_none() {
                return None;
            }
            stable_id(&mut job);
            Some(job)
        })
        .collect())
}

fn validate_prompt(template_path: &str) -> Result<()> {
    let template = load_prompt_template(template_path)?;
    let placeholder_re = regex::Regex::new(r"\{([A-Za-z][A-Za-z0-9_]*)\}").unwrap();
    let placeholders: HashSet<_> = placeholder_re
        .captures_iter(&template)
        .map(|captures| captures[1].to_string())
        .collect();
    if !placeholders.contains("targJD") {
        return Err(AppError::message(format!(
            "remoteEval prompt {template_path} must contain {{targJD}}"
        )));
    }
    let unsupported: Vec<_> = placeholders
        .into_iter()
        .filter(|placeholder| placeholder != "targJD")
        .collect();
    if unsupported.is_empty() {
        Ok(())
    } else {
        Err(AppError::message(format!(
            "remoteEval prompt {template_path} contains unsupported placeholder(s): {}",
            unsupported
                .iter()
                .map(|placeholder| format!("{{{placeholder}}}"))
                .collect::<Vec<_>>()
                .join(", ")
        )))
    }
}

async fn evaluate_remote_status(
    ctx: &RunContext,
    service: &LlmService,
    job: &JobInterface,
    preset: &crate::presets::Preset,
    options: &RemoteEvalOptions,
    system_prompt: &str,
    call_progress: Option<String>,
) -> Result<(RemoteEvalResult, bool, usize)> {
    let sanitized = sanitize_job_for_remote_evaluation(job);
    let mut placeholders = HashMap::new();
    placeholders.insert(
        "targJD".to_string(),
        serde_json::to_string_pretty(&sanitized)?,
    );
    let prompt = load_and_replace_prompt_template(&preset.prompt_template, &placeholders)?;
    let provider = preset.provider()?;
    let mut last_error = None;
    for attempt in 0..3 {
        crate::pipeline::cancellation::throw_if_cancelled(&ctx.cancellation)?;
        let response = service
            .call(
                ctx,
                LlmRequest {
                    provider,
                    model: preset.model_id.clone(),
                    messages: vec![
                        ChatMessage {
                            role: "system".to_string(),
                            content: system_prompt.to_string(),
                        },
                        ChatMessage {
                            role: "user".to_string(),
                            content: prompt.clone(),
                        },
                    ],
                    temperature: preset.temperature,
                    top_p: preset.top_p,
                    max_tokens: preset.max_tokens.unwrap_or(16_000),
                    timeout_ms: 30_000,
                    show_reasoning_tokens: !ctx.display.hide_reasoning && options.show_reasoning,
                    show_response_stream: options.show_stream,
                    reasoning_effort: options
                        .reasoning_effort
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned),
                    provider_routing: options.provider_routing.clone(),
                    json_mode: true,
                    stage: Some("remoteEval".to_string()),
                    call_progress: call_progress.clone(),
                },
            )
            .await;
        match response.and_then(|response| parse_remote_eval_results(&response.content)) {
            Ok(results) => return Ok((results.into_iter().next().unwrap(), false, attempt)),
            Err(error) => {
                if ctx.cancellation.is_cancelled() {
                    return Err(AppError::message(format!(
                        "Pipeline cancelled (original error: {})",
                        error.message
                    )));
                }
                last_error = Some(error);
                if attempt < 2 {
                    abortable_delay(
                        options
                            .retry_delay_ms
                            .unwrap_or(2_u64.pow((attempt + 1) as u32) * 1000),
                        &ctx.cancellation,
                    )
                    .await?;
                }
            }
        }
    }
    if options.strict_parsing {
        return Err(last_error.unwrap_or_else(|| AppError::message("remoteEval failed")));
    }
    Ok((
        RemoteEvalResult {
            job_title: job.title.clone().unwrap_or_default(),
            is_confirmed_remote: false,
            rationale:
                "LLM remote evaluation failed; recorded a conservative non-passing fallback."
                    .to_string(),
            confidence: 0.0,
        },
        true,
        3,
    ))
}

/// Executes Stage 5.  An LLM failure is deliberately conservative by default:
/// it records a filtered job rather than allowing it downstream.
pub async fn run(ctx: &RunContext, options: &RemoteEvalOptions) -> Result<RemoteEvalRunResult> {
    crate::pipeline::cancellation::throw_if_cancelled(&ctx.cancellation)?;
    let api_key = ctx
        .api_key
        .clone()
        .ok_or_else(|| AppError::message("--api-key is required for remoteEval"))?;
    let jobs = read_jobs(&options.input_file)?;
    let presets = load_presets()?;
    let preset = get_preset("remoteEval", &options.preset, &presets)?;
    validate_prompt(&preset.prompt_template)?;
    let parent = options.output_file.parent().unwrap_or(&ctx.paths.data_dir);
    std::fs::create_dir_all(parent)?;

    let mut repository = JobRepository::new(JobRepositoryConfig {
        db_file_path: parent.join("jobDB.sqlite"),
        legacy_json_path: Some(parent.join("jobDB.json")),
        default_expiration_ms: Some(JOB_DB_RETENTION_MS as i64),
        enable_job_db: options.use_checkpoints,
        max_records: None,
        now: None,
    });
    repository.initialize()?;
    let checkpoint = if options.use_checkpoints {
        check_stage_checkpoint(
            &repository,
            "remoteEval",
            &options.input_file,
            &options.output_file,
            &preset.name,
            &preset.model_id,
        )?
    } else {
        crate::jobrepo::stage_checkpoint::CheckpointMatch {
            has_matching_work: false,
            is_completed: false,
            input_hash: crate::artifact_manifest::compute_file_hash(&options.input_file)?,
            output_hash: None,
            processed_job_ids: HashSet::new(),
            checkpoint: None,
        }
    };
    if checkpoint.is_completed {
        let passed_jobs = read_jobs(&options.output_file)?;
        repository.close()?;
        return Ok(RemoteEvalRunResult {
            jobs: jobs.len(),
            evaluated: jobs.len(),
            passed: passed_jobs.len(),
            failed: jobs.len().saturating_sub(passed_jobs.len()),
            output_file: options.output_file.clone(),
        });
    }

    let mut passed_jobs = if checkpoint.has_matching_work {
        read_jobs(&options.output_file).unwrap_or_default()
    } else {
        Vec::new()
    };
    let processed_ids = if checkpoint.has_matching_work {
        checkpoint.processed_job_ids
    } else {
        HashSet::new()
    };
    if options.use_checkpoints {
        init_stage_checkpoint(
            &repository,
            "remoteEval",
            &options.input_file,
            &checkpoint.input_hash,
            &options.output_file,
            &preset.name,
            &preset.model_id,
            jobs.len() as i64,
            processed_ids.iter().cloned().collect(),
            ctx.now_ms() as i64,
        )?;
    }
    write_json_atomic_private(&options.output_file, &serde_json::to_value(&passed_jobs)?)?;

    let provider = preset.provider()?;
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
    let system_prompt = load_veritas_system_prompt()?;
    let mut stats = create_statistics_collector("remoteEval");
    stats.start();
    let mut progress = ProgressReporter::new(ProgressOptions {
        label: "Stage 5/8: RemoteEval".to_string(),
        unit_label: "job".to_string(),
        total_units: Some(jobs.len() as u64),
        phase: None,
        max_updates: Some(jobs.len().max(1) as u64),
        component: Some("RemoteEval".to_string()),
    });
    progress.start_with_context(&[
        ("totalJobs", serde_json::json!(jobs.len())),
        ("preset", serde_json::json!(preset.name)),
    ]);
    let mut evaluated = 0;
    let mut processed_ids = processed_ids;
    for (index, job) in jobs.iter().enumerate() {
        crate::pipeline::cancellation::throw_if_cancelled(&ctx.cancellation)?;
        let id = job.id.as_deref().expect("read_jobs creates an id");
        if processed_ids.contains(id) {
            progress.complete_with_context(
                &[
                    ("jobId", serde_json::json!(job.id)),
                    ("jobTitle", serde_json::json!(job.title)),
                    ("outcome", serde_json::json!("checkpoint_skip")),
                ],
                CompleteOptions {
                    suffix: Some("already evaluated from checkpoint".to_string()),
                    ..Default::default()
                },
            );
            continue;
        }
        let (result, fallback_used, retries) = if job
            .description_text
            .as_deref()
            .is_some_and(|description| !description.trim().is_empty())
        {
            let call_progress_str = format!("{}/{}", index + 1, jobs.len());
            crate::logging::log_kv(
                "RemoteEval",
                &format!(
                    "Evaluating remote status for job {}/{}: \"{}\"",
                    index + 1,
                    jobs.len(),
                    job.title.as_deref().unwrap_or("Untitled")
                ),
                LogLevel::Info,
                &[
                    ("jobIndex", serde_json::json!(index + 1)),
                    ("totalJobs", serde_json::json!(jobs.len())),
                    ("jobId", serde_json::json!(job.id)),
                    ("jobTitle", serde_json::json!(job.title)),
                    ("company", serde_json::json!(job.company)),
                ],
            );
            let started = Instant::now();
            let outcome = evaluate_remote_status(
                ctx,
                &service,
                job,
                &preset,
                options,
                &system_prompt,
                Some(call_progress_str),
            )
            .await?;
            // The Node collector records a successful provider call once the
            // conservative fallback has been produced as well.
            stats.record_api_call(true, started.elapsed().as_secs_f64() * 1000.0);
            evaluated += 1;
            outcome
        } else {
            (
                RemoteEvalResult {
                    job_title: job.title.clone().unwrap_or_default(),
                    is_confirmed_remote: false,
                    rationale: "Job has no description to evaluate.".to_string(),
                    confidence: 0.0,
                },
                true,
                0,
            )
        };
        let confirmed_remote = result.is_confirmed_remote;
        if result.is_confirmed_remote {
            let mut confirmed = job.clone();
            confirmed.is_confirmed_remote = Some(true);
            confirmed.remote_eval_metadata = Some(RemoteEvalMetadata {
                job_title: Some(result.job_title),
                rationale: Some(result.rationale),
                confidence: Some(result.confidence),
                timestamp: Some(
                    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                ),
                fallback_used: Some(fallback_used),
                retry_count: Some(retries as i64),
            });
            passed_jobs.retain(|existing| existing.id.as_deref() != Some(id));
            passed_jobs.push(confirmed);
        } else {
            stats.increment_counter("data.recordsFiltered");
        }
        write_json_atomic_private(&options.output_file, &serde_json::to_value(&passed_jobs)?)?;
        if options.use_checkpoints {
            repository.record_job_in_checkpoint(
                "remoteEval",
                &checkpoint.input_hash,
                &preset.name,
                &preset.model_id,
                id,
            )?;
        }
        processed_ids.insert(id.to_string());
        progress.complete_with_context(
            &[
                ("jobId", serde_json::json!(job.id)),
                ("jobTitle", serde_json::json!(job.title)),
                (
                    "outcome",
                    serde_json::json!(if confirmed_remote {
                        "passed"
                    } else {
                        "filtered"
                    }),
                ),
            ],
            CompleteOptions {
                level: fallback_used.then_some(LogLevel::Warn),
                suffix: fallback_used.then(|| "conservative fallback".to_string()),
            },
        );
        if options.sleep_ms > 0 {
            abortable_delay(options.sleep_ms, &ctx.cancellation).await?;
        }
    }
    crate::pipeline::cancellation::throw_if_cancelled(&ctx.cancellation)?;
    write_artifact_manifest(
        &options.output_file,
        "remoteEval",
        serde_json::json!({
            "preset": preset.name,
            "model": preset.model_id,
            "inputJobs": jobs.len(),
            "passed": passed_jobs.len(),
            "failed": jobs.len().saturating_sub(passed_jobs.len()),
        }),
    )?;
    if options.use_checkpoints {
        complete_stage_checkpoint(
            &repository,
            "remoteEval",
            &checkpoint.input_hash,
            &options.output_file,
            &preset.name,
            &preset.model_id,
            jobs.len() as i64,
        )?;
    }
    let stats_dir = parent.join("statistics");
    std::fs::create_dir_all(&stats_dir)?;
    stats.export_to_file(&stats_dir.join(format!(
        "remoteEval_stats_{}.json",
        chrono::Local::now().format(crate::constants::FILE_DATE_FORMAT)
    )))?;
    repository.close()?;
    crate::logging::log(
        "RemoteEval",
        &format!(
            "Remote evaluation kept {} of {} jobs.",
            passed_jobs.len(),
            jobs.len()
        ),
        LogLevel::Success,
    );
    Ok(RemoteEvalRunResult {
        jobs: jobs.len(),
        evaluated,
        passed: passed_jobs.len(),
        failed: jobs.len().saturating_sub(passed_jobs.len()),
        output_file: options.output_file.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parser_accepts_node_envelopes_and_boolean_coercion() {
        let result = parse_remote_eval_results(
            &json!({"results":[{"job_title":"Engineer","isConfirmedRemote":"yes","confidence":95}]}).to_string(),
        )
        .unwrap();
        assert_eq!(result[0].job_title, "Engineer");
        assert!(result[0].is_confirmed_remote);
        assert_eq!(result[0].confidence, 0.95);
        assert!(parse_remote_eval_results(r#"[{"jobTitle":"missing verdict"}]"#).is_err());
    }

    #[test]
    fn sanitizer_removes_prior_verdicts_without_losing_job_data() {
        let job = JobInterface {
            title: Some("Engineer".to_string()),
            description_text: Some("Remote role".to_string()),
            remote_ok: Some(true),
            is_remote: Some(true),
            is_confirmed_remote: Some(true),
            confidence: Some(0.9),
            rationale: Some("old".to_string()),
            is_worth_investigating: Some(true),
            remote_eval_metadata: Some(RemoteEvalMetadata::default()),
            ..Default::default()
        };
        let sanitized = sanitize_job_for_remote_evaluation(&job);
        assert_eq!(sanitized.title, job.title);
        assert_eq!(sanitized.description_text, job.description_text);
        assert!(sanitized.remote_ok.is_none());
        assert!(sanitized.is_remote.is_none());
        assert!(sanitized.is_confirmed_remote.is_none());
        assert!(sanitized.confidence.is_none());
        assert!(sanitized.rationale.is_none());
        assert!(sanitized.remote_eval_metadata.is_none());
    }

    #[test]
    fn job_model_uses_node_camel_case_field_names() {
        let encoded = serde_json::to_value(JobInterface {
            source_job_id: Some("123".to_string()),
            is_confirmed_remote: Some(true),
            remote_eval_metadata: Some(RemoteEvalMetadata {
                fallback_used: Some(false),
                retry_count: Some(0),
                ..Default::default()
            }),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(encoded["sourceJobId"], "123");
        assert_eq!(encoded["isConfirmedRemote"], true);
        assert_eq!(encoded["remoteEvalMetadata"]["fallbackUsed"], false);
        assert_eq!(encoded["remoteEvalMetadata"]["retryCount"], 0);
    }
}
