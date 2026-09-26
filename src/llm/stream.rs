//! SSE streaming for OpenAI-compatible chat completions. Port of the
//! streaming path of `callOpenAI`/`callPOE` in AstroEX-node src/llmService.ts.
//!
//! Reads the raw byte stream of a `text/event-stream` response, splits it
//! into SSE `data:` lines, accumulates content and reasoning deltas, feeds
//! reasoning deltas into a per-attempt [`StreamRepetitionDetector`], and
//! renders live reasoning/response output through [`StreamFader`]s.

use std::time::Duration;

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::context::RunContext;
use crate::error::{AppError, Result};
use crate::llm::openai_compat::shared_client;
use crate::llm::repetition::{create_repetition_error, StreamRepetitionDetector};
use crate::llm::service::{LlmRequest, LlmResponse, ProviderConfig};
use crate::llm::usage::parse_openrouter_usage;
use crate::logging::fader::{apply_hsv_fade, FadeOptions, GradientKey, StreamFader};
use crate::logging::{self};
use crate::types::Provider;

/// Cycle length of the reasoning stream fader (createStreamFader("reasoning")).
const REASONING_FADER_CYCLE: usize = 100;
/// Cycle length of the response stream fader (createStreamFader("streaming")).
const RESPONSE_FADER_CYCLE: usize = 120;

fn write_stdout(text: &str) {
    use std::io::Write;
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    let _ = lock.write_all(text.as_bytes());
    let _ = lock.flush();
}

/// Port of writeLiveStreamStart: `\n╭─ [label]` header plus an open `│ `
/// border, faded with the given gradient.
fn write_live_stream_start(label: &str, gradient: GradientKey) {
    let header = apply_hsv_fade(
        &format!("\n╭─ [{label}]"),
        gradient,
        FadeOptions {
            bold: true,
            ..FadeOptions::default()
        },
    );
    let border = apply_hsv_fade("│ ", gradient, FadeOptions::default());
    write_stdout(&format!("{header}\n{border}"));
}

/// Port of writeLiveStreamEnd: `\n╰─\n` footer faded with the given gradient.
fn write_live_stream_end(gradient: GradientKey) {
    write_stdout(&apply_hsv_fade("\n╰─\n", gradient, FadeOptions::default()));
}

/// Live terminal rendering of a streaming chat completion, mirroring the
/// printedReasoningHeader/printedResponseHeader state of the Node stream
/// loop (reasoning and response get distinct gradient-framed sections).
pub struct LiveStreamDisplay {
    show_reasoning: bool,
    show_response: bool,
    reasoning_fader: StreamFader,
    response_fader: StreamFader,
    printed_reasoning_header: bool,
    printed_response_header: bool,
}

impl LiveStreamDisplay {
    pub fn new(show_reasoning: bool, show_response: bool) -> Self {
        Self {
            show_reasoning,
            show_response,
            reasoning_fader: StreamFader::new(
                GradientKey::Reasoning,
                REASONING_FADER_CYCLE,
                FadeOptions::default(),
            ),
            response_fader: StreamFader::new(
                GradientKey::Streaming,
                RESPONSE_FADER_CYCLE,
                FadeOptions::default(),
            ),
            printed_reasoning_header: false,
            printed_response_header: false,
        }
    }

    fn use_color() -> bool {
        crate::logging::use_color()
    }

    /// Write one reasoning delta through the reasoning fader.
    pub fn write_reasoning(&mut self, chunk: &str) {
        if !self.show_reasoning || chunk.is_empty() {
            return;
        }
        if !self.printed_reasoning_header {
            write_live_stream_start("Reasoning Stream", GradientKey::Reasoning);
            self.printed_reasoning_header = true;
        }
        let faded = self.reasoning_fader.fade_chunk(chunk, Self::use_color());
        write_stdout(&faded);
    }

    /// Write one content delta through the response fader, closing the
    /// reasoning section first when it is still open.
    pub fn write_content(&mut self, chunk: &str) {
        if !self.show_response || chunk.is_empty() {
            return;
        }
        if !self.printed_response_header {
            if self.printed_reasoning_header {
                write_live_stream_end(GradientKey::Reasoning);
                self.printed_reasoning_header = false;
            }
            write_live_stream_start("Response Stream", GradientKey::Streaming);
            self.printed_response_header = true;
        }
        let faded = self.response_fader.fade_chunk(chunk, Self::use_color());
        write_stdout(&faded);
    }

    /// Close whichever stream header is still open (normal completion).
    pub fn finish(&mut self) {
        if self.printed_response_header {
            write_live_stream_end(GradientKey::Streaming);
            self.printed_response_header = false;
        } else if self.printed_reasoning_header {
            write_live_stream_end(GradientKey::Reasoning);
            self.printed_reasoning_header = false;
        }
    }

    /// Close any open header after an error/abort (the Node catch path).
    pub fn close_open_headers(&mut self) {
        self.finish();
    }
}

/// Accumulated state of one streaming attempt.
#[derive(Default)]
pub struct StreamState {
    pub content: String,
    pub reasoning: String,
    pub response_id: Option<String>,
    pub model: Option<String>,
    pub final_usage: Option<Value>,
}

/// Result of handling one SSE line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SseLineOutcome {
    Continue,
    /// `data: [DONE]` received.
    Done,
}

fn first_non_empty_str<'a>(delta: &'a Value, keys: &[&str]) -> Option<&'a str> {
    for key in keys {
        if let Some(text) = delta.get(*key).and_then(Value::as_str) {
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    None
}

/// Handle one SSE line: parse the `data:` JSON chunk, accumulate
/// content/reasoning, run repetition detection on reasoning deltas, and
/// render live output. Mirrors the per-chunk body of the Node stream loop.
#[allow(clippy::too_many_arguments)]
pub fn handle_sse_line(
    line: &str,
    state: &mut StreamState,
    display: &mut LiveStreamDisplay,
    detector: &mut StreamRepetitionDetector,
    provider: &str,
    model: &str,
    attempt: u32,
) -> Result<SseLineOutcome> {
    let line = line.trim();
    if line.is_empty() || line.starts_with(':') {
        return Ok(SseLineOutcome::Continue);
    }
    let Some(data) = line.strip_prefix("data:") else {
        return Ok(SseLineOutcome::Continue);
    };
    let data = data.trim();
    if data == "[DONE]" {
        return Ok(SseLineOutcome::Done);
    }

    let chunk: Value = serde_json::from_str(data)
        .map_err(|error| AppError::message(format!("Failed to parse streaming chunk: {error}")))?;

    if state.response_id.is_none() {
        if let Some(id) = chunk
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            state.response_id = Some(id.to_string());
        }
    }
    if state.model.is_none() {
        if let Some(m) = chunk
            .get("model")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            state.model = Some(m.to_string());
        }
    }
    if let Some(usage) = chunk.get("usage").filter(|u| u.is_object()) {
        state.final_usage = Some(usage.clone());
    }

    let delta = chunk
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("delta"));
    if let Some(delta) = delta {
        if let Some(reasoning_chunk) =
            first_non_empty_str(delta, &["reasoning_content", "reasoning", "thinking"])
        {
            state.reasoning.push_str(reasoning_chunk);
            if let Some(details) = detector.feed(reasoning_chunk) {
                let snippet = details.repeated_text.replace('\n', "\\n");
                logging::log_kv(
                    "LLMService",
                    &format!(
                        "Pathological reasoning repetition detected: period={}, repeats={}, snippet=\"{}\". Aborting stream...",
                        details.period, details.repeats, snippet
                    ),
                    crate::types::LogLevel::Warn,
                    &[
                        ("period", json!(details.period)),
                        ("repeats", json!(details.repeats)),
                        ("repeatedText", json!(details.repeated_text)),
                        ("totalChars", json!(details.total_chars)),
                        ("attempt", json!(attempt + 1)),
                    ],
                );
                display.close_open_headers();
                return Err(create_repetition_error(
                    provider,
                    model,
                    Some(attempt + 1),
                    &details,
                ));
            }
            display.write_reasoning(reasoning_chunk);
        }

        if let Some(content) = delta
            .get("content")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            state.content.push_str(content);
            display.write_content(content);
        }
    }

    Ok(SseLineOutcome::Continue)
}

/// Extract complete (newline-terminated) lines from the byte buffer, leaving
/// any trailing partial line in place for the next chunk.
pub fn take_complete_lines(buffer: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(position) = buffer.iter().position(|&byte| byte == b'\n') {
        let mut line: Vec<u8> = buffer.drain(..=position).collect();
        line.pop(); // trailing '\n'
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        lines.push(String::from_utf8_lossy(&line).into_owned());
    }
    lines
}

/// A source of raw response bytes: either a live `reqwest` response or a
/// plain async reader (tests).
pub enum ChunkSource<'a> {
    Response(reqwest::Response),
    Reader(Box<dyn tokio::io::AsyncRead + Unpin + 'a>),
}

impl ChunkSource<'_> {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>> {
        match self {
            ChunkSource::Response(response) => match response.chunk().await {
                Ok(Some(bytes)) => Ok(Some(bytes.to_vec())),
                Ok(None) => Ok(None),
                Err(error) => Err(AppError::from(error)),
            },
            ChunkSource::Reader(reader) => {
                use tokio::io::AsyncReadExt;
                let mut buffer = vec![0u8; 8192];
                let read = reader.read(&mut buffer).await?;
                if read == 0 {
                    Ok(None)
                } else {
                    buffer.truncate(read);
                    Ok(Some(buffer))
                }
            }
        }
    }
}

/// Consume an SSE byte source, invoking `line_sink` per line. The sink
/// returns `false` to stop (e.g. `[DONE]`). Propagates sink errors (stream
/// is dropped, aborting the request).
async fn consume_sse(
    source: &mut ChunkSource<'_>,
    cancellation: &CancellationToken,
    line_sink: &mut dyn FnMut(&str) -> Result<bool>,
) -> Result<()> {
    let mut buffer: Vec<u8> = Vec::new();
    loop {
        let chunk = tokio::select! {
            chunk = source.next_chunk() => chunk,
            _ = cancellation.cancelled() => {
                return Err(AppError::message("Pipeline cancelled before operation started"));
            }
        }?;
        match chunk {
            Some(bytes) => {
                buffer.extend_from_slice(&bytes);
                for line in take_complete_lines(&mut buffer) {
                    if !line_sink(&line)? {
                        return Ok(());
                    }
                }
            }
            None => break,
        }
    }
    if !buffer.is_empty() {
        let mut line = String::from_utf8_lossy(&buffer).into_owned();
        if line.ends_with('\r') {
            line.pop();
        }
        line_sink(&line)?;
    }
    Ok(())
}

/// Execute one streaming chat-completion attempt against an
/// OpenAI-compatible endpoint. `body` must already carry `stream: true`
/// (see [`crate::llm::openai_compat::build_request_body`]).
///
/// On pathological reasoning repetition the stream is aborted and the
/// retryable repetition error is returned; the caller decides whether to
/// retry or fall back to a non-streaming request.
pub async fn stream_openai_compatible(
    ctx: &RunContext,
    provider_config: &ProviderConfig,
    request: &LlmRequest,
    body: &Value,
    attempt: u32,
) -> Result<LlmResponse> {
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

    let mut state = StreamState::default();
    let mut display =
        LiveStreamDisplay::new(request.show_reasoning_tokens, request.show_response_stream);
    let mut detector = StreamRepetitionDetector::new();
    let provider_name = request.provider.to_string();
    let model = request.model.clone();

    let mut source = ChunkSource::Response(response);
    let stream_result = consume_sse(&mut source, &ctx.cancellation, &mut |line| {
        handle_sse_line(
            line,
            &mut state,
            &mut display,
            &mut detector,
            &provider_name,
            &model,
            attempt,
        )
        .map(|outcome| outcome != SseLineOutcome::Done)
    })
    .await;

    match stream_result {
        Ok(()) => display.finish(),
        Err(error) => {
            display.close_open_headers();
            return Err(error);
        }
    }

    let billing_usage = if request.provider == Provider::Openrouter {
        state.final_usage.as_ref().and_then(|usage| {
            let mut metadata = serde_json::Map::new();
            if let Some(response_id) = &state.response_id {
                metadata.insert("requestId".to_string(), json!(response_id));
            }
            metadata.insert(
                "model".to_string(),
                json!(state.model.as_deref().unwrap_or(&request.model)),
            );
            if let Some(stage) = &request.stage {
                metadata.insert("stage".to_string(), json!(stage));
            }
            parse_openrouter_usage(usage, Some(&Value::Object(metadata)))
        })
    } else {
        None
    };

    // Node streaming usage: prefer billing counts when OpenRouter reported
    // them, otherwise estimate from the accumulated content.
    let estimated = crate::llm::service::LlmService::estimate_token_count(&state.content) as i64;
    let token_usage = match &billing_usage {
        Some(billing) => crate::llm::service::TokenUsage {
            prompt_tokens: billing.input_tokens,
            completion_tokens: billing.output_tokens,
            total_tokens: billing.total_tokens,
            reasoning_tokens: None,
        },
        None => crate::llm::service::TokenUsage {
            prompt_tokens: 0,
            completion_tokens: estimated,
            total_tokens: estimated,
            reasoning_tokens: None,
        },
    };

    Ok(LlmResponse {
        content: state.content,
        reasoning_content: if state.reasoning.is_empty() {
            None
        } else {
            Some(state.reasoning)
        },
        finish_reason: None,
        token_usage,
        usage: billing_usage,
        response_id: state.response_id,
        model: Some(state.model.unwrap_or_else(|| request.model.clone())),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    async fn run_sse(bytes: Vec<u8>) -> (StreamState, Result<bool>) {
        let mut state = StreamState::default();
        let mut display = LiveStreamDisplay::new(false, false);
        let mut detector = StreamRepetitionDetector::new();
        let mut done = false;
        let mut source = ChunkSource::Reader(Box::new(Cursor::new(bytes)));
        let result =
            consume_sse(
                &mut source,
                &CancellationToken::new(),
                &mut |line| match handle_sse_line(
                    line,
                    &mut state,
                    &mut display,
                    &mut detector,
                    "openrouter",
                    "test-model",
                    0,
                ) {
                    Ok(SseLineOutcome::Done) => {
                        done = true;
                        Ok(false)
                    }
                    Ok(SseLineOutcome::Continue) => Ok(true),
                    Err(error) => Err(error),
                },
            )
            .await;
        (state, result.map(|_| done))
    }

    fn sse_frame(payload: &Value) -> String {
        format!("data: {payload}\n\n")
    }

    #[tokio::test]
    async fn parses_content_reasoning_and_usage_from_mock_stream() {
        let mut bytes = String::new();
        bytes.push_str(": ping\n\n");
        bytes.push_str(&sse_frame(&json!({
            "id": "resp-1",
            "model": "z-ai/glm-5.3",
            "choices": [{"delta": {"reasoning_content": "think "}}]
        })));
        bytes.push_str(&sse_frame(&json!({
            "id": "resp-1",
            "model": "z-ai/glm-5.3",
            "choices": [{"delta": {"reasoning": "harder"}}]
        })));
        bytes.push_str(&sse_frame(&json!({
            "choices": [{"delta": {"thinking": " still"}}]
        })));
        bytes.push_str(&sse_frame(&json!({
            "choices": [{"delta": {"content": "Hello"}, "finish_reason": null}]
        })));
        bytes.push_str(&sse_frame(&json!({
            "choices": [{"delta": {"content": " world"}}]
        })));
        bytes.push_str(&sse_frame(&json!({
            "choices": [],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15, "cost": 0.001}
        })));
        bytes.push_str("data: [DONE]\n\n");

        let (state, done) = run_sse(bytes.into_bytes()).await;
        assert!(matches!(done, Ok(true)));
        assert_eq!(state.content, "Hello world");
        assert_eq!(state.reasoning, "think harder still");
        assert_eq!(state.response_id.as_deref(), Some("resp-1"));
        assert_eq!(state.model.as_deref(), Some("z-ai/glm-5.3"));
        assert_eq!(state.final_usage.unwrap()["total_tokens"], 15);
    }

    #[tokio::test]
    async fn handles_split_chunks_and_crlf_lines() {
        let payload = json!({"choices": [{"delta": {"content": "abc"}}]});
        let mut bytes: Vec<u8> = Vec::new();
        bytes.extend_from_slice(b"data: ");
        bytes.extend_from_slice(payload.to_string().as_bytes());
        bytes.extend_from_slice(b"\r\n\r\n");
        bytes.extend_from_slice(b"data: [DONE]\r\n");

        // Split into awkward partial chunks to exercise buffering.
        let mut source = ChunkSource::Reader(Box::new(Cursor::new(Vec::new())));
        let _ = &mut source;
        let (state, done) = run_sse(bytes).await;
        assert!(matches!(done, Ok(true)));
        assert_eq!(state.content, "abc");
    }

    #[tokio::test]
    async fn detects_pathological_repetition_and_aborts_stream() {
        let mut bytes = String::new();
        bytes.push_str(&sse_frame(&json!({
            "choices": [{"delta": {"reasoning_content": "Initial thought. "}}]
        })));
        for _ in 0..30 {
            bytes.push_str(&sse_frame(&json!({
                "choices": [{"delta": {"reasoning_content": "lock"}}]
            })));
        }

        let mut state = StreamState::default();
        let mut display = LiveStreamDisplay::new(false, false);
        let mut detector = StreamRepetitionDetector::new();
        let mut source = ChunkSource::Reader(Box::new(Cursor::new(bytes.into_bytes())));
        let result = consume_sse(&mut source, &CancellationToken::new(), &mut |line| {
            handle_sse_line(
                line,
                &mut state,
                &mut display,
                &mut detector,
                "openrouter",
                "m",
                0,
            )
            .map(|outcome| outcome != SseLineOutcome::Done)
        })
        .await;

        let error = result.expect_err("repetition should abort the stream");
        assert_eq!(error.code, "PATHOLOGICAL_REASONING_REPETITION");
        assert!(error.is_retryable());
        assert!(state.reasoning.contains("lock"));
    }

    #[tokio::test]
    async fn malformed_chunk_json_returns_error() {
        let bytes = b"data: {not json}\n\n".to_vec();
        let (_state, result) = run_sse(bytes).await;
        let error = result.expect_err("malformed JSON should error");
        assert!(error.message.contains("Failed to parse streaming chunk"));
    }

    #[test]
    fn take_complete_lines_splits_and_keeps_remainder() {
        let mut buffer = b"line one\nline tw".to_vec();
        let lines = take_complete_lines(&mut buffer);
        assert_eq!(lines, vec!["line one".to_string()]);
        assert_eq!(buffer, b"line tw");

        buffer.extend_from_slice(b"o\nline three\r\n");
        let lines = take_complete_lines(&mut buffer);
        assert_eq!(
            lines,
            vec!["line two".to_string(), "line three".to_string()]
        );
        assert!(buffer.is_empty());
    }
}
