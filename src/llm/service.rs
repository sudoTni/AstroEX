//! Centralized LLM service. Port of the LLMService class in AstroEX-node
//! src/llmService.ts: provider registry, budget enforcement, dispatch,
//! retry logic and batch processing. JSON repair, repetition detection and
//! OpenRouter usage accounting live in the sibling modules.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use serde_json::{json, Map, Value};

use crate::circuit_breaker::{CircuitBreaker, CircuitBreakerConfig, CircuitBreakerFactory};
use crate::context::RunContext;
use crate::error::{AppError, Result};
use crate::llm::openai_compat::{build_request_body, call_openai_compatible};
use crate::llm::usage::{format_usd, OpenRouterUsageTracker};
use crate::logging::{self, llm_formatter, payload_logs};
use crate::types::{LogLevel, Provider, ProviderRouting};

/// Provider registry entry (Node: AIProviderConfig).
pub struct ProviderConfig {
    pub name: String,
    pub api_key: String,
    pub base_url: String,
    pub model: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct LlmRequest {
    pub provider: Provider,
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub temperature: f64,
    pub top_p: f64,
    pub max_tokens: u32,
    pub timeout_ms: u64,
    pub show_reasoning_tokens: bool,
    pub show_response_stream: bool,
    pub reasoning_effort: Option<String>,
    pub provider_routing: Option<ProviderRouting>,
    pub json_mode: bool,
    pub stage: Option<String>,
    pub call_progress: Option<String>,
}

impl Default for LlmRequest {
    fn default() -> Self {
        Self {
            provider: Provider::Openrouter,
            model: String::new(),
            messages: Vec::new(),
            temperature: crate::constants::DEFAULT_TEMPERATURE,
            top_p: crate::constants::DEFAULT_TOP_P,
            max_tokens: crate::constants::DEFAULT_MAX_TOKENS,
            timeout_ms: crate::constants::DEFAULT_TIMEOUT_MS,
            show_reasoning_tokens: false,
            show_response_stream: false,
            reasoning_effort: None,
            provider_routing: None,
            json_mode: false,
            stage: None,
            call_progress: None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct TokenUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub reasoning_tokens: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct LlmResponse {
    pub content: String,
    pub reasoning_content: Option<String>,
    pub finish_reason: Option<String>,
    /// Generic presentation usage (all providers). Mirrors Node's
    /// `LLMResponse.usage`.
    pub token_usage: TokenUsage,
    /// OpenRouter billing usage recorded by the usage tracker. Mirrors Node's
    /// `LLMResponse.billingUsage`.
    pub usage: Option<crate::llm::usage::OpenRouterCallUsage>,
    pub response_id: Option<String>,
    pub model: Option<String>,
}

/// Centralized LLM service (Node: the `LLMService` singleton class).
///
/// Call-count and token-reservation budgets live on the (immutable)
/// [`RunContext`], so the service tracks them in interior-mutable atomic
/// counters that advance across `&self` calls.
pub struct LlmService {
    providers: HashMap<String, ProviderConfig>,
    default_provider: String,
    request_count: AtomicU64,
    reserved_output_tokens: AtomicU64,
    success_count: AtomicU64,
    failure_count: AtomicU64,
    circuit_breakers: Mutex<HashMap<String, CircuitBreaker>>,
    usage_tracker: Option<Arc<Mutex<OpenRouterUsageTracker>>>,
}

impl Default for LlmService {
    fn default() -> Self {
        Self::new()
    }
}

/// Port of maskSensitiveData: keep the first/last 4 characters of long
/// secrets and mask the middle.
fn mask_sensitive_data(data: &str) -> String {
    let chars: Vec<char> = data.chars().collect();
    if chars.len() <= 8 {
        return "*".repeat(chars.len());
    }
    let masked: String = chars
        .iter()
        .enumerate()
        .map(|(index, c)| {
            if index < 4 || index >= chars.len() - 4 {
                *c
            } else {
                '*'
            }
        })
        .collect();
    masked
}

/// Port of validateProviderConfig (model is optional in the Rust config).
fn validate_provider_config(provider: &ProviderConfig) -> bool {
    if provider.name.trim().is_empty() {
        return false;
    }
    if provider.base_url.trim().is_empty() {
        return false;
    }
    if provider.api_key.trim().is_empty() {
        return false;
    }
    if reqwest::Url::parse(provider.base_url.trim()).is_err() {
        return false;
    }
    true
}

fn cancellation_error() -> AppError {
    AppError::message("Pipeline cancelled before operation started")
}

impl LlmService {
    pub fn new() -> Self {
        Self {
            providers: HashMap::new(),
            default_provider: "openrouter".to_string(),
            request_count: AtomicU64::new(0),
            reserved_output_tokens: AtomicU64::new(0),
            success_count: AtomicU64::new(0),
            failure_count: AtomicU64::new(0),
            circuit_breakers: Mutex::new(HashMap::new()),
            usage_tracker: None,
        }
    }

    /// Initialize the service with provider configurations. Throws (Err) on
    /// an empty or invalid provider list, mirroring the Node initialize().
    pub fn initialize(
        &mut self,
        providers: Vec<ProviderConfig>,
        default_provider: Provider,
    ) -> Result<()> {
        self.request_count.store(0, Ordering::SeqCst);
        self.reserved_output_tokens.store(0, Ordering::SeqCst);

        if providers.is_empty() {
            return Err(AppError::message("At least one provider must be specified"));
        }
        for provider in &providers {
            if !validate_provider_config(provider) {
                return Err(AppError::message(format!(
                    "Invalid provider configuration: {}",
                    serde_json::to_string(&json!({
                        "name": provider.name,
                        "baseUrl": provider.base_url,
                        "model": provider.model,
                    }))
                    .unwrap_or_default()
                )));
            }
        }

        self.providers.clear();
        for provider in providers {
            logging::log_kv(
                "LLMService",
                &format!(
                    "Initialized provider: {} ({})",
                    provider.name, provider.base_url
                ),
                LogLevel::Info,
                &[
                    ("provider", json!(provider.name)),
                    ("baseUrl", json!(provider.base_url)),
                    ("model", json!(provider.model)),
                    (
                        "maskedApiKey",
                        json!(mask_sensitive_data(&provider.api_key)),
                    ),
                ],
            );
            self.providers.insert(provider.name.clone(), provider);
        }

        let default_name = default_provider.to_string();
        if self.providers.contains_key(&default_name) {
            self.default_provider = default_name.clone();
            logging::info(
                "LLMService",
                &format!("Set default provider to: {default_name}"),
            );
        } else {
            logging::warn(
                "LLMService",
                &format!("Default provider {default_name} not found, using current default"),
            );
        }

        logging::log_kv(
            "LLMService",
            &format!(
                "LLM service initialized with {} providers",
                self.providers.len()
            ),
            LogLevel::Info,
            &[
                ("providerCount", json!(self.providers.len())),
                ("defaultProvider", json!(self.default_provider)),
            ],
        );
        Ok(())
    }

    /// Install the OpenRouter usage tracker used for call accounting (Node:
    /// `runWithUsageTracker`'s AsyncLocalStorage store).
    pub fn set_usage_tracker(&mut self, tracker: Arc<Mutex<OpenRouterUsageTracker>>) {
        self.usage_tracker = Some(tracker);
    }

    /// Look up the provider config by name, falling back to the default
    /// provider (Node: `providers.get(name) || providers.get(default)`).
    fn provider_config(&self, name: &str) -> Option<&ProviderConfig> {
        self.providers
            .get(name)
            .or_else(|| self.providers.get(&self.default_provider))
    }

    /// Get (or create) the circuit breaker for a provider and run the
    /// allow-request check (advancing OPEN -> HALF_OPEN after the recovery
    /// timeout).
    fn circuit_allows_request(&self, provider_name: &str) -> bool {
        let mut breakers = self
            .circuit_breakers
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let breaker = breakers
            .entry(provider_name.to_string())
            .or_insert_with(|| {
                CircuitBreakerFactory::create(
                    provider_name,
                    Some(&CircuitBreakerConfig {
                        timeout_ms: 60_000,
                        ..CircuitBreakerConfig::default()
                    }),
                )
            });
        breaker.allow_request()
    }

    /// Make a single LLM API call with budget enforcement, payload logging
    /// and OpenRouter usage accounting. Port of `call()`.
    pub async fn call(&self, ctx: &RunContext, request: LlmRequest) -> Result<LlmResponse> {
        let start = std::time::Instant::now();

        // Deadline and request-count budgets (checked before the try block
        // in the Node implementation).
        if let Some(deadline) = ctx.budgets.llm_deadline_ms {
            let elapsed = ctx.now_ms().saturating_sub(ctx.run_started_at_ms);
            if elapsed >= deadline {
                return Err(AppError::message(format!(
                    "LLM run deadline exceeded ({deadline}ms). Set --llm-deadline-ms to raise the limit."
                )));
            }
        }
        if let Some(budget) = ctx.budgets.max_llm_requests {
            if self.request_count.load(Ordering::SeqCst) >= budget {
                return Err(AppError::message(format!(
                    "LLM request budget exhausted ({budget}). Set --max-llm-requests to raise the limit."
                )));
            }
        }
        self.request_count.fetch_add(1, Ordering::SeqCst);

        let mut request = request;
        if ctx.display.hide_reasoning {
            request.show_reasoning_tokens = false;
        }
        // Preserve the historical ANSI-free behavior of the logged stages.
        if request.stage.is_some() {
            request.model = logging::strip_ansi(&request.model);
            for message in &mut request.messages {
                message.content = logging::strip_ansi(&message.content);
            }
            if let Some(effort) = request.reasoning_effort.take() {
                request.reasoning_effort = Some(logging::strip_ansi(&effort));
            }
        }

        match self.call_inner(ctx, &request, start).await {
            Ok(response) => Ok(response),
            Err(error) => {
                self.failure_count.fetch_add(1, Ordering::SeqCst);
                if ctx.cancellation.is_cancelled() {
                    return Err(cancellation_error());
                }
                logging::log_error("LLMService", &error, LogLevel::Error);
                Err(error)
            }
        }
    }

    /// Body of call() inside the Node try block: token budgets, provider
    /// lookup, payload logging, dispatch and usage accounting.
    async fn call_inner(
        &self,
        ctx: &RunContext,
        request: &LlmRequest,
        start: std::time::Instant,
    ) -> Result<LlmResponse> {
        if let Some(limit) = ctx.budgets.max_llm_output_tokens {
            if request.max_tokens > limit {
                return Err(AppError::new(
                    "LLM_CALL_FAILED",
                    500,
                    format!(
                        "LLM output-token budget exceeded ({} requested; limit {}).",
                        request.max_tokens, limit
                    ),
                ));
            }
        }
        if let Some(limit) = ctx.budgets.max_total_llm_output_tokens {
            let reserved = self.reserved_output_tokens.load(Ordering::SeqCst);
            if reserved + request.max_tokens as u64 > limit {
                return Err(AppError::new(
                    "LLM_CALL_FAILED",
                    500,
                    format!(
                        "Total LLM output-token budget exceeded ({} requested; limit {}).",
                        reserved + request.max_tokens as u64,
                        limit
                    ),
                ));
            }
        }
        self.reserved_output_tokens
            .fetch_add(request.max_tokens as u64, Ordering::SeqCst);

        // These were explicit throwing stubs in the Node gateway. Preserve
        // that result even when no provider registry was configured.
        match request.provider {
            Provider::Gemini => return Err(AppError::message("Gemini integration requires @google/generative-ai package. Please install it and uncomment the import statement.")),
            Provider::Mistral => return Err(AppError::message("Mistral integration requires @mistralai/mistralai package. Please install it and uncomment the import statement.")),
            _ => {}
        }

        let provider_name = request.provider.to_string();
        let provider_config = self.provider_config(&provider_name).ok_or_else(|| {
            AppError::message(format!(
                "Provider {provider_name} not found and no default provider set"
            ))
        })?;

        let accounting_id =
            if request.provider == Provider::Openrouter && self.usage_tracker.is_some() {
                Some(uuid::Uuid::new_v4().to_string())
            } else {
                None
            };

        let should_log_payload =
            ctx.diagnostics.log_llm_payloads || logging::is_level_enabled(LogLevel::Trace);

        // Wire body actually sent to the provider; also persisted to the
        // payload log (Node: sendProviderPayload).
        let streaming = request.show_reasoning_tokens || request.show_response_stream;
        let include_usage =
            request.provider == Provider::Openrouter && self.usage_tracker.is_some();
        let wire_body = build_request_body(request.provider, request, streaming, include_usage);

        if should_log_payload {
            let display_payload = self.display_payload(request);
            let formatted = llm_formatter::format_llm_request(
                &provider_name,
                &request.model,
                "",
                &Value::Object(display_payload),
                ctx.diagnostics.log_max_payload_length,
            );
            logging::debug("LLMService", &format!("\n{formatted}"));
        } else {
            let context_pairs =
                build_llm_call_context(&provider_name, request, streaming, include_usage);
            logging::log_kv(
                "LLMService",
                &format!("Making LLM call to {}/{}", provider_name, request.model),
                LogLevel::Info,
                &context_pairs,
            );
        }

        // Best-effort payload log (Node: sendProviderPayload).
        let payload_log_path = request.stage.as_deref().and_then(|stage| {
            payload_logs::write_llm_payload_log(&ctx.paths.log_dir, stage, &wire_body)
        });

        let response = match request.provider {
            Provider::Openai | Provider::Openrouter | Provider::Cerebras | Provider::Poe => {
                call_openai_compatible(ctx, provider_config, request, self.usage_tracker.as_ref())
                    .await?
            }
            Provider::Gemini | Provider::Mistral => unreachable!("handled before provider lookup"),
        };

        // OpenRouter usage accounting (Node: post-call tracker recording).
        if let (Some(tracker), Some(accounting_id)) = (&self.usage_tracker, &accounting_id) {
            if let Some(billing) = &response.usage {
                let mut guard = tracker.lock().unwrap_or_else(|e| e.into_inner());
                let recorded = guard.record(accounting_id, billing);
                if recorded {
                    let totals = guard.get_summary();
                    drop(guard);
                    logging::log_kv(
                        "LLMService",
                        &format!(
                            "OpenRouter usage recorded: input={}, output={}, total={}, cost={}; pipeline total={} tokens, {}",
                            billing.input_tokens,
                            billing.output_tokens,
                            billing.total_tokens,
                            format_usd(billing.cost_usd),
                            totals.total_tokens,
                            format_usd(totals.cost_usd)
                        ),
                        LogLevel::Info,
                        &[
                            ("event", json!("openrouter.usage.call")),
                            ("model", json!(billing.model.as_deref().unwrap_or(&request.model))),
                            ("inputTokens", json!(billing.input_tokens)),
                            ("outputTokens", json!(billing.output_tokens)),
                            ("totalTokens", json!(billing.total_tokens)),
                            ("costUsd", json!(billing.cost_usd)),
                            ("pipelineTotalTokens", json!(totals.total_tokens)),
                            ("pipelineCostUsd", json!(totals.cost_usd)),
                        ],
                    );
                }
            }
        }

        let duration_ms = start.elapsed().as_millis() as u64;

        self.success_count.fetch_add(1, Ordering::SeqCst);

        if let (Some(stage), Some(path)) = (request.stage.as_deref(), payload_log_path.as_deref()) {
            payload_logs::update_llm_payload_log(
                stage,
                path,
                &json!({
                    "reasoning": response.reasoning_content,
                    "response": response.content,
                }),
            );
        }

        if should_log_payload {
            let mut response_payload = Map::new();
            response_payload.insert("content".to_string(), json!(response.content));
            if let Some(finish_reason) = &response.finish_reason {
                response_payload.insert("finishReason".to_string(), json!(finish_reason));
            }
            if let Some(billing) = &response.usage {
                response_payload.insert(
                    "usage".to_string(),
                    json!({
                        "promptTokens": billing.input_tokens,
                        "completionTokens": billing.output_tokens,
                        "totalTokens": billing.total_tokens,
                    }),
                );
            }
            if request.show_response_stream {
                response_payload.insert("contentStreamed".to_string(), json!(true));
            }
            let formatted = llm_formatter::format_llm_response(
                &provider_name,
                &request.model,
                &Value::Object(response_payload),
                Some(duration_ms),
                ctx.diagnostics.log_max_payload_length,
            );
            logging::debug("LLMService", &format!("\n{formatted}"));
        }

        logging::log_kv(
            "LLMService",
            &format!(
                "LLM call completed successfully in {}",
                logging::formatter::format_duration(duration_ms as f64)
            ),
            LogLevel::Info,
            &[
                ("provider", json!(provider_name)),
                ("model", json!(request.model)),
                ("tokensUsed", json!(response.token_usage.total_tokens)),
                ("durationMs", json!(duration_ms)),
            ],
        );

        Ok(response)
    }

    /// Build the camelCase display payload consumed by
    /// `format_llm_request`.
    fn display_payload(&self, request: &LlmRequest) -> Map<String, Value> {
        let mut payload = Map::new();
        payload.insert("temperature".to_string(), json!(request.temperature));
        payload.insert("topP".to_string(), json!(request.top_p));
        payload.insert("maxTokens".to_string(), json!(request.max_tokens));
        payload.insert("timeout".to_string(), json!(request.timeout_ms));
        payload.insert(
            "messages".to_string(),
            json!(request
                .messages
                .iter()
                .map(|message| json!({"role": message.role, "content": message.content}))
                .collect::<Vec<_>>()),
        );
        if let Some(effort) = request
            .reasoning_effort
            .as_deref()
            .filter(|effort| !effort.is_empty())
        {
            payload.insert("reasoning_effort".to_string(), json!(effort));
        }
        if request.provider == Provider::Openrouter {
            if let Some(routing) = &request.provider_routing {
                let mut routing = routing.clone();
                routing.normalize();
                if let Ok(routing_value) = serde_json::to_value(&routing) {
                    payload.insert("providerRouting".to_string(), routing_value);
                }
            }
        }
        if request.json_mode {
            payload.insert("responseSchema".to_string(), json!(true));
        }
        payload
    }
}

/// Build the structured key-value context pairs for LLM call logging.
pub(crate) fn build_llm_call_context(
    provider_name: &str,
    request: &LlmRequest,
    streaming: bool,
    include_usage: bool,
) -> Vec<(&'static str, Value)> {
    let mut pairs: Vec<(&'static str, Value)> = Vec::with_capacity(16);

    // 1. Identity and stage context
    pairs.push(("provider", json!(provider_name)));
    pairs.push(("model", json!(request.model)));
    if let Some(stage) = &request.stage {
        pairs.push(("stage", json!(stage)));
    }
    if let Some(call_progress) = &request.call_progress {
        pairs.push(("callProgress", json!(call_progress)));
    }
    pairs.push(("messageCount", json!(request.messages.len())));

    // 2. Core hyperparameters (order matches Node convention)
    pairs.push(("temperature", json!(request.temperature)));
    pairs.push(("topP", json!(request.top_p)));
    pairs.push(("maxTokens", json!(request.max_tokens)));

    // 3. Execution, streaming & latency
    pairs.push(("stream", json!(streaming)));
    if streaming && include_usage {
        pairs.push(("streamOptions.includeUsage", json!(true)));
    }
    pairs.push(("timeout", json!(request.timeout_ms)));

    // 4. Output schema mode
    if request.json_mode {
        pairs.push(("jsonMode", json!(true)));
    }

    // 5. Reasoning effort
    if let Some(effort) = request
        .reasoning_effort
        .as_deref()
        .filter(|effort| !effort.is_empty())
    {
        pairs.push(("reasoning_effort", json!(effort)));
    }

    // 6. OpenRouter routing configuration (dotted keys render cleanly inline)
    if request.provider == Provider::Openrouter {
        if let Some(routing) = &request.provider_routing {
            let mut normalized = routing.clone();
            normalized.normalize();

            if let Some(order) = &normalized.order {
                if !order.is_empty() {
                    pairs.push(("provider.order", json!(order.join(","))));
                }
            }
            if let Some(only) = &normalized.only {
                if !only.is_empty() {
                    pairs.push(("provider.only", json!(only.join(","))));
                }
            }
            if let Some(ignore) = &normalized.ignore {
                if !ignore.is_empty() {
                    pairs.push(("provider.ignore", json!(ignore.join(","))));
                }
            }
            if let Some(quants) = &normalized.quantizations {
                if !quants.is_empty() {
                    pairs.push(("provider.quantizations", json!(quants.join(","))));
                }
            }
            if let Some(fallbacks) = normalized.allow_fallbacks {
                pairs.push(("provider.allow_fallbacks", json!(fallbacks)));
            }
        }
    }

    pairs
}

impl LlmService {
    /// gating. Port of `retryCall`.
    pub async fn call_with_retries(
        &self,
        ctx: &RunContext,
        request: LlmRequest,
        retry_attempts: u32,
        retry_delay_ms: u64,
    ) -> Result<LlmResponse> {
        let provider_name = request.provider.to_string();
        if !self.circuit_allows_request(&provider_name) {
            return Err(AppError::circuit_open(format!(
                "Circuit breaker tripped for provider {provider_name}. Please try again later."
            )));
        }

        let mut attempt: u32 = 0;
        loop {
            match self.call(ctx, request.clone()).await {
                Ok(response) => {
                    // Node's retryCall only reads breaker state; it never
                    // records success/failure, so breakers cannot open here.
                    return Ok(response);
                }
                Err(error) => {
                    if attempt < retry_attempts {
                        // Exponential backoff with jitter, capped at 30s.
                        let backoff = retry_delay_ms.saturating_mul(2u64.saturating_pow(attempt))
                            + (rand::random::<f64>() * 1000.0).round() as u64;
                        let actual_delay = backoff.min(crate::constants::MAX_RETRY_DELAY_MS);
                        logging::log_kv(
                            "LLMService",
                            &format!(
                                "Retry attempt {}/{} after {}ms",
                                attempt + 1,
                                retry_attempts,
                                actual_delay
                            ),
                            LogLevel::Warn,
                            &[
                                ("error", json!(error.message)),
                                ("attempt", json!(attempt + 1)),
                                ("maxRetries", json!(retry_attempts)),
                                ("provider", json!(provider_name)),
                                ("backoffDelay", json!(actual_delay)),
                            ],
                        );
                        crate::context::abortable_delay(actual_delay, &ctx.cancellation).await?;
                        if ctx.cancellation.is_cancelled() {
                            return Err(cancellation_error());
                        }
                        attempt += 1;
                        continue;
                    }
                    logging::log_kv(
                        "LLMService",
                        &format!(
                            "Max retries ({retry_attempts}) exceeded for provider {provider_name}"
                        ),
                        LogLevel::Error,
                        &[
                            ("error", json!(error.message)),
                            ("provider", json!(provider_name)),
                            ("totalAttempts", json!(attempt + 1)),
                        ],
                    );
                    return Err(AppError::message(format!(
                        "Max retries exceeded for provider {provider_name}: {}",
                        error.message
                    )));
                }
            }
        }
    }

    /// Batch processing with chunked concurrency and per-request retries.
    /// Port of `batch()` (returns per-request results instead of throwing
    /// on partial failure).
    pub async fn batch(
        &self,
        ctx: &RunContext,
        requests: Vec<LlmRequest>,
        concurrency: u32,
        retry_attempts: u32,
        retry_delay_ms: u64,
    ) -> Result<Vec<Result<LlmResponse>>> {
        let concurrency = concurrency.max(1) as usize;
        logging::log_kv(
            "LLMService",
            &format!(
                "Starting batch processing of {} requests with concurrency {concurrency}",
                requests.len()
            ),
            LogLevel::Info,
            &[
                ("totalRequests", json!(requests.len())),
                ("concurrency", json!(concurrency)),
                ("retryAttempts", json!(retry_attempts)),
                ("retryDelay", json!(retry_delay_ms)),
            ],
        );

        let mut results: Vec<Result<LlmResponse>> = Vec::with_capacity(requests.len());
        for (chunk_offset, chunk) in requests.chunks(concurrency).enumerate() {
            let futures: Vec<Pin<Box<dyn Future<Output = Result<LlmResponse>> + '_>>> = chunk
                .iter()
                .map(|request| {
                    Box::pin(self.call_with_retries(
                        ctx,
                        request.clone(),
                        retry_attempts,
                        retry_delay_ms,
                    ))
                        as Pin<Box<dyn Future<Output = Result<LlmResponse>> + '_>>
                })
                .collect();
            let chunk_results = join_all_borrowed(futures).await;
            for (index, result) in chunk_results.into_iter().enumerate() {
                if let Err(error) = &result {
                    logging::log_kv(
                        "LLMService",
                        &format!("Batch request failed: {}", error.message),
                        LogLevel::Error,
                        &[
                            ("error", json!(error.message)),
                            ("requestIndex", json!(chunk_offset * concurrency + index)),
                        ],
                    );
                }
                results.push(result);
            }
        }

        let errors = results.iter().filter(|result| result.is_err()).count();
        let successes = results.len() - errors;
        logging::log_kv(
            "LLMService",
            &format!("Batch processing completed. Success: {successes}, Errors: {errors}"),
            LogLevel::Info,
            &[
                ("successfulRequests", json!(successes)),
                ("failedRequests", json!(errors)),
                ("totalRequests", json!(results.len())),
            ],
        );
        if errors > 0 {
            logging::warn(
                "LLMService",
                &format!("Batch processing completed with {errors} errors"),
            );
        }
        Ok(results)
    }

    /// Rough token estimate: 1 token ~= 4 characters (Node:
    /// `estimateTokenCount`).
    pub fn estimate_token_count(text: &str) -> u64 {
        (text.chars().count() as f64 / 4.0).ceil() as u64
    }

    /// Truncate response content to respect a max-tokens limit: try a
    /// sentence boundary first (accepting it when it keeps more than 80% of
    /// the budget), then a word boundary. Port of
    /// `truncateResponseToMaxTokens`.
    pub fn truncate_response_to_max_tokens(content: &str, max_tokens: u32) -> String {
        let max_characters = max_tokens as usize * 4;
        if content.chars().count() <= max_characters {
            return content.to_string();
        }
        let sentence = truncate_at_sentence_boundary(content, max_characters);
        if sentence.chars().count() > (max_characters as f64 * 0.8) as usize {
            return sentence;
        }
        truncate_at_word_boundary(content, max_characters)
    }
}

/// Truncate at the last sentence boundary (`.`, `!` or `?`) before the
/// limit; keep the full prefix when no good boundary exists.
fn truncate_at_sentence_boundary(text: &str, max_length: usize) -> String {
    if text.chars().count() <= max_length {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max_length).collect();
    let last_sentence_end = ['.', '!', '?']
        .iter()
        .filter_map(|punct| truncated.rfind(*punct))
        .max()
        .unwrap_or(0);
    if last_sentence_end > max_length / 2 {
        truncated[..last_sentence_end + 1].to_string()
    } else {
        truncated
    }
}

/// Truncate at the last word boundary before the limit.
fn truncate_at_word_boundary(text: &str, max_length: usize) -> String {
    if text.chars().count() <= max_length {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max_length).collect();
    match truncated.rfind(' ') {
        Some(last_space) if last_space > (max_length as f64 * 0.8) as usize => {
            truncated[..last_space].to_string()
        }
        _ => truncated,
    }
}

/// Drive a set of borrowed futures to completion concurrently, round-robin
/// polling with yields between passes (no `futures` crate dependency).
/// Preserves input order.
async fn join_all_borrowed<T>(futures: Vec<Pin<Box<dyn Future<Output = T> + '_>>>) -> Vec<T> {
    let waker = Waker::noop();
    let mut cx = Context::from_waker(waker);
    let mut slots: Vec<Option<Pin<Box<dyn Future<Output = T> + '_>>>> =
        futures.into_iter().map(Some).collect();
    let mut results: Vec<Option<T>> = Vec::with_capacity(slots.len());
    for _ in 0..slots.len() {
        results.push(None);
    }

    loop {
        let mut any_pending = false;
        for (index, slot) in slots.iter_mut().enumerate() {
            let Some(future) = slot else { continue };
            match future.as_mut().poll(&mut cx) {
                Poll::Ready(value) => {
                    results[index] = Some(value);
                    *slot = None;
                }
                Poll::Pending => any_pending = true,
            }
        }
        if !any_pending {
            break;
        }
        tokio::task::yield_now().await;
    }

    results
        .into_iter()
        .map(|result| result.expect("join_all_borrowed result"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::{Diagnostics, DisplayConfig, LlmBudgets, Paths};
    use crate::types::LogFormat;
    use std::path::PathBuf;

    fn test_context(budgets: LlmBudgets) -> RunContext {
        RunContext {
            paths: Paths {
                project_root: PathBuf::from("/tmp"),
                data_dir: PathBuf::from("/tmp"),
                log_dir: PathBuf::from("/tmp"),
                materials_dir: PathBuf::from("/tmp"),
                profile_dir: PathBuf::from("/tmp"),
            },
            display: DisplayConfig {
                verbose: false,
                color: Some(false),
                hide_reasoning: false,
                show_reasoning: false,
                show_fetch_url: false,
                log_level: None,
                log_format: LogFormat::Pretty,
                machine_json: false,
                banner_loops: 4,
            },
            budgets,
            diagnostics: Diagnostics {
                log_llm_payloads: false,
                log_max_payload_length: None,
            },
            api_key: None,
            llm_base_url_override: None,
            indeed_api_key: None,
            usage_tracker: None,
            cancellation: tokio_util::sync::CancellationToken::new(),
            run_started_at_ms: 0,
        }
    }

    fn basic_request() -> LlmRequest {
        LlmRequest {
            provider: Provider::Openai,
            model: "unused".to_string(),
            messages: vec![],
            ..LlmRequest::default()
        }
    }

    // --- estimate_token_count ------------------------------------------------

    #[test]
    fn estimate_token_count_rounds_up_per_four_chars() {
        assert_eq!(LlmService::estimate_token_count(""), 0);
        assert_eq!(LlmService::estimate_token_count("abcd"), 1);
        assert_eq!(LlmService::estimate_token_count("abc"), 1);
        assert_eq!(LlmService::estimate_token_count("abcde"), 2);
        assert_eq!(LlmService::estimate_token_count("abcdefgh"), 2);
        // Multi-byte characters count as one char each.
        assert_eq!(LlmService::estimate_token_count("好的好的"), 1);
    }

    // --- truncate_response_to_max_tokens --------------------------------------

    #[test]
    fn truncate_returns_content_within_budget_unchanged() {
        let content = "short content";
        assert_eq!(
            LlmService::truncate_response_to_max_tokens(content, 100),
            content
        );
    }

    #[test]
    fn truncate_prefers_sentence_boundary() {
        let content = "Sentence one. Sentence two. Sentence three. Sentence four.";
        // max_tokens 3 -> 12 characters; sentence boundary at "Sentence one."
        let truncated = LlmService::truncate_response_to_max_tokens(content, 3);
        assert_eq!(truncated, "Sentence one");
        assert!(truncated.chars().count() <= 12);
    }

    #[test]
    fn truncate_falls_back_to_word_boundary_without_sentences() {
        let content = "aaaaaaaaaa bbbbbbbbbb ccc ddd eee";
        // max_chars = 21; last space at 21? "aaaaaaaaaa bbbbbbbbbb " -> index 20.
        let truncated = LlmService::truncate_response_to_max_tokens(content, 5);
        assert!(truncated.chars().count() <= 20);
        assert_eq!(truncated, "aaaaaaaaaa bbbbbbbbb");
        assert!(!truncated.contains("ccc"));
    }

    #[test]
    fn truncate_hard_cut_when_no_boundary_qualifies() {
        let content = "x".repeat(100);
        let truncated = LlmService::truncate_response_to_max_tokens(&content, 5);
        assert_eq!(truncated.chars().count(), 20);
        assert!(truncated.chars().all(|c| c == 'x'));
    }

    // --- budget enforcement (ported from test/llmBudget.test.js) -------------

    #[tokio::test]
    async fn request_budget_prevents_calls_before_provider_activity() {
        let ctx = test_context(LlmBudgets {
            max_llm_requests: Some(1),
            ..LlmBudgets::default()
        });
        let service = LlmService::new();
        // First call fails (no providers configured), but still consumes budget.
        let first = service.call(&ctx, basic_request()).await;
        assert!(first.is_err());
        // Second call is rejected by the budget before any provider activity.
        let second = service.call(&ctx, basic_request()).await;
        let error = second.expect_err("budget should be exhausted");
        assert!(error.message.contains("LLM request budget exhausted (1)"));
    }

    #[tokio::test]
    async fn output_token_budget_stops_call_before_provider_activity() {
        let ctx = test_context(LlmBudgets {
            max_llm_output_tokens: Some(10),
            ..LlmBudgets::default()
        });
        let service = LlmService::new();
        let mut request = basic_request();
        request.max_tokens = 11;
        let error = service
            .call(&ctx, request)
            .await
            .expect_err("output-token budget should reject");
        assert!(error
            .message
            .contains("LLM output-token budget exceeded (11 requested; limit 10)"));
    }

    #[tokio::test]
    async fn deadline_stops_call_before_provider_activity() {
        let ctx = RunContext {
            budgets: LlmBudgets {
                llm_deadline_ms: Some(1),
                ..LlmBudgets::default()
            },
            run_started_at_ms: 0, // epoch start: always past a 1ms deadline
            ..test_context(LlmBudgets::default())
        };
        let service = LlmService::new();
        let error = service
            .call(&ctx, basic_request())
            .await
            .expect_err("deadline should reject");
        assert!(error.message.contains("LLM run deadline exceeded (1ms)"));
    }

    #[tokio::test]
    async fn cumulative_output_token_reservations_stop_a_run() {
        let ctx = test_context(LlmBudgets {
            max_total_llm_output_tokens: Some(10),
            ..LlmBudgets::default()
        });
        let service = LlmService::new();
        let mut request = basic_request();
        request.max_tokens = 11;
        let error = service
            .call(&ctx, request)
            .await
            .expect_err("total output-token budget should reject");
        assert!(error
            .message
            .contains("Total LLM output-token budget exceeded (11 requested; limit 10)"));
    }

    #[tokio::test]
    async fn total_budget_accumulates_across_calls() {
        let ctx = test_context(LlmBudgets {
            max_total_llm_output_tokens: Some(20),
            ..LlmBudgets::default()
        });
        let service = LlmService::new();
        let mut request = basic_request();
        request.max_tokens = 12;
        assert!(service.call(&ctx, request.clone()).await.is_err()); // reserves 12
        let mut request = basic_request();
        request.max_tokens = 9; // 12 + 9 > 20
        let error = service
            .call(&ctx, request)
            .await
            .expect_err("cumulative budget should reject");
        assert!(error
            .message
            .contains("Total LLM output-token budget exceeded (21 requested; limit 20)"));
    }

    // --- provider dispatch -----------------------------------------------------

    #[tokio::test]
    async fn missing_provider_errors_before_any_request() {
        let ctx = test_context(LlmBudgets::default());
        let service = LlmService::new();
        let error = service
            .call(&ctx, basic_request())
            .await
            .expect_err("no providers configured");
        assert_eq!(
            error.message,
            "Provider openai not found and no default provider set"
        );
    }

    #[tokio::test]
    async fn gemini_and_mistral_are_unimplemented_stubs() {
        let ctx = test_context(LlmBudgets::default());
        let service = LlmService::new();
        let mut request = basic_request();
        request.provider = Provider::Gemini;
        let error = service.call(&ctx, request.clone()).await.unwrap_err();
        assert!(error
            .message
            .contains("Gemini integration requires @google/generative-ai package"));

        request.provider = Provider::Mistral;
        let error = service.call(&ctx, request).await.unwrap_err();
        assert!(error
            .message
            .contains("Mistral integration requires @mistralai/mistralai package"));
    }

    #[test]
    fn initialize_validates_provider_list() {
        let mut service = LlmService::new();
        assert!(service.initialize(vec![], Provider::Openai).is_err());

        let bad = ProviderConfig {
            name: "openai".to_string(),
            api_key: "  ".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            model: None,
        };
        assert!(service.initialize(vec![bad], Provider::Openai).is_err());

        let good = ProviderConfig {
            name: "openrouter".to_string(),
            api_key: "sk-or-key".to_string(),
            base_url: "https://openrouter.ai/api/v1".to_string(),
            model: Some("z-ai/glm-5.3".to_string()),
        };
        assert!(service.initialize(vec![good], Provider::Openrouter).is_ok());
    }

    #[test]
    fn mask_sensitive_data_keeps_edges() {
        assert_eq!(mask_sensitive_data("short"), "*****");
        assert_eq!(
            mask_sensitive_data("sk-or-verylongsecretkey"),
            "sk-o***************tkey"
        );
    }

    #[test]
    fn join_all_borrowed_preserves_order_and_drives_concurrency() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let futures: Vec<Pin<Box<dyn Future<Output = u32> + '_>>> = (0..5)
                .map(|i| {
                    Box::pin(async move { (i * 2) as u32 }) as Pin<Box<dyn Future<Output = u32>>>
                })
                .collect();
            let results = join_all_borrowed(futures).await;
            assert_eq!(results, vec![0, 2, 4, 6, 8]);
        });
    }

    // --- mock-server integration ---------------------------------------------

    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;

    struct MockServer {
        base_url: String,
        body_rx: std::sync::mpsc::Receiver<String>,
    }

    fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    /// Serves exactly one HTTP request and captures its raw body.
    fn spawn_mock_server(response: String, content_type: &str) -> MockServer {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let addr = listener.local_addr().expect("mock server addr");
        let (tx, body_rx) = std::sync::mpsc::channel();
        let content_type = content_type.to_string();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                .ok();
            let mut buffer = Vec::new();
            let mut temp = [0u8; 8192];
            let header_end;
            loop {
                if let Some(position) = find_subslice(&buffer, b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&buffer[..position]).to_string();
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|value| value.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if buffer.len() >= position + 4 + content_length {
                        header_end = position;
                        break;
                    }
                }
                match stream.read(&mut temp) {
                    Ok(0) => {
                        header_end = find_subslice(&buffer, b"\r\n\r\n").unwrap_or(0);
                        break;
                    }
                    Ok(n) => buffer.extend_from_slice(&temp[..n]),
                    Err(_) => {
                        header_end = 0;
                        break;
                    }
                }
            }
            let body = String::from_utf8_lossy(&buffer[header_end + 4..]).to_string();
            let _ = tx.send(body);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                response.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        });
        MockServer {
            base_url: format!("http://{addr}"),
            body_rx,
        }
    }

    async fn call_with_server(
        ctx: &RunContext,
        request: LlmRequest,
        server: &MockServer,
        provider: Provider,
    ) -> LlmResponse {
        let mut service = LlmService::new();
        service
            .initialize(
                vec![ProviderConfig {
                    name: provider.to_string(),
                    api_key: "test-key".to_string(),
                    base_url: server.base_url.clone(),
                    model: None,
                }],
                provider,
            )
            .expect("initialize");
        service.call(ctx, request).await.expect("llm call")
    }

    #[tokio::test]
    async fn non_streaming_call_sends_expected_body_and_parses_response() {
        let body = json!({
            "id": "resp-1",
            "model": "gpt-test",
            "choices": [{"message": {"role": "assistant", "content": "hello world"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15, "cost": 0.001}
        })
        .to_string();
        let server = spawn_mock_server(body, "application/json");
        let ctx = test_context(LlmBudgets::default());
        let request = LlmRequest {
            provider: Provider::Openai,
            model: "gpt-test".to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: "hi".to_string(),
            }],
            temperature: 0.2,
            top_p: 0.9,
            max_tokens: 100,
            json_mode: true,
            ..LlmRequest::default()
        };
        let response = call_with_server(&ctx, request, &server, Provider::Openai).await;
        assert_eq!(response.content, "hello world");
        assert_eq!(response.finish_reason.as_deref(), Some("stop"));

        let sent: Value =
            serde_json::from_str(&server.body_rx.recv().expect("captured body")).unwrap();
        assert_eq!(sent["model"], "gpt-test");
        assert_eq!(sent["temperature"], 0.2);
        assert_eq!(sent["top_p"], 0.9);
        assert_eq!(sent["max_tokens"], 100);
        assert_eq!(sent["response_format"]["type"], "json_object");
        assert_eq!(sent["messages"][0]["role"], "user");
        assert!(sent.get("stream").is_none());
    }

    #[tokio::test]
    async fn streaming_call_aggregates_reasoning_content_and_usage() {
        let sse = [
            "data: {\"id\":\"c1\",\"model\":\"m\",\"choices\":[{\"delta\":{\"reasoning_content\":\"think \"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"reasoning\":\"more\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"world\"},\"finish_reason\":\"stop\"}]}\n\n",
            "data: {\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3,\"total_tokens\":10,\"cost\":0.001}}\n\n",
            "data: [DONE]\n\n",
        ]
        .concat();
        let server = spawn_mock_server(sse, "text/event-stream");
        let ctx = test_context(LlmBudgets::default());
        let request = LlmRequest {
            provider: Provider::Openrouter,
            model: "m".to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: "hi".to_string(),
            }],
            show_reasoning_tokens: true,
            ..LlmRequest::default()
        };
        let response = call_with_server(&ctx, request, &server, Provider::Openrouter).await;
        assert_eq!(response.content, "Hello world");
        assert_eq!(response.reasoning_content.as_deref(), Some("think more"));
        assert!(response.usage.is_some());

        let sent: Value =
            serde_json::from_str(&server.body_rx.recv().expect("captured body")).unwrap();
        assert_eq!(sent["stream"], true);
    }

    #[test]
    fn build_llm_call_context_minimal() {
        let request = LlmRequest {
            provider: Provider::Openai,
            model: "gpt-4o-mini".to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: "ping".to_string(),
            }],
            temperature: 0.7,
            top_p: 0.95,
            max_tokens: 4096,
            timeout_ms: 30_000,
            ..LlmRequest::default()
        };

        let pairs = build_llm_call_context("openai", &request, false, false);
        let map: std::collections::HashMap<_, _> = pairs.into_iter().collect();

        assert_eq!(map["provider"], json!("openai"));
        assert_eq!(map["model"], json!("gpt-4o-mini"));
        assert_eq!(map["messageCount"], json!(1));
        assert_eq!(map["temperature"], json!(0.7));
        assert_eq!(map["topP"], json!(0.95));
        assert_eq!(map["maxTokens"], json!(4096));
        assert_eq!(map["stream"], json!(false));
        assert_eq!(map["timeout"], json!(30_000));
        assert!(!map.contains_key("stage"));
        assert!(!map.contains_key("streamOptions.includeUsage"));
        assert!(!map.contains_key("jsonMode"));
        assert!(!map.contains_key("reasoning_effort"));
        assert!(!map.contains_key("provider.order"));
    }

    #[test]
    fn build_llm_call_context_full_openrouter() {
        let request = LlmRequest {
            provider: Provider::Openrouter,
            model: "z-ai/glm-5.3-flash".to_string(),
            messages: vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: "system prompt".to_string(),
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: "user prompt".to_string(),
                },
            ],
            temperature: 1.0,
            top_p: 0.95,
            max_tokens: 64_000,
            timeout_ms: 180_000,
            show_reasoning_tokens: true,
            show_response_stream: false,
            reasoning_effort: Some("medium".to_string()),
            provider_routing: Some(ProviderRouting {
                order: None,
                only: Some(vec![
                    "baseten/fp8".to_string(),
                    "parasail/fp8".to_string(),
                    "gmicloud/fp8".to_string(),
                ]),
                ignore: Some(vec!["nitro".to_string()]),
                quantizations: Some(vec!["fp8".to_string()]),
                allow_fallbacks: None,
            }),
            json_mode: true,
            stage: Some("jobCloth".to_string()),
            call_progress: Some("1/5".to_string()),
        };

        let pairs = build_llm_call_context("openrouter", &request, true, true);
        let map: std::collections::HashMap<_, _> = pairs.into_iter().collect();

        assert_eq!(map["provider"], json!("openrouter"));
        assert_eq!(map["model"], json!("z-ai/glm-5.3-flash"));
        assert_eq!(map["stage"], json!("jobCloth"));
        assert_eq!(map["callProgress"], json!("1/5"));
        assert_eq!(map["messageCount"], json!(2));
        assert_eq!(map["temperature"], json!(1.0));
        assert_eq!(map["topP"], json!(0.95));
        assert_eq!(map["maxTokens"], json!(64_000));
        assert_eq!(map["stream"], json!(true));
        assert_eq!(map["streamOptions.includeUsage"], json!(true));
        assert_eq!(map["timeout"], json!(180_000));
        assert_eq!(map["jsonMode"], json!(true));
        assert_eq!(map["reasoning_effort"], json!("medium"));
        assert_eq!(
            map["provider.order"],
            json!("baseten/fp8,parasail/fp8,gmicloud/fp8")
        );
        assert_eq!(
            map["provider.only"],
            json!("baseten/fp8,parasail/fp8,gmicloud/fp8")
        );
        assert_eq!(map["provider.ignore"], json!("nitro"));
        assert_eq!(map["provider.quantizations"], json!("fp8"));
        assert_eq!(map["provider.allow_fallbacks"], json!(false));
    }
}
