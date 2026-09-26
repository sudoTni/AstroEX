//! JobSpy acquisition provider orchestration. Port of AstroEX-node
//! src/acquisition/jobspyProvider.ts. Also carries the IndeedProvider alias.

pub mod enrichment;
pub mod http;
pub mod indeed;
pub mod linkedin;
pub mod linkedin_util;
pub mod markdown;
pub mod normalize;
pub mod types;

use crate::error::{AppError, Result};
use crate::types::LogLevel;
use crate::{logging, logging::console_output};
use tokio_util::sync::CancellationToken;
use types::{CanonicalAcquiredJob, DescriptionFormat, DescriptionRepresentation, Site};

#[derive(Debug, Clone)]
pub struct AcquisitionQuery {
    pub site: Site,
    pub search_term: String,
    pub location: String,
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
    pub offset: u32,
    pub indeed_api_key: Option<String>,
    pub show_fetch_url: bool,
    pub token: CancellationToken,
    pub term_index: Option<usize>,
    pub total_terms: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DescriptionMode {
    None,
    Available,
    Full,
}

impl DescriptionMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_lowercase().as_str() {
            "none" => Some(DescriptionMode::None),
            "available" => Some(DescriptionMode::Available),
            "full" => Some(DescriptionMode::Full),
            _ => None,
        }
    }
}

/// The single supported scraper provider (vendored ts-jobspy port).
pub struct JobSpyAcquisitionProvider;

impl JobSpyAcquisitionProvider {
    pub fn new() -> Self {
        Self
    }

    /// Acquire jobs for one query. Errors carry a `retryable` flag matching
    /// jobspyProvider.ts semantics.
    pub async fn acquire(&self, query: &AcquisitionQuery) -> Result<Vec<CanonicalAcquiredJob>> {
        let include_descriptions = query.description_mode != DescriptionMode::None;
        let result = match query.site {
            Site::Indeed => indeed::acquire_indeed(query).await,
            Site::Linkedin => linkedin::acquire_linkedin(query).await,
        };
        let jobs = match result {
            Ok(jobs) => jobs,
            Err(err) => {
                let retryable = {
                    let re = regex::Regex::new("429|timeout|network|5[0-9][0-9]").unwrap();
                    re.is_match(&err.message.to_lowercase())
                };
                logging::log_kv(
                    "AcquireJobs",
                    &format!("{} acquisition failed: {}", query.site.name(), err.message),
                    LogLevel::Warn,
                    &[
                        ("site", serde_json::json!(query.site.name())),
                        ("retryable", serde_json::json!(retryable)),
                    ],
                );
                return Err(AppError::new(
                    "ACQUISITION_FAILED",
                    if retryable { 503 } else { 400 },
                    format!("{}: {}", query.site.name(), err.message),
                )
                .with_context(serde_json::json!({ "retryable": retryable })));
            }
        };
        let jobs = if include_descriptions {
            jobs
        } else {
            jobs.into_iter()
                .map(|mut job| {
                    job.description = None;
                    job.description_representation = Some(DescriptionRepresentation::Unknown);
                    job
                })
                .collect()
        };
        Ok(jobs)
    }

    /// Acquire from all requested sites in parallel (Promise.all equivalent).
    pub async fn acquire_all(
        &self,
        sites: &[Site],
        query_template: &AcquisitionQuery,
    ) -> Vec<Result<Vec<CanonicalAcquiredJob>>> {
        let mut queries = Vec::new();
        for site in sites {
            let mut query = query_template.clone();
            query.site = *site;
            queries.push(query);
        }
        let mut joined = Vec::new();
        for query in &queries {
            joined.push(self.acquire(query).await);
        }
        joined
    }
}

impl Default for JobSpyAcquisitionProvider {
    fn default() -> Self {
        Self::new()
    }
}

/// Backwards-compatibility alias used by the Node codebase.
pub type IndeedProvider = JobSpyAcquisitionProvider;

/// Format an external fetch URL when --show-fetch-url is enabled.
pub fn log_fetch_url(url: &str, show: bool) {
    if show {
        console_output::write_stdout_line(url);
    }
}

/// Format the progress message and context pairs when a search term begins or changes.
pub fn build_search_term_progress(
    site_tag: &str,
    query: &AcquisitionQuery,
    target: usize,
) -> (String, Vec<(&'static str, serde_json::Value)>) {
    let term_progress_str = match (query.term_index, query.total_terms) {
        (Some(idx), Some(total)) => format!(" (term {idx}/{total})"),
        (Some(idx), None) => format!(" (term {idx})"),
        _ => String::new(),
    };
    let location_str = if query.location.is_empty() {
        String::new()
    } else {
        format!(" location=\"{}\"", query.location)
    };
    let message = format!(
        "[search][{site_tag}] searchTerm=\"{}\"{location_str}{term_progress_str} target={target}",
        query.search_term
    );

    let mut pairs = vec![
        ("searchTerm", serde_json::json!(query.search_term)),
        ("target", serde_json::json!(target)),
    ];
    if let Some(idx) = query.term_index {
        pairs.push(("termIndex", serde_json::json!(idx)));
    }
    if let Some(total) = query.total_terms {
        pairs.push(("totalTerms", serde_json::json!(total)));
    }
    if !query.location.is_empty() {
        pairs.push(("location", serde_json::json!(query.location)));
    }

    (message, pairs)
}

/// Format the progress message and context pairs when a search term completes.
pub fn build_search_term_completion(
    site_tag: &str,
    search_term: &str,
    fetched: usize,
    target: usize,
) -> (String, Vec<(&'static str, serde_json::Value)>) {
    let message = format!(
        "[search][{site_tag}] searchTerm=\"{search_term}\" complete: fetched={fetched} cumulative={fetched}"
    );
    let pairs = vec![
        ("searchTerm", serde_json::json!(search_term)),
        ("fetched", serde_json::json!(fetched)),
        ("cumulative", serde_json::json!(fetched)),
        ("target", serde_json::json!(target)),
    ];
    (message, pairs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_query(
        term: &str,
        location: &str,
        term_index: Option<usize>,
        total_terms: Option<usize>,
    ) -> AcquisitionQuery {
        AcquisitionQuery {
            site: Site::Indeed,
            search_term: term.to_string(),
            location: location.to_string(),
            results_wanted: 50,
            distance: 25,
            hours_old: None,
            remote: false,
            remote_only: false,
            job_type: None,
            easy_apply: false,
            indeed_country: "us".to_string(),
            description_mode: DescriptionMode::None,
            description_format: DescriptionFormat::Plain,
            proxies: Vec::new(),
            user_agent: None,
            offset: 0,
            indeed_api_key: None,
            show_fetch_url: false,
            token: CancellationToken::new(),
            term_index,
            total_terms,
        }
    }

    #[test]
    fn search_term_progress_with_index_and_location() {
        let q = sample_query("DevSecOps Engineer", "Remote", Some(2), Some(8));
        let (msg, pairs) = build_search_term_progress("indeed", &q, 50);
        assert_eq!(
            msg,
            "[search][indeed] searchTerm=\"DevSecOps Engineer\" location=\"Remote\" (term 2/8) target=50"
        );
        let map: std::collections::HashMap<_, _> = pairs.into_iter().collect();
        assert_eq!(map.get("searchTerm").unwrap(), "DevSecOps Engineer");
        assert_eq!(map.get("location").unwrap(), "Remote");
        assert_eq!(map.get("termIndex").unwrap(), &serde_json::json!(2));
        assert_eq!(map.get("totalTerms").unwrap(), &serde_json::json!(8));
        assert_eq!(map.get("target").unwrap(), &serde_json::json!(50));
    }

    #[test]
    fn search_term_progress_without_location_or_index() {
        let q = sample_query("Software Engineer", "", None, None);
        let (msg, pairs) = build_search_term_progress("linkedin", &q, 20);
        assert_eq!(
            msg,
            "[search][linkedin] searchTerm=\"Software Engineer\" target=20"
        );
        let map: std::collections::HashMap<_, _> = pairs.into_iter().collect();
        assert_eq!(map.get("searchTerm").unwrap(), "Software Engineer");
        assert!(!map.contains_key("location"));
        assert!(!map.contains_key("termIndex"));
        assert!(!map.contains_key("totalTerms"));
        assert_eq!(map.get("target").unwrap(), &serde_json::json!(20));
    }

    #[test]
    fn search_term_completion_formatting() {
        let (msg, pairs) =
            build_search_term_completion("indeed", "Site Reliability Engineer", 54, 50);
        assert_eq!(
            msg,
            "[search][indeed] searchTerm=\"Site Reliability Engineer\" complete: fetched=54 cumulative=54"
        );
        let map: std::collections::HashMap<_, _> = pairs.into_iter().collect();
        assert_eq!(map.get("searchTerm").unwrap(), "Site Reliability Engineer");
        assert_eq!(map.get("fetched").unwrap(), &serde_json::json!(54));
        assert_eq!(map.get("cumulative").unwrap(), &serde_json::json!(54));
        assert_eq!(map.get("target").unwrap(), &serde_json::json!(50));
    }
}
