//! LinkedIn job-detail (description) enrichment. Port of AstroEX-node
//! src/acquisition/jobspy/linkedinEnrichment.ts.

use super::http::{description_to_format, JobSpySession};
use super::linkedin_util::{element_attr_or, linkedin_headers, percent_decode};
use super::types::DescriptionFormat;
use crate::error::Result;
use crate::logging;
use crate::pipeline::cancellation::throw_if_cancelled;
use crate::types::LogLevel;
use regex::Regex;
use scraper::{Html, Selector};
use std::sync::OnceLock;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct LinkedInJobDetails {
    pub description: Option<String>,
    pub description_html: Option<String>,
    pub direct_url: Option<String>,
    pub seniority_level: Option<String>,
    pub employment_type: Option<String>,
    pub job_function: Option<String>,
    /// Raw criteria text, matching Node's `companyIndustry` (a string).
    pub industries: Option<String>,
    pub img: Option<String>,
}

/// Fetch the guest job-detail page for one LinkedIn job. Auth-wall redirects
/// and fetch failures yield empty details (no error), matching the Node port.
pub async fn fetch_linkedin_job_details(
    job_id: &str,
    proxies: &[String],
    user_agent: Option<&str>,
    description_format: DescriptionFormat,
    token: &CancellationToken,
) -> Result<LinkedInJobDetails> {
    throw_if_cancelled(token)?;
    let session = JobSpySession::new(proxies, user_agent, true, 2);
    let headers = linkedin_headers(user_agent);
    let url = format!("https://www.linkedin.com/jobs/view/{job_id}");

    let response = match session.get(&url, &headers, token).await {
        Ok(response) => response,
        Err(err) => {
            logging::log_kv(
                "LinkedInEnrichment",
                &format!(
                    "Failed to fetch job details for LinkedIn job {job_id}: {}",
                    err.message
                ),
                LogLevel::Warn,
                &[
                    ("jobId", serde_json::json!(job_id)),
                    ("error", serde_json::json!(err.message)),
                ],
            );
            return Ok(LinkedInJobDetails::default());
        }
    };

    let status = response.status().as_u16();
    if !(200..400).contains(&status) {
        logging::log_kv(
            "LinkedInEnrichment",
            &format!("LinkedIn detail fetch returned HTTP {status} for job {job_id}"),
            LogLevel::Warn,
            &[
                ("jobId", serde_json::json!(job_id)),
                ("status", serde_json::json!(status)),
            ],
        );
        return Ok(LinkedInJobDetails::default());
    }

    let response_url = response.url().to_string();
    if is_auth_wall_url(&response_url) {
        logging::log_kv(
            "LinkedInEnrichment",
            &format!(
                "LinkedIn job details for {job_id} blocked by login/signup redirect: {response_url}"
            ),
            LogLevel::Warn,
            &[
                ("jobId", serde_json::json!(job_id)),
                ("responseUrl", serde_json::json!(response_url)),
            ],
        );
        return Ok(LinkedInJobDetails::default());
    }

    let body = match response.text().await {
        Ok(body) => body,
        Err(err) => {
            logging::log_kv(
                "LinkedInEnrichment",
                &format!("Failed to read job details body for LinkedIn job {job_id}: {err}"),
                LogLevel::Warn,
                &[("jobId", serde_json::json!(job_id))],
            );
            return Ok(LinkedInJobDetails::default());
        }
    };

    Ok(parse_details_html(&body, description_format))
}

/// True when a response URL is a LinkedIn login/signup/authwall page.
pub fn is_auth_wall_url(url: &str) -> bool {
    url.contains("linkedin.com/signup")
        || url.contains("linkedin.com/login")
        || url.contains("linkedin.com/authwall")
}

fn selector(css: &str) -> Selector {
    Selector::parse(css).expect("valid selector")
}

fn element_text(element: scraper::ElementRef) -> String {
    element.text().collect::<String>().trim().to_string()
}

/// cheerio `find("script, style").remove()` equivalent over an HTML fragment.
fn strip_script_style(html: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?is)<script\b[^>]*>.*?</script>|<style\b[^>]*>.*?</style>").unwrap()
    })
    .replace_all(html, "")
    .into_owned()
}

/// `code#applyUrl` extraction: capture after `?url=`, percent-decode, trim
/// trailing `->…` artifacts left by the surrounding HTML comment.
fn extract_direct_url(document: &Html) -> Option<String> {
    let content = document
        .select(&selector("code#applyUrl"))
        .next()?
        .inner_html();
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r#"\?url=([^"'\s<]+)"#).unwrap());
    let raw = re.captures(&content)?.get(1)?.as_str();
    let decoded = percent_decode(raw, true).unwrap_or_else(|| raw.to_string());
    Some(trim_apply_url_artifacts(&decoded))
}

fn trim_apply_url_artifacts(url: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"-+>.*$").unwrap())
        .replace(url, "")
        .trim()
        .to_string()
}

fn parse_criteria(document: &Html) -> LinkedInJobDetails {
    let mut details = LinkedInJobDetails::default();
    for item in document.select(&selector("li.description__job-criteria-item")) {
        let header = item
            .select(&selector("h3.description__job-criteria-subheader"))
            .next()
            .map(element_text)
            .map(|text| text.to_lowercase())
            .unwrap_or_default();
        let text = item
            .select(&selector("span.description__job-criteria-text"))
            .next()
            .map(element_text)
            .unwrap_or_default();
        if text.is_empty() {
            continue;
        }
        if header.contains("seniority") {
            details.seniority_level = Some(text);
        } else if header.contains("employment") {
            details.employment_type = Some(text);
        } else if header.contains("function") {
            details.job_function = Some(text);
        } else if header.contains("industries") {
            details.industries = Some(text);
        }
    }
    details
}

pub fn parse_details_html(html: &str, format: DescriptionFormat) -> LinkedInJobDetails {
    let document = Html::parse_document(html);
    let cleaned = document
        .select(&selector("div.show-more-less-html__markup"))
        .next()
        .map(|markup| strip_script_style(&markup.inner_html()));
    let description = cleaned
        .as_deref()
        .map(|cleaned| description_to_format(cleaned, format));
    let criteria = parse_criteria(&document);
    LinkedInJobDetails {
        description,
        description_html: cleaned,
        direct_url: extract_direct_url(&document),
        seniority_level: criteria.seniority_level,
        employment_type: criteria.employment_type,
        job_function: criteria.job_function,
        industries: criteria.industries,
        img: document
            .select(&selector("img.artdeco-entity-image"))
            .next()
            .and_then(|img| element_attr_or(img, &["data-delayed-url", "data-ghost-url", "src"])),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acquisition::types::DescriptionFormat;

    const DETAIL_HTML: &str = r#"
        <div class="show-more-less-html__markup">
            <h2>About the Role</h2>
            <p>We are seeking a senior security engineer to secure our cloud infrastructure.</p>
            <ul>
                <li>5+ years Kubernetes experience</li>
                <li>Terraform knowledge</li>
            </ul>
        </div>
        <code id="applyUrl"><!--https://careers.acme.com/apply?url=https%3A%2F%2Fboards.greenhouse.io%2Facme%2Fjobs%2F987654--></code>
        <ul>
            <li class="description__job-criteria-item">
                <h3 class="description__job-criteria-subheader">Seniority level</h3>
                <span class="description__job-criteria-text">Mid-Senior level</span>
            </li>
            <li class="description__job-criteria-item">
                <h3 class="description__job-criteria-subheader">Employment type</h3>
                <span class="description__job-criteria-text">Full-time</span>
            </li>
            <li class="description__job-criteria-item">
                <h3 class="description__job-criteria-subheader">Job function</h3>
                <span class="description__job-criteria-text">Engineering</span>
            </li>
            <li class="description__job-criteria-item">
                <h3 class="description__job-criteria-subheader">Industries</h3>
                <span class="description__job-criteria-text">Software Development</span>
            </li>
        </ul>
    "#;

    #[test]
    fn parses_description_direct_url_and_criteria() {
        let details = parse_details_html(DETAIL_HTML, DescriptionFormat::Markdown);
        let description = details.description.as_deref().unwrap_or_default();
        assert!(description.contains("About the Role"));
        assert!(description.contains("Kubernetes"));
        assert_eq!(
            details.direct_url.as_deref(),
            Some("https://boards.greenhouse.io/acme/jobs/987654")
        );
        assert_eq!(details.seniority_level.as_deref(), Some("Mid-Senior level"));
        assert_eq!(details.employment_type.as_deref(), Some("Full-time"));
        assert_eq!(details.job_function.as_deref(), Some("Engineering"));
        assert_eq!(details.industries.as_deref(), Some("Software Development"));
        assert_eq!(details.img, None);
    }

    #[test]
    fn strips_script_and_style_from_description_markup() {
        let html = r#"
            <div class="show-more-less-html__markup">
                <script>malicious()</script>
                <style>.a { color: red; }</style>
                <p>Real description</p>
            </div>
        "#;
        let details = parse_details_html(html, DescriptionFormat::Html);
        let description = details.description.as_deref().unwrap_or_default();
        assert!(description.contains("Real description"));
        assert!(!description.contains("malicious"));
        assert!(!description.contains("color: red"));
    }

    #[test]
    fn extracts_direct_url_from_lever_apply_link() {
        let html = r#"
            <code id="applyUrl"><!--https://careers.cybersec.com/apply?url=https%3A%2F%2Flever.co%2Fcybersec%2F123--></code>
        "#;
        let document = Html::parse_document(html);
        assert_eq!(
            extract_direct_url(&document).as_deref(),
            Some("https://lever.co/cybersec/123")
        );
    }

    #[test]
    fn direct_url_falls_back_to_undecoded_match() {
        let html = r#"
            <code id="applyUrl">https://careers.acme.com/apply?url=https%zz-bad</code>
        "#;
        let document = Html::parse_document(html);
        assert_eq!(
            extract_direct_url(&document).as_deref(),
            Some("https%zz-bad")
        );
    }

    #[test]
    fn detects_auth_wall_urls() {
        assert!(is_auth_wall_url(
            "https://www.linkedin.com/signup/cold-join"
        ));
        assert!(is_auth_wall_url(
            "https://www.linkedin.com/authwall?trk=guest"
        ));
        assert!(is_auth_wall_url("https://www.linkedin.com/login"));
        assert!(!is_auth_wall_url("https://www.linkedin.com/jobs/view/123"));
    }

    #[test]
    fn parses_company_logo_from_detail_page() {
        let html = r#"
            <img class="artdeco-entity-image" data-ghost-url="https://media.licdn.com/co.png" />
        "#;
        let details = parse_details_html(html, DescriptionFormat::Html);
        assert_eq!(
            details.img.as_deref(),
            Some("https://media.licdn.com/co.png")
        );
    }
}
