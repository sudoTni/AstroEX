//! Differential parity test for OpenRouter usage accounting against the real
//! Node `parseOpenRouterUsage`, `formatUsd`, and `OpenRouterUsageTracker`.
//!
//! Goldens in `tests/fixtures/usage_oracle.json` are produced via
//! `tests/differential/generate_usage_oracle.js`.

use astroom::llm::usage::{format_usd, parse_openrouter_usage, OpenRouterUsageTracker};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct ParseCase {
    label: String,
    raw: Value,
    metadata: Value,
    /// `null` when Node returned `undefined`, or the string `"THREW"`.
    result: Value,
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ExpectedUsage {
    request_id: Option<String>,
    timestamp: String,
    model: Option<String>,
    stage: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
    cost_usd: f64,
}

#[derive(Deserialize)]
struct FormatCase {
    value: f64,
    result: String,
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ExpectedSummary {
    accounted_calls: u64,
    unavailable_usage_calls: u64,
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
    cost_usd: f64,
}

#[derive(Deserialize)]
struct TrackerOperation {
    op: String,
    #[serde(default)]
    recorded: Option<bool>,
    #[serde(rename = "callNumber", default)]
    call_number: Option<u64>,
    summary: ExpectedSummary,
}

#[derive(Deserialize)]
struct Oracle {
    #[serde(rename = "parseCases")]
    parse_cases: Vec<ParseCase>,
    #[serde(rename = "formatCases")]
    format_cases: Vec<FormatCase>,
    #[serde(rename = "trackerOperations")]
    tracker_operations: Vec<TrackerOperation>,
}

fn load_oracle() -> Oracle {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/usage_oracle.json"
    );
    let raw = std::fs::read_to_string(path).expect("read usage oracle fixture");
    serde_json::from_str(&raw).expect("parse usage oracle fixture")
}

#[test]
fn usage_parsing_formatting_and_tracking_match_node_oracle() {
    let oracle = load_oracle();

    for case in &oracle.parse_cases {
        let actual = parse_openrouter_usage(&case.raw, Some(&case.metadata));
        if case.result.is_null() || case.result == Value::String("THREW".to_string()) {
            assert!(
                actual.is_none(),
                "parse case {}: expected None, got {actual:?}",
                case.label
            );
            continue;
        }
        let expected: ExpectedUsage =
            serde_json::from_value(case.result.clone()).expect("expected usage");
        let actual = actual.unwrap_or_else(|| panic!("parse case {}: expected Some", case.label));
        assert_eq!(
            ExpectedUsage {
                request_id: actual.request_id,
                timestamp: actual.timestamp,
                model: actual.model,
                stage: actual.stage,
                input_tokens: actual.input_tokens,
                output_tokens: actual.output_tokens,
                total_tokens: actual.total_tokens,
                cost_usd: actual.cost_usd,
            },
            expected,
            "parse case {} diverged",
            case.label
        );
    }

    for case in &oracle.format_cases {
        assert_eq!(
            format_usd(case.value),
            case.result,
            "formatUsd({}) diverged",
            case.value
        );
    }

    let mut tracker = OpenRouterUsageTracker::new();
    let usage_a = parse_openrouter_usage(
        &serde_json::json!({"prompt_tokens": 100, "completion_tokens": 25, "total_tokens": 125, "cost": 0.00427}),
        Some(&serde_json::json!({"timestamp": "2026-09-16T12:00:00.000Z"})),
    )
    .expect("usage a");
    let usage_b = parse_openrouter_usage(
        &serde_json::json!({"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15, "cost": 0.001}),
        Some(&serde_json::json!({"timestamp": "2026-09-16T12:00:00.000Z"})),
    )
    .expect("usage b");
    let usage_c = parse_openrouter_usage(
        &serde_json::json!({"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2, "cost": 0}),
        Some(&serde_json::json!({"timestamp": "2026-09-16T12:00:00.000Z"})),
    )
    .expect("usage c");

    for (index, operation) in oracle.tracker_operations.iter().enumerate() {
        let (recorded, call_number) = match operation.op.as_str() {
            "record-a" => {
                let recorded = tracker.record("acct-a", &usage_a);
                (recorded, tracker.get_summary().accounted_calls)
            }
            "record-a-again" => {
                let recorded = tracker.record("acct-a", &usage_a);
                (recorded, tracker.get_summary().accounted_calls)
            }
            "record-b" => {
                let recorded = tracker.record("acct-b", &usage_b);
                (recorded, tracker.get_summary().accounted_calls)
            }
            "mark-unavailable" => {
                tracker.mark_usage_unavailable();
                (true, tracker.get_summary().accounted_calls)
            }
            "record-c" => {
                let recorded = tracker.record("acct-c", &usage_c);
                (recorded, tracker.get_summary().accounted_calls)
            }
            other => panic!("unknown tracker op {other}"),
        };
        if let Some(expected_recorded) = operation.recorded {
            assert_eq!(
                recorded, expected_recorded,
                "tracker op #{index} ({}) recorded diverged",
                operation.op
            );
        }
        if let Some(expected_call_number) = operation.call_number {
            assert_eq!(
                call_number, expected_call_number,
                "tracker op #{index} ({}) callNumber diverged",
                operation.op
            );
        }
        let summary = tracker.get_summary();
        let actual_summary = ExpectedSummary {
            accounted_calls: summary.accounted_calls,
            unavailable_usage_calls: summary.unavailable_usage_calls,
            input_tokens: summary.input_tokens,
            output_tokens: summary.output_tokens,
            total_tokens: summary.total_tokens,
            cost_usd: summary.cost_usd,
        };
        assert_eq!(
            actual_summary, operation.summary,
            "tracker op #{index} ({}) summary diverged",
            operation.op
        );
    }
}
