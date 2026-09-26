//! LinkedIn scraping utilities. Port of AstroEX-node
//! src/acquisition/jobspy/linkedinUtil.ts.

use crate::acquisition::types::CompensationInterval;
use regex::Regex;
use std::sync::OnceLock;

/// Default request headers for LinkedIn guest endpoints.
pub const LINKEDIN_HEADERS: &[(&str, &str)] = &[
    ("authority", "www.linkedin.com"),
    (
        "accept",
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    ),
    ("accept-language", "en-US,en;q=0.9"),
    ("cache-control", "max-age=0"),
    ("upgrade-insecure-requests", "1"),
    (
        "user-agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ),
];

/// Request headers for LinkedIn, with an optional user-agent override.
pub fn linkedin_headers<'a>(user_agent: Option<&'a str>) -> Vec<(&'static str, &'a str)> {
    let mut headers: Vec<(&'static str, &'a str)> = LINKEDIN_HEADERS.to_vec();
    if let Some(user_agent) = user_agent.filter(|ua| !ua.is_empty()) {
        for pair in headers.iter_mut() {
            if pair.0.eq_ignore_ascii_case("user-agent") {
                pair.1 = user_agent;
            }
        }
    }
    headers
}

/// Maps common job type names to LinkedIn API search filter codes (f_JT).
pub fn job_type_code(job_type: Option<&str>) -> &'static str {
    let Some(job_type) = job_type else {
        return "";
    };
    let normalized: String = job_type
        .to_lowercase()
        .chars()
        .filter(|c| !matches!(c, '-' | '_' | ' ' | '\t' | '\n' | '\r' | '\u{b}' | '\u{c}'))
        .collect();
    match normalized.as_str() {
        "fulltime" => "F",
        "parttime" => "P",
        "internship" => "I",
        "contract" => "C",
        "temporary" => "T",
        _ => "",
    }
}

/// True when the string carries an absolute-URL scheme (`scheme://`).
pub(crate) fn has_url_scheme(url: &str) -> bool {
    match url.find("://") {
        Some(index) if index > 0 => {
            let scheme = &url[..index];
            scheme
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic())
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        }
        _ => false,
    }
}

fn split_path_and_query(url: &str) -> (String, String) {
    let without_fragment = match url.find('#') {
        Some(index) => &url[..index],
        None => url,
    };
    match without_fragment.find('?') {
        Some(index) => (
            without_fragment[..index].to_string(),
            without_fragment[index + 1..].to_string(),
        ),
        None => (without_fragment.to_string(), String::new()),
    }
}

fn query_param_value(query: &str, name: &str) -> Option<String> {
    for pair in query.split('&') {
        let (key, value) = match pair.split_once('=') {
            Some((key, value)) => (key, value),
            None => (pair, ""),
        };
        if key == name {
            return Some(percent_decode(value, false).unwrap_or_else(|| value.to_string()));
        }
    }
    None
}

/// First run of at least `min_digits` consecutive ASCII digits.
fn first_digit_run(text: &str, min_digits: usize) -> Option<String> {
    let mut start: Option<usize> = None;
    for (index, ch) in text.char_indices() {
        if ch.is_ascii_digit() {
            if start.is_none() {
                start = Some(index);
            }
        } else if let Some(begin) = start.take() {
            if index - begin >= min_digits {
                return Some(text[begin..index].to_string());
            }
        }
    }
    if let Some(begin) = start {
        if text.len() - begin >= min_digits {
            return Some(text[begin..].to_string());
        }
    }
    None
}

/// Extract the numeric job ID from a LinkedIn URL: currentJobId query param,
/// then the /jobs/view/{segment} slug, then any 8+ digit run in the path.
pub fn extract_job_id_from_url(url: &str) -> Option<String> {
    if has_url_scheme(url) {
        let (path, query) = split_path_and_query(url);
        if let Some(current_job_id) = query_param_value(&query, "currentJobId") {
            if !current_job_id.is_empty() && current_job_id.chars().all(|c| c.is_ascii_digit()) {
                return Some(current_job_id);
            }
        }
        let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        if let Some(view_index) = segments.iter().position(|s| *s == "view") {
            if let Some(segment) = segments.get(view_index + 1) {
                if let Some(job_id) = first_digit_run(segment, 6) {
                    return Some(job_id);
                }
            }
        }
        first_digit_run(&path, 8)
    } else {
        first_digit_run(url, 8)
    }
}

/// Defense-in-depth remote keyword check over title/description/location text.
pub fn is_remote_text(text: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b(?:remote|work\s*from\s*home|wfh|virtual|telecommute)\b").unwrap()
    })
    .is_match(text)
}

/// True when title/location text indicates on-site work without any remote
/// signal.
pub fn is_onsite_text(text: &str) -> bool {
    static NON_REMOTE: OnceLock<Regex> = OnceLock::new();
    static REMOTE: OnceLock<Regex> = OnceLock::new();
    let non_remote = NON_REMOTE
        .get_or_init(|| Regex::new(r"(?i)\b(?:onsite|on-site|in-office|office based)\b").unwrap());
    let remote =
        REMOTE.get_or_init(|| Regex::new(r"(?i)\b(?:remote|wfh|work from home)\b").unwrap());
    non_remote.is_match(text) && !remote.is_match(text)
}

/// Compensation interval keyword detection.
pub fn parse_salary_interval(text: &str) -> Option<CompensationInterval> {
    use CompensationInterval as Interval;
    let patterns: &[(&str, CompensationInterval)] = &[
        (
            r"(?i)\b(?:yr|year|annually|annual|yearly)\b",
            Interval::Yearly,
        ),
        (r"(?i)\b(?:mo|month|monthly)\b", Interval::Monthly),
        (r"(?i)\b(?:wk|week|weekly)\b", Interval::Weekly),
        (r"(?i)\b(?:day|daily)\b", Interval::Daily),
        (r"(?i)\b(?:hr|hour|hourly)\b", Interval::Hourly),
    ];
    patterns
        .iter()
        .find(|(pattern, _)| Regex::new(pattern).unwrap().is_match(text))
        .map(|(_, interval)| *interval)
}

/// Currency implied by the symbols present in a salary string.
///
/// Order mirrors Node's `parseCurrencySymbol` exactly: `$` is tested first, so
/// the `C$`/`A$` branches are unreachable (Node behaves the same way).
pub fn parse_currency_symbol(text: &str) -> &'static str {
    if text.contains('$') {
        "USD"
    } else if text.contains('€') {
        "EUR"
    } else if text.contains('£') {
        "GBP"
    } else if text.contains('₹') {
        "INR"
    } else if text.contains("C$") {
        "CAD"
    } else if text.contains("A$") {
        "AUD"
    } else {
        "USD"
    }
}

/// JS parseFloat over a string reduced to `[0-9.]`: longest valid prefix.
fn parse_digits_dots(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    let int_digits = index > 0;
    let mut end = index;
    let mut frac_digits = 0;
    if index < bytes.len() && bytes[index] == b'.' {
        let mut cursor = index + 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
            cursor += 1;
        }
        frac_digits = cursor - (index + 1);
        if frac_digits > 0 {
            end = cursor;
        }
    }
    if !int_digits && frac_digits == 0 {
        return None;
    }
    let mut prefix = text[..end].to_string();
    if prefix.starts_with('.') {
        prefix = format!("0{prefix}");
    }
    prefix.parse::<f64>().ok()
}

/// Parse a salary string like `$120,000 - $150,000/yr` into
/// (min_amount, max_amount, currency).
pub fn parse_salary_info(salary_text: &str) -> Option<(f64, f64, String)> {
    if salary_text.is_empty() {
        return None;
    }
    let parts: Vec<Option<f64>> = salary_text
        .split('-')
        .map(|part| {
            let filtered: String = part
                .chars()
                .filter(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            parse_digits_dots(&filtered)
        })
        .collect();
    let currency = parse_currency_symbol(salary_text).to_string();
    if parts.len() >= 2 {
        if let (Some(min), Some(max)) = (parts[0], parts[1]) {
            return Some((min.floor(), max.floor(), currency));
        }
        return None;
    }
    if let Some(Some(value)) = parts.first() {
        let floored = value.floor();
        return Some((floored, floored, currency));
    }
    None
}

/// Percent-decode `%XX` sequences. `strict` mirrors JS decodeURIComponent
/// (None on malformed input); non-strict keeps literal `%` bytes.
pub(crate) fn percent_decode(input: &str, strict: bool) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 3 <= bytes.len()
                && bytes[index + 1].is_ascii_hexdigit()
                && bytes[index + 2].is_ascii_hexdigit()
            {
                out.push(hex_byte(bytes[index + 1]) * 16 + hex_byte(bytes[index + 2]));
                index += 3;
            } else if strict {
                return None;
            } else {
                out.push(b'%');
                index += 1;
            }
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_byte(byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'a'..=b'f' => byte - b'a' + 10,
        b'A'..=b'F' => byte - b'A' + 10,
        _ => 0,
    }
}

/// First non-empty attribute among `names` on `element`.
pub(crate) fn element_attr_or(element: scraper::ElementRef, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        let value = element.value().attr(name)?;
        if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acquisition::types::CompensationInterval;

    #[test]
    fn job_type_code_maps_known_job_types() {
        assert_eq!(job_type_code(Some("fulltime")), "F");
        assert_eq!(job_type_code(Some("full-time")), "F");
        assert_eq!(job_type_code(Some("FULL_TIME")), "F");
        assert_eq!(job_type_code(Some("parttime")), "P");
        assert_eq!(job_type_code(Some("part time")), "P");
        assert_eq!(job_type_code(Some("contract")), "C");
        assert_eq!(job_type_code(Some("internship")), "I");
        assert_eq!(job_type_code(Some("temporary")), "T");
        assert_eq!(job_type_code(Some("unknown")), "");
        assert_eq!(job_type_code(None), "");
    }

    #[test]
    fn extract_job_id_from_url_parses_linkedin_urls() {
        assert_eq!(
            extract_job_id_from_url(
                "https://www.linkedin.com/jobs/view/senior-engineer-4123456789"
            ),
            Some("4123456789".to_string())
        );
        assert_eq!(
            extract_job_id_from_url("https://www.linkedin.com/jobs/view/4123456789/"),
            Some("4123456789".to_string())
        );
        assert_eq!(
            extract_job_id_from_url(
                "https://www.linkedin.com/jobs/search/?currentJobId=4123456789&keywords=devops"
            ),
            Some("4123456789".to_string())
        );
        assert_eq!(extract_job_id_from_url("invalid-url"), None);
        assert_eq!(
            extract_job_id_from_url("https://www.linkedin.com/jobs/view/12345"),
            None
        );
    }

    #[test]
    fn is_remote_text_detects_remote_keywords() {
        assert!(is_remote_text("Software Engineer (Remote) New York, NY"));
        assert!(is_remote_text(
            "DevOps Engineer This is a 100% work from home role Austin, TX"
        ));
        assert!(is_remote_text("Security Analyst Remote, US"));
        assert!(is_remote_text("Platform Engineer wfh flexible Chicago, IL"));
        assert!(is_remote_text("Fully virtual position"));
        assert!(is_remote_text("Telecommute friendly"));
        assert!(!is_remote_text(
            "Onsite Database Admin Must be in office 5 days a week Boston, MA"
        ));
    }

    #[test]
    fn is_onsite_text_detects_non_remote_keywords() {
        assert!(is_onsite_text("Onsite Analyst Dallas, TX"));
        assert!(is_onsite_text("In-Office Role NYC"));
        assert!(is_onsite_text("office based position london"));
        assert!(!is_onsite_text("Remote Engineer Dallas, TX"));
        assert!(!is_onsite_text("Hybrid Onsite Remote NYC"));
        assert!(!is_onsite_text("Software Engineer New York, NY"));
    }

    #[test]
    fn parse_salary_info_extracts_amounts_and_currency() {
        let annual = parse_salary_info("$120,000 - $160,000 / yr").unwrap();
        assert_eq!(annual.0, 120000.0);
        assert_eq!(annual.1, 160000.0);
        assert_eq!(annual.2, "USD");

        let hourly = parse_salary_info("€45 - €65 / hr").unwrap();
        assert_eq!(hourly.0, 45.0);
        assert_eq!(hourly.1, 65.0);
        assert_eq!(hourly.2, "EUR");

        let gbp = parse_salary_info("£50,000 - £70,000 a year").unwrap();
        assert_eq!(gbp.2, "GBP");

        let inr = parse_salary_info("₹1,200,000 - ₹1,800,000 / yr").unwrap();
        assert_eq!(inr.0, 1200000.0);
        assert_eq!(inr.2, "INR");

        // Node tests `$` before `C$`/`A$`, so those branches are unreachable
        // and a Canadian/Australian dollar symbol resolves to USD.
        let cad = parse_salary_info("C$50 - C$70 / hr").unwrap();
        assert_eq!(cad.2, "USD");

        let single = parse_salary_info("$100,000/yr").unwrap();
        assert_eq!(single.0, 100000.0);
        assert_eq!(single.1, 100000.0);
        assert_eq!(single.2, "USD");

        assert_eq!(parse_salary_info(""), None);
        assert_eq!(parse_salary_info("Competitive salary"), None);
    }

    #[test]
    fn parse_salary_interval_maps_keywords() {
        assert_eq!(
            parse_salary_interval("$1 - $2 / yr"),
            Some(CompensationInterval::Yearly)
        );
        assert_eq!(
            parse_salary_interval("$1 - $2 per year annually"),
            Some(CompensationInterval::Yearly)
        );
        assert_eq!(
            parse_salary_interval("€45 - €65 / hr"),
            Some(CompensationInterval::Hourly)
        );
        assert_eq!(
            parse_salary_interval("$1 - $2 / mo"),
            Some(CompensationInterval::Monthly)
        );
        assert_eq!(parse_salary_info("$500 - $900 a week").unwrap().0, 500.0);
        assert_eq!(parse_salary_interval("$1 - $2"), None);
    }

    #[test]
    fn percent_decode_decodes_and_validates() {
        assert_eq!(
            percent_decode("https%3A%2F%2Fexample.com", true).as_deref(),
            Some("https://example.com")
        );
        assert_eq!(
            percent_decode("no-escapes", true).as_deref(),
            Some("no-escapes")
        );
        assert_eq!(percent_decode("bad%zz", true), None);
        assert_eq!(percent_decode("bad%zz", false).as_deref(), Some("bad%zz"));
    }
}
