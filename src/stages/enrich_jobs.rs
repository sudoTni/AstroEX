//! Stage 4: fill missing LinkedIn description and detail fields.

use crate::acquisition::enrichment::fetch_linkedin_job_details;
use crate::acquisition::linkedin_util::extract_job_id_from_url;
use crate::acquisition::types::DescriptionFormat;
use crate::artifact_manifest::{write_artifact_manifest, write_json_atomic_private};
use crate::constants::JOB_DB_RETENTION_MS;
use crate::context::{abortable_delay, RunContext};
use crate::error::Result;
use crate::jobrepo::{JobIdentity, JobRepository, JobRepositoryConfig};
use crate::models::JobInterface;
use crate::types::LogLevel;
use serde::Serialize;
use serde_json::json;
use std::path::PathBuf;
use std::time::Instant;

#[derive(Debug, Clone)]
pub struct EnrichJobsOptions {
    pub input_file: PathBuf,
    pub output_file: PathBuf,
    pub delay_ms: u64,
    pub description_format: DescriptionFormat,
    pub proxies: Vec<String>,
    pub user_agent: Option<String>,
    pub use_jobdb: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichJobsResult {
    pub total_jobs: usize,
    pub enriched_count: usize,
    pub output_file: PathBuf,
}

pub async fn run(ctx: &RunContext, options: &EnrichJobsOptions) -> Result<EnrichJobsResult> {
    let started_at = Instant::now();
    let mut jobs: Vec<JobInterface> =
        serde_json::from_str(&std::fs::read_to_string(&options.input_file)?)?;
    let mut repository = JobRepository::new(JobRepositoryConfig {
        db_file_path: ctx.paths.data_dir.join("jobDB.sqlite"),
        legacy_json_path: Some(ctx.paths.data_dir.join("jobDB.json")),
        default_expiration_ms: Some(JOB_DB_RETENTION_MS as i64),
        enable_job_db: options.use_jobdb,
        max_records: None,
        now: None,
    });
    repository.initialize()?;
    // Node's enrich-jobs handler calls load() then cleanupExpired() when a
    // repository is configured; both are no-ops when JobDB is disabled.
    repository.cleanup_expired()?;
    let targets: Vec<_> = jobs
        .iter()
        .enumerate()
        .filter(|(_, job)| {
            is_linkedin(job)
                && job
                    .description_text
                    .as_deref()
                    .is_none_or(|text| text.trim().is_empty())
        })
        .map(|(index, _)| index)
        .collect();
    let total_to_enrich = targets.len();
    crate::logging::log_kv(
        "EnrichJobs",
        &format!(
            "Stage 4/8: [enrich][linkedin] 0/{total_to_enrich} Starting description enrichment for surviving LinkedIn jobs..."
        ),
        LogLevel::Info,
        &[
            ("totalJobs", json!(jobs.len())),
            ("toEnrich", json!(total_to_enrich)),
        ],
    );
    let show_fetch_url = ctx.display.show_fetch_url;
    let mut enriched_count = 0;
    for (step, index) in targets.iter().enumerate() {
        crate::pipeline::cancellation::throw_if_cancelled(&ctx.cancellation)?;
        if step > 0 && options.delay_ms > 0 {
            abortable_delay(options.delay_ms, &ctx.cancellation).await?;
        }
        let job = &mut jobs[*index];
        let raw_id = job
            .source_job_id
            .as_deref()
            .or(job.id.as_deref())
            .unwrap_or("")
            .trim_start_matches("linkedin:");
        let Some(id) = extract_job_id_from_url(job.url.as_deref().unwrap_or(""))
            .or_else(|| (!raw_id.is_empty()).then(|| raw_id.to_string()))
        else {
            crate::logging::log(
                "EnrichJobs",
                &format!(
                    "Stage 4/8: [enrich][linkedin] {}/{total_to_enrich} Skipping job with unresolvable jobId: \"{}\" at \"{}\"",
                    step + 1,
                    job.title_display(),
                    job.company_display()
                ),
                LogLevel::Warn,
            );
            continue;
        };
        let details = fetch_linkedin_job_details(
            &id,
            &options.proxies,
            options.user_agent.as_deref(),
            options.description_format,
            &ctx.cancellation,
        )
        .await?;
        let title = job.title_display().to_string();
        let company = job.company_display().to_string();
        if details
            .description
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty())
        {
            job.description_text = details.description;
            if let Some(html) = details.description_html.filter(|html| !html.is_empty()) {
                job.description_html = Some(html);
            }
            if details.direct_url.is_some() {
                job.direct_url = details.direct_url;
            }
            // Node gates each optional detail on the target being falsy, so an
            // existing empty string is treated as missing.
            if job.seniority_level.as_deref().is_none_or(str::is_empty) {
                job.seniority_level = details.seniority_level;
            }
            if job.employment_type.as_deref().is_none_or(str::is_empty) {
                job.employment_type = details.employment_type;
            }
            if job.job_function.as_deref().is_none_or(str::is_empty) {
                job.job_function = details.job_function;
            }
            if job
                .industries
                .as_ref()
                .is_none_or(|value| value.is_null() || value.as_str() == Some(""))
            {
                job.industries = details.industries.map(serde_json::Value::String);
            }
            if job.img.as_deref().is_none_or(str::is_empty) {
                job.img = details.img;
            }
            enriched_count += 1;
            // Node counts the enrichment first, then best-effort records the DB
            // checkpoint and downgrades any repository error to a warning.
            if let Err(error) = repository.mark_job_description_scraped(&identity(job)) {
                crate::logging::log(
                    "EnrichJobs",
                    &format!(
                        "Failed to record description scrape checkpoint in JobRepository: {}",
                        error.message
                    ),
                    LogLevel::Warn,
                );
            }
            if show_fetch_url {
                crate::logging::log_kv(
                    "EnrichJobs",
                    &format!(
                        "Stage 4/8: [enrich][linkedin] {}/{total_to_enrich} Enriched \"{title}\" at \"{company}\" url=https://www.linkedin.com/jobs/view/{id}",
                        step + 1
                    ),
                    LogLevel::Info,
                    &[
                        ("step", json!(step + 1)),
                        ("total", json!(total_to_enrich)),
                        ("jobId", json!(id)),
                        ("url", json!(format!("https://www.linkedin.com/jobs/view/{id}"))),
                    ],
                );
            } else {
                crate::logging::log_kv(
                    "EnrichJobs",
                    &format!(
                        "Stage 4/8: [enrich][linkedin] {}/{total_to_enrich} Enriched \"{title}\" at \"{company}\"",
                        step + 1
                    ),
                    LogLevel::Info,
                    &[
                        ("step", json!(step + 1)),
                        ("total", json!(total_to_enrich)),
                        ("jobId", json!(id)),
                    ],
                );
            }
        } else if show_fetch_url {
            crate::logging::log_kv(
                "EnrichJobs",
                &format!(
                    "Stage 4/8: [enrich][linkedin] {}/{total_to_enrich} No description retrieved for \"{title}\" at \"{company}\" (jobId: {id}, url: https://www.linkedin.com/jobs/view/{id})",
                    step + 1
                ),
                LogLevel::Warn,
                &[
                    ("step", json!(step + 1)),
                    ("total", json!(total_to_enrich)),
                    ("jobId", json!(id)),
                    ("url", json!(format!("https://www.linkedin.com/jobs/view/{id}"))),
                ],
            );
        } else {
            crate::logging::log_kv(
                "EnrichJobs",
                &format!(
                    "Stage 4/8: [enrich][linkedin] {}/{total_to_enrich} No description retrieved for \"{title}\" at \"{company}\" (jobId: {id})",
                    step + 1
                ),
                LogLevel::Warn,
                &[
                    ("step", json!(step + 1)),
                    ("total", json!(total_to_enrich)),
                    ("jobId", json!(id)),
                ],
            );
        }
    }
    if let Some(parent) = options.output_file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_json_atomic_private(&options.output_file, &serde_json::to_value(&jobs)?)?;
    write_artifact_manifest(
        &options.output_file,
        "enrichJobs",
        json!({
            "inputFile": options.input_file.file_name().and_then(|name| name.to_str()),
            "totalJobs": jobs.len(),
            "enrichedCount": enriched_count,
            "durationMs": started_at.elapsed().as_millis() as u64,
        }),
    )?;
    repository.close()?;
    crate::logging::log(
        "EnrichJobs",
        &format!(
            "LinkedIn enrichment complete: {enriched_count}/{total_to_enrich} enriched out of {} jobs.",
            jobs.len()
        ),
        LogLevel::Success,
    );
    Ok(EnrichJobsResult {
        total_jobs: jobs.len(),
        enriched_count,
        output_file: options.output_file.clone(),
    })
}

fn is_linkedin(job: &JobInterface) -> bool {
    job.source.as_deref() == Some("linkedin")
        || job
            .url
            .as_deref()
            .is_some_and(|url| url.contains("linkedin.com"))
}
fn identity(job: &JobInterface) -> JobIdentity {
    JobIdentity {
        id: job.id.clone(),
        source: job.source.clone(),
        source_job_id: job.source_job_id.clone(),
        title: job.title.clone().unwrap_or_default(),
        company: job.company.clone().unwrap_or_default(),
        url: job.url.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn linkedin_selection_requires_missing_description() {
        let job = JobInterface {
            source: Some("linkedin".into()),
            ..Default::default()
        };
        assert!(is_linkedin(&job));
    }
}
