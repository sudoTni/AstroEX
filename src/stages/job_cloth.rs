//! Stage 3 analysis-record normalization shared by jobCloth request paths.
//!
//! The Node implementation accepts several historical spellings from LLM
//! responses. Keep this parsing independent of transport so malformed model
//! output is rejected before it can affect JobDB cool-off state.

use crate::artifact_manifest::write_artifact_manifest;
use crate::constants::JOB_DB_RETENTION_MS;
use crate::context::{abortable_delay, RunContext};
use crate::error::{AppError, Result};
use crate::jobrepo::stage_checkpoint::{
    check_stage_checkpoint, complete_stage_checkpoint, init_stage_checkpoint, CheckpointMatch,
};
use crate::jobrepo::{JobClothIdentity, JobRepository, JobRepositoryConfig};
use crate::llm::json_repair::try_parse_json;
use crate::llm::service::{ChatMessage, LlmRequest, LlmService, ProviderConfig};
use crate::models::JobInterface;
use crate::presets::{
    get_preset, load_and_replace_prompt_template, load_presets, load_veritas_system_prompt,
};
use crate::statistics::{create_statistics_collector, StatisticsCollector};
use crate::types::LogLevel;
use crate::types::Provider;
use crate::types::ProviderRouting;
use crate::utils::progress::{CompleteOptions, ProgressOptions, ProgressReporter};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobAnalysis {
    pub job_title: String,
    pub is_worth_investigating: bool,
    pub is_very_highly_aligned: bool,
    pub is_highly_aligned: bool,
    pub rationale: String,
    pub confidence: f64,
}

#[derive(Debug, Clone)]
pub struct JobClothOptions {
    pub preset: String,
    pub batch: usize,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_tokens: Option<u32>,
    pub sleep_ms: u64,
    pub reasoning_effort: Option<String>,
    pub provider_routing: Option<ProviderRouting>,
    /// Per-request timeout in seconds (Node `openaiTimeout`, default 60).
    pub openai_timeout_s: u64,
    /// Batch-level retry attempts (Node default 3).
    pub batch_retry_attempts: u32,
    /// Batch retry base delay in ms; doubled each attempt (Node default 5000).
    pub batch_retry_delay_ms: u64,
    /// Single-title recovery attempts after a batch failure (Node default 2).
    pub job_title_retry_attempts: u32,
    /// Circuit-breaker failure-rate threshold (Node default 0.5).
    pub circuit_threshold: f64,
    /// Circuit-breaker reset timeout in seconds (Node default 60).
    pub circuit_timeout_s: u64,
    /// Node `showReasoningTokens` (standalone default false; pipeline default true).
    pub show_reasoning: bool,
    /// Node `showResponseStream` (standalone default false; pipeline default true).
    pub show_stream: bool,
}

impl Default for JobClothOptions {
    fn default() -> Self {
        Self {
            preset: String::new(),
            batch: 100,
            temperature: None,
            top_p: None,
            max_tokens: None,
            sleep_ms: 0,
            reasoning_effort: None,
            provider_routing: None,
            openai_timeout_s: 60,
            batch_retry_attempts: 3,
            batch_retry_delay_ms: 5000,
            job_title_retry_attempts: 2,
            circuit_threshold: 0.5,
            circuit_timeout_s: 60,
            show_reasoning: false,
            show_stream: false,
        }
    }
}

/// Inline circuit breaker matching Node jobCloth's local object (not the
/// generic `circuitBreaker.ts` class).
struct JcCircuitBreaker {
    is_tripped: bool,
    failure_count: u32,
    success_count: u32,
    consecutive_failures: u32,
    last_failure_time_ms: u64,
    timeout_ms: u64,
    threshold: f64,
}

impl JcCircuitBreaker {
    const MIN_FAILURES_TO_TRIP: u32 = 3;

    fn new(timeout_ms: u64, threshold: f64) -> Self {
        Self {
            is_tripped: false,
            failure_count: 0,
            success_count: 0,
            consecutive_failures: 0,
            last_failure_time_ms: 0,
            timeout_ms,
            threshold,
        }
    }

    fn reset(&mut self) {
        self.is_tripped = false;
        self.failure_count = 0;
        self.consecutive_failures = 0;
    }

    fn check_state(&mut self) -> bool {
        let now = now_ms();
        if self.is_tripped && now.saturating_sub(self.last_failure_time_ms) > self.timeout_ms {
            self.reset();
            crate::logging::log(
                "JobCloth",
                "Circuit breaker reset after timeout",
                LogLevel::Info,
            );
            return false;
        }
        self.is_tripped
    }

    fn record_success(&mut self) {
        self.success_count += 1;
        self.consecutive_failures = 0;
        if self.is_tripped {
            self.is_tripped = false;
            crate::logging::log(
                "JobCloth",
                "Circuit breaker recovered after success",
                LogLevel::Info,
            );
        }
    }

    fn record_failure(&mut self) {
        self.failure_count += 1;
        self.consecutive_failures += 1;
        self.last_failure_time_ms = now_ms();
        let total_attempts = self.failure_count + self.success_count;
        let failure_rate = if total_attempts > 0 {
            self.failure_count as f64 / total_attempts as f64
        } else {
            1.0
        };
        if !self.is_tripped
            && self.failure_count >= Self::MIN_FAILURES_TO_TRIP
            && (failure_rate >= self.threshold
                || self.consecutive_failures >= Self::MIN_FAILURES_TO_TRIP)
        {
            self.is_tripped = true;
            crate::logging::log_kv(
                "JobCloth",
                &format!(
                    "Circuit tripped: failure rate {:.2} >= threshold {} (failures: {}, consecutive: {})",
                    failure_rate,
                    self.threshold,
                    self.failure_count,
                    self.consecutive_failures
                ),
                LogLevel::Error,
                &[
                    ("failureRate", serde_json::json!(failure_rate)),
                    ("threshold", serde_json::json!(self.threshold)),
                    ("failureCount", serde_json::json!(self.failure_count)),
                    (
                        "consecutiveFailures",
                        serde_json::json!(self.consecutive_failures),
                    ),
                    ("successCount", serde_json::json!(self.success_count)),
                ],
            );
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Build the request for one batch/title set and return parsed analyses.
/// `singular` selects the per-title recovery framing (`--- Job Title ---`).
#[allow(clippy::too_many_arguments)]
async fn call_llm_for_titles(
    ctx: &RunContext,
    service: &LlmService,
    preset: &crate::presets::Preset,
    provider: Provider,
    system: &str,
    resume: &str,
    titles: &[String],
    singular: bool,
    options: &JobClothOptions,
    call_progress: Option<String>,
) -> Result<Vec<JobAnalysis>> {
    let joined = titles.join("\n");
    let mut values = HashMap::new();
    values.insert("targJD".to_string(), joined.clone());
    values.insert("myResume".to_string(), resume.to_string());
    values.insert("myTestimonials".to_string(), String::new());
    values.insert("myProfessionalTitle".to_string(), String::new());
    values.insert("myProfessionalSummary".to_string(), String::new());
    values.insert("myKeySkills".to_string(), String::new());
    let mut prompt = load_and_replace_prompt_template(&preset.prompt_template, &values)?;
    if singular {
        prompt.push_str(&format!(
            "\n\n--- Job Title ---\n{joined}\n\n--- Resume ---\n{resume}"
        ));
    } else {
        prompt.push_str(&format!(
            "\n\n--- Job Titles ---\n{joined}\n\n--- Resume ---\n{resume}"
        ));
    }
    let response = service
        .call(
            ctx,
            LlmRequest {
                provider,
                model: preset.model_id.clone(),
                messages: vec![
                    ChatMessage {
                        role: "system".into(),
                        content: system.to_string(),
                    },
                    ChatMessage {
                        role: "user".into(),
                        content: prompt,
                    },
                ],
                temperature: options.temperature.unwrap_or(preset.temperature),
                top_p: options.top_p.unwrap_or(preset.top_p),
                max_tokens: options.max_tokens.or(preset.max_tokens).unwrap_or(16_000),
                timeout_ms: options.openai_timeout_s.saturating_mul(1000),
                show_reasoning_tokens: !ctx.display.hide_reasoning && options.show_reasoning,
                show_response_stream: options.show_stream,
                reasoning_effort: options.reasoning_effort.clone(),
                provider_routing: options.provider_routing.clone(),
                json_mode: true,
                stage: Some("jobCloth".into()),
                call_progress,
            },
        )
        .await?;
    parse_analysis_results(&response.content)
}

/// Run the durable core of Stage 3. The output write is deliberately
/// non-atomic, retaining AstroEX's observable jobCloth quirk.
pub async fn run(
    ctx: &RunContext,
    inputs: &[std::path::PathBuf],
    output: &std::path::Path,
    options: &JobClothOptions,
) -> Result<Vec<JobInterface>> {
    let api_key = ctx
        .api_key
        .clone()
        .ok_or_else(|| AppError::message("--api-key is required for jobCloth"))?;
    let primary_input = inputs
        .first()
        .ok_or_else(|| AppError::message("No processed_jobs*.json files found in ./data/ directory. Please run processData first or provide a specific input file."))?;
    let mut stats = create_statistics_collector("jobCloth");
    stats.start();
    // Node reads each input file independently, logging and skipping files that
    // are unreadable/malformed rather than aborting the whole stage.
    let mut jobs: Vec<JobInterface> = Vec::new();
    let mut failed_files: Vec<String> = Vec::new();
    for input in inputs {
        crate::logging::log(
            "JobCloth",
            &format!("Processing input file: {}", input.display()),
            LogLevel::Info,
        );
        let text = match std::fs::read(input) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(error) => {
                crate::logging::log(
                    "JobCloth",
                    &format!("Error processing file {}: {error}", input.display()),
                    LogLevel::Error,
                );
                stats.record_error("file", &error.to_string());
                failed_files.push(input.display().to_string());
                continue;
            }
        };
        stats.increment_counter("files.opened");
        stats.increment_counter("files.read");
        if text.trim().is_empty() {
            crate::logging::log(
                "JobCloth",
                &format!("Error processing file {}: File is empty", input.display()),
                LogLevel::Error,
            );
            failed_files.push(input.display().to_string());
            continue;
        }
        let parsed: Vec<JobInterface> = match serde_json::from_str(&text) {
            Ok(parsed) => parsed,
            Err(error) => {
                crate::logging::log(
                    "JobCloth",
                    &format!(
                        "Error processing file {}: Invalid JSON format: {error}",
                        input.display()
                    ),
                    LogLevel::Error,
                );
                stats.record_error("json", &error.to_string());
                failed_files.push(input.display().to_string());
                continue;
            }
        };
        let total = parsed.len();
        let valid: Vec<JobInterface> = parsed
            .into_iter()
            .filter(|job| {
                job.title.as_deref().is_some_and(|title| !title.is_empty())
                    && job.url.as_deref().is_some_and(|url| !url.is_empty())
            })
            .collect();
        let invalid = total - valid.len();
        stats.record_data(total as u64, invalid as u64, 0, 1);
        if invalid > 0 {
            crate::logging::log(
                "JobCloth",
                &format!(
                    "Filtered out {invalid} invalid jobs from {}",
                    input
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("")
                ),
                LogLevel::Warn,
            );
        }
        if valid.is_empty() {
            crate::logging::log(
                "JobCloth",
                &format!("Skipping file: {} contains no valid jobs", input.display()),
                LogLevel::Warn,
            );
            failed_files.push(input.display().to_string());
            continue;
        }
        jobs.extend(valid);
    }
    if jobs.is_empty() {
        let failed = if failed_files.is_empty() {
            String::new()
        } else {
            format!("\nFailed files: {}", failed_files.join(", "))
        };
        return Err(AppError::message(format!(
            "No valid jobs found in any input files. Please run processData first or provide a valid job artifact.{failed}"
        )));
    }
    let presets = load_presets()?;
    let preset = get_preset("jobCloth", &options.preset, &presets)?;
    let provider = preset.provider()?;
    let repo_dir = output.parent().unwrap_or(&ctx.paths.data_dir);
    let mut repository = JobRepository::new(JobRepositoryConfig {
        db_file_path: repo_dir.join("jobDB.sqlite"),
        legacy_json_path: Some(repo_dir.join("jobDB.json")),
        default_expiration_ms: Some(JOB_DB_RETENTION_MS as i64),
        enable_job_db: true,
        max_records: None,
        now: None,
    });
    repository.initialize()?;
    // Node wraps checkpoint hash/check/init in try/catch, logs a debug
    // "notice", and continues; only DB failures after this point are fatal.
    let checkpoint = match check_stage_checkpoint(
        &repository,
        "jobCloth",
        primary_input,
        output,
        &preset.name,
        &preset.model_id,
    ) {
        Ok(checkpoint) => checkpoint,
        Err(error) => {
            crate::logging::log(
                "JobCloth",
                &format!("Checkpoint initialization notice: {}", error.message),
                LogLevel::Debug,
            );
            CheckpointMatch {
                has_matching_work: false,
                is_completed: false,
                input_hash: String::new(),
                output_hash: None,
                processed_job_ids: std::collections::HashSet::new(),
                checkpoint: None,
            }
        }
    };
    if checkpoint.is_completed {
        let cached: Vec<JobInterface> = serde_json::from_str(&std::fs::read_to_string(output)?)?;
        // Node re-stamps the cool-off window with the original checkpoint time.
        let processed_at = checkpoint
            .checkpoint
            .as_ref()
            .map(|record| record.updated_at);
        repository.record_job_cloth_processed(&job_identities(&jobs), processed_at)?;
        repository.close()?;
        export_job_cloth_stats(ctx, &mut stats);
        return Ok(cached);
    }
    let resume = std::fs::read_to_string(ctx.paths.profile_dir.join("my_resume.txt"))
        .map_err(|error| AppError::message(format!("Failed to read profile resume: {error}")))?;
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
    let mut titles = Vec::new();
    for job in &jobs {
        let title = job.title.clone().expect("validated title");
        if !titles.contains(&title) {
            titles.push(title);
        }
    }
    stats.increment_counter_by("jobCloth.uniqueTitles", titles.len() as u64);
    // Node initializes the checkpoint after computing unique titles, carrying
    // forward any already-processed job ids from a previous partial run.
    if let Err(error) = init_stage_checkpoint(
        &repository,
        "jobCloth",
        primary_input,
        &checkpoint.input_hash,
        output,
        &preset.name,
        &preset.model_id,
        titles.len() as i64,
        checkpoint.processed_job_ids.iter().cloned().collect(),
        ctx.now_ms() as i64,
    ) {
        crate::logging::log(
            "JobCloth",
            &format!("Checkpoint initialization notice: {}", error.message),
            LogLevel::Debug,
        );
    }
    let mut circuit = JcCircuitBreaker::new(
        options.circuit_timeout_s.saturating_mul(1000),
        options.circuit_threshold,
    );
    let mut analyses: Vec<JobAnalysis> = Vec::new();

    let planned_calls = if options.batch == 0 {
        1
    } else {
        titles.chunks(options.batch).len()
    };
    let mut progress = ProgressReporter::new(ProgressOptions {
        label: "Stage 3/8: JobCloth".into(),
        unit_label: "LLM call".into(),
        total_units: Some(planned_calls as u64),
        phase: None,
        max_updates: Some(planned_calls.max(1) as u64),
        component: Some("JobCloth".into()),
    });
    progress.start_with_context(&[
        ("uniqueJobTitles", json!(titles.len())),
        ("batchSize", json!(options.batch)),
    ]);

    if options.batch == 0 {
        let mut processed_count = 0usize;
        while processed_count < titles.len() {
            crate::pipeline::cancellation::throw_if_cancelled(&ctx.cancellation)?;
            let remaining = &titles[processed_count..];
            let mut newly_processed = 0usize;
            let mut last_error: Option<AppError> = None;
            let success = if circuit.check_state() {
                let error = AppError::message(format!(
                    "Circuit breaker is tripped. Skipping API call for {} job titles.",
                    remaining.len()
                ));
                circuit.record_failure();
                last_error = Some(error);
                false
            } else {
                let call_started = std::time::Instant::now();
                match call_llm_for_titles(
                    ctx,
                    &service,
                    &preset,
                    provider,
                    &system,
                    &resume,
                    remaining,
                    false,
                    options,
                    Some("1/1".to_string()),
                )
                .await
                {
                    Ok(results) => {
                        stats.record_api_call(true, call_started.elapsed().as_secs_f64() * 1000.0);
                        circuit.record_success();
                        newly_processed = results.len();
                        let complete = newly_processed == remaining.len();
                        if complete {
                            analyses.extend(results);
                        }
                        complete
                    }
                    Err(error) => {
                        stats.record_api_call(false, call_started.elapsed().as_secs_f64() * 1000.0);
                        crate::pipeline::cancellation::throw_if_cancelled(&ctx.cancellation)?;
                        circuit.record_failure();
                        last_error = Some(error);
                        false
                    }
                }
            };
            if !success {
                if options.sleep_ms > 0 {
                    crate::logging::log(
                        "JobCloth",
                        &format!(
                            "Sleeping for {} seconds before next attempt...",
                            options.sleep_ms as f64 / 1000.0
                        ),
                        LogLevel::Debug,
                    );
                    abortable_delay(options.sleep_ms, &ctx.cancellation).await?;
                }
                let message = last_error.map(|error| error.message).unwrap_or_default();
                return Err(AppError::message(format!(
                    "Failed to process job titles starting from index {}. Last error: {}",
                    titles.len() - remaining.len(),
                    message
                )));
            }
            processed_count += newly_processed;
            progress.complete_with_context(
                &[
                    ("jobTitlesCompleted", json!(processed_count)),
                    ("jobTitlesTotal", json!(titles.len())),
                ],
                CompleteOptions::default(),
            );
        }
    } else {
        let mut titles_seen = 0usize;
        let total_batches = titles.chunks(options.batch).len();
        for (batch_index, batch_titles) in titles.chunks(options.batch).enumerate() {
            crate::pipeline::cancellation::throw_if_cancelled(&ctx.cancellation)?;
            crate::logging::log_kv(
                "JobCloth",
                &format!(
                    "Processing batch {}/{} ({} job titles)",
                    batch_index + 1,
                    total_batches,
                    batch_titles.len()
                ),
                LogLevel::Info,
                &[
                    ("batchNumber", json!(batch_index + 1)),
                    ("totalBatches", json!(total_batches)),
                    ("jobTitlesInBatch", json!(batch_titles.len())),
                ],
            );
            let mut batch_success = false;
            let mut batch_results: Vec<JobAnalysis> = Vec::new();
            let mut batch_last_error: Option<AppError> = None;
            for batch_attempt in 1..=options.batch_retry_attempts {
                if batch_attempt > 1 {
                    let delay = options
                        .batch_retry_delay_ms
                        .saturating_mul(2u64.saturating_pow(batch_attempt - 2));
                    abortable_delay(delay, &ctx.cancellation).await?;
                }
                if circuit.check_state() {
                    let error = AppError::message(format!(
                        "Circuit breaker is tripped. Skipping batch {}.",
                        batch_index + 1
                    ));
                    circuit.record_failure();
                    batch_last_error = Some(error);
                    continue;
                }
                let call_started = std::time::Instant::now();
                let call_progress_str = format!("{}/{}", batch_index + 1, total_batches);
                match call_llm_for_titles(
                    ctx,
                    &service,
                    &preset,
                    provider,
                    &system,
                    &resume,
                    batch_titles,
                    false,
                    options,
                    Some(call_progress_str),
                )
                .await
                {
                    Ok(results) => {
                        stats.record_api_call(true, call_started.elapsed().as_secs_f64() * 1000.0);
                        circuit.record_success();
                        batch_results = results;
                        batch_success = true;
                        batch_last_error = None;
                        break;
                    }
                    Err(error) => {
                        stats.record_api_call(false, call_started.elapsed().as_secs_f64() * 1000.0);
                        crate::pipeline::cancellation::throw_if_cancelled(&ctx.cancellation)?;
                        circuit.record_failure();
                        batch_last_error = Some(error);
                    }
                }
            }
            if batch_success {
                progress.complete_with_context(
                    &[
                        ("batchNumber", json!(batch_index + 1)),
                        ("totalBatches", json!(total_batches)),
                        ("jobTitlesInBatch", json!(batch_titles.len())),
                    ],
                    CompleteOptions::default(),
                );
            }
            if !batch_success && options.job_title_retry_attempts > 0 {
                crate::logging::log(
                    "JobCloth",
                    &format!(
                        "Batch {} failed, attempting individual job title retries...",
                        batch_index + 1
                    ),
                    LogLevel::Warn,
                );
                // Node resets the circuit breaker before per-title recovery.
                circuit.reset();
                for title in batch_titles {
                    let mut success = false;
                    let mut retry_count = 0u32;
                    let mut last_error: Option<AppError> = None;
                    while retry_count < options.job_title_retry_attempts && !success {
                        if circuit.check_state() {
                            let error = AppError::message(format!(
                                "Circuit breaker is tripped. Skipping job title: {title}"
                            ));
                            circuit.record_failure();
                            last_error = Some(error);
                            retry_count += 1;
                            continue;
                        }
                        let call_started = std::time::Instant::now();
                        let call_progress_str = format!("{}/{}", batch_index + 1, total_batches);
                        match call_llm_for_titles(
                            ctx,
                            &service,
                            &preset,
                            provider,
                            &system,
                            &resume,
                            std::slice::from_ref(title),
                            true,
                            options,
                            Some(call_progress_str),
                        )
                        .await
                        {
                            Ok(results) if !results.is_empty() => {
                                stats.record_api_call(
                                    true,
                                    call_started.elapsed().as_secs_f64() * 1000.0,
                                );
                                circuit.record_success();
                                analyses.extend(results);
                                success = true;
                            }
                            Ok(_) => {
                                stats.record_api_call(
                                    true,
                                    call_started.elapsed().as_secs_f64() * 1000.0,
                                );
                                circuit.record_failure();
                                retry_count += 1;
                            }
                            Err(error) => {
                                stats.record_api_call(
                                    false,
                                    call_started.elapsed().as_secs_f64() * 1000.0,
                                );
                                crate::pipeline::cancellation::throw_if_cancelled(
                                    &ctx.cancellation,
                                )?;
                                circuit.record_failure();
                                last_error = Some(error);
                                retry_count += 1;
                                if retry_count < options.job_title_retry_attempts {
                                    let delay = 1000u64
                                        .saturating_mul(2u64.saturating_pow(retry_count - 1));
                                    abortable_delay(delay, &ctx.cancellation).await?;
                                }
                            }
                        }
                    }
                    if !success {
                        let message = last_error.map(|error| error.message).unwrap_or_default();
                        crate::logging::log(
                            "JobCloth",
                            &format!(
                                "Job title {title} failed after {} retries. Last error: {message}",
                                options.job_title_retry_attempts
                            ),
                            LogLevel::Error,
                        );
                    }
                }
            }
            if !batch_success && batch_results.is_empty() {
                let message = batch_last_error
                    .map(|error| error.message)
                    .unwrap_or_else(|| "unknown error".to_string());
                return Err(AppError::message(format!(
                    "Batch {} failed after {} attempts. Last error: {}",
                    batch_index + 1,
                    options.batch_retry_attempts,
                    message
                )));
            }
            analyses.extend(batch_results);
            titles_seen += batch_titles.len();
            if options.sleep_ms > 0 && titles_seen < titles.len() {
                crate::logging::log(
                    "JobCloth",
                    &format!(
                        "Sleeping for {} seconds before next batch...",
                        options.sleep_ms as f64 / 1000.0
                    ),
                    LogLevel::Debug,
                );
                abortable_delay(options.sleep_ms, &ctx.cancellation).await?;
            }
        }
    }
    let passing = passing_jobs(&jobs, &analyses);
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Node records the cool-off history before writing the artifact.
    repository.record_job_cloth_processed(&job_identities(&jobs), None)?;
    crate::artifact_manifest::write_private_file(
        output,
        serde_json::to_string_pretty(&passing)?.as_bytes(),
    )?;
    write_artifact_manifest(
        output,
        "jobCloth",
        serde_json::json!({"inputJobs": jobs.len(), "outputJobs": passing.len(), "preset": preset.name, "model": preset.model_id}),
    )?;
    complete_stage_checkpoint(
        &repository,
        "jobCloth",
        &checkpoint.input_hash,
        output,
        &preset.name,
        &preset.model_id,
        passing.len() as i64,
    )?;
    stats.increment_counter("files.written");
    stats.increment_counter_by(
        "jobCloth.jobsRejected",
        jobs.len().saturating_sub(passing.len()) as u64,
    );
    stats.increment_counter_by("jobCloth.jobsAccepted", passing.len() as u64);
    stats.record_operation("jobCloth.complete", true);
    repository.close()?;
    export_job_cloth_stats(ctx, &mut stats);
    Ok(passing)
}

/// Writes the jobCloth statistics file, matching Node's default-permission
/// `fsPromises.writeFile` (not the private 0600 writer used elsewhere).
fn export_job_cloth_stats(ctx: &RunContext, stats: &mut StatisticsCollector) {
    let summary = stats.finalize();
    let path = ctx.paths.data_dir.join(format!(
        "job-cloth-stats_{}.json",
        chrono::Local::now().format(crate::constants::FILE_DATE_FORMAT)
    ));
    if std::fs::create_dir_all(&ctx.paths.data_dir).is_err() {
        return;
    }
    let Ok(serialized) = serde_json::to_string_pretty(&summary) else {
        return;
    };
    if std::fs::write(&path, serialized).is_ok() {
        crate::logging::log(
            "JobCloth",
            &format!("Statistics exported to: {}", path.display()),
            LogLevel::Info,
        );
    }
}

fn job_identities(jobs: &[JobInterface]) -> Vec<JobClothIdentity> {
    jobs.iter()
        .filter_map(|job| {
            Some(JobClothIdentity {
                title: job.title.clone()?,
                company: job.company.clone()?,
            })
        })
        .collect()
}

impl JobAnalysis {
    pub fn passes(&self) -> bool {
        self.is_worth_investigating || self.is_very_highly_aligned || self.is_highly_aligned
    }
}

/// Parse Node-compatible response envelopes: array, `{jobs}`, `{results}`,
/// `{jobTitles}`, `{data}`, or a single analysis object.
pub fn parse_analysis_results(content: &str) -> Result<Vec<JobAnalysis>> {
    let value = try_parse_json(content)
        .ok_or_else(|| AppError::message("jobCloth LLM response did not contain valid JSON"))?;
    let values = match value {
        Value::Array(values) => values,
        Value::Object(mut object) => match ["jobs", "results", "jobTitles", "data"]
            .iter()
            .find_map(|key| object.remove(*key))
        {
            Some(Value::Array(values)) => values,
            Some(_) => {
                return Err(AppError::message(
                    "jobCloth response envelope must contain an array",
                ))
            }
            None => vec![Value::Object(object)],
        },
        _ => {
            return Err(AppError::message(
                "jobCloth LLM response must be an object or array",
            ))
        }
    };
    values.into_iter().map(parse_analysis).collect()
}

fn parse_analysis(value: Value) -> Result<JobAnalysis> {
    // Node runs the model response through `normalizeJobAnalysisRecord` as a
    // zod preprocess, which resolves typos/aliases (jobTtitle, job_name, role,
    // isAligned, reasoning, ...) before the strict schema reads exact keys.
    let value = crate::utils::shared::normalize_job_analysis_record(&value);
    let object = value
        .as_object()
        .ok_or_else(|| AppError::message("jobCloth analysis record must be an object"))?;
    let title = first_string(object, &["jobTitle", "job_title", "title"])
        .filter(|title| !title.trim().is_empty())
        .ok_or_else(|| {
            AppError::message("jobCloth analysis requires jobTitle, job_title, or title")
        })?;
    let aligned = first_bool(
        object,
        &[
            "isWorthInvestigating",
            "isVeryHighlyAligned",
            "isHighlyAligned",
        ],
    );
    let rationale = first_string(object, &["rationale"]).unwrap_or_default();
    let confidence = object
        .get("confidence")
        .map(coerce_confidence)
        .unwrap_or(0.0);
    Ok(JobAnalysis {
        job_title: title,
        // Node transforms every alignment field to the combined true/false value.
        is_worth_investigating: aligned,
        is_very_highly_aligned: aligned,
        is_highly_aligned: aligned,
        rationale,
        confidence,
    })
}

fn first_string(object: &serde_json::Map<String, Value>, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| object.get(*name)?.as_str().map(str::to_owned))
}

fn first_bool(object: &serde_json::Map<String, Value>, names: &[&str]) -> bool {
    names
        .iter()
        .find_map(|name| match object.get(*name) {
            Some(Value::Bool(value)) => Some(*value),
            Some(Value::String(value))
                if matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "true" | "1" | "yes" | "y"
                ) =>
            {
                Some(true)
            }
            Some(Value::String(value))
                if matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "false" | "0" | "no" | "n"
                ) =>
            {
                Some(false)
            }
            _ => None,
        })
        .unwrap_or(false)
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

/// Return clean passing records. Analysis fields are intentionally stripped
/// from artifacts, matching Node's `cleanPassingJobs` destructuring.
pub fn passing_jobs(jobs: &[JobInterface], analysis: &[JobAnalysis]) -> Vec<JobInterface> {
    let mut by_title = HashMap::new();
    for item in analysis {
        by_title.insert(item.job_title.trim().to_ascii_lowercase(), item);
    }
    jobs.iter()
        .filter(|job| {
            job.title
                .as_deref()
                .and_then(|title| by_title.get(&title.trim().to_ascii_lowercase()))
                .is_some_and(|item| item.passes())
        })
        .map(|job| {
            let mut clean = job.clone();
            clean.confidence = None;
            clean.rationale = None;
            clean.is_worth_investigating = None;
            clean.is_very_highly_aligned = None;
            clean.is_highly_aligned = None;
            clean
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_node_envelopes_aliases_and_confidence_coercion() {
        let results = parse_analysis_results(
            &json!({"results":[{"job_title":"Engineer","isHighlyAligned":"yes","confidence":85}]})
                .to_string(),
        )
        .unwrap();
        assert_eq!(results[0].job_title, "Engineer");
        assert!(results[0].passes());
        assert_eq!(results[0].confidence, 0.85);
        assert!(results[0].is_worth_investigating);
    }

    #[test]
    fn pass_filter_matches_titles_case_insensitively_and_strips_analysis() {
        let jobs = vec![JobInterface {
            title: Some("Engineer".into()),
            rationale: Some("old".into()),
            confidence: Some(0.5),
            is_worth_investigating: Some(true),
            ..Default::default()
        }];
        let analysis = vec![JobAnalysis {
            job_title: " engineer ".into(),
            is_worth_investigating: false,
            is_very_highly_aligned: true,
            is_highly_aligned: false,
            rationale: "new".into(),
            confidence: 1.0,
        }];
        let passing = passing_jobs(&jobs, &analysis);
        assert_eq!(passing.len(), 1);
        assert!(passing[0].rationale.is_none());
        assert!(passing[0].confidence.is_none());
        assert!(passing[0].is_worth_investigating.is_none());
    }

    #[test]
    fn alias_and_typo_keys_are_normalized_before_parsing() {
        // `jobTtitle` and `isAligned` are accepted through
        // normalizeJobAnalysisRecord, mirroring Node's zod preprocess.
        let results = parse_analysis_results(
            &json!([{"jobTtitle":"Engineer","isAligned":true,"reasoning":"ok","confidence":0.9}])
                .to_string(),
        )
        .unwrap();
        assert_eq!(results[0].job_title, "Engineer");
        assert!(results[0].passes());
        assert_eq!(results[0].rationale, "ok");
    }
}
