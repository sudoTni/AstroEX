//! Differential parity test for secret redaction/sanitization against the
//! Node implementation (`src/logging/redaction.ts`).
//!
//! Goldens are produced by `tests/differential/generate_redaction_oracle.js`
//! calling the real Node `sanitizeString`/`sanitizeContext`.

use astroom::logging::redaction::{sanitize_json, sanitize_string};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct StringCase {
    input: String,
    output: String,
}

#[derive(Deserialize)]
struct ContextCase {
    input: Value,
    output: Value,
}

#[derive(Deserialize)]
struct Oracle {
    strings: Vec<StringCase>,
    contexts: Vec<ContextCase>,
}

fn load_oracle() -> Oracle {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/redaction_oracle.json"
    );
    let raw = std::fs::read_to_string(path).expect("read redaction oracle fixture");
    let synthetic_or_key = format!("sk-or-v1-{}", "a".repeat(64));
    let hydrated = raw.replace("__SK_OR_V1_64A__", &synthetic_or_key);
    serde_json::from_str(&hydrated).expect("parse redaction oracle fixture")
}

#[test]
fn sanitize_string_matches_node_oracle() {
    let oracle = load_oracle();
    assert!(!oracle.strings.is_empty());
    for (index, case) in oracle.strings.iter().enumerate() {
        assert_eq!(
            sanitize_string(&case.input),
            case.output,
            "sanitize_string divergence at case #{index}"
        );
    }
}

#[test]
fn sanitize_context_matches_node_oracle() {
    let oracle = load_oracle();
    assert!(!oracle.contexts.is_empty());
    for (index, case) in oracle.contexts.iter().enumerate() {
        assert_eq!(
            sanitize_json(&case.input, 0),
            case.output,
            "sanitize_json divergence at case #{index} for input: {}",
            case.input
        );
    }
}
