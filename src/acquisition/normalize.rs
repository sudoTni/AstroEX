//! Canonical → legacy job projection. Port of AstroEX-node
//! src/acquisition/normalize.ts.

use super::types::{CanonicalAcquiredJob, DescriptionRepresentation};
use crate::models::JobInterface;

fn location_parts(location: Option<&str>) -> (String, String, String) {
    let parts: Vec<&str> = location
        .unwrap_or("")
        .split(',')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect();
    let city = parts.first().copied().unwrap_or("").to_string();
    let country_text = parts.last().copied().unwrap_or("").to_string();
    (city, country_text, String::new())
}

/// Compatibility projection for existing filtering and LLM commands.
pub fn to_legacy_job(job: &CanonicalAcquiredJob) -> JobInterface {
    let (city, country_text, country_code) = location_parts(job.location.as_deref());
    let date_source = job
        .posted_at
        .as_deref()
        .unwrap_or_else(|| job.acquired_at.as_deref().unwrap_or(""));
    let date = chrono::DateTime::parse_from_rfc3339(date_source)
        .map(|d| d.with_timezone(&chrono::Utc))
        .unwrap_or_else(|_| chrono::Utc::now());
    let description_html =
        if job.description_representation == Some(DescriptionRepresentation::Html) {
            job.description.clone()
        } else {
            None
        };
    let salary_min = job.compensation.as_ref().and_then(|c| c.min_amount);
    let salary_max = job.compensation.as_ref().and_then(|c| c.max_amount);
    let currency = job
        .compensation
        .as_ref()
        .and_then(|c| c.currency.clone())
        .unwrap_or_default();
    // Node uses truthiness: either amount being 0 (or missing) omits the
    // range entirely.
    let salary_range = match (
        job.compensation.as_ref().and_then(|c| c.min_amount),
        job.compensation.as_ref().and_then(|c| c.max_amount),
    ) {
        (Some(min), Some(max)) if min != 0.0 && max != 0.0 => {
            Some(format!("{min}-{max} {currency}").trim().to_string())
        }
        _ => None,
    };
    JobInterface {
        id: Some(job.id.clone()),
        title: Some(job.title.clone()),
        img: Some(job.company_logo.clone().unwrap_or_default()),
        url: job.canonical_url.clone(),
        company_url: Some(job.company_url.clone().unwrap_or_default()),
        date: Some(date.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)[..10].to_string()),
        posted_date: Some(date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        company: Some(job.company.clone()),
        location: Some(job.location.clone().unwrap_or_default()),
        country_code: Some(country_code),
        country_text: Some(country_text),
        description_html,
        description_text: job.description.clone(),
        city: Some(city),
        remote_ok: Some(job.is_remote.unwrap_or(false)),
        salary_min: Some(salary_min.unwrap_or(0.0)),
        salary_max: Some(salary_max.unwrap_or(0.0)),
        salary_currency: Some(if currency.is_empty() {
            "".to_string()
        } else {
            currency.clone()
        }),
        stack_required: Some(Vec::new()),
        applicants: None,
        seniority_level: job.job_level.clone(),
        employment_type: job.job_type.clone(),
        job_function: job.job_function.clone(),
        industries: job.company_industry.clone().map(serde_json::Value::String),
        salary_range,
        posted_time: None,
        source: Some(job.source.clone()),
        source_job_id: job.source_job_id.clone(),
        canonical_url: job.canonical_url.clone(),
        direct_url: job.direct_url.clone(),
        acquired_at: job.acquired_at.clone(),
        is_remote: None,
        is_confirmed_remote: None,
        remote_eval_metadata: None,
        confidence: None,
        rationale: None,
        is_worth_investigating: None,
        is_very_highly_aligned: None,
        is_highly_aligned: None,
        extra: Default::default(),
    }
}
