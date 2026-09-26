//! Indeed acquisition. Port of AstroEX-node src/acquisition/jobspy/indeed.ts
//! (vendored ts-jobspy Indeed GraphQL mobile client).

use crate::acquisition::http::{description_to_format, JobSpySession};
use crate::acquisition::types::{
    CanonicalAcquiredJob, CanonicalCompensation, CompensationInterval, DescriptionFormat,
    DescriptionRepresentation,
};
use crate::acquisition::{
    build_search_term_completion, build_search_term_progress, AcquisitionQuery,
};
use crate::error::{AppError, Result};
use crate::logging::log_kv;
use crate::types::LogLevel;
use chrono::{SecondsFormat, Utc};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::Duration;

const INDEED_API_URL: &str = "https://apis.indeed.com/graphql";

/// Public Indeed mobile-app client key, extracted from the official Indeed iOS
/// app and already present in any copy of that app. It is NOT a user secret.
///
/// This value is intentionally committed and embedded in the released binary.
/// Users who have their own Indeed API credential should pass it with
/// `--indeed-api-key` (or `AOM_INDEED_API_KEY` via the launcher), which takes
/// precedence at runtime; see `acquire_indeed` below.
const DEFAULT_INDEED_CLIENT_KEY: &str =
    "161092c2017b5bbab13edb12461a62d5a833871e7cad6d9d475304573de67ac8";

const INDEED_USER_AGENT: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Indeed App 193.1";

const INDEED_APP_INFO: &str =
    "appv=193.1; appid=com.indeed.jobsearch; osv=16.6.1; os=ios; dtype=phone";

const QUERY_TEMPLATE: &str = "query AstroOmIndeed { jobSearch({what} {location} limit: 100 {cursor} sort: RELEVANCE {filters}) { pageInfo { nextCursor } results { job { key title datePublished description { html } location { city admin1Code countryCode formatted { long } } compensation { baseSalary { unitOfWork range { ... on Range { min max } } } estimated { currencyCode baseSalary { unitOfWork range { ... on Range { min max } } } } currencyCode } attributes { key label } employer { name relativeCompanyPageUrl dossier { employerDetails { industry } images { squareLogoUrl } links { corporateWebsite } } } recruit { viewJobUrl } } } } }";

/// Map a country alias to its Indeed domain and ISO code (defaults to USA).
fn country_code(country: Option<&str>) -> (&'static str, &'static str) {
    let key = country
        .unwrap_or("usa")
        .to_lowercase()
        .replace(char::is_whitespace, "");
    match key.as_str() {
        "uk" => ("uk", "GB"),
        "canada" => ("ca", "CA"),
        "australia" => ("au", "AU"),
        "india" => ("in", "IN"),
        "germany" => ("de", "DE"),
        "france" => ("fr", "FR"),
        "brazil" => ("br", "BR"),
        "japan" => ("jp", "JP"),
        _ => ("www", "US"),
    }
}

fn escape_graphql(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn job_type_key(job_type: Option<&str>) -> Option<&'static str> {
    match job_type.map(str::to_lowercase).as_deref() {
        Some("fulltime") => Some("CF3CP"),
        Some("parttime") => Some("75GKK"),
        Some("contract") => Some("NJXCK"),
        Some("internship") => Some("VDTG7"),
        _ => None,
    }
}

/// Port of buildIndeedFilters (same strings and mutual-exclusion rules).
pub fn build_indeed_filters(
    hours_old: Option<u32>,
    easy_apply: bool,
    is_remote: bool,
    remote_only: bool,
    job_type: Option<&str>,
) -> Result<String> {
    if let Some(hours) = hours_old {
        if hours == 0 {
            return Err(AppError::message(
                "hoursOld must be greater than zero when supplied",
            ));
        }
        return Ok(format!(
            "filters: {{ date: {{ field: \"dateOnIndeed\", start: \"{hours}h\" }} }}"
        ));
    }
    if remote_only && easy_apply {
        return Err(AppError::message(
            "Indeed remote-only and easy-apply filters cannot be combined without hoursOld",
        ));
    }
    if remote_only {
        let mut remote_keys = vec!["DSQF7"];
        if let Some(key) = job_type_key(job_type) {
            remote_keys.insert(0, key);
        }
        let keys = remote_keys
            .iter()
            .map(|key| format!("\"{key}\""))
            .collect::<Vec<_>>()
            .join(", ");
        return Ok(format!(
            "filters: {{ composite: {{ filters: [{{ keyword: {{ field: \"attributes\", keys: [{keys}]}} }}] }} }}"
        ));
    }
    if easy_apply {
        return Ok(
            "filters: { keyword: { field: \"indeedApplyScope\", keys: [\"DESKTOP\"] } }"
                .to_string(),
        );
    }
    let mut keys = Vec::new();
    if let Some(key) = job_type_key(job_type) {
        keys.push(key);
    }
    if is_remote {
        keys.push("DSQF7");
    }
    if keys.is_empty() {
        return Ok(String::new());
    }
    let joined = keys
        .iter()
        .map(|key| format!("\"{key}\""))
        .collect::<Vec<_>>()
        .join(", ");
    Ok(format!(
        "filters: {{ composite: {{ filters: [{{ keyword: {{ field: \"attributes\", keys: [{joined}]}} }}] }} }}"
    ))
}

fn remote_regex() -> &'static regex::Regex {
    static REMOTE_RE: OnceLock<regex::Regex> = OnceLock::new();
    REMOTE_RE.get_or_init(|| {
        regex::Regex::new(r"(?i)\b(remote|work from home|work-from-home|wfh)\b").unwrap()
    })
}

/// Classify a returned job for strict remote-only validation. The Indeed
/// remote attribute (DSQF7) is authoritative; text matching remains a
/// fallback for date-filtered searches.
pub fn is_indeed_remote_job(job: &Value) -> bool {
    let attributes = job.get("attributes").and_then(|a| a.as_array());
    if let Some(attributes) = attributes {
        if attributes
            .iter()
            .any(|a| a.get("key").and_then(|k| k.as_str()) == Some("DSQF7"))
        {
            return true;
        }
    }
    let mut haystack = String::new();
    if let Some(attributes) = attributes {
        for attribute in attributes {
            haystack.push_str(attribute.get("key").and_then(|v| v.as_str()).unwrap_or(""));
            haystack.push(' ');
            haystack.push_str(
                attribute
                    .get("label")
                    .and_then(|v| v.as_str())
                    .unwrap_or(""),
            );
            haystack.push(' ');
        }
    }
    if let Some(title) = job.get("title").and_then(|v| v.as_str()) {
        haystack.push_str(title);
        haystack.push(' ');
    }
    if let Some(location) = job
        .get("location")
        .and_then(|l| l.get("formatted"))
        .and_then(|f| f.get("long"))
        .and_then(|v| v.as_str())
    {
        haystack.push_str(location);
    }
    remote_regex().is_match(&haystack)
}

/// Map Indeed's unitOfWork to the canonical compensation interval.
fn interval_from_unit(value: Option<&str>) -> Option<CompensationInterval> {
    let normalized = value.map(str::to_lowercase);
    match normalized.as_deref() {
        Some("year") | Some("yearly") | Some("annual") => Some(CompensationInterval::Yearly),
        Some("month") | Some("monthly") => Some(CompensationInterval::Monthly),
        Some("week") | Some("weekly") => Some(CompensationInterval::Weekly),
        Some("day") | Some("daily") => Some(CompensationInterval::Daily),
        Some("hour") | Some("hourly") => Some(CompensationInterval::Hourly),
        _ => None,
    }
}

/// serde_json navigation helper: present-and-non-null lookup.
fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|v| !v.is_null())
}

fn str_field(value: &Value, key: &str) -> Option<String> {
    // Node uses nullish coalescing (`??`): an empty string is preserved, only
    // null/undefined falls through to the default.
    get(value, key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn representation_for(format: DescriptionFormat) -> DescriptionRepresentation {
    match format {
        DescriptionFormat::Markdown => DescriptionRepresentation::Markdown,
        DescriptionFormat::Html => DescriptionRepresentation::Html,
        DescriptionFormat::Plain => DescriptionRepresentation::Plain,
    }
}

pub async fn acquire_indeed(query: &AcquisitionQuery) -> Result<Vec<CanonicalAcquiredJob>> {
    let session = JobSpySession::new(&query.proxies, query.user_agent.as_deref(), false, 0);
    let (domain, country) = country_code(Some(query.indeed_country.as_str()));
    let api_key = query
        .indeed_api_key
        .clone()
        .filter(|key| !key.is_empty())
        .unwrap_or_else(|| DEFAULT_INDEED_CLIENT_KEY.to_string());
    let mut jobs: Vec<CanonicalAcquiredJob> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut cursor: Option<String> = None;
    let wanted = (query.results_wanted + query.offset) as usize;
    let remote_requested = query.remote_only || query.remote;
    let filters = build_indeed_filters(
        query.hours_old,
        query.easy_apply,
        query.remote,
        query.remote_only,
        query.job_type.as_deref(),
    )?;

    let (start_msg, start_pairs) = build_search_term_progress("indeed", query, wanted);
    log_kv("IndeedSearch", &start_msg, LogLevel::Info, &start_pairs);

    let mut page_num = 0u32;
    while jobs.len() < wanted {
        crate::pipeline::cancellation::throw_if_cancelled(&query.token)?;
        page_num += 1;
        let what = if query.search_term.is_empty() {
            String::new()
        } else {
            format!("what: \"{}\"", escape_graphql(&query.search_term))
        };
        let location = if query.location.is_empty() {
            String::new()
        } else {
            format!(
                "location: {{where: \"{}\", radius: {}, radiusUnit: MILES}}",
                escape_graphql(&query.location),
                if query.distance > 0 {
                    query.distance
                } else {
                    50
                }
            )
        };
        let cursor_clause = match &cursor {
            Some(cursor) => format!("cursor: \"{}\"", escape_graphql(cursor)),
            None => String::new(),
        };
        let query_string = QUERY_TEMPLATE
            .replace("{what}", &what)
            .replace("{location}", &location)
            .replace("{cursor}", &cursor_clause)
            .replace("{filters}", &filters);

        let filter_mode = if let Some(hours) = query.hours_old {
            format!("hoursOld:{hours}")
        } else if query.remote_only {
            "remoteOnly:DSQF7".to_string()
        } else if query.easy_apply {
            "easyApply".to_string()
        } else if query.remote {
            "remote:DSQF7".to_string()
        } else if let Some(job_type) = &query.job_type {
            format!("jobType:{job_type}")
        } else {
            "none".to_string()
        };
        if query.show_fetch_url {
            super::log_fetch_url(
                &format!(
                    "[search][indeed] POST {INDEED_API_URL} filter={filter_mode} cursor={}",
                    if cursor.is_some() { "present" } else { "none" }
                ),
                true,
            );
        }

        let headers: Vec<(&str, &str)> = vec![
            ("Host", "apis.indeed.com"),
            ("content-type", "application/json"),
            ("accept", "application/json"),
            ("indeed-locale", "en-US"),
            ("accept-language", "en-US,en;q=0.9"),
            ("user-agent", INDEED_USER_AGENT),
            ("indeed-app-info", INDEED_APP_INFO),
            ("indeed-api-key", api_key.as_str()),
            ("indeed-co", country),
        ];
        let body = serde_json::json!({ "query": query_string }).to_string();
        let response = session
            .post_with_timeout(
                INDEED_API_URL,
                &headers,
                &body,
                Duration::from_secs(10),
                &query.token,
            )
            .await?;
        let payload: Value = response
            .json()
            .await
            .map_err(|e| AppError::message(format!("invalid Indeed response: {e}")))?;
        let search = get(&payload, "data").and_then(|d| get(d, "jobSearch"));
        let results = search
            .and_then(|s| s.get("results"))
            .and_then(|r| r.as_array())
            .cloned()
            .unwrap_or_default();
        if results.is_empty() {
            break;
        }

        let mut page_fetched = 0usize;
        for result in &results {
            let Some(job) = get(result, "job") else {
                continue;
            };
            let key = str_field(job, "key").unwrap_or_default();
            if key.is_empty() || seen.contains(&key) {
                continue;
            }
            let is_remote = is_indeed_remote_job(job);
            if remote_requested && !is_remote {
                continue;
            }
            seen.insert(key.clone());

            let html = job
                .get("description")
                .and_then(|d| d.get("html"))
                .and_then(|h| h.as_str())
                .unwrap_or("")
                .to_string();
            let compensation = get(job, "compensation");
            let base_salary = compensation.and_then(|c| get(c, "baseSalary")).or_else(|| {
                compensation
                    .and_then(|c| get(c, "estimated"))
                    .and_then(|e| get(e, "baseSalary"))
            });
            let compensation = build_compensation(base_salary, compensation);

            let employer = get(job, "employer");
            let location_value = get(job, "location");
            let location = location_value
                .and_then(|l| get(l, "formatted"))
                .and_then(|f| str_field(f, "long"))
                .or_else(|| {
                    let parts = [
                        location_value.and_then(|l| str_field(l, "city")),
                        location_value.and_then(|l| str_field(l, "admin1Code")),
                        location_value.and_then(|l| str_field(l, "countryCode")),
                    ];
                    let joined = parts
                        .iter()
                        .flatten()
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", ");
                    if joined.is_empty() {
                        None
                    } else {
                        Some(joined)
                    }
                });
            let company_url = employer
                .and_then(|e| str_field(e, "relativeCompanyPageUrl"))
                .map(|relative| format!("https://{domain}.indeed.com{relative}"));
            let job_type = job
                .get("attributes")
                .and_then(|a| a.as_array())
                .map(|attributes| {
                    attributes
                        .iter()
                        .filter_map(|a| {
                            a.get("label")
                                .and_then(|l| l.as_str())
                                .filter(|l| !l.is_empty())
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .filter(|joined| !joined.is_empty());
            let company_industry = employer
                .and_then(|e| get(e, "dossier"))
                .and_then(|d| get(d, "employerDetails"))
                .and_then(|details| details.get("industry"))
                .and_then(|i| i.as_str())
                .map(|industry| {
                    industry
                        .replacen("Iv1", "", 1)
                        .replace('_', " ")
                        .trim()
                        .to_string()
                });
            let posted_at = get(job, "datePublished")
                .and_then(|d| d.as_i64())
                .and_then(chrono::DateTime::from_timestamp_millis)
                .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true));

            jobs.push(CanonicalAcquiredJob {
                id: format!("indeed:{key}"),
                source: "indeed".to_string(),
                source_job_id: Some(key.clone()),
                canonical_url: Some(format!("https://{domain}.indeed.com/viewjob?jk={key}")),
                direct_url: job.get("recruit").and_then(|r| str_field(r, "viewJobUrl")),
                title: job
                    .get("title")
                    .and_then(|t| t.as_str())
                    .unwrap_or_default()
                    .to_string(),
                company: employer
                    .and_then(|e| str_field(e, "name"))
                    .unwrap_or_else(|| "Unknown".to_string()),
                company_url,
                location,
                posted_at,
                description: if html.is_empty() {
                    None
                } else {
                    Some(description_to_format(&html, query.description_format))
                },
                description_representation: if html.is_empty() {
                    Some(DescriptionRepresentation::Unknown)
                } else {
                    Some(representation_for(query.description_format))
                },
                is_remote: Some(is_remote),
                job_type,
                job_level: None,
                job_function: None,
                company_industry,
                company_logo: employer
                    .and_then(|e| get(e, "dossier"))
                    .and_then(|d| get(d, "images"))
                    .and_then(|i| str_field(i, "squareLogoUrl")),
                compensation,
                acquired_at: Some(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)),
            });
            page_fetched += 1;
            if jobs.len() >= wanted {
                break;
            }
        }
        if query.show_fetch_url {
            log_kv(
                "IndeedSearch",
                &format!(
                    "[search][indeed] page={page_num} fetched={page_fetched} cumulative={} url={INDEED_API_URL} filter={filter_mode}",
                    jobs.len()
                ),
                LogLevel::Info,
                &[
                    ("page", serde_json::json!(page_num)),
                    ("fetched", serde_json::json!(page_fetched)),
                    ("cumulative", serde_json::json!(jobs.len())),
                    ("url", serde_json::json!(INDEED_API_URL)),
                    ("filterMode", serde_json::json!(filter_mode)),
                ],
            );
        } else {
            log_kv(
                "IndeedSearch",
                &format!(
                    "[search][indeed] page={page_num} fetched={page_fetched} cumulative={}",
                    jobs.len()
                ),
                LogLevel::Info,
                &[
                    ("page", serde_json::json!(page_num)),
                    ("fetched", serde_json::json!(page_fetched)),
                    ("cumulative", serde_json::json!(jobs.len())),
                ],
            );
        }
        cursor = search
            .and_then(|s| get(s, "pageInfo"))
            .and_then(|p| str_field(p, "nextCursor"));
        if cursor.is_none() {
            break;
        }
    }
    let (comp_msg, comp_pairs) =
        build_search_term_completion("indeed", &query.search_term, jobs.len(), wanted);
    log_kv("IndeedSearch", &comp_msg, LogLevel::Info, &comp_pairs);
    Ok(jobs
        .into_iter()
        .skip(query.offset as usize)
        .take(query.results_wanted as usize)
        .collect())
}

/// Prefer baseSalary, else estimated.baseSalary; requires a non-zero min/max
/// range (TS truthiness), currency defaults to USD, source "direct_data".
fn build_compensation(
    base_salary: Option<&Value>,
    compensation: Option<&Value>,
) -> Option<CanonicalCompensation> {
    let range = base_salary.and_then(|b| get(b, "range"));
    let min = range.and_then(|r| r.get("min")).and_then(|v| v.as_f64());
    let max = range.and_then(|r| r.get("max")).and_then(|v| v.as_f64());
    let (min, max) = (min?, max?);
    if min == 0.0 || max == 0.0 {
        return None;
    }
    let currency = compensation
        .and_then(|c| str_field(c, "currencyCode"))
        .or_else(|| {
            compensation
                .and_then(|c| get(c, "estimated"))
                .and_then(|e| str_field(e, "currencyCode"))
        })
        .unwrap_or_else(|| "USD".to_string());
    Some(CanonicalCompensation {
        interval: interval_from_unit(
            base_salary
                .and_then(|b| b.get("unitOfWork"))
                .and_then(|v| v.as_str()),
        ),
        min_amount: Some(min),
        max_amount: Some(max),
        currency: Some(currency),
        source: Some("direct_data".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn country_map() {
        assert_eq!(country_code(Some("usa")), ("www", "US"));
        assert_eq!(country_code(None), ("www", "US"));
        assert_eq!(country_code(Some("UK")), ("uk", "GB"));
        assert_eq!(country_code(Some("canada")), ("ca", "CA"));
        assert_eq!(country_code(Some("australia")), ("au", "AU"));
        assert_eq!(country_code(Some("india")), ("in", "IN"));
        assert_eq!(country_code(Some("germany")), ("de", "DE"));
        assert_eq!(country_code(Some("france")), ("fr", "FR"));
        assert_eq!(country_code(Some("brazil")), ("br", "BR"));
        assert_eq!(country_code(Some("japan")), ("jp", "JP"));
        assert_eq!(country_code(Some(" unknown ")), ("www", "US"));
        assert_eq!(country_code(Some("u k")), ("uk", "GB"));
    }

    #[test]
    fn graphql_escaping() {
        assert_eq!(escape_graphql(r#"plain"#), "plain");
        assert_eq!(escape_graphql(r#"a\b"#), r#"a\\b"#);
        assert_eq!(escape_graphql("say \"hi\""), "say \\\"hi\\\"");
    }

    #[test]
    fn filters_hours_old() {
        assert_eq!(
            build_indeed_filters(Some(24), false, false, false, None).unwrap(),
            "filters: { date: { field: \"dateOnIndeed\", start: \"24h\" } }"
        );
        assert!(build_indeed_filters(Some(0), false, false, false, None).is_err());
    }

    #[test]
    fn filters_remote_only() {
        assert_eq!(
            build_indeed_filters(None, false, false, true, None).unwrap(),
            "filters: { composite: { filters: [{ keyword: { field: \"attributes\", keys: [\"DSQF7\"]} }] } }"
        );
        assert_eq!(
            build_indeed_filters(None, false, false, true, Some("fulltime")).unwrap(),
            "filters: { composite: { filters: [{ keyword: { field: \"attributes\", keys: [\"CF3CP\", \"DSQF7\"]} }] } }"
        );
    }

    #[test]
    fn filters_easy_apply_and_exclusion() {
        assert_eq!(
            build_indeed_filters(None, true, false, false, None).unwrap(),
            "filters: { keyword: { field: \"indeedApplyScope\", keys: [\"DESKTOP\"] } }"
        );
        let err = build_indeed_filters(None, true, false, true, None).unwrap_err();
        assert_eq!(
            err.message,
            "Indeed remote-only and easy-apply filters cannot be combined without hoursOld"
        );
    }

    #[test]
    fn filters_remote_and_job_type() {
        assert_eq!(
            build_indeed_filters(None, false, true, false, Some("fulltime")).unwrap(),
            "filters: { composite: { filters: [{ keyword: { field: \"attributes\", keys: [\"CF3CP\", \"DSQF7\"]} }] } }"
        );
        assert_eq!(
            build_indeed_filters(None, false, true, false, None).unwrap(),
            "filters: { composite: { filters: [{ keyword: { field: \"attributes\", keys: [\"DSQF7\"]} }] } }"
        );
        assert_eq!(
            build_indeed_filters(None, false, false, false, Some("contract")).unwrap(),
            "filters: { composite: { filters: [{ keyword: { field: \"attributes\", keys: [\"NJXCK\"]} }] } }"
        );
        assert_eq!(
            build_indeed_filters(None, false, false, false, None).unwrap(),
            ""
        );
    }

    #[test]
    fn remote_classification() {
        let attribute = serde_json::json!({
            "title": "Software Engineer",
            "attributes": [{ "key": "DSQF7", "label": "Remote" }]
        });
        assert!(is_indeed_remote_job(&attribute));

        let text_only = serde_json::json!({
            "title": "Work From Home Developer",
            "location": { "formatted": { "long": "Austin, TX" } }
        });
        assert!(is_indeed_remote_job(&text_only));

        let onsite = serde_json::json!({
            "title": "Cashier",
            "location": { "formatted": { "long": "Dallas, TX" } }
        });
        assert!(!is_indeed_remote_job(&onsite));
    }

    #[test]
    fn compensation_normalization() {
        let comp = serde_json::json!({
            "baseSalary": { "unitOfWork": "YEAR", "range": { "min": 100000, "max": 120000 } },
            "currencyCode": "USD"
        });
        let salary = build_compensation(Some(&comp["baseSalary"]), Some(&comp)).unwrap();
        assert_eq!(salary.interval, Some(CompensationInterval::Yearly));
        assert_eq!(salary.min_amount, Some(100000.0));
        assert_eq!(salary.max_amount, Some(120000.0));
        assert_eq!(salary.currency, Some("USD".to_string()));
        assert_eq!(salary.source, Some("direct_data".to_string()));

        let estimated = serde_json::json!({
            "estimated": {
                "currencyCode": "EUR",
                "baseSalary": { "unitOfWork": "hour", "range": { "min": 20, "max": 25 } }
            }
        });
        let salary = build_compensation(
            Some(&estimated["estimated"]["baseSalary"]),
            Some(&estimated),
        )
        .unwrap();
        assert_eq!(salary.interval, Some(CompensationInterval::Hourly));
        assert_eq!(salary.currency, Some("EUR".to_string()));

        let missing_max = serde_json::json!({
            "baseSalary": { "unitOfWork": "year", "range": { "min": 100000 } }
        });
        assert!(build_compensation(Some(&missing_max["baseSalary"]), Some(&missing_max)).is_none());

        let zero = serde_json::json!({
            "baseSalary": { "unitOfWork": "year", "range": { "min": 0, "max": 100 } }
        });
        assert!(build_compensation(Some(&zero["baseSalary"]), Some(&zero)).is_none());

        assert_eq!(
            interval_from_unit(Some("ANNUAL")),
            Some(CompensationInterval::Yearly)
        );
        assert_eq!(
            interval_from_unit(Some("monthly")),
            Some(CompensationInterval::Monthly)
        );
        assert_eq!(
            interval_from_unit(Some("WEEK")),
            Some(CompensationInterval::Weekly)
        );
        assert_eq!(
            interval_from_unit(Some("daily")),
            Some(CompensationInterval::Daily)
        );
        assert_eq!(interval_from_unit(None), None);
        assert_eq!(interval_from_unit(Some("fortnight")), None);
    }
}
