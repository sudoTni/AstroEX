//! Differential parity test for LinkedIn utility pure functions against Node
//! `src/acquisition/jobspy/linkedinUtil.ts`.
//!
//! Goldens are produced by
//! `tests/differential/generate_linkedin_util_oracle.js`.

use astroom::acquisition::linkedin_util::{
    extract_job_id_from_url, is_onsite_text, is_remote_text, job_type_code, parse_currency_symbol,
    parse_salary_info, parse_salary_interval,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
struct OptStringCase {
    input: Option<String>,
    output: String,
}

#[derive(Deserialize)]
struct RemoteCase {
    title: Option<String>,
    description: Option<String>,
    location: Option<String>,
    output: bool,
}

#[derive(Deserialize)]
struct NonRemoteCase {
    title: Option<String>,
    location: Option<String>,
    output: bool,
}

#[derive(Deserialize)]
struct NullableStringCase {
    input: String,
    output: Option<String>,
}

#[derive(Deserialize)]
struct StringCase {
    input: String,
    output: String,
}

#[derive(Deserialize)]
struct SalaryInfoCase {
    input: String,
    output: Value,
}

#[derive(Deserialize)]
struct Oracle {
    #[serde(rename = "jobType")]
    job_type: Vec<OptStringCase>,
    #[serde(rename = "linkedinRemote")]
    linkedin_remote: Vec<RemoteCase>,
    #[serde(rename = "nonRemote")]
    non_remote: Vec<NonRemoteCase>,
    #[serde(rename = "jobIds")]
    job_ids: Vec<NullableStringCase>,
    #[serde(rename = "salaryIntervals")]
    salary_intervals: Vec<NullableStringCase>,
    #[serde(rename = "currencySymbols")]
    currency_symbols: Vec<StringCase>,
    #[serde(rename = "salaryInfos")]
    salary_infos: Vec<SalaryInfoCase>,
}

fn load_oracle() -> Oracle {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/linkedin_util_oracle.json"
    );
    let raw = std::fs::read_to_string(path).expect("read linkedin util oracle fixture");
    serde_json::from_str(&raw).expect("parse linkedin util oracle fixture")
}

fn normalize_numbers(value: &Value) -> Value {
    match value {
        Value::Number(number) => Value::from(number.as_f64().unwrap_or(0.0)),
        Value::Array(items) => Value::Array(items.iter().map(normalize_numbers).collect()),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| (key.clone(), normalize_numbers(value)))
                .collect(),
        ),
        other => other.clone(),
    }
}

#[test]
fn job_type_code_matches_node_oracle() {
    let oracle = load_oracle();
    for (index, case) in oracle.job_type.iter().enumerate() {
        assert_eq!(
            job_type_code(case.input.as_deref()),
            case.output,
            "jobTypeCode divergence at case #{index}"
        );
    }
}

#[test]
fn remote_heuristics_match_node_oracle() {
    let oracle = load_oracle();
    for (index, case) in oracle.linkedin_remote.iter().enumerate() {
        let combined = format!(
            "{} {} {}",
            case.title.clone().unwrap_or_default(),
            case.description.clone().unwrap_or_default(),
            case.location.clone().unwrap_or_default()
        );
        assert_eq!(
            is_remote_text(&combined),
            case.output,
            "isLinkedInRemote divergence at case #{index}"
        );
    }
    for (index, case) in oracle.non_remote.iter().enumerate() {
        let combined = format!(
            "{} {}",
            case.title.clone().unwrap_or_default(),
            case.location.clone().unwrap_or_default()
        );
        assert_eq!(
            is_onsite_text(&combined),
            case.output,
            "isExplicitlyNonRemote divergence at case #{index}"
        );
    }
}

#[test]
fn job_id_extraction_matches_node_oracle() {
    let oracle = load_oracle();
    for (index, case) in oracle.job_ids.iter().enumerate() {
        assert_eq!(
            extract_job_id_from_url(&case.input),
            case.output,
            "extractJobIdFromUrl divergence at case #{index} for {:?}",
            case.input
        );
    }
}

#[test]
fn salary_interval_and_currency_match_node_oracle() {
    let oracle = load_oracle();
    for (index, case) in oracle.salary_intervals.iter().enumerate() {
        let actual = parse_salary_interval(&case.input).map(|interval| {
            serde_json::to_value(interval)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        });
        assert_eq!(
            actual, case.output,
            "parseSalaryInterval divergence at case #{index}"
        );
    }
    for (index, case) in oracle.currency_symbols.iter().enumerate() {
        assert_eq!(
            parse_currency_symbol(&case.input),
            case.output,
            "parseCurrencySymbol divergence at case #{index} for {:?}",
            case.input
        );
    }
}

#[test]
fn salary_info_matches_node_oracle() {
    let oracle = load_oracle();
    for (index, case) in oracle.salary_infos.iter().enumerate() {
        let actual = match parse_salary_info(&case.input) {
            Some((min, max, currency)) => {
                let mut object = serde_json::Map::new();
                object.insert("minAmount".to_string(), json!(min));
                object.insert("maxAmount".to_string(), json!(max));
                object.insert("currency".to_string(), json!(currency));
                if let Some(interval) = parse_salary_interval(&case.input) {
                    object.insert(
                        "interval".to_string(),
                        serde_json::to_value(interval).unwrap(),
                    );
                }
                object.insert("source".to_string(), json!("direct_data"));
                Value::Object(object)
            }
            None => Value::Null,
        };
        assert_eq!(
            normalize_numbers(&actual),
            normalize_numbers(&case.output),
            "parseSalaryInfo divergence at case #{index} for {:?}",
            case.input
        );
    }
}
