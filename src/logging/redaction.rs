//! Secret redaction and context sanitization. Port of AstroEX-node
//! src/logging/redaction.ts.

use serde_json::{Map, Value};

const MAX_CONTEXT_DEPTH: usize = 6;
const MAX_STRING_LENGTH: usize = 10_000;
const MAX_ARRAY_LENGTH: usize = 100;

fn token_metric_key_pattern() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r"(?i)^(?:(?:max|prompt|completion|total|cached|reasoning)[_-]?tokens?|tokens|tokens?[_-](?:used|count)|token[_-]count|tokensUsed|tokenCount)$",
        )
        .unwrap()
    })
}

fn sensitive_key_pattern() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r"(?i)(?:api[_-]?key|auth|authorization|cookie|password|secret|(?:^|[_-]|auth|access|refresh|bearer|session|id|csrf)token|credential|private[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?id|jwt|cert)",
        )
        .unwrap()
    })
}

/// Whether an object key represents a sensitive credential or secret.
/// Explicitly exempts token count/budget metrics (maxTokens, promptTokens...).
pub fn is_sensitive_key(key: &str) -> bool {
    if token_metric_key_pattern().is_match(key) {
        return false;
    }
    sensitive_key_pattern().is_match(key)
}

/// Sanitize a string by redacting known token and secret patterns.
pub fn sanitize_string(value: &str) -> String {
    if value.is_empty() {
        return value.to_string();
    }
    let mut result = value.to_string();
    static REPLACEMENTS: [(&str, &str); 8] = [
        // URL basic auth: https://user:password@example.com
        (r"(https?://)([^:\s@/]+):([^@\s/]+)@", "$1$2:[redacted]@"),
        // Bearer tokens
        (r"(?i)(Bearer\s+)[a-zA-Z0-9._\-]{10,}", "$1[redacted]"),
        // Basic auth tokens
        (r"(?i)(Basic\s+)[a-zA-Z0-9+/=]{10,}", "$1[redacted]"),
        // OpenRouter API keys
        (r"\bsk-or-v1-[a-f0-9]{64}\b", "sk-or-v1-[redacted]"),
        // OpenAI / Anthropic / standard sk- keys
        (r"\bsk-[a-zA-Z0-9_\-]{20,}\b", "sk-[redacted]"),
        // Google AI API keys
        (r"\bAIza[0-9A-Za-z\-_]{35}\b", "AIza[redacted]"),
        // GitHub tokens
        (r"\bgh[pousr]_[A-Za-z0-9_]{36,255}\b", "gh-[redacted]"),
        // Slack tokens
        (r"\bxox[baprs]-[0-9a-zA-Z]{10,48}\b", "xox-[redacted]"),
    ];
    for (pattern, replacement) in REPLACEMENTS {
        if let Ok(re) = regex::Regex::new(pattern) {
            result = re.replace_all(&result, replacement.to_string()).to_string();
        }
    }
    if result.chars().count() > MAX_STRING_LENGTH {
        let truncated: String = result.chars().take(MAX_STRING_LENGTH).collect();
        return format!("{truncated}\u{2026}[truncated]");
    }
    result
}

/// Deeply sanitize a JSON context value for logging.
pub fn sanitize_json(value: &Value, depth: usize) -> Value {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
        Value::String(s) => Value::String(sanitize_string(s)),
        Value::Array(arr) => {
            if depth >= MAX_CONTEXT_DEPTH {
                return Value::String("[max-depth]".to_string());
            }
            Value::Array(
                arr.iter()
                    .take(MAX_ARRAY_LENGTH)
                    .map(|item| sanitize_json(item, depth + 1))
                    .collect(),
            )
        }
        Value::Object(map) => {
            if depth >= MAX_CONTEXT_DEPTH {
                return Value::String("[max-depth]".to_string());
            }
            let mut out = Map::new();
            for (key, nested) in map {
                if is_sensitive_key(key) {
                    out.insert(key.clone(), Value::String("[redacted]".to_string()));
                } else {
                    out.insert(key.clone(), sanitize_json(nested, depth + 1));
                }
            }
            Value::Object(out)
        }
    }
}

/// Sanitize a logging context map.
pub fn sanitize_context(context: &Map<String, Value>) -> Map<String, Value> {
    match sanitize_json(&Value::Object(context.clone()), 0) {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sensitive_keys_redact_but_token_metrics_survive() {
        for key in [
            "api_key",
            "apiKey",
            "Authorization",
            "password",
            "refresh_token",
            "sessionId",
            "private-key",
        ] {
            assert!(is_sensitive_key(key), "{key} should be sensitive");
        }
        for key in [
            "maxTokens",
            "max_tokens",
            "promptTokens",
            "tokensUsed",
            "tokenCount",
        ] {
            assert!(
                !is_sensitive_key(key),
                "{key} is a token metric and must be exempt"
            );
        }
    }

    #[test]
    fn secret_string_patterns_are_redacted() {
        let openrouter = format!("key=sk-or-v1-{}", "a".repeat(64));
        assert!(sanitize_string(&openrouter).contains("sk-or-v1-[redacted]"));
        assert!(sanitize_string("token sk-abcdefghijklmnopqrstuvwxyz").contains("sk-[redacted]"));
        assert!(sanitize_string(&format!("AIza{}", "A".repeat(35))).contains("AIza[redacted]"));
        assert!(sanitize_string(&format!("ghp_{}", "a".repeat(40))).contains("gh-[redacted]"));
        assert!(sanitize_string("xoxb-1234567890").contains("xox-[redacted]"));
        assert!(sanitize_string("Authorization: Bearer abcdefghijklmnop").contains("[redacted]"));
        assert!(sanitize_string("Basic YWJjZGVmZ2hpamtsbW5vcA==").contains("[redacted]"));
        assert!(sanitize_string("https://user:supersecret@example.com/path")
            .contains("user:[redacted]@example.com"));
    }

    #[test]
    fn nested_context_redacts_sensitive_values_only() {
        let context = json!({
            "apiKey": "secret-value",
            "model": "gpt",
            "usage": { "prompt_tokens": 10, "totalTokens": 20 }
        });
        let sanitized = sanitize_context(context.as_object().unwrap());
        assert_eq!(sanitized["apiKey"], json!("[redacted]"));
        assert_eq!(sanitized["model"], json!("gpt"));
        assert_eq!(sanitized["usage"]["prompt_tokens"], json!(10));
        assert_eq!(sanitized["usage"]["totalTokens"], json!(20));
    }

    #[test]
    fn long_strings_are_truncated_and_arrays_capped() {
        let long = "x".repeat(20_000);
        let sanitized = sanitize_string(&long);
        assert!(sanitized.ends_with("[truncated]"));
        assert!(sanitized.chars().count() < 20_000);

        let array = Value::Array((0..250).map(|i| json!(i)).collect());
        match sanitize_json(&array, 0) {
            Value::Array(values) => assert_eq!(values.len(), MAX_ARRAY_LENGTH),
            other => panic!("expected array, got {other:?}"),
        }
    }

    #[test]
    fn deep_nesting_is_marked_max_depth() {
        let mut value = json!("leaf");
        for _ in 0..(MAX_CONTEXT_DEPTH + 3) {
            value = json!({ "nested": value });
        }
        let sanitized = sanitize_json(&value, 0);
        assert!(sanitized.to_string().contains("[max-depth]"));
    }
}
