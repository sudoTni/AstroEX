//! Differential parity test for the LLM terminal formatter against
//! AstroEX-node's `src/logging/llmFormatter.ts`.
//!
//! Goldens in `tests/fixtures/llm_formatter_oracle.json` are produced by
//! `tests/differential/generate_llm_formatter_oracle.js` from the real Node
//! implementation with colors disabled. Regenerate with:
//!
//! ```sh
//! node tests/differential/generate_llm_formatter_oracle.js /path/to/AstroEX-node \
//!   > tests/fixtures/llm_formatter_oracle.json
//! ```
//!
//! This test does not require Node at test time.

use astroom::logging::llm_formatter::{
    format_llm_request, format_llm_response, format_reasoning_block, format_tool_call_block,
    format_tool_result_block,
};
use astroom::types::{LogFormat, LogLevel};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    kind: String,
    name: String,
    output: String,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    payload: Option<Value>,
    #[serde(default)]
    max_payload_length: Option<usize>,
    #[serde(default)]
    duration: Option<f64>,
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default)]
    reasoning_summary: Option<String>,
    #[serde(default)]
    reasoning_tokens: Option<u64>,
    #[serde(default)]
    tool_name: Option<String>,
    #[serde(default)]
    call_id: Option<String>,
    #[serde(default)]
    arguments: Option<Value>,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<String>,
}

fn load_oracle() -> Vec<Case> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/llm_formatter_oracle.json"
    );
    let raw = std::fs::read_to_string(path).expect("read llm formatter oracle");
    serde_json::from_str(&raw).expect("parse llm formatter oracle")
}

#[test]
fn llm_formatter_matches_node_oracle() {
    // Force colorless (byte-comparable) output for the whole test process.
    astroom::logging::configure_logging(LogFormat::Pretty, LogLevel::Error, false);

    let cases = load_oracle();
    assert!(!cases.is_empty(), "fixture should not be empty");
    for case in &cases {
        let actual = match case.kind.as_str() {
            "request" => format_llm_request(
                case.provider.as_deref().unwrap_or(""),
                case.model.as_deref().unwrap_or(""),
                case.request_id.as_deref().unwrap_or(""),
                case.payload
                    .as_ref()
                    .unwrap_or(&Value::Object(serde_json::Map::new())),
                case.max_payload_length,
            ),
            "response" => format_llm_response(
                case.provider.as_deref().unwrap_or(""),
                case.model.as_deref().unwrap_or(""),
                case.payload
                    .as_ref()
                    .unwrap_or(&Value::Object(serde_json::Map::new())),
                case.duration.map(|duration| duration.round() as u64),
                case.max_payload_length,
            ),
            "reasoning" => format_reasoning_block(
                case.provider.as_deref(),
                case.model.as_deref(),
                case.reasoning_content.as_deref(),
                case.reasoning_summary.as_deref(),
                case.reasoning_tokens,
            ),
            "toolCall" => format_tool_call_block(
                case.tool_name.as_deref().unwrap_or(""),
                case.call_id.as_deref(),
                case.arguments.as_ref(),
                case.max_payload_length,
            ),
            "toolResult" => format_tool_result_block(
                case.tool_name.as_deref().unwrap_or(""),
                case.duration.map(|duration| duration.round() as u64),
                case.result.as_ref(),
                case.error.as_deref(),
                case.max_payload_length,
            ),
            other => panic!("unknown oracle kind: {other}"),
        };
        assert_eq!(
            actual, case.output,
            "llm formatter divergence for case '{}' ({})",
            case.name, case.kind
        );
    }
}
