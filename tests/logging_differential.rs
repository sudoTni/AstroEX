//! Differential parity test for the terminal/JSON log formatters against the
//! Node implementation (`src/logging/formatter.ts`).
//!
//! Goldens in `tests/fixtures/logging_oracle.json` are produced by the real
//! Node `formatTerminal`/`formatJson` via
//! `tests/differential/generate_logging_oracle.js` with `TZ=UTC`. This test
//! pins `TZ=UTC` as well so the localized timestamp prefix is deterministic.

use astroom::logging::formatter::{format_json, format_terminal};
use astroom::logging::types::LogRecord;
use astroom::types::LogLevel;
use serde::Deserialize;
use serde_json::{Map, Value};

#[derive(Deserialize)]
struct Entry {
    record: RecordInput,
    color: ColorOutput,
}

#[derive(Deserialize)]
struct RecordInput {
    timestamp: String,
    level: String,
    component: String,
    message: String,
    #[serde(default)]
    context: Option<Map<String, Value>>,
}

#[derive(Deserialize)]
struct ColorOutput {
    pretty: String,
    plain: String,
    json: String,
}

fn load_oracle() -> Vec<Entry> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/logging_oracle.json"
    );
    let raw = std::fs::read_to_string(path).expect("read logging oracle fixture");
    serde_json::from_str(&raw).expect("parse logging oracle fixture")
}

fn to_record(input: &RecordInput) -> LogRecord {
    LogRecord {
        timestamp: input.timestamp.clone(),
        level: LogLevel::parse(&input.level).expect("valid level"),
        component: input.component.clone(),
        message: input.message.clone(),
        context: input.context.clone(),
    }
}

#[test]
fn terminal_plain_matches_node() {
    std::env::set_var("TZ", "UTC");
    for (index, entry) in load_oracle().iter().enumerate() {
        let record = to_record(&entry.record);
        assert_eq!(
            format_terminal(&record, false),
            entry.color.plain,
            "plain divergence at fixture #{index}: {:?}",
            entry.record.message
        );
    }
}

#[test]
fn terminal_color_matches_node() {
    std::env::set_var("TZ", "UTC");
    for (index, entry) in load_oracle().iter().enumerate() {
        let record = to_record(&entry.record);
        assert_eq!(
            format_terminal(&record, true),
            entry.color.pretty,
            "color divergence at fixture #{index}: {:?}",
            entry.record.message
        );
    }
}

#[test]
fn json_matches_node() {
    for (index, entry) in load_oracle().iter().enumerate() {
        let record = to_record(&entry.record);
        assert_eq!(
            format_json(&record),
            entry.color.json,
            "json divergence at fixture #{index}: {:?}",
            entry.record.message
        );
    }
}
