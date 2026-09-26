//! OpenAI-compatible chat-completion transport used for the
//! openai/openrouter/cerebras/poe providers. Port of `callOpenAI`/`callPOE`
//! in AstroEX-node src/llmService.ts (streaming lives in `stream.rs`; the
//! repetition-retry/fallback loop around the stream lives here).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::context::RunContext;
use crate::error::{AppError, Result};
use crate::llm::service::{LlmRequest, LlmResponse, ProviderConfig};
use crate::llm::stream::stream_openai_compatible;
use crate::llm::usage::{parse_openrouter_usage, OpenRouterUsageTracker};
use crate::logging::{self, llm_formatter};
use crate::types::{LogLevel, Provider};

/// Error code for OpenRouter responses that completed without authoritative
/// usage data while a usage tracker is active (Node: the
/// `OpenRouterUsageUnavailableError` class name).
pub const OPENROUTER_USAGE_UNAVAILABLE: &str = "OPENROUTER_USAGE_UNAVAILABLE";

/// options.maxRepetitionRetries default from the Node streaming path.
const MAX_REPETITION_RETRIES: u32 = 1;
/// Delay before retrying a stream after pathological repetition.
const REPETITION_RETRY_DELAY_MS: u64 = 1000;

/// Shared HTTP client (no global timeout; per-request timeouts are applied
/// on each call). Every request made through this client automatically
/// includes the `HTTP-Referer` and `X-Title` identification headers
/// required by OpenRouter and compatible LLM APIs.
pub(crate) fn shared_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            "HTTP-Referer",
            reqwest::header::HeaderValue::from_static("https://github.com/sudoTni/AstroOM"),
        );
        headers.insert(
            "X-Title",
            reqwest::header::HeaderValue::from_static("AstroOM"),
        );
        reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .expect("Failed to build shared LLM HTTP client")
    })
}

/// Build the JSON body for an OpenAI-compatible chat-completion request.
///
/// * `streaming` adds `stream: true` plus, when `include_usage` is set
///   (openrouter + active tracker), `stream_options: {include_usage: true}`.
/// * `response_format: {type: "json_object"}` is only added for the
///   providers whose JSON mode is honored (openai and poe).
/// * OpenRouter provider routing is passed through as the `provider` body
///   field.
pub fn build_request_body(
    provider: Provider,
    request: &LlmRequest,
    streaming: bool,
    include_usage: bool,
) -> Value {
    let mut body = json!({
        "model": request.model,
        "messages": request
            .messages
            .iter()
            .map(|message| json!({"role": message.role, "content": message.content}))
            .collect::<Vec<_>>(),
        "temperature": request.temperature,
        "top_p": request.top_p,
        "max_tokens": request.max_tokens,
    });
    let object = body.as_object_mut().expect("body is an object");

    if streaming {
        object.insert("stream".to_string(), json!(true));
        if include_usage {
            object.insert("stream_options".to_string(), json!({"include_usage": true}));
        }
    }
    if request.json_mode && matches!(provider, Provider::Openai | Provider::Poe) {
        object.insert(
            "response_format".to_string(),
            json!({"type": "json_object"}),
        );
    }
    if let Some(effort) = request
        .reasoning_effort
        .as_deref()
        .filter(|effort| !effort.is_empty())
    {
        object.insert("reasoning_effort".to_string(), json!(effort));
    }
    if provider == Provider::Openrouter {
        if let Some(routing) = &request.provider_routing {
            let mut routing = routing.clone();
            routing.normalize();
            if let Ok(routing_value) = serde_json::to_value(&routing) {
                object.insert("provider".to_string(), routing_value);
            }
        }
    }
    body
}

/// Send the (already built) chat-completion body and await the full JSON
/// response. Aborts cooperatively when `ctx.cancellation` fires and applies
/// the shared LLM HTTP timeout.
async fn send_chat_completion(
    ctx: &RunContext,
    provider_config: &ProviderConfig,
    body: &Value,
) -> Result<Value> {
    let url = format!(
        "{}/chat/completions",
        provider_config.base_url.trim_end_matches('/')
    );
    let send = shared_client()
        .post(&url)
        .bearer_auth(&provider_config.api_key)
        .timeout(Duration::from_millis(crate::constants::LLM_HTTP_TIMEOUT_MS))
        .json(body)
        .send();
    let response = tokio::select! {
        sent = send => sent,
        _ = ctx.cancellation.cancelled() => {
            return Err(AppError::message("Pipeline cancelled before operation started"));
        }
    }?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let snippet: String = text.chars().take(500).collect();
        return Err(AppError::new(
            "LLM_CALL_FAILED",
            status.as_u16(),
            format!("Provider API error (HTTP {}): {}", status.as_u16(), snippet),
        ));
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| AppError::new("LLM_CALL_FAILED", 500, error.to_string()))
}

/// Result of parsing a non-streaming response body: the response plus a flag
/// telling the caller that the provider returned no usage object.
pub struct NonStreamingOutcome {
    pub response: LlmResponse,
    pub usage_missing: bool,
}

/// Parse a non-streaming chat-completion JSON body into an
/// [`LlmResponse`]. Pure: tracker handling for missing usage is done by the
/// caller. Truncates the content and clamps the reported total when the
/// reported token usage exceeds the request's `max_tokens`.
pub fn parse_non_streaming_response(
    request: &LlmRequest,
    response_body: &Value,
    _max_payload_length: Option<usize>,
) -> NonStreamingOutcome {
    let provider_label = if request.provider == Provider::Poe {
        "POE"
    } else {
        "OpenAI"
    };

    let choice = response_body.get("choices").and_then(|c| c.get(0));
    let message = choice.and_then(|c| c.get("message"));
    let content = message
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let reasoning_text = ["reasoning_content", "reasoning", "thinking"]
        .iter()
        .find_map(|key| {
            message
                .and_then(|m| m.get(*key))
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
        });

    if request.show_reasoning_tokens {
        if let Some(reasoning) = reasoning_text.filter(|r| !r.is_empty()) {
            let provider_name = request.provider.to_string();
            let block = llm_formatter::format_reasoning_block(
                Some(provider_name.as_str()),
                Some(request.model.as_str()),
                Some(reasoning),
                None,
                None,
            );
            logging::debug("LLMService", &format!("\n{block}"));
        }
    }

    let usage = response_body.get("usage").filter(|u| u.is_object());
    if usage.is_none() {
        return NonStreamingOutcome {
            response: LlmResponse {
                content,
                reasoning_content: reasoning_text.map(str::to_owned),
                finish_reason: choice
                    .and_then(|c| c.get("finish_reason"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                token_usage: Default::default(),
                usage: None,
                response_id: response_body
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                model: Some(
                    response_body
                        .get("model")
                        .and_then(Value::as_str)
                        .filter(|m| !m.is_empty())
                        .unwrap_or(&request.model)
                        .to_string(),
                ),
            },
            usage_missing: true,
        };
    }
    let usage = usage.expect("usage checked above");

    let total_tokens_used = usage
        .get("total_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let mut content = content;
    if request.max_tokens > 0 && total_tokens_used > request.max_tokens as i64 {
        logging::log_kv(
            "LLMService",
            &format!(
                "{provider_label} exceeded maxTokens: requested {}, used {}",
                request.max_tokens, total_tokens_used
            ),
            LogLevel::Warn,
            &[
                ("provider", json!(request.provider.to_string())),
                ("model", json!(request.model)),
                ("requestedMaxTokens", json!(request.max_tokens)),
                ("actualTokensUsed", json!(total_tokens_used)),
                (
                    "overage",
                    json!(total_tokens_used - request.max_tokens as i64),
                ),
            ],
        );

        let truncated = crate::llm::service::LlmService::truncate_response_to_max_tokens(
            &content,
            request.max_tokens,
        );
        if truncated != content {
            logging::log_kv(
                "LLMService",
                &format!("Truncated {provider_label} response to respect maxTokens limit"),
                LogLevel::Info,
                &[
                    ("provider", json!(request.provider.to_string())),
                    ("model", json!(request.model)),
                    ("originalTokens", json!(total_tokens_used)),
                    (
                        "truncatedTokens",
                        json!(crate::llm::service::LlmService::estimate_token_count(
                            &truncated
                        )),
                    ),
                ],
            );
            content = truncated;
        }
    }

    // Reasoning tokens (usage.completion_tokens_details.reasoning_tokens).
    let reasoning_tokens = usage
        .get("completion_tokens_details")
        .and_then(|details| details.get("reasoning_tokens"))
        .and_then(Value::as_i64);

    // Generic presentation usage for every provider: Node reports the raw
    // prompt/completion counts and clamps only the reported total to
    // `maxTokens || totalTokensUsed`.
    let presentation_usage = crate::llm::service::TokenUsage {
        prompt_tokens: usage
            .get("prompt_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        completion_tokens: usage
            .get("completion_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        total_tokens: if request.max_tokens > 0 {
            total_tokens_used.min(request.max_tokens as i64)
        } else {
            total_tokens_used
        },
        reasoning_tokens,
    };

    // OpenRouter billing usage is tracked unclamped (Node's `billingUsage`).
    let billing_usage = if request.provider == Provider::Openrouter {
        let mut metadata = Map::new();
        if let Some(id) = response_body
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            metadata.insert("requestId".to_string(), json!(id));
        }
        metadata.insert(
            "model".to_string(),
            json!(response_body
                .get("model")
                .and_then(Value::as_str)
                .filter(|m| !m.is_empty())
                .unwrap_or(&request.model)),
        );
        if let Some(stage) = &request.stage {
            metadata.insert("stage".to_string(), json!(stage));
        }
        parse_openrouter_usage(usage, Some(&Value::Object(metadata)))
    } else {
        None
    };

    NonStreamingOutcome {
        response: LlmResponse {
            content,
            reasoning_content: reasoning_text.map(str::to_owned),
            finish_reason: choice
                .and_then(|c| c.get("finish_reason"))
                .and_then(Value::as_str)
                .map(str::to_string),
            token_usage: presentation_usage,
            usage: billing_usage,
            response_id: response_body
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string),
            model: Some(
                response_body
                    .get("model")
                    .and_then(Value::as_str)
                    .filter(|m| !m.is_empty())
                    .unwrap_or(&request.model)
                    .to_string(),
            ),
        },
        usage_missing: false,
    }
}

/// Make an OpenAI-compatible chat-completion call for the
/// openai/openrouter/cerebras/poe providers, with the Node streaming
/// behavior: when reasoning tokens or the response stream are shown, first
/// attempt SSE streaming (retrying once after pathological repetition, then
/// falling back to non-streaming on other stream errors); otherwise use the
/// plain non-streaming JSON path.
pub async fn call_openai_compatible(
    ctx: &RunContext,
    provider_config: &ProviderConfig,
    request: &LlmRequest,
    tracker: Option<&Arc<Mutex<OpenRouterUsageTracker>>>,
) -> Result<LlmResponse> {
    if request.show_reasoning_tokens || request.show_response_stream {
        let include_usage = request.provider == Provider::Openrouter && tracker.is_some();
        let body = build_request_body(request.provider, request, true, include_usage);

        for attempt in 0..=MAX_REPETITION_RETRIES {
            match stream_openai_compatible(ctx, provider_config, request, &body, attempt).await {
                Ok(response) => {
                    if !response.content.is_empty() {
                        return Ok(response);
                    }
                    // Stream completed without content: fall back to a
                    // non-streaming request (Node breaks the attempt loop).
                    break;
                }
                Err(error) => {
                    if error.code == "PATHOLOGICAL_REASONING_REPETITION" {
                        if attempt < MAX_REPETITION_RETRIES {
                            logging::warn(
                                "LLMService",
                                &format!(
                                    "Retrying LLM stream after pathological reasoning repetition (attempt {} of {})...",
                                    attempt + 1,
                                    MAX_REPETITION_RETRIES
                                ),
                            );
                            crate::context::abortable_delay(
                                REPETITION_RETRY_DELAY_MS,
                                &ctx.cancellation,
                            )
                            .await?;
                            if ctx.cancellation.is_cancelled() {
                                return Err(AppError::message(
                                    "Pipeline cancelled before operation started",
                                ));
                            }
                            continue;
                        }
                        logging::error(
                            "LLMService",
                            &format!(
                                "Pathological reasoning repetition retries exhausted ({}/{}). Aborting request.",
                                attempt + 1,
                                MAX_REPETITION_RETRIES + 1
                            ),
                        );
                        return Err(error);
                    }

                    logging::warn(
                        "LLMService",
                        &format!(
                            "Streaming error, falling back to non-streaming: {}",
                            error.message
                        ),
                    );
                    break;
                }
            }
        }
    }

    let body = build_request_body(request.provider, request, false, false);
    let response_body = send_chat_completion(ctx, provider_config, &body).await?;
    let outcome = parse_non_streaming_response(
        request,
        &response_body,
        ctx.diagnostics.log_max_payload_length,
    );

    if outcome.usage_missing {
        // Node only raises the OpenRouter usage-unavailable identity while a
        // usage tracker is active; otherwise it throws a generic error.
        if request.provider == Provider::Openrouter {
            if let Some(tracker) = tracker {
                let mut guard = tracker.lock().unwrap_or_else(|e| e.into_inner());
                let totals = guard.mark_usage_unavailable();
                drop(guard);
                logging::log_kv(
                    "LLMService",
                    "OpenRouter response completed without usage metadata; pipeline totals exclude this call.",
                    LogLevel::Warn,
                    &[
                        ("event", json!("openrouter.usage.unavailable")),
                        ("model", json!(request.model)),
                        (
                            "unavailableUsageCalls",
                            json!(totals.unavailable_usage_calls),
                        ),
                    ],
                );
                return Err(AppError::new(
                    OPENROUTER_USAGE_UNAVAILABLE,
                    500,
                    "No usage information returned from OpenRouter API",
                ));
            }
        }
        let message = if request.provider == Provider::Poe {
            "No usage information returned from POE API"
        } else {
            "No usage information returned from OpenAI API"
        };
        return Err(AppError::message(message));
    }

    Ok(outcome.response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::service::ChatMessage;
    use crate::types::ProviderRouting;

    fn request(provider: Provider) -> LlmRequest {
        LlmRequest {
            provider,
            model: "test-model".to_string(),
            messages: vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: "sys".to_string(),
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: "hi".to_string(),
                },
            ],
            ..LlmRequest::default()
        }
    }

    #[test]
    fn builds_base_body_with_wire_fields() {
        let body = build_request_body(Provider::Openai, &request(Provider::Openai), false, false);
        assert_eq!(body["model"], "test-model");
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["content"], "hi");
        assert_eq!(body["temperature"], 0.6);
        assert_eq!(body["top_p"], 0.95);
        assert_eq!(body["max_tokens"], 16000);
        assert!(body.get("stream").is_none());
        assert!(body.get("response_format").is_none());
        assert!(body.get("reasoning_effort").is_none());
        assert!(body.get("provider").is_none());
    }

    #[test]
    fn streaming_body_gates_stream_options_on_usage() {
        let request = request(Provider::Openrouter);
        let with_usage = build_request_body(Provider::Openrouter, &request, true, true);
        assert_eq!(with_usage["stream"], true);
        assert_eq!(with_usage["stream_options"]["include_usage"], true);

        let without_usage = build_request_body(Provider::Openrouter, &request, true, false);
        assert!(without_usage.get("stream_options").is_none());

        let non_streaming = build_request_body(Provider::Openrouter, &request, false, true);
        assert!(non_streaming.get("stream").is_none());
        assert!(non_streaming.get("stream_options").is_none());
    }

    #[test]
    fn response_format_only_for_openai_and_poe_json_mode() {
        let mut req = request(Provider::Openai);
        req.json_mode = true;
        assert_eq!(
            build_request_body(Provider::Openai, &req, false, false)["response_format"],
            json!({"type": "json_object"})
        );

        let mut req = request(Provider::Poe);
        req.json_mode = true;
        assert_eq!(
            build_request_body(Provider::Poe, &req, false, false)["response_format"],
            json!({"type": "json_object"})
        );

        let mut req = request(Provider::Openrouter);
        req.json_mode = true;
        assert!(build_request_body(Provider::Openrouter, &req, false, false)
            .get("response_format")
            .is_none());

        let req = request(Provider::Openai);
        assert!(build_request_body(Provider::Openai, &req, false, false)
            .get("response_format")
            .is_none());
    }

    #[test]
    fn reasoning_effort_included_only_when_non_empty() {
        let mut req = request(Provider::Openai);
        req.reasoning_effort = Some("high".to_string());
        assert_eq!(
            build_request_body(Provider::Openai, &req, false, false)["reasoning_effort"],
            "high"
        );

        let mut req = request(Provider::Openai);
        req.reasoning_effort = Some(String::new());
        assert!(build_request_body(Provider::Openai, &req, false, false)
            .get("reasoning_effort")
            .is_none());

        let mut req = request(Provider::Openai);
        req.reasoning_effort = None;
        assert!(build_request_body(Provider::Openai, &req, false, false)
            .get("reasoning_effort")
            .is_none());
    }

    #[test]
    fn provider_routing_only_for_openrouter() {
        let routing = ProviderRouting {
            order: Some(vec!["z-ai".to_string()]),
            only: Some(vec!["z-ai".to_string()]),
            quantizations: Some(vec!["bf16".to_string()]),
            allow_fallbacks: Some(false),
            ..Default::default()
        };

        let mut req = request(Provider::Openrouter);
        req.provider_routing = Some(routing.clone());
        let body = build_request_body(Provider::Openrouter, &req, false, false);
        assert_eq!(body["provider"]["order"], json!(["z-ai"]));
        assert_eq!(body["provider"]["only"], json!(["z-ai"]));
        assert_eq!(body["provider"]["allow_fallbacks"], json!(false));
        assert_eq!(body["provider"]["quantizations"], json!(["bf16"]));
        assert!(body["provider"].get("ignore").is_none());

        let mut req = request(Provider::Openai);
        req.provider_routing = Some(routing);
        let body = build_request_body(Provider::Openai, &req, false, false);
        assert!(body.get("provider").is_none());
    }

    #[test]
    fn provider_routing_normalizes_order_and_allow_fallbacks() {
        let routing = ProviderRouting {
            order: Some(vec!["mismatched".to_string()]),
            only: Some(vec!["z-ai".to_string()]),
            allow_fallbacks: Some(true),
            ..Default::default()
        };

        let mut req = request(Provider::Openrouter);
        req.provider_routing = Some(routing);
        let body = build_request_body(Provider::Openrouter, &req, false, false);
        assert_eq!(body["provider"]["order"], json!(["z-ai"]));
        assert_eq!(body["provider"]["only"], json!(["z-ai"]));
        assert_eq!(body["provider"]["allow_fallbacks"], json!(false));
    }

    #[test]
    fn parses_non_streaming_response_fields() {
        let body = json!({
            "id": "chatcmpl-123",
            "model": "gpt-test",
            "choices": [{
                "message": {
                    "content": "Hello!",
                    "reasoning_content": "thinking hard"
                },
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120, "cost": 0.002}
        });
        let outcome = parse_non_streaming_response(&request(Provider::Openai), &body, None);
        assert!(!outcome.usage_missing);
        let response = outcome.response;
        assert_eq!(response.content, "Hello!");
        assert_eq!(response.reasoning_content.as_deref(), Some("thinking hard"));
        assert_eq!(response.finish_reason.as_deref(), Some("stop"));
        assert_eq!(response.response_id.as_deref(), Some("chatcmpl-123"));
        assert_eq!(response.model.as_deref(), Some("gpt-test"));
        assert!(response.usage.is_none(), "billing usage is openrouter-only");
    }

    #[test]
    fn parses_openrouter_billing_usage_with_metadata() {
        let body = json!({
            "id": "gen-1",
            "model": "z-ai/glm-5.3",
            "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1500, "completion_tokens": 320, "total_tokens": 1820, "cost": 0.00042035}
        });
        let mut req = request(Provider::Openrouter);
        req.stage = Some("jobJudge".to_string());
        let outcome = parse_non_streaming_response(&req, &body, None);
        let usage = outcome.response.usage.expect("billing usage");
        assert_eq!(usage.input_tokens, 1500);
        assert_eq!(usage.output_tokens, 320);
        assert_eq!(usage.total_tokens, 1820);
        assert_eq!(usage.request_id.as_deref(), Some("gen-1"));
        assert_eq!(usage.model.as_deref(), Some("z-ai/glm-5.3"));
        assert_eq!(usage.stage.as_deref(), Some("jobJudge"));
    }

    #[test]
    fn missing_usage_flags_outcome() {
        let body = json!({
            "id": "x",
            "choices": [{"message": {"content": "hi"}, "finish_reason": "stop"}]
        });
        let outcome = parse_non_streaming_response(&request(Provider::Openai), &body, None);
        assert!(outcome.usage_missing);
        assert_eq!(outcome.response.content, "hi");
    }

    #[test]
    fn truncates_content_and_clamps_presentation_total_when_over_max_tokens() {
        let content =
            "Sentence one that is fairly long. Sentence two follows here. Sentence three.";
        let mut req = request(Provider::Openai);
        req.max_tokens = 3; // 12 characters
        let body = json!({
            "choices": [{"message": {"content": content}, "finish_reason": "length"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 900, "total_tokens": 910}
        });
        let outcome = parse_non_streaming_response(&req, &body, None);
        assert!(!outcome.usage_missing);
        assert!(outcome.response.content.chars().count() <= 12);
        assert_ne!(outcome.response.content, content);
        // Presentation usage clamps the total to max_tokens.
        assert_eq!(outcome.response.token_usage.total_tokens, 3);

        // openrouter: billing usage stays raw (unclamped), presentation clamps.
        let mut req = request(Provider::Openrouter);
        req.max_tokens = 3;
        let (billing, presentation) = outcome_with_openrouter(req);
        assert_eq!(billing.total_tokens, 910);
        assert_eq!(presentation.total_tokens, 3);
    }

    fn outcome_with_openrouter(
        req: LlmRequest,
    ) -> (
        crate::llm::usage::OpenRouterCallUsage,
        crate::llm::service::TokenUsage,
    ) {
        let body = json!({
            "choices": [{"message": {"content": "abcdefghijklmnopqrstuvwxyz"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 900, "total_tokens": 910, "cost": 0.01}
        });
        let outcome = parse_non_streaming_response(&req, &body, None);
        (
            outcome.response.usage.expect("billing usage"),
            outcome.response.token_usage,
        )
    }

    #[test]
    fn no_truncation_when_within_budget() {
        let mut req = request(Provider::Openai);
        req.max_tokens = 16000;
        let body = json!({
            "choices": [{"message": {"content": "short"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 1, "total_tokens": 11}
        });
        let outcome = parse_non_streaming_response(&req, &body, None);
        assert_eq!(outcome.response.content, "short");
    }
}
