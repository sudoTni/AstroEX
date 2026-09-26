//! OpenRouter usage accounting, ported from AstroEX-node
//! src/openRouterUsage.ts.

use std::collections::HashSet;

use serde_json::Value;

/// Internal billing shape for a single OpenRouter call (validated by
/// `parse_openrouter_usage`).
#[derive(Debug, Clone, PartialEq)]
pub struct OpenRouterCallUsage {
    pub request_id: Option<String>,
    pub timestamp: String,
    pub model: Option<String>,
    pub stage: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub cost_usd: f64,
}

/// Aggregated usage totals for one pipeline execution.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct UsageSummary {
    pub accounted_calls: u64,
    pub unavailable_usage_calls: u64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub cost_usd: f64,
}

/// JavaScript `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn parse_safe_nonneg_int(value: &Value) -> Option<i64> {
    if let Some(i) = value.as_i64() {
        return if (0..=MAX_SAFE_INTEGER as i64).contains(&i) {
            Some(i)
        } else {
            None
        };
    }
    // zod's `int()` accepts integral floats such as 150.0.
    if let Some(f) = value.as_f64() {
        if f.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&f) {
            return Some(f as i64);
        }
    }
    None
}

fn parse_nonneg_finite_f64(value: &Value) -> Option<f64> {
    let f = value.as_f64()?;
    if f.is_finite() && f >= 0.0 {
        Some(f)
    } else {
        None
    }
}

fn parse_nonempty_str(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

/// Convert OpenRouter's OpenAI-compatible wire usage into the internal
/// billing shape without coercing or estimating any values.
///
/// Returns `None` on any missing or invalid field (mirroring the Node
/// schema's `safeParse` failure). `metadata` may optionally carry
/// `requestId`, `timestamp`, `model` and `stage` overrides.
pub fn parse_openrouter_usage(
    raw: &Value,
    metadata: Option<&Value>,
) -> Option<OpenRouterCallUsage> {
    let usage = raw.as_object()?;

    let meta = metadata.and_then(Value::as_object);
    let meta_field = |key: &str| meta.and_then(|m| m.get(key));

    let request_id = meta_field("requestId").and_then(parse_nonempty_str);
    let model = meta_field("model").and_then(parse_nonempty_str);
    let stage = meta_field("stage").and_then(parse_nonempty_str);
    let timestamp = meta_field("timestamp")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));

    Some(OpenRouterCallUsage {
        request_id,
        timestamp,
        model,
        stage,
        input_tokens: parse_safe_nonneg_int(usage.get("prompt_tokens")?)?,
        output_tokens: parse_safe_nonneg_int(usage.get("completion_tokens")?)?,
        total_tokens: parse_safe_nonneg_int(usage.get("total_tokens")?)?,
        cost_usd: parse_nonneg_finite_f64(usage.get("cost")?)?,
    })
}

fn is_valid_usage(usage: &OpenRouterCallUsage) -> bool {
    usage.input_tokens >= 0
        && usage.output_tokens >= 0
        && usage.total_tokens >= 0
        && usage.cost_usd.is_finite()
        && usage.cost_usd >= 0.0
}

/// A compact display formatter; raw numeric values remain in log context.
///
/// Mirrors the Node `formatUsd`: `"$0"` for zero, otherwise the value
/// rounded to 8 significant digits and rendered like a JavaScript number
/// (`Number(value.toPrecision(8)).toString()`).
pub fn format_usd(value: f64) -> String {
    if value == 0.0 {
        return "$0".to_string();
    }
    if value.is_nan() {
        return "$NaN".to_string();
    }
    if value.is_infinite() {
        return if value < 0.0 {
            "$-Infinity".to_string()
        } else {
            "$Infinity".to_string()
        };
    }
    let neg = value < 0.0;
    let body = js_number_string_8_sig_digits(value.abs());
    if neg {
        format!("$-{body}")
    } else {
        format!("${body}")
    }
}

/// Render a positive finite value the way JavaScript renders
/// `Number(v.toPrecision(8)).toString()`.
fn js_number_string_8_sig_digits(a: f64) -> String {
    // 8 significant digits in scientific form: "d.ddddddd e exp"
    let sci = format!("{:.7e}", a);
    let (mantissa, exp_str) = sci.split_once('e').expect("scientific notation");
    let exp: i32 = exp_str.parse().expect("exponent");
    let mut digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    while digits.len() > 1 && digits.ends_with('0') {
        digits.pop();
    }

    // JavaScript Number.prototype.toString switches to exponential notation
    // when the decimal exponent is >= 21 or <= -7.
    let n = digits.len() as i32;
    if exp >= 21 || exp <= -7 {
        let mantissa_str = if n == 1 {
            digits
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        let sign = if exp < 0 { '-' } else { '+' };
        format!("{mantissa_str}e{sign}{}", exp.abs())
    } else if exp >= 0 {
        if n <= exp + 1 {
            let mut s = digits;
            for _ in 0..(exp + 1 - n) {
                s.push('0');
            }
            s
        } else {
            format!(
                "{}.{}",
                &digits[..(exp + 1) as usize],
                &digits[(exp + 1) as usize..]
            )
        }
    } else {
        let mut s = String::from("0.");
        for _ in 0..(-exp - 1) {
            s.push('0');
        }
        s.push_str(&digits);
        s
    }
}

/// Mutable usage state owned by exactly one pipeline execution.
#[derive(Debug, Default)]
pub struct OpenRouterUsageTracker {
    accounting_ids: HashSet<String>,
    accounted_calls: u64,
    unavailable_usage_calls: u64,
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
    cost_usd: f64,
}

impl OpenRouterUsageTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record usage for a call, deduplicating by `call_id`.
    ///
    /// Returns `true` when the call was newly accounted for, `false` when the
    /// `call_id` was already seen or the usage is invalid.
    pub fn record(&mut self, call_id: &str, usage: &OpenRouterCallUsage) -> bool {
        if self.accounting_ids.contains(call_id) {
            return false;
        }
        if !is_valid_usage(usage) {
            return false;
        }
        self.accounting_ids.insert(call_id.to_string());
        self.accounted_calls += 1;
        self.input_tokens += usage.input_tokens;
        self.output_tokens += usage.output_tokens;
        self.total_tokens += usage.total_tokens;
        self.cost_usd += usage.cost_usd;
        true
    }

    /// Mark a call as having completed without authoritative usage; pipeline
    /// totals exclude such calls.
    pub fn mark_usage_unavailable(&mut self) -> UsageSummary {
        self.unavailable_usage_calls += 1;
        self.get_summary()
    }

    pub fn get_summary(&self) -> UsageSummary {
        UsageSummary {
            accounted_calls: self.accounted_calls,
            unavailable_usage_calls: self.unavailable_usage_calls,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            total_tokens: self.total_tokens,
            cost_usd: self.cost_usd,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_raw() -> Value {
        json!({
            "prompt_tokens": 1500,
            "completion_tokens": 320,
            "total_tokens": 1820,
            "cost": 0.00042035
        })
    }

    #[test]
    fn parses_valid_usage() {
        let usage = parse_openrouter_usage(&sample_raw(), None).expect("valid");
        assert_eq!(usage.input_tokens, 1500);
        assert_eq!(usage.output_tokens, 320);
        assert_eq!(usage.total_tokens, 1820);
        assert!((usage.cost_usd - 0.00042035).abs() < 1e-12);
        assert!(usage.request_id.is_none());
        assert!(usage.model.is_none());
        assert!(usage.stage.is_none());
        assert!(!usage.timestamp.is_empty());
    }

    #[test]
    fn parses_usage_with_metadata() {
        let metadata = json!({
            "requestId": "req-123",
            "timestamp": "2026-09-22T00:00:00.000Z",
            "model": "z-ai/glm-5.3-flash",
            "stage": "jobJudge"
        });
        let usage = parse_openrouter_usage(&sample_raw(), Some(&metadata)).expect("valid");
        assert_eq!(usage.request_id.as_deref(), Some("req-123"));
        assert_eq!(usage.timestamp, "2026-09-22T00:00:00.000Z");
        assert_eq!(usage.model.as_deref(), Some("z-ai/glm-5.3-flash"));
        assert_eq!(usage.stage.as_deref(), Some("jobJudge"));
    }

    #[test]
    fn returns_none_for_non_object_usage() {
        assert!(parse_openrouter_usage(&json!(null), None).is_none());
        assert!(parse_openrouter_usage(&json!([]), None).is_none());
        assert!(parse_openrouter_usage(&json!(42), None).is_none());
        assert!(parse_openrouter_usage(&json!("x"), None).is_none());
    }

    #[test]
    fn returns_none_for_missing_fields() {
        let mut raw = sample_raw();
        raw.as_object_mut().unwrap().remove("cost");
        assert!(parse_openrouter_usage(&raw, None).is_none());

        let mut raw = sample_raw();
        raw.as_object_mut().unwrap().remove("prompt_tokens");
        assert!(parse_openrouter_usage(&raw, None).is_none());
    }

    #[test]
    fn returns_none_for_invalid_fields() {
        let raw = json!({
            "prompt_tokens": -1,
            "completion_tokens": 320,
            "total_tokens": 1820,
            "cost": 0.00042035
        });
        assert!(parse_openrouter_usage(&raw, None).is_none());

        let raw = json!({
            "prompt_tokens": 1.5,
            "completion_tokens": 320,
            "total_tokens": 1820,
            "cost": 0.00042035
        });
        assert!(parse_openrouter_usage(&raw, None).is_none());

        let raw = json!({
            "prompt_tokens": "1500",
            "completion_tokens": 320,
            "total_tokens": 1820,
            "cost": 0.00042035
        });
        assert!(parse_openrouter_usage(&raw, None).is_none());

        let raw = json!({
            "prompt_tokens": 1500,
            "completion_tokens": 320,
            "total_tokens": 1820,
            "cost": -0.5
        });
        assert!(parse_openrouter_usage(&raw, None).is_none());

        // Beyond Number.MAX_SAFE_INTEGER is rejected by `.safe()`.
        let raw = json!({
            "prompt_tokens": 9007199254740992i64,
            "completion_tokens": 320,
            "total_tokens": 1820,
            "cost": 0.00042035
        });
        assert!(parse_openrouter_usage(&raw, None).is_none());
    }

    #[test]
    fn accepts_integral_float_token_counts() {
        let raw = json!({
            "prompt_tokens": 1500.0,
            "completion_tokens": 320,
            "total_tokens": 1820,
            "cost": 0.00042035
        });
        let usage = parse_openrouter_usage(&raw, None).expect("valid");
        assert_eq!(usage.input_tokens, 1500);
    }

    #[test]
    fn format_usd_zero_and_typical_values() {
        assert_eq!(format_usd(0.0), "$0");
        assert_eq!(format_usd(-0.0), "$0");
        assert_eq!(format_usd(0.00042035), "$0.00042035");
        assert_eq!(format_usd(123.456), "$123.456");
        assert_eq!(format_usd(0.1 + 0.2), "$0.3");
        assert_eq!(format_usd(1.0), "$1");
        assert_eq!(format_usd(12345678.9), "$12345679");
    }

    #[test]
    fn format_usd_exponential_notation_boundaries() {
        assert_eq!(format_usd(1e20), "$100000000000000000000");
        assert_eq!(format_usd(1e21), "$1e+21");
        assert_eq!(format_usd(0.000001), "$0.000001");
        assert_eq!(format_usd(0.0000001), "$1e-7");
    }

    #[test]
    fn tracker_records_and_deduplicates() {
        let mut tracker = OpenRouterUsageTracker::new();
        let usage = parse_openrouter_usage(&sample_raw(), None).expect("valid");

        assert!(tracker.record("call-1", &usage));
        assert!(!tracker.record("call-1", &usage));

        let summary = tracker.get_summary();
        assert_eq!(summary.accounted_calls, 1);
        assert_eq!(summary.input_tokens, 1500);
        assert_eq!(summary.output_tokens, 320);
        assert_eq!(summary.total_tokens, 1820);
        assert!((summary.cost_usd - 0.00042035).abs() < 1e-12);

        let raw2 = json!({
            "prompt_tokens": 100,
            "completion_tokens": 50,
            "total_tokens": 150,
            "cost": 0.00001
        });
        let usage2 = parse_openrouter_usage(&raw2, None).expect("valid");
        assert!(tracker.record("call-2", &usage2));

        let summary = tracker.get_summary();
        assert_eq!(summary.accounted_calls, 2);
        assert_eq!(summary.input_tokens, 1600);
        assert_eq!(summary.total_tokens, 1970);
        assert!((summary.cost_usd - 0.00043035).abs() < 1e-12);
    }

    #[test]
    fn tracker_marks_usage_unavailable() {
        let mut tracker = OpenRouterUsageTracker::new();
        let summary = tracker.mark_usage_unavailable();
        assert_eq!(summary.unavailable_usage_calls, 1);
        assert_eq!(summary.accounted_calls, 0);
        let summary = tracker.mark_usage_unavailable();
        assert_eq!(summary.unavailable_usage_calls, 2);
    }

    #[test]
    fn tracker_rejects_invalid_usage() {
        let mut tracker = OpenRouterUsageTracker::new();
        let usage = OpenRouterCallUsage {
            request_id: None,
            timestamp: "t".to_string(),
            model: None,
            stage: None,
            input_tokens: -5,
            output_tokens: 0,
            total_tokens: 0,
            cost_usd: 0.0,
        };
        assert!(!tracker.record("call-1", &usage));
        assert_eq!(tracker.get_summary().accounted_calls, 0);
    }
}
