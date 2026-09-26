//! Stage 1: acquire canonical jobs and maintain per-source resume artifacts.

use crate::acquisition::types::{CanonicalAcquiredJob, DescriptionFormat, Site};
use crate::acquisition::{AcquisitionQuery, DescriptionMode, JobSpyAcquisitionProvider};
use crate::constants::JOB_DB_RETENTION_MS;
use crate::context::RunContext;
use crate::error::{AppError, Result};
use crate::jobrepo::{JobIdentity, JobRepository, JobRepositoryConfig};
use crate::logging;
use crate::types::LogLevel;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct AcquireJobsOptions {
    pub sites: Vec<Site>,
    pub search_terms: Vec<String>,
    pub search_terms_file: PathBuf,
    pub locations: Vec<String>,
    pub results_wanted: u32,
    pub distance: u32,
    pub hours_old: Option<u32>,
    pub remote: bool,
    pub remote_only: bool,
    pub job_type: Option<String>,
    pub easy_apply: bool,
    pub indeed_country: String,
    pub description_mode: DescriptionMode,
    pub description_format: DescriptionFormat,
    pub proxies: Vec<String>,
    pub user_agent: Option<String>,
    pub output_file: Option<PathBuf>,
    pub output_file_indeed: Option<PathBuf>,
    pub output_file_linkedin: Option<PathBuf>,
    pub use_jobdb: bool,
}

#[derive(Debug, Clone)]
pub struct AcquisitionResult {
    pub output_file: PathBuf,
    pub output_files: Vec<PathBuf>,
    pub jobs: usize,
}

pub fn parse_sources(value: &str) -> Result<Vec<Site>> {
    let mut sites = Vec::new();
    for value in value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let site = Site::parse(value).ok_or_else(|| {
            AppError::message(format!(
                "Unsupported acquisition site(s): {value}. Supported sources: indeed, linkedin."
            ))
        })?;
        if !sites.contains(&site) {
            sites.push(site);
        }
    }
    if sites.is_empty() {
        Err(AppError::message(
            "--sites must include at least one supported source (indeed, linkedin)",
        ))
    } else {
        Ok(sites)
    }
}

/// Source-specific backoff copied from `getProviderCooldownMs` in AstroEX.
pub fn provider_cooldown_ms(error: &AppError, consecutive_failures: u32) -> u64 {
    let exponent = consecutive_failures.max(1) - 1;
    if error.message.contains("429") {
        60_000_u64
            .saturating_mul(2_u64.saturating_pow(exponent))
            .min(5 * 60_000)
    } else {
        15_000_u64
            .saturating_mul(2_u64.saturating_pow(exponent))
            .min(2 * 60_000)
    }
}

pub fn should_disable_source(error: &AppError) -> bool {
    let retryable = error
        .context
        .as_ref()
        .and_then(|context| context.get("retryable"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    !retryable
        || [400, 401, 403, 404].contains(&error.status_code)
        || ["400", "401", "403", "404"]
            .iter()
            .any(|status| error.message.contains(status))
}

pub async fn run(ctx: &RunContext, options: &AcquireJobsOptions) -> Result<AcquisitionResult> {
    if options.results_wanted == 0 {
        return Err(AppError::message(
            "--results-wanted must be a positive integer",
        ));
    }
    let terms = if options.search_terms.is_empty() {
        load_terms(&options.search_terms_file)?
    } else {
        options.search_terms.clone()
    };
    if terms.is_empty() {
        return Err(AppError::message(
            "No search terms supplied or found in --search-terms-file",
        ));
    }
    let locations = if options.locations.is_empty() {
        vec![String::new()]
    } else {
        options.locations.clone()
    };
    let output_files = resolve_output_files(ctx, options);
    let repository_dir = output_files
        .get(&options.sites[0])
        .and_then(|path| path.parent())
        .unwrap_or(&ctx.paths.data_dir);
    let mut repo = JobRepository::new(JobRepositoryConfig {
        db_file_path: repository_dir.join("jobDB.sqlite"),
        legacy_json_path: Some(repository_dir.join("jobDB.json")),
        default_expiration_ms: Some(JOB_DB_RETENTION_MS as i64),
        enable_job_db: options.use_jobdb,
        max_records: None,
        now: None,
    });
    repo.initialize()?;
    repo.cleanup_expired()?;
    let mut saved: HashMap<Site, Vec<CanonicalAcquiredJob>> = HashMap::new();
    let mut ids = HashSet::new();
    for site in &options.sites {
        let path = output_files
            .get(site)
            .expect("configured site output exists");
        let mut jobs = load_checkpoint(path)?;
        if options.remote_only {
            jobs.retain(|job| job.is_remote == Some(true));
        }
        for job in &jobs {
            ids.insert(job.id.clone());
        }
        saved.insert(*site, jobs);
    }
    let provider = JobSpyAcquisitionProvider::new();
    let mut failures = Vec::new();
    let mut disabled_sources = HashSet::new();
    let mut cooldown_until = HashMap::new();
    let mut consecutive_failures = HashMap::<Site, u32>::new();
    for (term_idx, term) in terms.iter().enumerate() {
        for location in &locations {
            crate::pipeline::cancellation::throw_if_cancelled(&ctx.cancellation)?;
            let now = ctx.now_ms();
            let ready_source_exists = options.sites.iter().any(|site| {
                !disabled_sources.contains(site)
                    && cooldown_until.get(site).copied().unwrap_or(0) <= now
            });
            if !ready_source_exists {
                if let Some(until) = options
                    .sites
                    .iter()
                    .filter(|site| !disabled_sources.contains(*site))
                    .filter_map(|site| cooldown_until.get(site).copied())
                    .min()
                {
                    let wait_ms = until.saturating_sub(now);
                    logging::log(
                        "AcquireJobs",
                        &format!(
                            "All active providers are cooling down; waiting {}s before retrying this query.",
                            wait_ms.div_ceil(1000)
                        ),
                        LogLevel::Warn,
                    );
                    crate::context::abortable_delay(wait_ms, &ctx.cancellation).await?;
                }
            }
            for site in &options.sites {
                if disabled_sources.contains(site) {
                    continue;
                }
                if cooldown_until.get(site).copied().unwrap_or(0) > ctx.now_ms() {
                    logging::log(
                        "AcquireJobs",
                        &format!("Skipping cooling {} provider.", site.name()),
                        LogLevel::Info,
                    );
                    continue;
                }
                let query = AcquisitionQuery {
                    site: *site,
                    search_term: term.clone(),
                    location: location.clone(),
                    results_wanted: options.results_wanted,
                    distance: options.distance,
                    hours_old: options.hours_old,
                    remote: options.remote,
                    remote_only: options.remote_only,
                    job_type: options.job_type.clone(),
                    easy_apply: options.easy_apply,
                    indeed_country: options.indeed_country.clone(),
                    description_mode: options.description_mode,
                    description_format: options.description_format,
                    proxies: options.proxies.clone(),
                    user_agent: options.user_agent.clone(),
                    offset: 0,
                    indeed_api_key: ctx.indeed_api_key.clone(),
                    show_fetch_url: ctx.display.show_fetch_url,
                    token: ctx.cancellation.clone(),
                    term_index: Some(term_idx + 1),
                    total_terms: Some(terms.len()),
                };
                match provider.acquire(&query).await {
                    Ok(jobs) => {
                        consecutive_failures.remove(site);
                        cooldown_until.remove(site);
                        let new: Vec<_> = jobs
                            .into_iter()
                            .filter(|job| {
                                (!options.remote_only || job.is_remote == Some(true))
                                    && ids.insert(job.id.clone())
                                    && !repo.is_job_matched(&job_identity(job)).unwrap_or(false)
                            })
                            .collect();
                        if new.is_empty() {
                            continue;
                        }
                        let entry = saved.entry(*site).or_default();
                        entry.extend(new.iter().cloned());
                        write_checkpoint(
                            output_files
                                .get(site)
                                .expect("configured site output exists"),
                            entry,
                        )?;
                        let identities: Vec<_> = new.iter().map(job_identity).collect();
                        if let Err(error) = repo.add_searched_jobs(&identities) {
                            logging::log("AcquireJobs", &format!("Repository discovery update failed after artifact write: {error}"), LogLevel::Warn);
                        }
                    }
                    Err(error) => {
                        let disable = should_disable_source(&error);
                        let cooldown = if disable {
                            None
                        } else {
                            let count = consecutive_failures.entry(*site).or_insert(0);
                            *count += 1;
                            Some((provider_cooldown_ms(&error, *count), *count))
                        };
                        failures.push(error.message);
                        logging::log(
                            "AcquireJobs",
                            failures.last().expect("failure was appended"),
                            LogLevel::Warn,
                        );
                        if disable {
                            disabled_sources.insert(*site);
                            logging::log(
                                "AcquireJobs",
                                &format!(
                                    "Disabled {} for this run after an unrecoverable failure.",
                                    site.name()
                                ),
                                LogLevel::Warn,
                            );
                        } else if let Some((cooldown_ms, failures)) = cooldown {
                            cooldown_until.insert(*site, ctx.now_ms().saturating_add(cooldown_ms));
                            logging::log(
                                "AcquireJobs",
                                &format!(
                                    "{} will cool down for {}s after {} retryable failure(s).",
                                    site.name(),
                                    cooldown_ms.div_ceil(1000),
                                    failures
                                ),
                                LogLevel::Warn,
                            );
                        }
                    }
                }
            }
        }
    }
    let total: usize = saved.values().map(Vec::len).sum();
    if total == 0 && !failures.is_empty() {
        return Err(AppError::message(format!(
            "No jobs were acquired because every active provider failed. First failure: {}",
            failures[0]
        )));
    }
    for site in &options.sites {
        let jobs = saved.get(site).cloned().unwrap_or_default();
        let path = output_files
            .get(site)
            .expect("configured site output exists");
        if !path.exists() {
            write_checkpoint(path, &jobs)?;
        }
        logging::log(
            "AcquireJobs",
            &format!(
                "Wrote {} canonical {} jobs to {}",
                jobs.len(),
                site.name(),
                path.display()
            ),
            LogLevel::Success,
        );
    }
    repo.close()?;
    Ok(AcquisitionResult {
        output_file: output_files[&options.sites[0]].clone(),
        output_files: options
            .sites
            .iter()
            .map(|site| output_files[site].clone())
            .collect(),
        jobs: total,
    })
}

fn resolve_output_files(ctx: &RunContext, options: &AcquireJobsOptions) -> HashMap<Site, PathBuf> {
    let mut files = HashMap::from([
        (
            Site::Indeed,
            ctx.paths.data_dir.join("acquired_jobs_indeed.json"),
        ),
        (
            Site::Linkedin,
            ctx.paths.data_dir.join("acquired_jobs_linkedin.json"),
        ),
    ]);
    if let Some(path) = &options.output_file {
        if options.sites.len() == 1 {
            files.insert(options.sites[0], path.clone());
        }
    }
    if let Some(path) = &options.output_file_indeed {
        files.insert(Site::Indeed, path.clone());
    }
    if let Some(path) = &options.output_file_linkedin {
        files.insert(Site::Linkedin, path.clone());
    }
    files
}
fn load_terms(path: &Path) -> Result<Vec<String>> {
    Ok(std::fs::read_to_string(path)?
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_owned)
        .collect())
}
fn load_checkpoint(path: &Path) -> Result<Vec<CanonicalAcquiredJob>> {
    match std::fs::read_to_string(path) {
        Ok(contents) => {
            // Node's `loadAcquisitionCheckpoint` filters parsed entries through
            // `isCanonicalAcquiredJob`, warns when entries are ignored, and
            // deduplicates the survivors by id.
            let parsed: Vec<serde_json::Value> =
                serde_json::from_str(&contents).map_err(|error| {
                    AppError::message(format!(
                        "Unable to resume acquisition output {}: {error}",
                        path.display()
                    ))
                })?;
            let total = parsed.len();
            let jobs: Vec<CanonicalAcquiredJob> = parsed
                .into_iter()
                .filter(CanonicalAcquiredJob::is_valid)
                .filter_map(|value| serde_json::from_value(value).ok())
                .collect();
            if jobs.len() != total {
                logging::log(
                    "AcquireJobs",
                    "Ignored noncanonical or retired-source entries in acquisition checkpoint.",
                    LogLevel::Warn,
                );
            }
            let mut seen = HashSet::new();
            Ok(jobs
                .into_iter()
                .filter(|job| seen.insert(job.id.clone()))
                .collect())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}
fn write_checkpoint(path: &Path, jobs: &[CanonicalAcquiredJob]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_file_name(format!(
        "{}.{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("jobs"),
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    std::fs::write(&temp, serde_json::to_string_pretty(jobs)?)?;
    std::fs::rename(&temp, path)?;
    Ok(())
}

fn job_identity(job: &CanonicalAcquiredJob) -> JobIdentity {
    JobIdentity {
        id: Some(job.id.clone()),
        source: Some(job.source.clone()),
        source_job_id: job.source_job_id.clone(),
        title: job.title.clone(),
        company: job.company.clone(),
        url: job.canonical_url.clone().or_else(|| job.direct_url.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::{Diagnostics, DisplayConfig, LlmBudgets, Paths};
    use crate::types::LogFormat;
    use tempfile::TempDir;
    use tokio_util::sync::CancellationToken;

    fn context(temp: &TempDir) -> RunContext {
        RunContext {
            paths: Paths {
                project_root: temp.path().to_path_buf(),
                data_dir: temp.path().join("data"),
                log_dir: temp.path().join("logs"),
                materials_dir: temp.path().join("materials"),
                profile_dir: temp.path().join("profile"),
            },
            display: DisplayConfig {
                verbose: false,
                color: Some(false),
                hide_reasoning: false,
                show_reasoning: false,
                show_fetch_url: false,
                log_level: None,
                log_format: LogFormat::Pretty,
                machine_json: false,
                banner_loops: 4,
            },
            budgets: LlmBudgets::default(),
            diagnostics: Diagnostics {
                log_llm_payloads: false,
                log_max_payload_length: None,
            },
            api_key: None,
            llm_base_url_override: None,
            indeed_api_key: None,
            usage_tracker: None,
            cancellation: CancellationToken::new(),
            run_started_at_ms: 0,
        }
    }

    fn options(sites: Vec<Site>) -> AcquireJobsOptions {
        AcquireJobsOptions {
            sites,
            search_terms: Vec::new(),
            search_terms_file: PathBuf::from("terms.txt"),
            locations: Vec::new(),
            results_wanted: 25,
            distance: 50,
            hours_old: None,
            remote: false,
            remote_only: false,
            job_type: None,
            easy_apply: false,
            indeed_country: "USA".to_string(),
            description_mode: DescriptionMode::Full,
            description_format: DescriptionFormat::Markdown,
            proxies: Vec::new(),
            user_agent: None,
            output_file: None,
            output_file_indeed: None,
            output_file_linkedin: None,
            use_jobdb: true,
        }
    }

    #[test]
    fn sources_are_trimmed_deduplicated_and_validated() {
        assert_eq!(
            parse_sources(" indeed, linkedin,indeed ").unwrap(),
            vec![Site::Indeed, Site::Linkedin]
        );
        assert!(parse_sources("glassdoor").is_err());
        assert!(parse_sources(" , ").is_err());
    }

    #[test]
    fn provider_cooldowns_and_definitive_failures_match_node_policy() {
        let rate_limited = AppError::new("ACQUISITION_FAILED", 503, "Indeed returned 429")
            .with_context(serde_json::json!({"retryable": true}));
        assert_eq!(provider_cooldown_ms(&rate_limited, 1), 60_000);
        assert_eq!(provider_cooldown_ms(&rate_limited, 5), 300_000);
        assert!(!should_disable_source(&rate_limited));

        let forbidden = AppError::new("ACQUISITION_FAILED", 403, "forbidden")
            .with_context(serde_json::json!({"retryable": false}));
        assert!(should_disable_source(&forbidden));
        assert_eq!(provider_cooldown_ms(&forbidden, 5), 120_000);
    }

    #[test]
    fn output_paths_follow_node_source_defaults_and_single_source_override() {
        let temp = TempDir::new().unwrap();
        let context = context(&temp);
        let mut both = options(vec![Site::Indeed, Site::Linkedin]);
        let paths = resolve_output_files(&context, &both);
        assert_eq!(
            paths[&Site::Indeed],
            context.paths.data_dir.join("acquired_jobs_indeed.json")
        );
        assert_eq!(
            paths[&Site::Linkedin],
            context.paths.data_dir.join("acquired_jobs_linkedin.json")
        );

        both.sites = vec![Site::Linkedin];
        both.output_file = Some(temp.path().join("custom.json"));
        assert_eq!(
            resolve_output_files(&context, &both)[&Site::Linkedin],
            temp.path().join("custom.json")
        );
    }
}
