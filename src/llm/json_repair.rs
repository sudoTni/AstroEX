//! Robust JSON repair pipeline, ported from AstroEX-node
//! src/llmService.ts (`robustJsonParse`, `quickCleanJson`,
//! `fixTruncationIssues`, `repairJsonByRemovingTrailingComma`,
//! `repairJsonByFixingEscapes`, `repairJsonByBalancingBrackets`,
//! `extractPartialJsonData`).

use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use serde_json::Value;

use crate::error::{AppError, Result};

fn trailing_comma_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r",(\s*[}\]])").expect("valid regex"))
}

fn escape_fix_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"\\([nrtbf"\\])"#).expect("valid regex"))
}

fn json_array_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)\[\s*(.*?)\s*\]").expect("valid regex"))
}

fn json_object_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}").expect("valid regex"))
}

/// Quick JSON cleaning for common LLM response patterns: strips
/// ```json fences, "Here's the JSON:" prefixes, and stray "JSON" labels.
pub fn quick_clean_json(input: &str) -> String {
    let cleaned = strip_prefix_re(input, r"(?i)^```json\s*");
    let cleaned = strip_prefix_re(&cleaned, r"(?i)^```\s*");
    let cleaned = strip_suffix_re(&cleaned, r"(?i)\s*```\s*$");
    let cleaned = strip_prefix_re(&cleaned, r"(?i)^Here's the JSON:\s*");
    let cleaned = strip_prefix_re(&cleaned, r"(?i)^JSON:\s*");
    let cleaned = strip_suffix_re(&cleaned, r"(?i)\s*JSON\s*$");
    cleaned.trim().to_string()
}

/// JavaScript `String.replace` with a non-global regex: replaces the first
/// match (anchored at the start here) with "".
fn strip_prefix_re(input: &str, pattern: &str) -> String {
    let re = Regex::new(pattern).expect("valid regex");
    re.replace(input, "").into_owned()
}

fn strip_suffix_re(input: &str, pattern: &str) -> String {
    let re = Regex::new(pattern).expect("valid regex");
    re.replace(input, "").into_owned()
}

/// Repair JSON by removing trailing commas before `}` or `]`.
fn repair_json_by_removing_trailing_comma(input: &str) -> String {
    trailing_comma_re().replace_all(input, "${1}").into_owned()
}

/// Repair JSON by fixing (unescaping) escape sequences: `\n` -> `n`, `\"` -> `"` etc.
fn repair_json_by_fixing_escapes(input: &str) -> String {
    escape_fix_re().replace_all(input, "${1}").into_owned()
}

/// Repair JSON by balancing brackets and braces (truncation repair that
/// closes any open structures).
fn repair_json_by_balancing_brackets(input: &str) -> String {
    fix_truncation_issues(input)
}

/// Fix truncation issues by balancing brackets and braces.
fn fix_truncation_issues(json_str: &str) -> String {
    let mut open_braces: u32 = 0;
    let mut open_brackets: u32 = 0;
    let mut result = String::new();
    let mut in_string = false;
    let mut escape_next = false;

    for ch in json_str.chars() {
        if escape_next {
            result.push(ch);
            escape_next = false;
            continue;
        }

        if ch == '\\' && in_string {
            result.push(ch);
            escape_next = true;
            continue;
        }

        if ch == '"' {
            in_string = !in_string;
            result.push(ch);
            continue;
        }

        if !in_string {
            match ch {
                '{' => open_braces += 1,
                '}' => open_braces = open_braces.saturating_sub(1),
                '[' => open_brackets += 1,
                ']' => open_brackets = open_brackets.saturating_sub(1),
                _ => {}
            }
        }

        result.push(ch);
    }

    // Close any remaining open structures
    for _ in 0..open_braces {
        result.push('}');
    }
    for _ in 0..open_brackets {
        result.push(']');
    }

    result
}

/// Extract partial JSON data when complete parsing fails: the first
/// embedded JSON array, or otherwise all parseable `{...}` objects
/// (including one level of nesting) collected into an array.
///
/// Mirrors the Node `extractPartialJsonData`, which never throws and returns
/// an empty array when nothing could be extracted.
pub fn extract_partial_json_data(input: &str) -> Value {
    // Try to find JSON array patterns
    if let Some(array_match) = json_array_re().find(input) {
        if let Ok(array) = serde_json::from_str::<Value>(array_match.as_str()) {
            return array;
        }
        // Continue to other extraction methods
    }

    // Try to extract individual JSON objects
    let mut objects: Vec<Value> = Vec::new();
    for m in json_object_re().find_iter(input) {
        if let Ok(obj) = serde_json::from_str::<Value>(m.as_str()) {
            if obj.is_object() {
                objects.push(obj);
            }
        }
    }

    Value::Array(objects)
}

/// Single synchronous attempt through the full repair pipeline:
///
/// 1. direct parse
/// 2. quickClean
/// 3. remove trailing commas
/// 4. fix escape sequences
/// 5. balance brackets/braces (truncation repair)
/// 6. extractPartialJsonData
pub fn try_parse_json(input: &str) -> Option<Value> {
    // Fast path: try direct parsing first
    if let Ok(v) = serde_json::from_str::<Value>(input) {
        return Some(v);
    }

    let cleaned = quick_clean_json(input);

    // Try most common fixes first (in order of likelihood); each strategy is
    // applied to the cleaned text independently, as in the Node pipeline.
    let strategy_outputs = [
        repair_json_by_removing_trailing_comma(&cleaned),
        repair_json_by_fixing_escapes(&cleaned),
        repair_json_by_balancing_brackets(&cleaned),
    ];
    for repaired in strategy_outputs {
        if let Ok(v) = serde_json::from_str::<Value>(&repaired) {
            return Some(v);
        }
    }

    // If all strategies fail, try partial extraction (never fails; yields an
    // empty array when nothing parseable is present, matching Node).
    Some(extract_partial_json_data(&cleaned))
}

/// Robust JSON parsing with repair retries and exponential backoff.
///
/// Attempts a direct parse, then retries the full repair pipeline up to
/// `max_retries` times, sleeping (exponentially backing off, capped at
/// `max_delay_ms`) between attempts. Returns
/// `AppError("Failed to parse JSON after repair attempts: ...")` when every
/// attempt fails.
pub async fn robust_json_parse(
    input: &str,
    max_retries: u32,
    initial_delay_ms: u64,
    max_delay_ms: u64,
) -> Result<Value> {
    let initial_error = match serde_json::from_str::<Value>(input) {
        Ok(v) => return Ok(v),
        Err(e) => e,
    };

    let mut delay_ms = initial_delay_ms;
    for attempt in 0..max_retries {
        if let Some(v) = try_parse_json(input) {
            return Ok(v);
        }
        if attempt + 1 < max_retries {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            delay_ms = delay_ms.saturating_mul(2).min(max_delay_ms);
        }
    }

    Err(AppError::message(format!(
        "Failed to parse JSON after repair attempts: {initial_error}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn quick_clean_strips_json_fences() {
        assert_eq!(quick_clean_json("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(quick_clean_json("```\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(quick_clean_json("```JSON {\"a\":1}```"), "{\"a\":1}");
    }

    #[test]
    fn quick_clean_strips_heres_the_json_prefix() {
        assert_eq!(
            quick_clean_json("Here's the JSON: {\"a\": 1}"),
            "{\"a\": 1}"
        );
        assert_eq!(quick_clean_json("JSON: {\"a\": 1}"), "{\"a\": 1}");
        assert_eq!(quick_clean_json("{\"a\": 1} JSON"), "{\"a\": 1}");
        assert_eq!(quick_clean_json("  {\"a\": 1}  "), "{\"a\": 1}");
    }

    #[test]
    fn parses_valid_json_directly() {
        let v = try_parse_json("{\"a\": 1}").expect("parses");
        assert_eq!(v, json!({"a": 1}));
    }

    #[test]
    fn parses_fenced_json() {
        let v = try_parse_json("```json\n{\"a\": [1, 2, 3]}\n```").expect("parses");
        assert_eq!(v, json!({"a": [1, 2, 3]}));
    }

    #[test]
    fn removes_trailing_commas() {
        let v = try_parse_json("{\"a\": 1, \"b\": [1, 2,],}").expect("parses");
        assert_eq!(v, json!({"a": 1, "b": [1, 2]}));
    }

    #[test]
    fn balances_unbalanced_brackets_and_braces() {
        // Truncated object: {"a": {"b": 1
        let v = try_parse_json("{\"a\": {\"b\": 1").expect("parses");
        assert_eq!(v, json!({"a": {"b": 1}}));

        // Truncated array with nested object: [1, 2, {"x": 3
        let v = try_parse_json("[1, 2, {\"x\": 3").expect("parses");
        assert_eq!(v, json!([1, 2, {"x": 3}]));

        // Braces inside strings must not be counted.
        let v = try_parse_json("{\"s\": \"a{b\" }").expect("parses");
        assert_eq!(v, json!({"s": "a{b"}));
    }

    #[test]
    fn extracts_embedded_array() {
        let input = "Here is some preamble text [1, 2, 3] and trailing text";
        let v = try_parse_json(input).expect("parses");
        assert_eq!(v, json!([1, 2, 3]));

        assert_eq!(extract_partial_json_data(input), json!([1, 2, 3]));
    }

    #[test]
    fn extracts_embedded_objects() {
        let input = "noise before {\"a\": 1} middle noise {\"b\": {\"c\": 2}} after";
        let v = try_parse_json(input).expect("parses");
        assert_eq!(v, json!([{"a": 1}, {"b": {"c": 2}}]));

        assert_eq!(
            extract_partial_json_data(input),
            json!([{"a": 1}, {"b": {"c": 2}}])
        );
    }

    #[test]
    fn extraction_yields_empty_array_when_nothing_parses() {
        // Node's extractPartialJsonData returns [] rather than throwing.
        assert_eq!(extract_partial_json_data("no json here"), json!([]));
        assert_eq!(
            try_parse_json("plain text, nothing parseable"),
            Some(json!([]))
        );
    }

    #[test]
    fn truncated_top_level_object_with_partial_extraction() {
        // Truncated array whose contents are still parseable objects.
        let input = "[{\"a\": 1}, {\"b\": 2}";
        let v = try_parse_json(input).expect("parses");
        assert_eq!(v, json!([{"a": 1}, {"b": 2}]));
    }

    #[tokio::test]
    async fn robust_parse_succeeds_for_repairable_input() {
        let v = robust_json_parse("```json\n{\"a\": 1,}\n```", 3, 1, 2)
            .await
            .expect("parses");
        assert_eq!(v, json!({"a": 1}));
    }

    #[tokio::test]
    async fn robust_parse_direct_fast_path() {
        let v = robust_json_parse("{\"ok\": true}", 3, 1, 2)
            .await
            .expect("parses");
        assert_eq!(v, json!({"ok": true}));
    }

    #[tokio::test]
    async fn robust_parse_yields_empty_array_for_unrepairable_input() {
        // Node's robustJsonParse never throws with aggressive repairs enabled;
        // partial extraction yields [].
        let value = robust_json_parse("this is not JSON at all", 2, 1, 2)
            .await
            .expect("partial extraction returns an empty array");
        assert_eq!(value, json!([]));
    }
}
