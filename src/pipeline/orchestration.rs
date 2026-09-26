//! In-process eight-stage pipeline runner.

use crate::acquisition::types::DescriptionFormat;
use crate::acquisition::DescriptionMode;
use crate::astro_auto_provider::{
    astro_auto_provider, AstroAutoProviderParams, ASTRO_AUTO_PROVIDER,
};
use crate::context::RunContext;
use crate::error::{AppError, Result};
use crate::pipeline::config::PipelineConfig;
use crate::presets::{get_preset, load_presets};
use crate::stages::{
    acquire_jobs, enrich_jobs, job_cloth, job_judge, make_materials, process_data, remote_eval,
};
use crate::types::{should_execute_phase, LogLevel, Provider, ProviderRouting};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicU16, Ordering},
    Arc, Mutex,
};

/// Resolve the `astro_auto_provider` sentinel into concrete OpenRouter
/// provider slugs immediately before a stage runs (Node
/// resolveStageProviderRouting). Explicit routes pass through unchanged.
async fn resolve_stage_provider_routing(
    ctx: &RunContext,
    stage: &str,
    provider_flag: &str,
    preset_name: &str,
    configured_routing: Option<ProviderRouting>,
    top: u32,
) -> Result<Option<ProviderRouting>> {
    let only = configured_routing
        .as_ref()
        .and_then(|routing| routing.only.as_ref());
    let contains_auto = only.is_some_and(|slugs| slugs.iter().any(|s| s == ASTRO_AUTO_PROVIDER));
    if !contains_auto {
        let mut routing = configured_routing;
        if let Some(r) = routing.as_mut() {
            r.normalize();
        }
        return Ok(routing);
    }
    if only.map_or(0, Vec::len) != 1 {
        return Err(AppError::message(format!(
            "{provider_flag}={ASTRO_AUTO_PROVIDER} must be used alone; it cannot be combined with explicit provider slugs."
        )));
    }
    let presets = load_presets()?;
    let preset = get_preset(stage, preset_name, &presets)?;
    if preset.model_id.trim().is_empty() {
        return Err(AppError::message(format!(
            "Preset {preset_name} for {stage} does not contain a usable modelId for {ASTRO_AUTO_PROVIDER}."
        )));
    }
    if preset.provider()? != Provider::Openrouter {
        return Err(AppError::message(format!(
            "{provider_flag}={ASTRO_AUTO_PROVIDER} requires an OpenRouter preset; {preset_name} uses {}.",
            preset.provider
        )));
    }
    crate::pipeline::cancellation::throw_if_cancelled(&ctx.cancellation)?;
    let selection = astro_auto_provider(AstroAutoProviderParams {
        model_id: preset.model_id.clone(),
        api_key: ctx.api_key.clone().unwrap_or_default(),
        top: Some(top),
        quantizations: configured_routing
            .as_ref()
            .and_then(|routing| routing.quantizations.clone()),
        min_uptime: None,
        max_price_vs_median: None,
        signal: ctx.cancellation.clone(),
    })
    .await?;
    crate::logging::log("Pipeline", &selection.no_details_output, LogLevel::Info);
    if selection.provider_slugs.is_empty() {
        return Err(AppError::message(format!(
            "{ASTRO_AUTO_PROVIDER} found no eligible OpenRouter providers for {stage} preset {preset_name} ({}).",
            preset.model_id
        )));
    }
    if selection
        .provider_slugs
        .iter()
        .any(|slug| slug.trim().is_empty())
    {
        return Err(AppError::message(format!(
            "{ASTRO_AUTO_PROVIDER} returned an invalid provider slug for {stage} preset {preset_name}."
        )));
    }
    crate::pipeline::cancellation::throw_if_cancelled(&ctx.cancellation)?;
    let mut routing = configured_routing.unwrap_or_default();
    routing.order = Some(selection.provider_slugs.clone());
    routing.only = Some(selection.provider_slugs);
    routing.allow_fallbacks = Some(false);
    Ok(Some(routing))
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineResult {
    pub completed_phases: Vec<String>,
    pub remote_eval_skipped: bool,
}
fn path(config: &PipelineConfig, name: &str) -> std::path::PathBuf {
    config.data_dir.join(name)
}
fn run_phase(config: &PipelineConfig, name: &str) -> bool {
    should_execute_phase(name, config.resume.as_deref())
}

pub async fn execute(ctx: &RunContext, config: &PipelineConfig) -> Result<PipelineResult> {
    // Install SIGINT/SIGTERM handling before any stage work (including the
    // preflight rclone check), so signals during startup are also caught and
    // mapped to exit codes 130/143, matching Node's CLI handler.
    let signal_code = Arc::new(AtomicU16::new(0));
    let signal_stop = tokio_util::sync::CancellationToken::new();
    #[cfg(unix)]
    let signal_task = {
        let cancellation = ctx.cancellation.clone();
        let stop = signal_stop.clone();
        let code = Arc::clone(&signal_code);
        tokio::spawn(async move {
            let Ok(mut int) =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
            else {
                return;
            };
            let Ok(mut term) =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            else {
                return;
            };
            tokio::select! {
                _ = int.recv() => {
                    crate::logging::log(
                        "Pipeline",
                        "Received SIGINT; cancelling pipeline gracefully.",
                        LogLevel::Warn,
                    );
                    code.store(130, Ordering::SeqCst);
                    cancellation.cancel();
                }
                _ = term.recv() => {
                    crate::logging::log(
                        "Pipeline",
                        "Received SIGTERM; cancelling pipeline gracefully.",
                        LogLevel::Warn,
                    );
                    code.store(143, Ordering::SeqCst);
                    cancellation.cancel();
                }
                _ = stop.cancelled() => {}
            }
        })
    };

    #[cfg(windows)]
    let signal_task = {
        let cancellation = ctx.cancellation.clone();
        let stop = signal_stop.clone();
        let code = Arc::clone(&signal_code);
        tokio::spawn(async move {
            tokio::select! {
                res = tokio::signal::ctrl_c() => {
                    if res.is_ok() {
                        crate::logging::log(
                            "Pipeline",
                            "Received Ctrl-C; cancelling pipeline gracefully.",
                            LogLevel::Warn,
                        );
                        code.store(130, Ordering::SeqCst);
                        cancellation.cancel();
                    }
                }
                _ = stop.cancelled() => {}
            }
        })
    };
    let outcome = execute_untracked(ctx, config).await;
    signal_stop.cancel();
    signal_task.abort();
    let result = match signal_code.load(Ordering::SeqCst) {
        130 => Err(AppError::new("SIGINT", 130, "Pipeline cancelled by SIGINT")),
        143 => Err(AppError::new(
            "SIGTERM",
            143,
            "Pipeline cancelled by SIGTERM",
        )),
        _ => outcome,
    };
    if let Some(tracker) = &ctx.usage_tracker {
        let summary = tracker
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get_summary();
        crate::logging::log_kv(
            "Pipeline",
            &format!(
                "OpenRouter pipeline usage summary: input={}, output={}, total={}, cost={}",
                summary.input_tokens,
                summary.output_tokens,
                summary.total_tokens,
                crate::llm::usage::format_usd(summary.cost_usd)
            ),
            LogLevel::Info,
            &[
                (
                    "event",
                    serde_json::json!("openrouter.usage.pipeline_summary"),
                ),
                (
                    "status",
                    serde_json::json!(if result.is_ok() { "success" } else { "failed" }),
                ),
                ("accountedCalls", serde_json::json!(summary.accounted_calls)),
                (
                    "unavailableUsageCalls",
                    serde_json::json!(summary.unavailable_usage_calls),
                ),
                ("inputTokens", serde_json::json!(summary.input_tokens)),
                ("outputTokens", serde_json::json!(summary.output_tokens)),
                ("totalTokens", serde_json::json!(summary.total_tokens)),
                ("totalCostUsd", serde_json::json!(summary.cost_usd)),
            ],
        );
    }
    result
}

async fn execute_untracked(ctx: &RunContext, config: &PipelineConfig) -> Result<PipelineResult> {
    let mut result = PipelineResult::default();
    // Stage 0: preflight assertion (matches Node's executePipeline). The API
    // key is only required when an LLM stage will actually run.
    let requires_llm = run_phase(config, "jobCloth")
        || (config.remote_only && run_phase(config, "remoteEval"))
        || run_phase(config, "jobJudge")
        || (run_phase(config, "makeMaterials") && !config.skip_materials);
    let mut selected_preset_categories = vec![
        ("jobCloth".to_string(), config.jobcloth_preset.clone()),
        ("jobJudge".to_string(), config.jobjudge_preset.clone()),
        (
            "makeMaterials".to_string(),
            config.makematerials_preset.clone(),
        ),
    ];
    if config.remote_only {
        selected_preset_categories
            .push(("remoteEval".to_string(), config.remoteeval_preset.clone()));
    }
    crate::commands::preflight::assert_preflight(
        ctx,
        &crate::commands::preflight::PreflightOptions {
            require_api_key: requires_llm,
            check_deployment: config.deploy && run_phase(config, "deployment"),
            deployment_destination: config.deploy_destination.clone(),
            selected_presets: vec![],
            selected_preset_categories,
        },
    )?;
    crate::logging::log("Pipeline", "Preflight checks passed", LogLevel::Success);
    crate::logging::log(
        "Pipeline",
        "Pipeline progress initialized — tracking 8 planned stages.",
        LogLevel::Info,
    );
    let watchdog_error: Arc<Mutex<Option<AppError>>> = Arc::new(Mutex::new(None));
    let watchdog = if let Some(target) = &config.internet_watchdog {
        let watchdog = crate::internet_watchdog::InternetWatchdog::new(target)?;
        watchdog.validate_startup(&ctx.cancellation).await?;
        let cancellation = ctx.cancellation.clone();
        let slot = Arc::clone(&watchdog_error);
        watchdog.start(ctx.cancellation.clone(), move |error| {
            *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(error);
            cancellation.cancel()
        });
        Some(watchdog)
    } else {
        None
    };
    let run = async {
        let run_started = std::time::Instant::now();
        if config.clean {
            clean_artifacts(&ctx.cancellation, &config.data_dir)?;
        }
        let acquired_indeed = path(config, "acquired_jobs_indeed.json");
        let acquired_linkedin = path(config, "acquired_jobs_linkedin.json");
        let processed = path(config, "processed_jobs_indeed.json");
        let clothed = path(config, "clothed_jobs_indeed.json");
        let enriched = path(config, "clothed_jobs_enriched.json");
        let remote = path(config, "remote_eval_pass.json");
        if !config.skip_acquisition && run_phase(config, "acquireJobs") {
            let stage_started = std::time::Instant::now();
            let sites_list: Vec<String> = config
                .sites
                .split(',')
                .map(|site| site.trim().to_string())
                .filter(|site| !site.is_empty())
                .collect();
            crate::logging::log_kv(
                "Pipeline",
                &format!("Stage 1/8: Acquiring {} jobs...", sites_list.join(", ")),
                LogLevel::Info,
                &[
                    ("sites", serde_json::json!(sites_list)),
                    ("resultsWanted", serde_json::json!(config.results_wanted)),
                ],
            );
            let acquisition = acquire_jobs::run(
                ctx,
                &acquire_jobs::AcquireJobsOptions {
                    sites: acquire_jobs::parse_sources(&config.sites)?,
                    search_terms: vec![],
                    search_terms_file: config.search_terms_file.clone(),
                    locations: vec![String::new()],
                    results_wanted: config.results_wanted,
                    distance: 25,
                    hours_old: config.hours_old,
                    remote: false,
                    remote_only: config.remote_only,
                    job_type: None,
                    easy_apply: false,
                    indeed_country: "USA".into(),
                    description_mode: DescriptionMode::Available,
                    description_format: DescriptionFormat::Markdown,
                    proxies: vec![],
                    user_agent: None,
                    output_file: None,
                    output_file_indeed: Some(acquired_indeed.clone()),
                    output_file_linkedin: Some(acquired_linkedin.clone()),
                    use_jobdb: true,
                },
            )
            .await?;
            crate::logging::log_kv(
                "Pipeline",
                "Stage 1/8: Acquisition completed",
                LogLevel::Success,
                &[
                    ("jobsAcquired", serde_json::json!(acquisition.jobs)),
                    (
                        "durationMs",
                        serde_json::json!(stage_started.elapsed().as_secs_f64() * 1000.0),
                    ),
                ],
            );
            result.completed_phases.push("acquireJobs".into());
        } else {
            let reason = if !run_phase(config, "acquireJobs") {
                format!(
                    "skipped by resume (resuming from {}).",
                    config.resume.as_deref().unwrap_or_default()
                )
            } else {
                "skipped by flag.".to_string()
            };
            crate::logging::log(
                "Pipeline",
                &format!("Stage 1/8: Acquisition {reason}"),
                LogLevel::Info,
            );
        }
        if run_phase(config, "processData") {
            let stage_started = std::time::Instant::now();
            crate::logging::log(
                "Pipeline",
                "Stage 2/8: Normalizing and filtering acquired jobs...",
                LogLevel::Info,
            );
            // Match Node resolvePipelineAcquisitionInputFiles: only the
            // per-source artifacts for the selected sites, never a directory
            // scan (which could pick up stale sibling artifacts).
            let sites: Vec<String> = config
                .sites
                .split(',')
                .map(|site| site.trim().to_ascii_lowercase())
                .filter(|site| !site.is_empty())
                .collect();
            let mut normalization_input_files = Vec::new();
            if sites.iter().any(|site| site == "indeed") {
                normalization_input_files.push(acquired_indeed.clone());
            }
            if sites.iter().any(|site| site == "linkedin") {
                normalization_input_files.push(acquired_linkedin.clone());
            }
            let mut seen = std::collections::HashSet::new();
            normalization_input_files.retain(|file| seen.insert(file.clone()));
            let process_result = process_data::run(
                ctx,
                &process_data::ProcessDataOptions {
                    input_directory: config.data_dir.clone(),
                    input_files: normalization_input_files,
                    scan_input_directory: false,
                    output_file: processed.clone(),
                    company_filters: vec![],
                    title_filters: vec![],
                    remote_only: config.remote_only,
                    jobcloth_cool_off_days: config.jobcloth_cool_off_days,
                    batch_size: 1000,
                    sleep_min_ms: 0,
                    sleep_max_ms: 0,
                    log_cool_offs: config.log_cool_offs,
                },
            )
            .await?;
            crate::logging::log_kv(
                "Pipeline",
                "Stage 2/8: Normalization completed",
                LogLevel::Success,
                &[
                    (
                        "outputRecordCount",
                        serde_json::json!(process_result.output_record_count),
                    ),
                    (
                        "duplicatesRemoved",
                        serde_json::json!(process_result.duplicates_removed),
                    ),
                    (
                        "coolOffSuppressed",
                        serde_json::json!(process_result.job_db_cool_off_skipped_entries),
                    ),
                    (
                        "durationMs",
                        serde_json::json!(stage_started.elapsed().as_secs_f64() * 1000.0),
                    ),
                ],
            );
            result.completed_phases.push("processData".into());
        } else {
            crate::logging::log(
                "Pipeline",
                &format!(
                    "Stage 2/8: Normalization skipped by resume (resuming from {}).",
                    config.resume.as_deref().unwrap_or_default()
                ),
                LogLevel::Info,
            );
        }
        if run_phase(config, "jobCloth") {
            let stage_started = std::time::Instant::now();
            crate::logging::log(
                "Pipeline",
                &format!(
                    "Stage 3/8: Job prefiltering with {}...",
                    config.jobcloth_preset
                ),
                LogLevel::Info,
            );
            let cloth_routing = resolve_stage_provider_routing(
                ctx,
                "jobCloth",
                "--jc-provider",
                &config.jobcloth_preset,
                config.routing_jobcloth.clone(),
                config.astro_auto_provider_top,
            )
            .await?;
            let cloth_output = job_cloth::run(
                ctx,
                std::slice::from_ref(&processed),
                &clothed,
                &job_cloth::JobClothOptions {
                    preset: config.jobcloth_preset.clone(),
                    batch: config.batch_size,
                    temperature: None,
                    top_p: None,
                    max_tokens: None,
                    // Node's pipeline does not forward run-pipeline's --sleep to
                    // jobCloth, so runJobCloth's own 2-second default applies.
                    sleep_ms: 2_000,
                    reasoning_effort: config.reasoning_jobcloth.clone(),
                    provider_routing: cloth_routing,
                    show_reasoning: true,
                    show_stream: true,
                    ..job_cloth::JobClothOptions::default()
                },
            )
            .await?;
            crate::logging::log_kv(
                "Pipeline",
                "Stage 3/8: JobCloth completed",
                LogLevel::Success,
                &[
                    ("outputJobs", serde_json::json!(cloth_output.len())),
                    (
                        "durationMs",
                        serde_json::json!(stage_started.elapsed().as_secs_f64() * 1000.0),
                    ),
                ],
            );
            result.completed_phases.push("jobCloth".into());
        } else {
            crate::logging::log(
                "Pipeline",
                &format!(
                    "Stage 3/8: JobCloth skipped by resume (resuming from {}).",
                    config.resume.as_deref().unwrap_or_default()
                ),
                LogLevel::Info,
            );
        }
        let cloth_jobs: Vec<crate::models::JobInterface> = std::fs::read_to_string(&clothed)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        let has_linkedin_jobs = config
            .sites
            .split(',')
            .any(|site| site.trim().eq_ignore_ascii_case("linkedin"))
            || cloth_jobs.iter().any(|job| {
                job.source.as_deref() == Some("linkedin")
                    || job
                        .url
                        .as_deref()
                        .is_some_and(|url| url.contains("linkedin.com"))
            });
        let mut post_enrichment_input = clothed.clone();
        if run_phase(config, "enrichJobs") {
            if has_linkedin_jobs && !cloth_jobs.is_empty() {
                let stage_started = std::time::Instant::now();
                crate::logging::log(
                    "Pipeline",
                    "Stage 4/8: Enriching descriptions for surviving LinkedIn jobs...",
                    LogLevel::Info,
                );
                let enrich_result = enrich_jobs::run(
                    ctx,
                    &enrich_jobs::EnrichJobsOptions {
                        input_file: clothed,
                        output_file: enriched.clone(),
                        delay_ms: 1000,
                        description_format: DescriptionFormat::Markdown,
                        proxies: vec![],
                        user_agent: None,
                        use_jobdb: true,
                    },
                )
                .await?;
                crate::logging::log_kv(
                    "Pipeline",
                    "Stage 4/8: LinkedIn Enrichment completed",
                    LogLevel::Success,
                    &[
                        (
                            "enrichedCount",
                            serde_json::json!(enrich_result.enriched_count),
                        ),
                        ("totalJobs", serde_json::json!(enrich_result.total_jobs)),
                        (
                            "durationMs",
                            serde_json::json!(stage_started.elapsed().as_secs_f64() * 1000.0),
                        ),
                    ],
                );
                post_enrichment_input = enriched.clone();
                result.completed_phases.push("enrichJobs".into());
            } else {
                crate::logging::log(
                    "Pipeline",
                    "Stage 4/8: LinkedIn Enrichment skipped (no LinkedIn jobs).",
                    LogLevel::Info,
                );
            }
        } else {
            crate::logging::log(
                "Pipeline",
                &format!(
                    "Stage 4/8: LinkedIn Enrichment skipped by resume (resuming from {}).",
                    config.resume.as_deref().unwrap_or_default()
                ),
                LogLevel::Info,
            );
            if has_linkedin_jobs && enriched.exists() {
                post_enrichment_input = enriched.clone();
            }
        }
        let judge_input = if config.remote_only {
            if run_phase(config, "remoteEval") {
                let stage_started = std::time::Instant::now();
                crate::logging::log(
                    "Pipeline",
                    &format!(
                        "Stage 5/8: Confirming remote status with {}...",
                        config.remoteeval_preset
                    ),
                    LogLevel::Info,
                );
                let remote_routing = resolve_stage_provider_routing(
                    ctx,
                    "remoteEval",
                    "--re-provider",
                    &config.remoteeval_preset,
                    config.routing_remoteeval.clone(),
                    config.astro_auto_provider_top,
                )
                .await?;
                let remote_result = remote_eval::run(
                    ctx,
                    &remote_eval::RemoteEvalOptions {
                        input_file: post_enrichment_input.clone(),
                        output_file: remote.clone(),
                        preset: config.remoteeval_preset.clone(),
                        sleep_ms: config.sleep_ms,
                        retry_delay_ms: None,
                        reasoning_effort: config.reasoning_remoteeval.clone(),
                        provider_routing: remote_routing,
                        strict_parsing: false,
                        use_checkpoints: true,
                        show_reasoning: true,
                        show_stream: true,
                    },
                )
                .await?;
                crate::logging::log_kv(
                    "Pipeline",
                    "Stage 5/8: RemoteEval completed",
                    LogLevel::Success,
                    &[
                        ("jobs", serde_json::json!(remote_result.jobs)),
                        ("passed", serde_json::json!(remote_result.passed)),
                        (
                            "durationMs",
                            serde_json::json!(stage_started.elapsed().as_secs_f64() * 1000.0),
                        ),
                    ],
                );
                result.completed_phases.push("remoteEval".into());
            } else {
                // Node requires the remoteEval artifact to already exist when a
                // resume skips the stage under --remote-only.
                if !remote.exists() {
                    return Err(AppError::message(format!(
                        "Cannot resume from {} with --remote-only: required remoteEval artifact is missing: {}",
                        config.resume.as_deref().unwrap_or_default(),
                        remote.display()
                    )));
                }
                crate::logging::log(
                    "Pipeline",
                    &format!(
                        "Stage 5/8: RemoteEval skipped by resume (resuming from {}).",
                        config.resume.as_deref().unwrap_or_default()
                    ),
                    LogLevel::Info,
                );
            }
            remote
        } else {
            result.remote_eval_skipped = true;
            crate::logging::log(
                "Pipeline",
                "Stage 5/8: RemoteEval skipped (--remote-only is disabled).",
                LogLevel::Info,
            );
            post_enrichment_input
        };
        if run_phase(config, "jobJudge") {
            let stage_started = std::time::Instant::now();
            crate::logging::log(
                "Pipeline",
                &format!(
                    "Stage 6/8: Job alignment evaluation with {}...",
                    config.jobjudge_preset
                ),
                LogLevel::Info,
            );
            let judge_routing = resolve_stage_provider_routing(
                ctx,
                "jobJudge",
                "--jj-provider",
                &config.jobjudge_preset,
                config.routing_jobjudge.clone(),
                config.astro_auto_provider_top,
            )
            .await?;
            let judge_result = job_judge::run(
                ctx,
                &job_judge::JobJudgeOptions {
                    input_file: judge_input,
                    output_file: path(config, "astroapply_eval_"),
                    preset: config.jobjudge_preset.clone(),
                    eval_mode: 1,
                    sleep_ms: config.sleep_ms,
                    strict_parsing: false,
                    use_jobdb: true,
                    max_tokens: None,
                    reasoning_effort: config.reasoning_jobjudge.clone(),
                    provider_routing: judge_routing,
                    show_reasoning: true,
                    show_stream: true,
                },
            )
            .await?;
            crate::logging::log_kv(
                "Pipeline",
                "Stage 6/8: JobJudge completed",
                LogLevel::Success,
                &[
                    ("jobs", serde_json::json!(judge_result.jobs)),
                    ("passed", serde_json::json!(judge_result.passed)),
                    (
                        "durationMs",
                        serde_json::json!(stage_started.elapsed().as_secs_f64() * 1000.0),
                    ),
                ],
            );
            result.completed_phases.push("jobJudge".into());
        } else {
            crate::logging::log(
                "Pipeline",
                &format!(
                    "Stage 6/8: JobJudge skipped by resume (resuming from {}).",
                    config.resume.as_deref().unwrap_or_default()
                ),
                LogLevel::Info,
            );
        }
        if !config.skip_materials && run_phase(config, "makeMaterials") {
            let stage_started = std::time::Instant::now();
            crate::logging::log(
                "Pipeline",
                &format!(
                    "Stage 7/8: Application materials generation with {}...",
                    config.makematerials_preset
                ),
                LogLevel::Info,
            );
            let materials_routing = resolve_stage_provider_routing(
                ctx,
                "makeMaterials",
                "--mm-provider",
                &config.makematerials_preset,
                config.routing_makematerials.clone(),
                config.astro_auto_provider_top,
            )
            .await?;
            let materials_result = make_materials::run(
                ctx,
                &make_materials::MakeMaterialsOptions {
                    preset: config.makematerials_preset.clone(),
                    targ_jd: None,
                    cover_length: 275,
                    sleep_min_ms: 2500,
                    sleep_max_ms: 4500,
                    jitter: true,
                    temperature: None,
                    top_p: None,
                    max_tokens: None,
                    reasoning_effort: config.reasoning_makematerials.clone(),
                    provider_routing: materials_routing,
                    resume: None,
                    testimonials: None,
                    professional_title: None,
                    professional_summary: None,
                    key_skills: None,
                    show_reasoning: true,
                    show_stream: true,
                    suppress_errors: true,
                },
            )
            .await?;
            crate::logging::log_kv(
                "Pipeline",
                "Stage 7/8: MakeMaterials completed",
                LogLevel::Success,
                &[
                    ("generated", serde_json::json!(materials_result.generated)),
                    (
                        "durationMs",
                        serde_json::json!(stage_started.elapsed().as_secs_f64() * 1000.0),
                    ),
                ],
            );
            result.completed_phases.push("makeMaterials".into());
        } else {
            let reason = if !run_phase(config, "makeMaterials") {
                format!(
                    "skipped by resume (resuming from {}).",
                    config.resume.as_deref().unwrap_or_default()
                )
            } else {
                "skipped by flag.".to_string()
            };
            crate::logging::log(
                "Pipeline",
                &format!("Stage 7/8: MakeMaterials {reason}"),
                LogLevel::Info,
            );
        }
        if run_phase(config, "deployment") {
            if config.deploy {
                let stage_started = std::time::Instant::now();
                let destination = config
                    .deploy_destination
                    .as_deref()
                    .expect("validated deploy destination");
                crate::logging::log_kv(
                    "Pipeline",
                    "Stage 8/8: Deploying materials...",
                    LogLevel::Info,
                    &[("destination", serde_json::json!(destination))],
                );
                let deploy_result = crate::pipeline::deploy::deploy(
                    ctx,
                    &config.materials_dir,
                    &config.deployed_materials_dir,
                    destination,
                )
                .await?;
                crate::logging::log_kv(
                    "Pipeline",
                    &format!(
                        "Stage 8/8: Deployment completed (deployed {} material items).",
                        deploy_result.deployed
                    ),
                    LogLevel::Success,
                    &[
                        ("deployedCount", serde_json::json!(deploy_result.deployed)),
                        (
                            "durationMs",
                            serde_json::json!(stage_started.elapsed().as_secs_f64() * 1000.0),
                        ),
                    ],
                );
                result.completed_phases.push("deployment".into());
            } else {
                crate::logging::log(
                    "Pipeline",
                    "Stage 8/8: Deployment skipped (disabled).",
                    LogLevel::Info,
                );
            }
        } else {
            crate::logging::log(
                "Pipeline",
                &format!(
                    "Stage 8/8: Deployment skipped by resume (resuming from {}).",
                    config.resume.as_deref().unwrap_or_default()
                ),
                LogLevel::Info,
            );
        }
        let duration_ms = run_started.elapsed().as_secs_f64() * 1000.0;
        crate::logging::log_kv(
            "Pipeline",
            &format!(
                "Pipeline completed successfully in {}.",
                crate::logging::formatter::format_duration(duration_ms)
            ),
            LogLevel::Success,
            &[
                ("durationMs", serde_json::json!(duration_ms)),
                (
                    "stages",
                    serde_json::json!({
                        "completedPhases": result.completed_phases,
                        "remoteEvalSkipped": result.remote_eval_skipped,
                    }),
                ),
            ],
        );
        Ok(result)
    };
    let outcome = run.await;
    if let Some(watchdog) = watchdog {
        watchdog.stop();
    }
    // Node rethrows the cancellation cause (e.g. the connectivity-lost error)
    // instead of the generic "pipeline cancelled" error.
    if outcome.is_err() && ctx.cancellation.is_cancelled() {
        if let Some(error) = watchdog_error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            return Err(error);
        }
    }
    outcome
}
fn clean_artifacts(
    cancellation: &tokio_util::sync::CancellationToken,
    data_dir: &std::path::Path,
) -> Result<()> {
    crate::pipeline::cancellation::throw_if_cancelled(cancellation)?;
    crate::logging::log(
        "Pipeline",
        "Cleaning transient data and log artifacts (preserving SQLite)...",
        LogLevel::Warn,
    );
    fn remove_file(base: &std::path::Path) {
        let _ = std::fs::remove_file(base);
        let _ = std::fs::remove_file(manifest_path(base));
    }
    fn manifest_path(base: &std::path::Path) -> std::path::PathBuf {
        let mut name = base
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        name.push_str(".manifest.json");
        base.with_file_name(name)
    }
    for name in [
        "acquired_jobs_indeed.json",
        "acquired_jobs_linkedin.json",
        "processed_jobs_indeed.json",
        "clothed_jobs_indeed.json",
        "clothed_jobs_enriched.json",
        "remote_eval_pass.json",
    ] {
        remove_file(&data_dir.join(name));
    }
    for dir in [
        "astroapply_eval_pass",
        "astroapply_eval_fail",
        "astroapply_eval_dupe",
    ] {
        let _ = std::fs::remove_dir_all(data_dir.join(dir));
    }
    if let Ok(entries) = std::fs::read_dir(data_dir) {
        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if !file_type.is_file() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let is_preserved = name.contains(".sqlite")
                || name.ends_with(".bak")
                || name.contains(".bak.")
                || name == "jobDB.json";
            if !is_preserved
                && (name.ends_with(".manifest.json")
                    || name.starts_with("acquired_jobs_")
                    || name.starts_with("processed_jobs_")
                    || name.starts_with("clothed_jobs_")
                    || name.starts_with("remote_eval_"))
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Port of Node multiProviderPipeline.test.js "pipeline transient cleanup
    /// preserves *.sqlite* and *.bak* while cleaning transient files".
    #[test]
    fn transient_cleanup_preserves_sqlite_and_backups() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path();
        for (name, contents) in [
            ("jobDB.sqlite", "SQLITE-DATA"),
            ("jobDB.sqlite-wal", "SQLITE-WAL"),
            ("jobDB.sqlite-shm", "SQLITE-SHM"),
            ("jobDB.sqlite.bak", "BACKUP-DATA"),
            ("data_backup.bak", "BACKUP-ARCHIVE"),
            ("jobDB.json", "{}"),
        ] {
            fs::write(root.join(name), contents).expect("write preserved");
        }
        for name in [
            "acquired_jobs_indeed.json",
            "acquired_jobs_indeed.json.manifest.json",
            "acquired_jobs_linkedin.json",
            "acquired_jobs_linkedin.json.manifest.json",
            "processed_jobs_indeed.json",
            "processed_jobs_indeed.json.manifest.json",
            "clothed_jobs_indeed.json",
            "clothed_jobs_enriched.json",
        ] {
            fs::write(root.join(name), "[]").expect("write transient");
        }
        for dir in [
            "astroapply_eval_pass",
            "astroapply_eval_fail",
            "astroapply_eval_dupe",
        ] {
            let path = root.join(dir);
            fs::create_dir_all(&path).expect("mkdir eval");
            fs::write(path.join("job1.json"), "{}").expect("write eval job");
        }

        let token = tokio_util::sync::CancellationToken::new();
        clean_artifacts(&token, root).expect("clean succeeds");

        for (name, contents) in [
            ("jobDB.sqlite", "SQLITE-DATA"),
            ("jobDB.sqlite-wal", "SQLITE-WAL"),
            ("jobDB.sqlite-shm", "SQLITE-SHM"),
            ("jobDB.sqlite.bak", "BACKUP-DATA"),
            ("data_backup.bak", "BACKUP-ARCHIVE"),
            ("jobDB.json", "{}"),
        ] {
            assert_eq!(
                fs::read_to_string(root.join(name)).expect("preserved file"),
                contents,
                "{name} must be preserved"
            );
        }
        for name in [
            "acquired_jobs_indeed.json",
            "acquired_jobs_indeed.json.manifest.json",
            "acquired_jobs_linkedin.json",
            "acquired_jobs_linkedin.json.manifest.json",
            "clothed_jobs_indeed.json",
            "clothed_jobs_enriched.json",
        ] {
            assert!(!root.join(name).exists(), "{name} must be removed");
        }
        for dir in [
            "astroapply_eval_pass",
            "astroapply_eval_fail",
            "astroapply_eval_dupe",
        ] {
            assert!(!root.join(dir).exists(), "{dir} must be removed");
        }
    }

    #[test]
    fn transient_cleanup_noop_when_cancelled() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(dir.path().join("acquired_jobs_indeed.json"), "[]").expect("write");
        let token = tokio_util::sync::CancellationToken::new();
        token.cancel();
        assert!(clean_artifacts(&token, dir.path()).is_err());
        assert!(dir.path().join("acquired_jobs_indeed.json").exists());
    }
}
