//! LinkedIn guest-search job scraping. Port of AstroEX-node
//! src/acquisition/jobspy/linkedin.ts.

use super::http::JobSpySession;
use super::linkedin_util::{
    element_attr_or, extract_job_id_from_url, has_url_scheme, is_onsite_text, is_remote_text,
    job_type_code, linkedin_headers, parse_salary_info, parse_salary_interval,
};
use super::types::{CanonicalAcquiredJob, CanonicalCompensation, DescriptionRepresentation};
use super::{
    build_search_term_completion, build_search_term_progress, log_fetch_url, AcquisitionQuery,
};
use crate::context::abortable_delay;
use crate::error::{AppError, Result};
use crate::logging;
use crate::pipeline::cancellation::throw_if_cancelled;
use crate::types::LogLevel;
use rand::Rng;
use scraper::{ElementRef, Html, Selector};
use std::collections::HashSet;
use tokio_util::sync::CancellationToken;

const SEARCH_URL: &str = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const PAGE_DELAY_MS: u64 = 1000;
const PAGE_JITTER_MS: u64 = 500;
const MAX_START: u32 = 1000;

pub async fn acquire_linkedin(query: &AcquisitionQuery) -> Result<Vec<CanonicalAcquiredJob>> {
    let session = JobSpySession::new(&query.proxies, query.user_agent.as_deref(), true, 3);
    let headers = linkedin_headers(query.user_agent.as_deref());
    let remote_filter = query.remote || query.remote_only;
    let location = if query.location.is_empty() {
        None
    } else {
        Some(query.location.as_str())
    };

    let mut jobs: Vec<CanonicalAcquiredJob> = Vec::new();
    let mut seen_ids: HashSet<String> = HashSet::new();
    let (mut start, skip) = page_window(query.offset);
    let results_wanted = query.results_wanted as usize;
    let target_count = results_wanted + skip;
    let mut page_num: u32 = 0;

    let continue_search =
        |jobs: &[CanonicalAcquiredJob], start: u32| jobs.len() < target_count && start < MAX_START;

    let (start_msg, start_pairs) = build_search_term_progress("linkedin", query, results_wanted);
    logging::log_kv("LinkedInSearch", &start_msg, LogLevel::Info, &start_pairs);

    while continue_search(&jobs, start) {
        throw_if_cancelled(&query.token)?;
        page_num += 1;

        let url = build_search_url(query, location, start);
        log_fetch_url(&url, query.show_fetch_url);

        let html = match fetch_search_page(&session, &url, &headers, &query.token).await {
            Ok(html) => html,
            Err(err) => {
                logging::log_kv(
                    "LinkedInSearch",
                    &format!(
                        "LinkedIn search request failed on page {}: {}",
                        page_num, err.message
                    ),
                    LogLevel::Warn,
                    &[
                        ("page", serde_json::json!(page_num)),
                        ("error", serde_json::json!(err.message)),
                    ],
                );
                if jobs.is_empty() {
                    return Err(err);
                }
                break;
            }
        };

        let document = Html::parse_document(&html);
        let cards: Vec<ElementRef> = document
            .select(&selector("div.base-search-card, li.base-search-card"))
            .collect();

        if cards.is_empty() {
            logging::log(
                "LinkedInSearch",
                &format!(
                    "[search][linkedin] No job cards found on page {page_num}, ending search."
                ),
                LogLevel::Debug,
            );
            break;
        }

        let mut page_fetched = 0usize;
        let mut new_cards_on_page = 0usize;
        for card in &cards {
            let Some(job_id) = card_job_id(*card) else {
                continue;
            };
            if seen_ids.contains(&job_id) {
                continue;
            }
            seen_ids.insert(job_id.clone());
            new_cards_on_page += 1;

            let Some(job) = build_card_job(*card, &job_id, remote_filter) else {
                continue;
            };
            jobs.push(job);
            page_fetched += 1;

            if !continue_search(&jobs, start) {
                break;
            }
        }

        let mut message = format!(
            "[search][linkedin] page={} fetched={} cumulative={}",
            page_num,
            page_fetched,
            jobs.len()
        );
        let mut pairs = vec![
            ("page", serde_json::json!(page_num)),
            ("fetched", serde_json::json!(page_fetched)),
            ("cumulative", serde_json::json!(jobs.len())),
        ];
        if query.show_fetch_url {
            message.push_str(&format!(" url={url}"));
            pairs.push(("url", serde_json::json!(url)));
        }
        logging::log_kv("LinkedInSearch", &message, LogLevel::Info, &pairs);

        if new_cards_on_page == 0 {
            logging::log(
                "LinkedInSearch",
                &format!(
                    "[search][linkedin] All cards on page {page_num} were already seen; ending search."
                ),
                LogLevel::Debug,
            );
            break;
        }

        if continue_search(&jobs, start) {
            start += cards.len() as u32;
            let jitter = rand::thread_rng().gen_range(0..PAGE_JITTER_MS);
            abortable_delay(PAGE_DELAY_MS + jitter, &query.token).await?;
        }
    }

    let (comp_msg, comp_pairs) =
        build_search_term_completion("linkedin", &query.search_term, jobs.len(), results_wanted);
    logging::log_kv("LinkedInSearch", &comp_msg, LogLevel::Info, &comp_pairs);

    Ok(jobs.into_iter().skip(skip).take(results_wanted).collect())
}

/// Offset aligned down to a multiple of 10, plus the number of leading
/// results to skip on the first page.
fn page_window(offset: u32) -> (u32, usize) {
    let start = (offset / 10) * 10;
    (start, (offset - start) as usize)
}

fn build_search_url(query: &AcquisitionQuery, location: Option<&str>, start: u32) -> String {
    let mut params: Vec<(&str, String)> = vec![("keywords", query.search_term.clone())];
    if let Some(location) = location {
        params.push(("location", location.to_string()));
        params.push(("distance", query.distance.to_string()));
    }
    if query.remote || query.remote_only {
        params.push(("f_WT", "2".to_string()));
    }
    let job_type = job_type_code(query.job_type.as_deref());
    if !job_type.is_empty() {
        params.push(("f_JT", job_type.to_string()));
    }
    params.push(("pageNum", "0".to_string()));
    params.push(("start", start.to_string()));
    if query.easy_apply {
        params.push(("f_AL", "true".to_string()));
    }
    if let Some(hours_old) = query.hours_old.filter(|hours| *hours > 0) {
        params.push(("f_TPR", format!("r{}", hours_old as u64 * 3600)));
    }
    params.retain(|(_, value)| !value.is_empty());
    reqwest::Url::parse_with_params(SEARCH_URL, &params)
        .expect("valid search URL")
        .to_string()
}

async fn fetch_search_page(
    session: &JobSpySession,
    url: &str,
    headers: &[(&str, &str)],
    token: &CancellationToken,
) -> Result<String> {
    let response = session.get(url, headers, token).await?;
    let status = response.status().as_u16();
    if !(200..400).contains(&status) {
        return Err(AppError::message(format!(
            "LinkedIn responded with HTTP {status}"
        )));
    }
    let body = response
        .text()
        .await
        .map_err(|err| AppError::message(err.to_string()))?;
    Ok(body)
}

fn selector(css: &str) -> Selector {
    Selector::parse(css).expect("valid selector")
}

fn element_text(element: ElementRef) -> String {
    element.text().collect::<String>().trim().to_string()
}

fn card_job_id(card: ElementRef) -> Option<String> {
    card.select(&selector("a.base-card__full-link"))
        .next()
        .and_then(|link| link.value().attr("href"))
        .and_then(extract_job_id_from_url)
}

/// Drop the query string from an absolute company URL (TS `urlObj.search = ""`).
fn strip_url_query(url: &str) -> Option<String> {
    if !has_url_scheme(url) {
        return None;
    }
    let (before_fragment, fragment) = match url.find('#') {
        Some(index) => (&url[..index], &url[index..]),
        None => (url, ""),
    };
    let base = match before_fragment.find('?') {
        Some(index) => &before_fragment[..index],
        None => before_fragment,
    };
    Some(format!("{base}{fragment}"))
}

fn parse_datetime(value: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    if let Ok(datetime) = chrono::DateTime::parse_from_rfc3339(value) {
        return Some(datetime.with_timezone(&chrono::Utc));
    }
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .map(|naive| chrono::TimeZone::from_utc_datetime(&chrono::Utc, &naive))
}

/// Build a canonical job from one search card. None when the f_WT=2
/// defense-in-depth onsite filter rejects the card.
fn build_card_job(
    card: ElementRef,
    job_id: &str,
    remote_filter: bool,
) -> Option<CanonicalAcquiredJob> {
    let title = card
        .select(&selector("span.sr-only, h3.base-search-card__title"))
        .next()
        .map(element_text)
        .unwrap_or_default();
    let title = if title.is_empty() {
        "Untitled".to_string()
    } else {
        title
    };

    let subtitle = card
        .select(&selector("h4.base-search-card__subtitle"))
        .next();
    let company_link = subtitle.and_then(|s| s.select(&selector("a")).next());
    let company_url = company_link
        .and_then(|link| link.value().attr("href"))
        .and_then(strip_url_query);
    let company = match company_link {
        Some(link) => element_text(link),
        None => subtitle.map(element_text).unwrap_or_default(),
    };
    let company = if company.is_empty() {
        "Unknown".to_string()
    } else {
        company
    };

    let location = card
        .select(&selector("span.job-search-card__location"))
        .next()
        .map(element_text)
        .filter(|text| !text.is_empty());

    let posted_at = card
        .select(&selector("time.job-search-card__listdate"))
        .next()
        .or_else(|| {
            card.select(&selector("time.job-search-card__listdate--new"))
                .next()
        })
        .and_then(|time| time.value().attr("datetime"))
        .and_then(parse_datetime)
        .map(|datetime| datetime.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));

    let compensation = card
        .select(&selector("span.job-search-card__salary-info"))
        .next()
        .map(element_text)
        .filter(|text| !text.is_empty())
        .and_then(|text| {
            parse_salary_info(&text).map(|(min_amount, max_amount, currency)| {
                CanonicalCompensation {
                    interval: parse_salary_interval(&text),
                    min_amount: Some(min_amount),
                    max_amount: Some(max_amount),
                    currency: Some(currency),
                    source: Some("direct_data".to_string()),
                }
            })
        });

    let company_logo = card
        .select(&selector("img.artdeco-entity-image"))
        .next()
        .and_then(|img| element_attr_or(img, &["data-delayed-url", "data-ghost-url", "src"]));

    let combined = format!("{} {}", title, location.as_deref().unwrap_or(""));
    let is_remote = if remote_filter {
        if is_onsite_text(&combined) {
            return None;
        }
        true
    } else {
        is_remote_text(&combined)
    };

    Some(CanonicalAcquiredJob {
        id: format!("linkedin:{job_id}"),
        source: "linkedin".to_string(),
        source_job_id: Some(job_id.to_string()),
        canonical_url: Some(format!("https://www.linkedin.com/jobs/view/{job_id}")),
        direct_url: None,
        title,
        company,
        company_url,
        location,
        posted_at,
        description: None,
        description_representation: Some(DescriptionRepresentation::Unknown),
        is_remote: Some(is_remote),
        job_type: None,
        job_level: None,
        job_function: None,
        company_industry: None,
        company_logo,
        compensation,
        acquired_at: Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    })
}

/// Parse one page of search cards (no cross-page dedup); test helper.
#[allow(dead_code)] // retained as the fixture-level parser alongside the paginated client
fn parse_search_page(html: &str, remote_filter: bool) -> Vec<CanonicalAcquiredJob> {
    let document = Html::parse_document(html);
    document
        .select(&selector("div.base-search-card, li.base-search-card"))
        .filter_map(|card| {
            card_job_id(card).and_then(|job_id| build_card_job(card, &job_id, remote_filter))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acquisition::types::{CompensationInterval, DescriptionFormat, Site};

    const SEARCH_HTML: &str = r#"
        <div class="base-search-card">
            <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/staff-security-engineer-4198765432?position=1"></a>
            <span class="sr-only">Staff Security Engineer</span>
            <h4 class="base-search-card__subtitle">
                <a href="https://www.linkedin.com/company/guard-corp?trk=public_jobs">Guard Corp</a>
            </h4>
            <span class="job-search-card__location">Remote, United States</span>
            <time class="job-search-card__listdate" datetime="2026-09-08">2 days ago</time>
            <span class="job-search-card__salary-info">$180,000 - $220,000 / yr</span>
        </div>
        <div class="base-search-card">
            <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/onsite-analyst-4198765433"></a>
            <h3 class="base-search-card__title">Onsite Analyst</h3>
            <h4 class="base-search-card__subtitle">Local Bank</h4>
            <span class="job-search-card__location">Dallas, TX</span>
        </div>
    "#;

    #[test]
    fn parses_guest_search_cards_into_canonical_jobs() {
        let jobs = parse_search_page(SEARCH_HTML, false);
        assert_eq!(jobs.len(), 2);
        let first = &jobs[0];
        assert_eq!(first.id, "linkedin:4198765432");
        assert_eq!(first.source, "linkedin");
        assert_eq!(first.source_job_id.as_deref(), Some("4198765432"));
        assert_eq!(first.title, "Staff Security Engineer");
        assert_eq!(first.company, "Guard Corp");
        assert_eq!(
            first.company_url.as_deref(),
            Some("https://www.linkedin.com/company/guard-corp")
        );
        assert_eq!(first.location.as_deref(), Some("Remote, United States"));
        assert_eq!(
            first.canonical_url.as_deref(),
            Some("https://www.linkedin.com/jobs/view/4198765432")
        );
        assert_eq!(first.is_remote, Some(true));
        assert!(first
            .posted_at
            .as_deref()
            .unwrap_or("")
            .starts_with("2026-09-08"));
        assert!(first.acquired_at.is_some());
        let compensation = first.compensation.as_ref().unwrap();
        assert_eq!(compensation.min_amount, Some(180000.0));
        assert_eq!(compensation.max_amount, Some(220000.0));
        assert_eq!(compensation.currency.as_deref(), Some("USD"));
        assert_eq!(compensation.interval, Some(CompensationInterval::Yearly));
        assert_eq!(compensation.source.as_deref(), Some("direct_data"));
        assert_eq!(first.description, None);
        assert_eq!(
            first.description_representation,
            Some(DescriptionRepresentation::Unknown)
        );
        let second = &jobs[1];
        assert_eq!(second.title, "Onsite Analyst");
        assert_eq!(second.company, "Local Bank");
        assert_eq!(second.company_url, None);
        assert_eq!(second.location.as_deref(), Some("Dallas, TX"));
        assert_eq!(second.is_remote, Some(false));
        assert!(second.compensation.is_none());
    }

    #[test]
    fn remote_filter_skips_onsite_cards() {
        let jobs = parse_search_page(SEARCH_HTML, true);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].id, "linkedin:4198765432");
        assert_eq!(jobs[0].is_remote, Some(true));
    }

    #[test]
    fn parses_li_cards_logos_and_defaults() {
        let html = r#"
            <li class="base-search-card">
                <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/data-engineer-1234567890"></a>
                <img class="artdeco-entity-image" data-delayed-url="https://media.licdn.com/logo.png" src="fallback.png" />
            </li>
        "#;
        let jobs = parse_search_page(html, false);
        assert_eq!(jobs.len(), 1);
        let job = &jobs[0];
        assert_eq!(job.title, "Untitled");
        assert_eq!(job.company, "Unknown");
        assert_eq!(
            job.company_logo.as_deref(),
            Some("https://media.licdn.com/logo.png")
        );
        assert_eq!(job.location, None);
    }

    #[test]
    fn new_date_fallback_uses_listdate_new() {
        let html = r#"
            <div class="base-search-card">
                <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/9876543210"></a>
                <time class="job-search-card__listdate--new" datetime="2026-09-01">1 week ago</time>
            </div>
        "#;
        let jobs = parse_search_page(html, false);
        assert_eq!(jobs.len(), 1);
        assert!(jobs[0]
            .posted_at
            .as_deref()
            .unwrap_or("")
            .starts_with("2026-09-01"));
    }

    fn test_query() -> AcquisitionQuery {
        AcquisitionQuery {
            site: Site::Linkedin,
            search_term: "security".to_string(),
            location: "New York".to_string(),
            results_wanted: 10,
            distance: 25,
            hours_old: Some(24),
            remote: false,
            remote_only: true,
            job_type: Some("full-time".to_string()),
            easy_apply: true,
            indeed_country: String::new(),
            description_mode: crate::acquisition::DescriptionMode::None,
            description_format: DescriptionFormat::Markdown,
            proxies: Vec::new(),
            user_agent: None,
            offset: 0,
            indeed_api_key: None,
            show_fetch_url: false,
            token: CancellationToken::new(),
            term_index: None,
            total_terms: None,
        }
    }

    #[test]
    fn builds_search_url_with_all_filters() {
        let query = test_query();
        let url = build_search_url(&query, Some("New York"), 0);
        assert!(url.starts_with(
            "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?"
        ));
        assert!(url.contains("keywords=security"));
        assert!(url.contains("location=New+York"));
        assert!(url.contains("distance=25"));
        assert!(url.contains("f_WT=2"));
        assert!(url.contains("f_JT=F"));
        assert!(url.contains("pageNum=0"));
        assert!(url.contains("start=0"));
        assert!(url.contains("f_AL=true"));
        assert!(url.contains("f_TPR=r86400"));
    }

    #[test]
    fn builds_search_url_without_optional_filters() {
        let mut query = test_query();
        query.location = String::new();
        query.remote = false;
        query.remote_only = false;
        query.job_type = None;
        query.easy_apply = false;
        query.hours_old = Some(0);
        let url = build_search_url(&query, None, 30);
        assert!(!url.contains("f_WT"));
        assert!(!url.contains("f_JT"));
        assert!(!url.contains("f_AL"));
        assert!(!url.contains("f_TPR"));
        assert!(!url.contains("distance"));
        assert!(!url.contains("location"));
        assert!(url.contains("start=30"));
    }

    #[test]
    fn page_window_aligns_offset_to_multiples_of_ten() {
        assert_eq!(page_window(0), (0, 0));
        assert_eq!(page_window(5), (0, 5));
        assert_eq!(page_window(23), (20, 3));
        assert_eq!(page_window(40), (40, 0));
    }

    #[test]
    fn strip_url_query_removes_search_params() {
        assert_eq!(
            strip_url_query("https://www.linkedin.com/company/foo?trk=public_jobs&ok=1").as_deref(),
            Some("https://www.linkedin.com/company/foo")
        );
        assert_eq!(
            strip_url_query("https://www.linkedin.com/company/foo").as_deref(),
            Some("https://www.linkedin.com/company/foo")
        );
        assert_eq!(strip_url_query("/relative/company/foo"), None);
    }
}
