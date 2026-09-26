//! Differential parity test for the stream repetition detector against the
//! real Node `StreamRepetitionDetector`.
//!
//! Goldens in `tests/fixtures/repetition_oracle.json` are produced via
//! `tests/differential/generate_repetition_oracle.js`.

use astroom::llm::repetition::StreamRepetitionDetector;
use serde::Deserialize;

#[derive(Deserialize)]
struct Feed {
    chunk: String,
    detected: bool,
    period: usize,
    repeats: u64,
    #[serde(rename = "repeatedText")]
    repeated_text: String,
    #[serde(rename = "totalChars")]
    total_chars: u64,
}

#[derive(Deserialize)]
struct CurrentMatch {
    detected: bool,
    period: usize,
    repeats: u64,
    #[serde(rename = "repeatedText")]
    repeated_text: String,
    #[serde(rename = "totalChars")]
    total_chars: u64,
}

#[derive(Deserialize)]
struct Scenario {
    name: String,
    feeds: Vec<Feed>,
    #[serde(rename = "totalObserved")]
    total_observed: u64,
    #[serde(rename = "bufferedLength")]
    buffered_length: usize,
    #[serde(rename = "currentMatch")]
    current_match: Option<CurrentMatch>,
}

fn load_oracle() -> Vec<Scenario> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/repetition_oracle.json"
    );
    let raw = std::fs::read_to_string(path).expect("read repetition oracle fixture");
    serde_json::from_str(&raw).expect("parse repetition oracle fixture")
}

#[test]
fn repetition_detector_matches_node_oracle() {
    let oracle = load_oracle();
    assert!(!oracle.is_empty(), "fixture should not be empty");
    for scenario in &oracle {
        let mut detector = StreamRepetitionDetector::new();
        for (index, expected) in scenario.feeds.iter().enumerate() {
            let actual = detector.feed(&expected.chunk);
            let (detected, period, repeats, repeated_text, total_chars) = match actual {
                Some(m) => (
                    m.detected,
                    m.period,
                    m.repeats,
                    m.repeated_text,
                    m.total_chars,
                ),
                None => (false, 0, 0, String::new(), 0),
            };
            assert_eq!(
                detected, expected.detected,
                "{}/feed#{index}: detected mismatch",
                scenario.name
            );
            assert_eq!(
                period, expected.period,
                "{}/feed#{index}: period mismatch",
                scenario.name
            );
            assert_eq!(
                repeats, expected.repeats,
                "{}/feed#{index}: repeats mismatch",
                scenario.name
            );
            assert_eq!(
                repeated_text, expected.repeated_text,
                "{}/feed#{index}: repeatedText mismatch",
                scenario.name
            );
            assert_eq!(
                total_chars, expected.total_chars,
                "{}/feed#{index}: totalChars mismatch",
                scenario.name
            );
        }
        assert_eq!(
            detector.total_observed(),
            scenario.total_observed,
            "{}: totalObserved mismatch",
            scenario.name
        );
        assert_eq!(
            detector.buffered_length(),
            scenario.buffered_length,
            "{}: bufferedLength mismatch",
            scenario.name
        );
        match (&scenario.current_match, detector.current_match()) {
            (None, None) => {}
            (Some(expected), Some(actual)) => {
                assert_eq!(actual.detected, expected.detected, "currentMatch detected");
                assert_eq!(actual.period, expected.period, "currentMatch period");
                assert_eq!(actual.repeats, expected.repeats, "currentMatch repeats");
                assert_eq!(
                    actual.repeated_text, expected.repeated_text,
                    "currentMatch repeatedText"
                );
                assert_eq!(
                    actual.total_chars, expected.total_chars,
                    "currentMatch totalChars"
                );
            }
            _ => panic!("{}: currentMatch presence mismatch", scenario.name),
        }
    }
}
