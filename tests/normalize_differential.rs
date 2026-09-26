//! Differential parity test for the canonical → legacy job projection and
//! canonical artifact field names against the Node implementation.
//!
//! Goldens in `tests/fixtures/normalize_oracle.json` are produced by the real
//! `toLegacyJob` via `tests/differential/generate_normalize_oracle.js`.
//!
//! Numbers are normalized (Node emits `120000`, Rust `f64` may emit
//! `120000.0`) before semantic comparison; JSON parsers treat them as equal.

use astroom::acquisition::normalize::to_legacy_job;
use astroom::acquisition::types::CanonicalAcquiredJob;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct OracleEntry {
    canonical: Value,
    legacy: Value,
}

fn load_oracle() -> Vec<OracleEntry> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/normalize_oracle.json"
    );
    let raw = std::fs::read_to_string(path).expect("read normalize oracle fixture");
    serde_json::from_str(&raw).expect("parse normalize oracle fixture")
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
fn to_legacy_job_matches_node_oracle() {
    let oracle = load_oracle();
    assert!(!oracle.is_empty(), "fixture should not be empty");
    for (index, entry) in oracle.iter().enumerate() {
        let canonical: CanonicalAcquiredJob = serde_json::from_value(entry.canonical.clone())
            .unwrap_or_else(|error| {
                panic!("canonical #{index} did not deserialize from camelCase: {error}")
            });
        let actual = normalize_numbers(&serde_json::to_value(to_legacy_job(&canonical)).unwrap());
        let expected = normalize_numbers(&entry.legacy);
        assert_eq!(
            actual, expected,
            "legacy projection divergence at case #{index}"
        );
    }
}

#[test]
fn canonical_serializes_with_camel_case_field_names() {
    let oracle = load_oracle();
    for entry in &oracle {
        let canonical: CanonicalAcquiredJob =
            serde_json::from_value(entry.canonical.clone()).expect("deserialize canonical");
        let serialized = serde_json::to_value(&canonical).expect("serialize canonical");
        let object = serialized.as_object().expect("canonical is an object");
        for key in object.keys() {
            assert!(
                !key.contains('_'),
                "canonical field {key:?} should be camelCase for Node artifact compatibility"
            );
        }
        if let Some(compensation) = object.get("compensation").and_then(Value::as_object) {
            for key in compensation.keys() {
                assert!(
                    !key.contains('_'),
                    "compensation field {key:?} should be camelCase"
                );
            }
        }
    }
}
