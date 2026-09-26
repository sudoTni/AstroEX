//! Differential parity test for robust JSON repair against the Node
//! `LLMService.robustJsonParse` pipeline.
//!
//! Goldens in `tests/fixtures/json_repair_oracle.json` are produced by the
//! real Node implementation via
//! `tests/differential/generate_json_repair_oracle.js`. On unrepairable input
//! Node returns `[]` (via `extractPartialJsonData`) rather than throwing, which
//! `try_parse_json` now mirrors.

use astroom::llm::json_repair::try_parse_json;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct OracleEntry {
    input: String,
    parsed: Value,
}

fn load_oracle() -> Vec<OracleEntry> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/json_repair_oracle.json"
    );
    let raw = std::fs::read_to_string(path).expect("read json repair oracle fixture");
    serde_json::from_str(&raw).expect("parse json repair oracle fixture")
}

#[test]
fn json_repair_matches_node_oracle() {
    let oracle = load_oracle();
    assert!(!oracle.is_empty(), "fixture should not be empty");
    for (index, entry) in oracle.iter().enumerate() {
        let actual = try_parse_json(&entry.input).unwrap_or_else(|| {
            panic!("repair returned None for input #{index}: {:?}", entry.input)
        });
        assert_eq!(
            actual, entry.parsed,
            "json repair divergence at case #{index} for input: {:?}",
            entry.input
        );
    }
}
