//! Differential parity test for delay/retry helpers against Node
//! `src/utils/delayUtils.ts`.
//!
//! Goldens are produced by `tests/differential/generate_delay_oracle.js`.

use astroom::utils::delay::{get_random_jitter_delay_ms, is_network_error, is_retryable_status};
use serde::Deserialize;

#[derive(Deserialize)]
struct StatusCase {
    status: u16,
    output: bool,
}

#[derive(Deserialize)]
struct MessageCase {
    input: String,
    output: bool,
}

#[derive(Deserialize)]
struct JitterCase {
    min: f64,
    max: f64,
    error: Option<String>,
}

#[derive(Deserialize)]
struct Oracle {
    statuses: Vec<StatusCase>,
    messages: Vec<MessageCase>,
    jitter: Vec<JitterCase>,
}

fn load_oracle() -> Oracle {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/delay_oracle.json"
    );
    let raw = std::fs::read_to_string(path).expect("read delay oracle fixture");
    serde_json::from_str(&raw).expect("parse delay oracle fixture")
}

#[test]
fn retryable_status_matches_node_oracle() {
    let oracle = load_oracle();
    for case in &oracle.statuses {
        assert_eq!(
            is_retryable_status(case.status),
            case.output,
            "retryable status divergence at {}",
            case.status
        );
    }
}

#[test]
fn network_error_matches_node_oracle() {
    let oracle = load_oracle();
    for case in &oracle.messages {
        assert_eq!(
            is_network_error(&case.input),
            case.output,
            "network error divergence for {:?}",
            case.input
        );
    }
}

#[test]
fn jitter_validation_matches_node_oracle() {
    let oracle = load_oracle();
    for case in &oracle.jitter {
        match (&case.error, get_random_jitter_delay_ms(case.min, case.max)) {
            (Some(expected), Err(error)) => assert_eq!(&error.message, expected),
            (Some(expected), Ok(value)) => panic!(
                "expected error {expected:?} for ({}, {}), got {value}",
                case.min, case.max
            ),
            (None, Err(error)) => panic!("unexpected error: {error}"),
            (None, Ok(_)) => {}
        }
    }
}
