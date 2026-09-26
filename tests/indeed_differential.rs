//! Differential parity test for Indeed pure helpers against Node
//! `src/acquisition/jobspy/indeed.ts` (`buildIndeedFilters`,
//! `isIndeedRemoteJob`).
//!
//! Goldens are produced by `tests/differential/generate_indeed_oracle.js`.

use astroom::acquisition::indeed::{build_indeed_filters, is_indeed_remote_job};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct FilterCase {
    options: Value,
    value: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct RemoteCase {
    job: Value,
    output: bool,
}

#[derive(Deserialize)]
struct Oracle {
    filters: Vec<FilterCase>,
    #[serde(rename = "remoteJobs")]
    remote_jobs: Vec<RemoteCase>,
}

fn load_oracle() -> Oracle {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/indeed_oracle.json"
    );
    let raw = std::fs::read_to_string(path).expect("read indeed oracle fixture");
    serde_json::from_str(&raw).expect("parse indeed oracle fixture")
}

#[test]
fn build_indeed_filters_matches_node_oracle() {
    let oracle = load_oracle();
    for (index, case) in oracle.filters.iter().enumerate() {
        let hours_old = case
            .options
            .get("hoursOld")
            .and_then(Value::as_u64)
            .map(|value| value as u32);
        let easy_apply = case
            .options
            .get("easyApply")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let is_remote = case
            .options
            .get("isRemote")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let remote_only = case
            .options
            .get("remoteOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let job_type = case.options.get("jobType").and_then(Value::as_str);
        let actual = build_indeed_filters(hours_old, easy_apply, is_remote, remote_only, job_type);
        match (&case.error, &case.value) {
            (Some(expected_error), _) => {
                let error = actual.expect_err("expected filter error");
                assert_eq!(
                    &error.message, expected_error,
                    "filter error divergence at case #{index}"
                );
            }
            (None, Some(expected)) => {
                assert_eq!(
                    &actual.expect("expected filter string"),
                    expected,
                    "filter divergence at case #{index}"
                );
            }
            (None, None) => panic!("fixture case #{index} has neither value nor error"),
        }
    }
}

#[test]
fn is_indeed_remote_job_matches_node_oracle() {
    let oracle = load_oracle();
    for (index, case) in oracle.remote_jobs.iter().enumerate() {
        assert_eq!(
            is_indeed_remote_job(&case.job),
            case.output,
            "isIndeedRemoteJob divergence at case #{index}"
        );
    }
}
