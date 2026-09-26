//! Stage 2: normalize acquisition artifacts into the legacy pipeline shape.

use crate::acquisition::normalize::to_legacy_job;
use crate::acquisition::types::CanonicalAcquiredJob;
use crate::artifact_manifest::{write_artifact_manifest, write_json_atomic_private};
use crate::constants::{JOB_DB_RETENTION_MS, MILLISECONDS_PER_DAY};
use crate::context::{abortable_delay, RunContext};
use crate::error::{AppError, Result};
use crate::jobrepo::{
    create_job_cloth_match_key, JobClothIdentity, JobRepository, JobRepositoryConfig,
};
use crate::logging;
use crate::models::JobInterface;
use crate::types::LogLevel;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct ProcessDataOptions {
    pub input_directory: PathBuf,
    pub input_files: Vec<PathBuf>,
    /// When false, only `input_files` are used (pipeline behavior). When true,
    /// `input_directory` is also scanned for `acquired_jobs_*.json`
    /// (standalone `processData` behavior).
    pub scan_input_directory: bool,
    pub output_file: PathBuf,
    pub company_filters: Vec<String>,
    pub title_filters: Vec<String>,
    pub remote_only: bool,
    pub jobcloth_cool_off_days: i64,
    pub batch_size: usize,
    pub sleep_min_ms: u64,
    pub sleep_max_ms: u64,
    pub log_cool_offs: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDataResult {
    pub files_processed: usize,
    pub records_merged: usize,
    pub duplicates_removed: usize,
    pub filtered_entries: usize,
    pub remote_filtered_entries: usize,
    pub retired_or_invalid_entries: usize,
    pub job_db_cool_off_skipped_entries: usize,
    pub output_record_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cool_off_log_file: Option<PathBuf>,
}

pub async fn run(ctx: &RunContext, options: &ProcessDataOptions) -> Result<ProcessDataResult> {
    validate_options(options)?;
    crate::pipeline::cancellation::throw_if_cancelled(&ctx.cancellation)?;
    let output_file = absolute_path(&options.output_file)?;
    let input_files = discover_input_files(options, &output_file)?;
    let (default_companies, default_titles) = load_default_filters(&ctx.paths.profile_dir);
    let company_filters = normalize_filters(
        default_companies
            .into_iter()
            .chain(options.company_filters.clone()),
    );
    let title_filters = normalize_filters(
        default_titles
            .into_iter()
            .chain(options.title_filters.clone()),
    );
    let mut result = ProcessDataResult::default();
    let mut id_index = HashMap::new();
    let mut title_company_index = HashMap::new();
    let mut output = Vec::new();

    for input_file in &input_files {
        crate::pipeline::cancellation::throw_if_cancelled(&ctx.cancellation)?;
        let values: Vec<Value> = match std::fs::read_to_string(input_file)
            .ok()
            .and_then(|contents| serde_json::from_str(&contents).ok())
        {
            Some(values) => values,
            None => {
                logging::log(
                    "ProcessData",
                    &format!(
                        "Skipping unreadable or non-array artifact {}",
                        input_file.display()
                    ),
                    LogLevel::Warn,
                );
                continue;
            }
        };
        result.files_processed += 1;
        result.records_merged += values.len();
        for value in values {
            crate::pipeline::cancellation::throw_if_cancelled(&ctx.cancellation)?;
            let Some(job) = normalize_pipeline_job(value) else {
                result.retired_or_invalid_entries += 1;
                continue;
            };
            if options.remote_only && job.remote_ok != Some(true) {
                result.filtered_entries += 1;
                result.remote_filtered_entries += 1;
                continue;
            }
            let id = job.id.clone().expect("normalized jobs have an id");
            let key = title_company_key(&job).expect("normalized jobs have title and company");
            if id_index.contains_key(&id) {
                result.duplicates_removed += 1;
                continue;
            }
            if let Some(&existing_index) = title_company_index.get(&key) {
                result.duplicates_removed += 1;
                let existing = &output[existing_index];
                if should_replace_duplicate(existing, &job) {
                    let old_id = existing.id.clone().expect("normalized job id");
                    id_index.remove(&old_id);
                    output[existing_index] = job;
                    id_index.insert(id, existing_index);
                }
                continue;
            }
            if is_filtered(&job, &company_filters, &title_filters) {
                result.filtered_entries += 1;
                continue;
            }
            let index = output.len();
            id_index.insert(id, index);
            title_company_index.insert(key, index);
            output.push(job);
            if output.len() % options.batch_size == 0 && options.sleep_max_ms > 0 {
                let delay = options.sleep_min_ms
                    + (rand::random::<u64>() % (options.sleep_max_ms - options.sleep_min_ms + 1));
                abortable_delay(delay, &ctx.cancellation).await?;
            }
        }
    }

    // Node queries the shared repository rooted at the data directory (not
    // the output file's parent) and only opens it when there are records.
    if output.is_empty() {
        result.output_record_count = 0;
    } else {
        let mut repository = JobRepository::new(JobRepositoryConfig {
            db_file_path: ctx.paths.data_dir.join("jobDB.sqlite"),
            legacy_json_path: Some(ctx.paths.data_dir.join("jobDB.json")),
            default_expiration_ms: Some(JOB_DB_RETENTION_MS as i64),
            enable_job_db: true,
            max_records: None,
            now: None,
        });
        repository.initialize()?;
        let identities: Vec<_> = output.iter().filter_map(job_cloth_identity).collect();
        let recent = repository.get_recent_job_cloth_processing_keys(
            &identities,
            options.jobcloth_cool_off_days * MILLISECONDS_PER_DAY as i64,
        )?;
        let mut suppressed = Vec::new();
        output.retain(|job| {
            let suppressed_here = title_company_key(job).is_some_and(|key| recent.contains(&key));
            if suppressed_here && options.log_cool_offs {
                suppressed.push(json!({
                    "id": job.id,
                    "company": job.company,
                    "title": job.title,
                }));
            }
            !suppressed_here
        });
        result.job_db_cool_off_skipped_entries = identities.len() - output.len();
        result.filtered_entries += result.job_db_cool_off_skipped_entries;
        result.output_record_count = output.len();
        repository.close()?;

        if result.job_db_cool_off_skipped_entries > 0 {
            logging::log_kv(
                "ProcessData",
                &format!(
                    "Suppressed {} job(s) from pipeline due to {}-day cool-off.",
                    result.job_db_cool_off_skipped_entries, options.jobcloth_cool_off_days,
                ),
                LogLevel::Info,
                &[
                    ("coolOffDays", json!(options.jobcloth_cool_off_days)),
                    (
                        "suppressedCount",
                        json!(result.job_db_cool_off_skipped_entries),
                    ),
                ],
            );
        }

        if options.log_cool_offs {
            let log_file = write_cool_off_log(
                &ctx.paths.log_dir,
                options.jobcloth_cool_off_days,
                suppressed,
            )?;
            logging::log_kv(
                "ProcessData",
                &format!(
                    "Wrote {} cool-off suppression record(s) to {}",
                    result.job_db_cool_off_skipped_entries,
                    log_file.display()
                ),
                LogLevel::Info,
                &[
                    ("outputFile", json!(log_file.display().to_string())),
                    ("records", json!(result.job_db_cool_off_skipped_entries)),
                    ("coolOffDays", json!(options.jobcloth_cool_off_days)),
                ],
            );
            result.cool_off_log_file = Some(log_file);
        }
    }
    if let Some(parent) = output_file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_json_atomic_private(&output_file, &serde_json::to_value(&output)?)?;
    write_artifact_manifest(
        &output_file,
        "processData",
        json!({
            "inputFiles": input_files.iter().filter_map(|path| path.file_name()).filter_map(|name| name.to_str()).collect::<Vec<_>>(),
            "result": result,
        }),
    )?;
    logging::log(
        "ProcessData",
        &format!(
            "Processed {} artifacts into {} jobs at {}",
            result.files_processed,
            result.output_record_count,
            output_file.display()
        ),
        LogLevel::Success,
    );
    Ok(result)
}

fn validate_options(options: &ProcessDataOptions) -> Result<()> {
    if options.batch_size == 0 {
        return Err(AppError::message("--batch-size must be a positive integer"));
    }
    if options.jobcloth_cool_off_days <= 0 {
        return Err(AppError::message(
            "--jobcloth-cool-off-days must be a positive integer",
        ));
    }
    if options.sleep_max_ms < options.sleep_min_ms {
        return Err(AppError::message(
            "--sleep-max must be greater than or equal to --sleep-min",
        ));
    }
    Ok(())
}

fn discover_input_files(options: &ProcessDataOptions, output_file: &Path) -> Result<Vec<PathBuf>> {
    let mut files = HashSet::new();
    for file in &options.input_files {
        let file = absolute_path(file)?;
        if file != output_file {
            files.insert(file);
        }
    }
    if options.scan_input_directory && options.input_directory.is_dir() {
        for entry in std::fs::read_dir(&options.input_directory)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if entry.file_type()?.is_file()
                && name.starts_with("acquired_jobs_")
                && name.ends_with(".json")
            {
                let file = absolute_path(&entry.path())?;
                if file != output_file {
                    files.insert(file);
                }
            }
        }
    }
    let mut files: Vec<_> = files.into_iter().collect();
    files.sort();
    Ok(files)
}

fn absolute_path(path: &Path) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn normalize_filters(values: impl IntoIterator<Item = String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .collect()
}

fn load_default_filters(profile_dir: &Path) -> (Vec<String>, Vec<String>) {
    let read = |name| {
        std::fs::read_to_string(profile_dir.join(name))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    };
    (read("company_filters.txt"), read("title_filters.txt"))
}

fn normalize_pipeline_job(value: Value) -> Option<JobInterface> {
    // Node's `isCanonicalAcquiredJob` type guard requires canonicalUrl and
    // acquiredAt in addition to source/id/title/company; without it a legacy
    // record that happens to carry a `source` field would be misparsed as a
    // canonical job by serde's permissive optional fields.
    if CanonicalAcquiredJob::is_valid(&value) {
        if let Ok(canonical) = serde_json::from_value::<CanonicalAcquiredJob>(value.clone()) {
            return Some(to_legacy_job(&canonical));
        }
    }
    let mut job = serde_json::from_value::<JobInterface>(value).ok()?;
    let id = job.id.as_deref()?.trim();
    let title = job.title.as_deref()?.trim();
    let company = job.company.as_deref()?.trim();
    if id.is_empty()
        || title.is_empty()
        || company.is_empty()
        || !is_pipeline_url(job.url.as_deref()?)
    {
        return None;
    }
    job.source = Some(
        if job.source.as_deref() == Some("linkedin")
            || job
                .url
                .as_deref()
                .is_some_and(|url| url.contains("linkedin.com"))
        {
            "linkedin".to_string()
        } else {
            "indeed".to_string()
        },
    );
    Some(job)
}

fn is_pipeline_url(value: &str) -> bool {
    reqwest::Url::parse(value).ok().is_some_and(|url| {
        let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
        host.ends_with("indeed.com") || host.ends_with("linkedin.com")
    })
}

fn title_company_key(job: &JobInterface) -> Option<String> {
    job_cloth_identity(job).and_then(|identity| create_job_cloth_match_key(&identity))
}

fn job_cloth_identity(job: &JobInterface) -> Option<JobClothIdentity> {
    Some(JobClothIdentity {
        title: job.title.as_deref()?.to_string(),
        company: job.company.as_deref()?.to_string(),
    })
}

fn is_filtered(job: &JobInterface, company_filters: &[String], title_filters: &[String]) -> bool {
    let company = job.company_display().to_ascii_lowercase();
    let title = job.title_display().to_ascii_lowercase();
    company_filters
        .iter()
        .any(|filter| company.contains(filter))
        || title_filters.iter().any(|filter| title.contains(filter))
}

fn should_replace_duplicate(existing: &JobInterface, replacement: &JobInterface) -> bool {
    (existing
        .description_text
        .as_deref()
        .unwrap_or_default()
        .is_empty()
        && replacement
            .description_text
            .as_deref()
            .is_some_and(|value| !value.is_empty()))
        || (existing.source.as_deref() == Some("linkedin")
            && replacement.source.as_deref() == Some("indeed"))
}

fn write_cool_off_log(log_dir: &Path, cool_off_days: i64, jobs: Vec<Value>) -> Result<PathBuf> {
    std::fs::create_dir_all(log_dir)?;
    let path = log_dir.join(format!(
        "processData_cool_off_suppressions_{}_p{}_{}.json",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ"),
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    write_json_atomic_private(
        &path,
        &json!({
            "generatedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "coolOffDays": cool_off_days,
            "count": jobs.len(),
            "jobs": jobs,
        }),
    )?;
    Ok(path)
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

    #[test]
    fn legacy_jobs_with_source_are_not_mistaken_for_canonical() {
        // A legacy record that carries `source` but lacks canonicalUrl and
        // acquiredAt must take the legacy passthrough path, preserving its
        // original fields, rather than being projected through to_legacy_job.
        let legacy = json!({
            "id": "indeed-1",
            "title": "Staff Engineer",
            "company": "Acme",
            "url": "https://www.indeed.com/viewjob?jk=indeed-1",
            "source": "indeed",
            "description": "Full description here",
            "descriptionText": "Full description here"
        });
        let normalized = normalize_pipeline_job(legacy).expect("legacy job accepted");
        let value = serde_json::to_value(&normalized).unwrap();
        assert_eq!(value["url"], "https://www.indeed.com/viewjob?jk=indeed-1");
        assert_eq!(value["source"], "indeed");
        assert_eq!(value["description"], "Full description here");
        assert_eq!(value["descriptionText"], "Full description here");
        assert!(value.get("postedDate").is_none() || value["postedDate"].is_null());
        assert!(value.get("salaryMin").is_none() || value["salaryMin"].is_null());

        let canonical = json!({
            "id": "c1",
            "source": "indeed",
            "canonicalUrl": "https://www.indeed.com/viewjob?jk=c1",
            "title": "Staff Engineer",
            "company": "Acme",
            "acquiredAt": "2026-01-02T03:04:05.000Z",
            "description": "canonical description",
            "isRemote": true
        });
        let projected = serde_json::to_value(normalize_pipeline_job(canonical).unwrap()).unwrap();
        assert_eq!(projected["url"], "https://www.indeed.com/viewjob?jk=c1");
        assert_eq!(projected["descriptionText"], "canonical description");
        assert_eq!(projected["remoteOk"], true);
    }

    #[test]
    fn legacy_jobs_require_supported_urls_and_normalize_source() {
        let valid = json!({"id":"x","title":"Engineer","company":"Acme","url":"https://www.linkedin.com/jobs/view/x"});
        assert_eq!(
            normalize_pipeline_job(valid).unwrap().source.as_deref(),
            Some("linkedin")
        );
        let invalid =
            json!({"id":"x","title":"Engineer","company":"Acme","url":"https://example.com/job/x"});
        assert!(normalize_pipeline_job(invalid).is_none());
    }

    #[test]
    fn duplicate_prefers_indeed_or_a_description() {
        let mut linked_in = JobInterface {
            id: Some("one".into()),
            title: Some("Engineer".into()),
            company: Some("Acme".into()),
            source: Some("linkedin".into()),
            ..Default::default()
        };
        let mut indeed = linked_in.clone();
        indeed.id = Some("two".into());
        indeed.source = Some("indeed".into());
        assert!(should_replace_duplicate(&linked_in, &indeed));
        linked_in.source = Some("indeed".into());
        assert!(!should_replace_duplicate(&linked_in, &indeed));
    }

    #[tokio::test]
    async fn processing_deduplicates_filters_and_writes_private_manifested_artifact() {
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;

        let temp = TempDir::new().unwrap();
        let context = context(&temp);
        std::fs::create_dir_all(&context.paths.data_dir).unwrap();
        let input = context.paths.data_dir.join("acquired_jobs_indeed.json");
        std::fs::write(
            &input,
            serde_json::to_string(&json!([
                {"id":"one","title":"Engineer","company":"Acme","url":"https://www.indeed.com/viewjob?jk=one","descriptionText":"short"},
                {"id":"two","title":"Engineer","company":"Acme","url":"https://www.linkedin.com/jobs/view/two","descriptionText":"longer"},
                {"id":"three","title":"Blocked","company":"Nope","url":"https://www.indeed.com/viewjob?jk=three"}
            ]))
            .unwrap(),
        )
        .unwrap();
        let output = context.paths.data_dir.join("processed_jobs.json");
        let result = run(
            &context,
            &ProcessDataOptions {
                input_directory: context.paths.data_dir.clone(),
                input_files: Vec::new(),
                scan_input_directory: true,
                output_file: output.clone(),
                company_filters: Vec::new(),
                title_filters: vec!["blocked".to_string()],
                remote_only: false,
                jobcloth_cool_off_days: 30,
                batch_size: 1000,
                sleep_min_ms: 0,
                sleep_max_ms: 0,
                log_cool_offs: false,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.duplicates_removed, 1);
        assert_eq!(result.filtered_entries, 1);
        let jobs: Vec<JobInterface> =
            serde_json::from_str(&std::fs::read_to_string(&output).unwrap()).unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].id.as_deref(), Some("one"));
        #[cfg(unix)]
        assert_eq!(
            std::fs::metadata(&output).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(output.with_extension("json.manifest.json").exists());
    }
}
