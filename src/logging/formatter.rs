//! Pretty/JSON log record formatters. Port of AstroEX-node src/logging/formatter.ts.

use super::fader::{apply_hsv_fade, FadeOptions, GradientKey, GradientMode};
use super::types::LogRecord;
use crate::types::LogLevel;
use serde_json::{Map, Value};

/// Format a duration in milliseconds to a human-readable string.
pub fn format_duration(milliseconds: f64) -> String {
    if milliseconds <= 0.0 {
        return String::new();
    }
    if milliseconds < 1000.0 {
        return format!("{}ms", milliseconds.round());
    }
    let seconds = (milliseconds / 1000.0).floor() as i64;
    let minutes = seconds / 60;
    let remaining_seconds = seconds % 60;
    let mut parts: Vec<String> = Vec::new();
    if minutes > 0 {
        parts.push(format!("{minutes}m"));
    }
    if remaining_seconds > 0 || minutes == 0 {
        parts.push(format!("{remaining_seconds}s"));
    }
    parts.join(" ")
}

/// Format an ISO timestamp to local `YYYY-MM-DD HH:mm:ss`.
pub fn format_timestamp(timestamp: &str) -> String {
    use chrono::{Local, TimeZone};
    let parsed = chrono::DateTime::parse_from_rfc3339(timestamp)
        .or_else(|_| chrono::DateTime::parse_from_rfc3339(&format!("{timestamp}Z")))
        .map(|dt| dt.with_timezone(&Local));
    match parsed {
        Ok(local) => local.format("%Y-%m-%d %H:%M:%S").to_string(),
        Err(_) => {
            // Fallback: interpret as epoch millis if numeric, else use now.
            timestamp
                .parse::<i64>()
                .ok()
                .and_then(|ms| Local.timestamp_millis_opt(ms).single())
                .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_else(|| Local::now().format("%Y-%m-%d %H:%M:%S").to_string())
        }
    }
}

#[allow(dead_code)]
fn level_gradient(level: LogLevel) -> GradientKey {
    match level {
        LogLevel::Trace => GradientKey::Trace,
        LogLevel::Debug => GradientKey::Debug,
        LogLevel::Info => GradientKey::Info,
        LogLevel::Success => GradientKey::Success,
        LogLevel::Warn => GradientKey::Warn,
        LogLevel::Error => GradientKey::Error,
        LogLevel::Fatal => GradientKey::Fatal,
    }
}

fn fade(text: &str, gradient: GradientKey, use_color: bool, bold: bool, dim: bool) -> String {
    apply_hsv_fade(
        text,
        gradient,
        FadeOptions {
            use_color: Some(use_color),
            mode: Some(GradientMode::PerLine),
            bold,
            dim,
            ..Default::default()
        },
    )
}

pub const CONTEXT_KEY_SECTION_BOUNDARY: &str = "_is_section_boundary";

pub fn is_section_boundary(message: &str) -> bool {
    static RE_EQ: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static RE_STAGE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re_eq = RE_EQ.get_or_init(|| regex::Regex::new(r"^={3,}.*={3,}$").unwrap());
    let re_stage = RE_STAGE
        .get_or_init(|| regex::Regex::new(r"^(?:stage \d+(?:\.\d+)?/\d+:|phase \d+:)").unwrap());
    let trimmed = message.trim();
    re_eq.is_match(trimmed)
        || re_stage.is_match(&trimmed.to_lowercase())
        || re_stage.is_match(trimmed)
}

pub fn is_boundary_record(record: &LogRecord) -> bool {
    if let Some(ctx) = &record.context {
        if let Some(val) = ctx
            .get(CONTEXT_KEY_SECTION_BOUNDARY)
            .or_else(|| ctx.get("is_section_boundary"))
        {
            if let Some(b) = val.as_bool() {
                return b;
            }
        }
    }
    is_section_boundary(&record.message)
}

fn format_terminal_context(
    context: Option<&Map<String, Value>>,
    use_color: bool,
) -> (String, String) {
    let Some(context) = context else {
        return (String::new(), String::new());
    };
    if context.is_empty() {
        return (String::new(), String::new());
    }

    let mut inline_parts: Vec<String> = Vec::new();
    let mut multiline_lines: Vec<String> = Vec::new();
    let mut remaining: Vec<(&String, &Value)> = Vec::new();

    for (k, v) in context {
        if k == CONTEXT_KEY_SECTION_BOUNDARY || k == "is_section_boundary" {
            continue;
        }
        if k == "durationMs" {
            if let Some(ms) = v.as_f64() {
                let dur_str = if format_duration(ms).is_empty() {
                    format!("{}ms", ms.round())
                } else {
                    format_duration(ms)
                };
                inline_parts.push(fade(
                    &format!("({dur_str})"),
                    GradientKey::Context,
                    use_color,
                    false,
                    false,
                ));
                continue;
            }
        }
        if k == "error" && v.is_object() {
            let err_obj = v.as_object().unwrap();
            let err_msg = err_obj
                .get("message")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| v.to_string());
            let err_name = err_obj
                .get("name")
                .and_then(|m| m.as_str())
                .unwrap_or("Error")
                .to_string();
            multiline_lines.push(fade(
                &format!("  ↳ {err_name}: {err_msg}"),
                GradientKey::ErrorFallback,
                use_color,
                false,
                false,
            ));
            if let Some(Value::String(stack)) = err_obj.get("stack") {
                for line in stack.split('\n').skip(1).take(4) {
                    multiline_lines.push(fade(
                        &format!("    {}", line.trim()),
                        GradientKey::Context,
                        use_color,
                        false,
                        false,
                    ));
                }
            }
            continue;
        }
        match v {
            Value::String(_) | Value::Number(_) | Value::Bool(_) => {
                let rendered = match v {
                    Value::String(s) if s.contains(' ') => format!("\"{s}\""),
                    Value::String(s) => s.clone(),
                    Value::Bool(b) => b.to_string(),
                    Value::Number(n) => {
                        if let Some(i) = n.as_i64() {
                            i.to_string()
                        } else if let Some(u) = n.as_u64() {
                            u.to_string()
                        } else {
                            let f = n.as_f64().unwrap_or(0.0);
                            format!("{f}")
                        }
                    }
                    _ => v.to_string(),
                };
                let token = format!("{k}={rendered}");
                inline_parts.push(fade(&token, GradientKey::Context, use_color, false, false));
            }
            _ => remaining.push((k, v)),
        }
    }

    if !remaining.is_empty() {
        let mut map = Map::new();
        for (k, v) in remaining {
            map.insert(k.clone(), v.clone());
        }
        if let Ok(serialized) = serde_json::to_string(&Value::Object(map)) {
            inline_parts.push(fade(
                &serialized,
                GradientKey::Context,
                use_color,
                false,
                false,
            ));
        } else {
            inline_parts.push("[complex-context]".to_string());
        }
    }

    let inline = if !inline_parts.is_empty() {
        format!(" {}", inline_parts.join(" "))
    } else {
        String::new()
    };
    let multiline = if !multiline_lines.is_empty() {
        format!("\n{}", multiline_lines.join("\n"))
    } else {
        String::new()
    };
    (inline, multiline)
}

/// Format a LogRecord for terminal output.
pub fn format_terminal(record: &LogRecord, use_color: bool) -> String {
    let timestamp_str = format_timestamp(&record.timestamp);
    let timestamp = fade(
        &timestamp_str,
        GradientKey::Timestamp,
        use_color,
        false,
        false,
    );

    let label = record.level.label();
    let level_badge = if use_color {
        fade(
            &format!("[{label}]"),
            GradientKey::Badge,
            use_color,
            true,
            false,
        )
    } else {
        format!("[{label}]")
    };

    let component_badge = fade(
        &format!("[{}]", record.component),
        GradientKey::Component,
        use_color,
        true,
        false,
    );

    let mut message = record.message.clone();
    if use_color {
        match record.level {
            LogLevel::Error => {
                message = fade(&message, GradientKey::Error, use_color, false, false);
            }
            LogLevel::Fatal => {
                message = fade(&message, GradientKey::Fatal, use_color, false, false);
            }
            LogLevel::Warn => {
                message = fade(&message, GradientKey::Warn, use_color, false, false);
            }
            LogLevel::Success => {
                message = fade(&message, GradientKey::Success, use_color, false, false);
            }
            LogLevel::Debug => {
                message = fade(&message, GradientKey::Debug, use_color, false, false);
            }
            LogLevel::Trace => {
                message = fade(&message, GradientKey::Trace, use_color, false, false);
            }
            LogLevel::Info => {
                if is_boundary_record(record) {
                    message = fade(&message, GradientKey::Info, use_color, false, false);
                }
            }
        }
    }

    let (inline, multiline) = format_terminal_context(record.context.as_ref(), use_color);

    format!("{timestamp} {component_badge} {level_badge} {message}{inline}{multiline}")
}

/// Format a LogRecord as a structured JSON string.
pub fn format_json(record: &LogRecord) -> String {
    let mut out = Map::new();
    out.insert(
        "timestamp".to_string(),
        Value::String(record.timestamp.clone()),
    );
    out.insert(
        "level".to_string(),
        Value::String(record.level.name().to_string()),
    );
    out.insert(
        "component".to_string(),
        Value::String(record.component.clone()),
    );
    out.insert("message".to_string(), Value::String(record.message.clone()));
    if let Some(context) = &record.context {
        if !context.is_empty() {
            out.insert("context".to_string(), Value::Object(context.clone()));
        }
    }
    serde_json::to_string(&Value::Object(out)).unwrap_or_default()
}
