//! LLM request, response, and reasoning formatters. Port of AstroEX-node
//! src/logging/llmFormatter.ts. Produces structured, visually distinct,
//! human-readable terminal blocks for LLM requests, responses, tool calls,
//! and reasoning tokens with intentional HSV gradient framing and robust
//! nested payload formatting.

use super::fader::{apply_hsv_fade, FadeOptions, GradientKey};
use super::redaction::{sanitize_context, sanitize_string};
use serde_json::Value;

fn fade(text: &str, key: GradientKey, use_color: bool, bold: bool, dim: bool) -> String {
    apply_hsv_fade(
        text,
        key,
        FadeOptions {
            use_color: Some(use_color),
            bold,
            dim,
            ..FadeOptions::default()
        },
    )
}

/// Formats an arbitrary value into clean, indented, and safe multiline
/// strings. Masks sensitive data and truncates long strings.
pub fn format_structured_data(value: &Value, indent: usize, max_len: Option<usize>) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(boolean) => boolean.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => {
            let sanitized = sanitize_string(text);
            if let Some(limit) = max_len {
                let total = sanitized.chars().count();
                if total > limit {
                    let sliced: String = sanitized.chars().take(limit).collect();
                    return format!("\"{sliced}... [truncated {} chars]\"", total - limit);
                }
            }
            format!("\"{sanitized}\"")
        }
        Value::Array(items) => {
            if items.is_empty() {
                return "[]".to_string();
            }
            let pad = " ".repeat(indent);
            let inner_pad = " ".repeat(indent + 2);
            let lines: Vec<String> = items
                .iter()
                .map(|item| {
                    format!(
                        "{inner_pad}{},",
                        format_structured_data(item, indent + 2, max_len)
                    )
                })
                .collect();
            format!("[\n{}\n{pad}]", lines.join("\n"))
        }
        Value::Object(map) => {
            if map.is_empty() {
                return "{}".to_string();
            }
            let pad = " ".repeat(indent);
            let inner_pad = " ".repeat(indent + 2);
            let sanitized_entries = sanitize_context(map);
            let lines: Vec<String> = sanitized_entries
                .iter()
                .map(|(key, value)| {
                    format!(
                        "{inner_pad}{key}: {},",
                        format_structured_data(value, indent + 2, max_len)
                    )
                })
                .collect();
            format!("{{\n{}\n{pad}}}", lines.join("\n"))
        }
    }
}

/// Formats a complete LLM request with structured border framing and request
/// gradient. The payload carries the request fields (messages, tools,
/// parameters) using the same camelCase keys as the TypeScript port.
pub fn format_llm_request(
    provider: &str,
    model: &str,
    request_id: &str,
    payload: &Value,
    max_payload_length: Option<usize>,
) -> String {
    let use_color = crate::logging::use_color();

    let mut header_text = format!("╭─ LLM REQUEST [{provider}/{model}]");
    if !request_id.is_empty() {
        header_text.push_str(&format!(" (id: {request_id})"));
    }
    let header = fade(&header_text, GradientKey::Request, use_color, true, false);
    let border = |glyph: &str| fade(glyph, GradientKey::Request, use_color, false, false);

    let mut lines: Vec<String> = vec![header];

    let mut params: Vec<String> = Vec::new();
    if let Some(temperature) = payload.get("temperature").filter(|v| v.is_number()) {
        params.push(format!("temperature={temperature}"));
    }
    if let Some(top_p) = payload.get("topP").filter(|v| v.is_number()) {
        params.push(format!("topP={top_p}"));
    }
    if let Some(max_tokens) = payload.get("maxTokens").filter(|v| v.is_number()) {
        params.push(format!("maxTokens={max_tokens}"));
    }
    if let Some(timeout) = payload.get("timeout").filter(|v| v.is_number()) {
        params.push(format!("timeout={timeout}ms"));
    }
    if let Some(reasoning_effort) = payload.get("reasoning_effort").and_then(Value::as_str) {
        if !reasoning_effort.is_empty() {
            params.push(format!("reasoning_effort={reasoning_effort}"));
        }
    }
    if provider == "openrouter" {
        if let Some(Value::Object(routing)) = payload.get("providerRouting") {
            for (key, label) in [
                ("only", "provider.only"),
                ("ignore", "provider.ignore"),
                ("quantizations", "provider.quantizations"),
            ] {
                if let Some(Value::Array(list)) = routing.get(key) {
                    if !list.is_empty() {
                        let entries: Vec<&str> = list.iter().filter_map(Value::as_str).collect();
                        params.push(format!("{label}={}", entries.join(",")));
                    }
                }
            }
        }
    }

    let params_line = if params.is_empty() {
        "default".to_string()
    } else {
        params.join(", ")
    };
    lines.push(format!("{} Parameters: {params_line}", border("│")));

    if payload
        .get("responseSchema")
        .map(is_truthy)
        .unwrap_or(false)
    {
        lines.push(format!(
            "{} Response Schema: [Configured Object Schema]",
            border("│")
        ));
    }

    if let Some(messages) = payload.get("messages").and_then(Value::as_array) {
        if !messages.is_empty() {
            let divider = fade(
                &format!("├─ Messages ({})", messages.len()),
                GradientKey::Request,
                use_color,
                true,
                false,
            );
            lines.push(divider);

            for (index, message) in messages.iter().enumerate() {
                let role = message.get("role").and_then(Value::as_str).unwrap_or("");
                let role_label = fade(
                    &format!("[{}]", role.to_uppercase()),
                    GradientKey::Request,
                    use_color,
                    false,
                    true,
                );
                lines.push(format!(
                    "{} {role_label} (Message #{}):",
                    border("│"),
                    index + 1
                ));

                let content = message.get("content").and_then(Value::as_str).unwrap_or("");
                for content_line in sanitize_string(content).split('\n') {
                    lines.push(format!("{}   {content_line}", border("│")));
                }
            }
        }
    }

    if let Some(tools) = payload.get("tools").filter(|v| v.is_array()) {
        let count = tools.as_array().map(Vec::len).unwrap_or(0);
        if count > 0 {
            let divider = fade(
                &format!("├─ Tools ({count} available)"),
                GradientKey::Request,
                use_color,
                true,
                false,
            );
            lines.push(divider);
            let formatted = format_structured_data(tools, 2, max_payload_length);
            for tool_line in formatted.split('\n') {
                lines.push(format!("{}   {tool_line}", border("│")));
            }
        }
    }

    lines.push(fade("╰─", GradientKey::Request, use_color, false, false));
    lines.join("\n")
}

/// Formats a complete LLM response with structured border framing and
/// response gradient. The response carries the response fields
/// (responseId, finishReason, usage, toolCalls, content) using the same
/// camelCase keys as the TypeScript port.
pub fn format_llm_response(
    provider: &str,
    model: &str,
    response: &Value,
    duration_ms: Option<u64>,
    max_payload_length: Option<usize>,
) -> String {
    let use_color = crate::logging::use_color();

    let usage = response.get("usage").filter(|v| v.is_object());
    let total_tokens = usage
        .and_then(|u| first_present(u, &["totalTokens", "total_tokens"]).filter(|v| v.is_number()));
    let mut meta_parts: Vec<String> = Vec::new();
    if let Some(duration) = duration_ms {
        meta_parts.push(format!("{duration}ms"));
    }
    if let Some(total) = total_tokens {
        meta_parts.push(format!("{total} tokens"));
    }
    let meta = meta_parts.join(", ");

    let mut header_text = format!("╭─ LLM RESPONSE [{provider}/{model}]");
    if !meta.is_empty() {
        header_text.push_str(&format!(" ({meta})"));
    }
    let header = fade(&header_text, GradientKey::Response, use_color, true, false);
    let border = |glyph: &str| fade(glyph, GradientKey::Response, use_color, false, false);

    let mut lines: Vec<String> = vec![header];

    if let Some(response_id) = response.get("responseId").and_then(Value::as_str) {
        if !response_id.is_empty() {
            lines.push(format!("{} Response ID: {response_id}", border("│")));
        }
    }
    if let Some(finish_reason) = response.get("finishReason").and_then(Value::as_str) {
        if !finish_reason.is_empty() {
            lines.push(format!("{} Finish Reason: {finish_reason}", border("│")));
        }
    }

    if let Some(usage_value) = usage {
        let mut usage_parts: Vec<String> = Vec::new();
        let mut push_usage = |label: &str, keys: &[&str]| {
            if let Some(value) = first_present(usage_value, keys).filter(|v| v.is_number()) {
                usage_parts.push(format!("{label}={value}"));
            }
        };
        push_usage("prompt", &["promptTokens", "prompt_tokens"]);
        push_usage("completion", &["completionTokens", "completion_tokens"]);
        push_usage("total", &["totalTokens", "total_tokens"]);
        push_usage("cached", &["cachedTokens", "cached_tokens"]);
        push_usage("reasoning", &["reasoningTokens", "reasoning_tokens"]);
        if !usage_parts.is_empty() {
            lines.push(format!(
                "{} Token Usage: {}",
                border("│"),
                usage_parts.join(", ")
            ));
        }
    }

    if let Some(tool_calls) = response.get("toolCalls").and_then(Value::as_array) {
        if !tool_calls.is_empty() {
            let divider = fade(
                &format!("├─ Tool Calls ({})", tool_calls.len()),
                GradientKey::ToolCall,
                use_color,
                true,
                false,
            );
            lines.push(divider);
            for tool_call in tool_calls {
                let name = tool_call.get("name").and_then(Value::as_str).unwrap_or("");
                let id_suffix = match tool_call.get("id").and_then(Value::as_str) {
                    Some(id) if !id.is_empty() => format!(" (callId: {id})"),
                    _ => String::new(),
                };
                lines.push(format!("{}   Function: {name}{id_suffix}", border("│")));
                let arguments = tool_call.get("arguments").cloned().unwrap_or(Value::Null);
                let formatted = format_structured_data(&arguments, 4, max_payload_length);
                for argument_line in formatted.split('\n') {
                    lines.push(format!("{}     {argument_line}", border("│")));
                }
            }
        }
    }

    let omit_content = response.get("omitContent").map(is_truthy).unwrap_or(false);
    let content_streamed = response
        .get("contentStreamed")
        .map(is_truthy)
        .unwrap_or(false);
    if omit_content || content_streamed {
        lines.push(format!("{} Content: [Streamed live above]", border("│")));
    } else {
        lines.push(fade(
            "├─ Content",
            GradientKey::Response,
            use_color,
            true,
            false,
        ));
        if let Some(content) = response.get("content") {
            if let Value::String(text) = content {
                for content_line in sanitize_string(text).split('\n') {
                    lines.push(format!("{}   {content_line}", border("│")));
                }
            } else {
                let formatted = format_structured_data(content, 2, max_payload_length);
                for content_line in formatted.split('\n') {
                    lines.push(format!("{}   {content_line}", border("│")));
                }
            }
        }
    }

    lines.push(fade("╰─", GradientKey::Response, use_color, false, false));
    lines.join("\n")
}

/// Formats reasoning content or token diagnostics with the reasoning gradient.
/// Port of `formatReasoningBlock`: the header optionally carries the
/// `[provider/model]` label and a `(N tokens)` suffix, and the body prefers
/// summary/content over the provider-reported token notice.
pub fn format_reasoning_block(
    provider: Option<&str>,
    model: Option<&str>,
    reasoning_content: Option<&str>,
    reasoning_summary: Option<&str>,
    reasoning_tokens: Option<u64>,
) -> String {
    let use_color = crate::logging::use_color();

    let model_label = [provider, model]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    let mut header_text = "╭─ REASONING".to_string();
    if !model_label.is_empty() {
        header_text.push_str(&format!(" [{model_label}]"));
    }
    if let Some(tokens) = reasoning_tokens {
        header_text.push_str(&format!(" ({tokens} tokens)"));
    }
    let header = fade(&header_text, GradientKey::Reasoning, use_color, true, false);
    let border = |glyph: &str| fade(glyph, GradientKey::Reasoning, use_color, false, false);

    let mut lines: Vec<String> = vec![header];

    if let Some(summary) = reasoning_summary.filter(|summary| !summary.is_empty()) {
        lines.push(format!(
            "{} Summary: {}",
            border("│"),
            sanitize_string(summary)
        ));
    }

    if let Some(content) = reasoning_content.filter(|content| !content.is_empty()) {
        for content_line in sanitize_string(content).split('\n') {
            lines.push(format!("{}   {content_line}", border("│")));
        }
    } else if let Some(tokens) = reasoning_tokens {
        if reasoning_summary.is_none() {
            lines.push(format!(
                "{}   (Provider reported {tokens} reasoning tokens consumed during inference)",
                border("│")
            ));
        }
    }

    lines.push(fade("╰─", GradientKey::Reasoning, use_color, false, false));
    lines.join("\n")
}

/// Formats a tool execution call with toolCall gradient.
pub fn format_tool_call_block(
    tool_name: &str,
    call_id: Option<&str>,
    arguments: Option<&Value>,
    max_payload_length: Option<usize>,
) -> String {
    let use_color = crate::logging::use_color();

    let mut header_text = format!("╭─ TOOL CALL [{tool_name}]");
    if let Some(call_id) = call_id.filter(|id| !id.is_empty()) {
        header_text.push_str(&format!(" (id: {call_id})"));
    }
    let header = fade(&header_text, GradientKey::ToolCall, use_color, true, false);
    let border = |glyph: &str| fade(glyph, GradientKey::ToolCall, use_color, false, false);

    let mut lines: Vec<String> = vec![header];

    if let Some(arguments) = arguments {
        lines.push(format!("{} Arguments:", border("│")));
        let formatted = format_structured_data(arguments, 2, max_payload_length);
        for argument_line in formatted.split('\n') {
            lines.push(format!("{}   {argument_line}", border("│")));
        }
    }

    lines.push(fade("╰─", GradientKey::ToolCall, use_color, false, false));
    lines.join("\n")
}

/// Formats a tool execution result with toolResult gradient.
pub fn format_tool_result_block(
    tool_name: &str,
    duration_ms: Option<u64>,
    result: Option<&Value>,
    error: Option<&str>,
    max_payload_length: Option<usize>,
) -> String {
    let use_color = crate::logging::use_color();

    let duration_suffix = duration_ms
        .map(|duration| format!(" ({duration}ms)"))
        .unwrap_or_default();
    let header_text = format!("╭─ TOOL RESULT [{tool_name}]{duration_suffix}");
    let header = fade(
        &header_text,
        GradientKey::ToolResult,
        use_color,
        true,
        false,
    );
    let border = |glyph: &str| fade(glyph, GradientKey::ToolResult, use_color, false, false);

    let mut lines: Vec<String> = vec![header];

    if let Some(error_message) = error.filter(|message| !message.is_empty()) {
        lines.push(format!("{} Status: ERROR", border("│")));
        lines.push(format!("{} Error: {error_message}", border("│")));
    } else {
        lines.push(format!("{} Status: SUCCESS", border("│")));
    }

    if let Some(result) = result {
        lines.push(format!("{} Result:", border("│")));
        let formatted = format_structured_data(result, 2, max_payload_length);
        for result_line in formatted.split('\n') {
            lines.push(format!("{}   {result_line}", border("│")));
        }
    }

    lines.push(fade("╰─", GradientKey::ToolResult, use_color, false, false));
    lines.join("\n")
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(boolean) => *boolean,
        Value::Number(number) => number.as_f64().map(|n| n != 0.0).unwrap_or(true),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// First non-null value among the given keys (JS nullish coalescing).
fn first_present<'a>(object: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    for key in keys {
        if let Some(value) = object.get(key) {
            if !value.is_null() {
                return Some(value);
            }
        }
    }
    None
}
