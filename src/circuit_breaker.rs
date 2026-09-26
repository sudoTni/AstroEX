//! Enhanced Circuit Breaker, ported from AstroEX-node src/circuitBreaker.ts.
//!
//! Provides fault tolerance for external API calls with intelligent failure
//! detection and recovery mechanisms.
//!
//! This is a synchronous port of the state machine: the caller (LLM service)
//! is responsible for applying per-operation timeouts and for calling
//! [`CircuitBreaker::allow_request`], [`CircuitBreaker::record_success`] and
//! [`CircuitBreaker::record_failure`] around each operation.

use std::time::{SystemTime, UNIX_EPOCH};

/// Circuit breaker states.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CircuitState {
    /// Normal operation, requests are passed through.
    Closed,
    /// Circuit is open, requests are immediately failed.
    Open,
    /// Testing if service has recovered.
    HalfOpen,
}

impl CircuitState {
    pub fn as_str(self) -> &'static str {
        match self {
            CircuitState::Closed => "CLOSED",
            CircuitState::Open => "OPEN",
            CircuitState::HalfOpen => "HALF_OPEN",
        }
    }
}

impl std::fmt::Display for CircuitState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// Circuit breaker configuration (all values resolved; defaults mirror the
/// Node `CircuitBreakerFactory.defaultConfig`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CircuitBreakerConfig {
    /// Number of failures before opening circuit.
    pub failure_threshold: u32,
    /// Timeout for individual requests (ms). The sync port does not enforce
    /// this itself; the caller applies it.
    pub timeout_ms: u64,
    /// Time to wait before trying recovery (ms).
    pub recovery_timeout_ms: u64,
    /// Period to reset failure count (ms).
    pub monitoring_period_ms: u64,
    /// Max requests in half-open state.
    pub half_open_max_requests: u32,
}

impl Default for CircuitBreakerConfig {
    fn default() -> Self {
        Self {
            failure_threshold: 5,
            timeout_ms: 30_000,
            recovery_timeout_ms: 60_000,
            monitoring_period_ms: 60_000,
            half_open_max_requests: 3,
        }
    }
}

/// Circuit breaker metrics for monitoring.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CircuitBreakerMetrics {
    pub total_requests: u64,
    pub successful_requests: u64,
    pub failed_requests: u64,
    pub circuit_open_count: u64,
    pub circuit_open_duration_ms: f64,
    pub average_response_time_ms: f64,
}

const MAX_REQUEST_TIMES: usize = 100;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Enhanced circuit breaker for fault tolerance.
pub struct CircuitBreaker {
    name: String,
    config: CircuitBreakerConfig,
    state: CircuitState,
    failure_count: u32,
    last_failure_time: u64,
    next_attempt_time: u64,
    half_open_request_count: u32,
    metrics: CircuitBreakerMetrics,
    request_times: Vec<f64>,
    opened_at: Option<u64>,
}

impl CircuitBreaker {
    pub fn new(name: impl Into<String>, config: CircuitBreakerConfig) -> Self {
        Self {
            name: name.into(),
            config,
            state: CircuitState::Closed,
            failure_count: 0,
            last_failure_time: 0,
            next_attempt_time: 0,
            half_open_request_count: 0,
            metrics: CircuitBreakerMetrics::default(),
            request_times: Vec::new(),
            opened_at: None,
        }
    }

    pub fn with_default_config(name: impl Into<String>) -> Self {
        Self::new(name, CircuitBreakerConfig::default())
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn config(&self) -> CircuitBreakerConfig {
        self.config
    }

    /// Check if the circuit should allow the request, advancing the state
    /// machine (OPEN -> HALF_OPEN after the recovery timeout) as needed.
    ///
    /// Mirrors the check performed at the start of the Node `execute()`
    /// (which also counted the request), so this increments
    /// `total_requests`.
    pub fn allow_request(&mut self) -> bool {
        self.metrics.total_requests += 1;
        self.should_allow_request()
    }

    fn should_allow_request(&mut self) -> bool {
        let now = now_ms();

        // Reset failure count if monitoring period has passed
        if self.state == CircuitState::Closed
            && now.saturating_sub(self.last_failure_time) > self.config.monitoring_period_ms
        {
            self.failure_count = 0;
        }

        match self.state {
            CircuitState::Closed => true,
            CircuitState::Open => {
                // Check if we should attempt recovery
                if now >= self.next_attempt_time {
                    self.transition_to_half_open();
                    true
                } else {
                    false
                }
            }
            CircuitState::HalfOpen => {
                // Allow limited requests in half-open state
                self.half_open_request_count < self.config.half_open_max_requests
            }
        }
    }

    /// Record a successful operation (no response-time sample).
    pub fn record_success(&mut self) {
        self.record_success_with_response_time(None);
    }

    /// Record a successful operation with an optional response-time sample
    /// (ms), folded into the 100-sample average-response-time window.
    pub fn record_success_with_response_time(&mut self, response_time_ms: Option<f64>) {
        if let Some(rt) = response_time_ms {
            self.record_response_time(rt);
        }

        if self.state == CircuitState::HalfOpen {
            // Success in half-open state means recovery
            self.transition_to_closed();
            self.half_open_request_count = 0;
        }

        self.metrics.successful_requests += 1;
        self.failure_count = 0; // Reset failure count on success
    }

    /// Record a failed operation (no response-time sample).
    pub fn record_failure(&mut self) {
        self.record_failure_with_response_time(None);
    }

    /// Record a failed operation with an optional response-time sample (ms).
    pub fn record_failure_with_response_time(&mut self, response_time_ms: Option<f64>) {
        if let Some(rt) = response_time_ms {
            self.record_response_time(rt);
        }

        self.metrics.failed_requests += 1;

        if self.state == CircuitState::HalfOpen {
            // Failure in half-open state means circuit should stay open
            self.transition_to_open();
            self.half_open_request_count = 0;
        } else if self.state == CircuitState::Closed {
            // Increment failure count
            self.failure_count += 1;
            self.last_failure_time = now_ms();

            // Check if we should open the circuit
            if self.failure_count >= self.config.failure_threshold {
                self.transition_to_open();
            }
        }
    }

    fn record_response_time(&mut self, response_time: f64) {
        self.request_times.push(response_time);

        // Keep only recent request times
        if self.request_times.len() > MAX_REQUEST_TIMES {
            self.request_times.remove(0);
        }

        // Update average response time
        self.metrics.average_response_time_ms =
            self.request_times.iter().sum::<f64>() / self.request_times.len() as f64;
    }

    fn transition_to_open(&mut self) {
        if self.state != CircuitState::Open {
            self.state = CircuitState::Open;
            let now = now_ms();
            self.next_attempt_time = now + self.config.recovery_timeout_ms;
            self.opened_at = Some(now);
            self.metrics.circuit_open_count += 1;
        }
    }

    fn transition_to_half_open(&mut self) {
        if self.state == CircuitState::Open {
            self.close_open_duration();
        }
        self.state = CircuitState::HalfOpen;
        self.half_open_request_count = 0;
    }

    fn transition_to_closed(&mut self) {
        if self.state == CircuitState::Open {
            self.close_open_duration();
        }
        self.state = CircuitState::Closed;
        self.failure_count = 0;
    }

    fn close_open_duration(&mut self) {
        if let Some(opened_at) = self.opened_at.take() {
            self.metrics.circuit_open_duration_ms += now_ms().saturating_sub(opened_at) as f64;
        }
    }

    /// Get current circuit state.
    pub fn state(&self) -> CircuitState {
        self.state
    }

    /// Whether the circuit is currently open.
    pub fn is_open(&self) -> bool {
        self.state == CircuitState::Open
    }

    /// Get circuit breaker metrics.
    pub fn metrics(&self) -> CircuitBreakerMetrics {
        self.metrics
    }

    /// Get success rate (percentage).
    pub fn success_rate(&self) -> f64 {
        if self.metrics.total_requests == 0 {
            return 0.0;
        }
        (self.metrics.successful_requests as f64 / self.metrics.total_requests as f64) * 100.0
    }

    /// Reset circuit breaker to closed state (metrics are preserved, as in
    /// the Node implementation).
    pub fn reset(&mut self) {
        self.state = CircuitState::Closed;
        self.failure_count = 0;
        self.last_failure_time = 0;
        self.next_attempt_time = 0;
        self.half_open_request_count = 0;
        self.request_times.clear();
        self.opened_at = None;
    }

    /// Force open the circuit breaker.
    pub fn force_open(&mut self) {
        self.transition_to_open();
    }

    /// Force close the circuit breaker.
    pub fn force_close(&mut self) {
        self.transition_to_closed();
    }

    /// Time until next attempt (ms); 0 unless the circuit is open.
    pub fn time_until_next_attempt(&self) -> u64 {
        if self.state != CircuitState::Open {
            return 0;
        }
        self.next_attempt_time.saturating_sub(now_ms())
    }
}

/// Circuit breaker factory for consistent configuration.
pub struct CircuitBreakerFactory;

impl Default for CircuitBreakerFactory {
    fn default() -> Self {
        Self
    }
}

impl CircuitBreakerFactory {
    pub fn default_config() -> CircuitBreakerConfig {
        CircuitBreakerConfig::default()
    }

    /// Create a circuit breaker with default configuration (or a full
    /// override via `config`).
    pub fn create(name: &str, config: Option<&CircuitBreakerConfig>) -> CircuitBreaker {
        CircuitBreaker::new(name, config.copied().unwrap_or_default())
    }

    /// Create circuit breakers for common services.
    pub fn create_for_service(service: &str) -> CircuitBreaker {
        use crate::constants as c;
        let config = match service {
            "openai" => CircuitBreakerConfig {
                failure_threshold: c::CB_OPENAI_FAILURE_THRESHOLD,
                timeout_ms: c::CB_OPENAI_TIMEOUT_MS,
                recovery_timeout_ms: c::CB_OPENAI_RECOVERY_MS,
                ..CircuitBreakerConfig::default()
            },
            "gemini" => CircuitBreakerConfig {
                failure_threshold: c::CB_GEMINI_FAILURE_THRESHOLD,
                timeout_ms: c::CB_GEMINI_TIMEOUT_MS,
                recovery_timeout_ms: c::CB_GEMINI_RECOVERY_MS,
                ..CircuitBreakerConfig::default()
            },
            "mistral" => CircuitBreakerConfig {
                failure_threshold: c::CB_MISTRAL_FAILURE_THRESHOLD,
                timeout_ms: c::CB_MISTRAL_TIMEOUT_MS,
                recovery_timeout_ms: c::CB_MISTRAL_RECOVERY_MS,
                ..CircuitBreakerConfig::default()
            },
            "openrouter" => CircuitBreakerConfig {
                failure_threshold: c::CB_OPENROUTER_FAILURE_THRESHOLD,
                timeout_ms: c::CB_OPENROUTER_TIMEOUT_MS,
                recovery_timeout_ms: c::CB_OPENROUTER_RECOVERY_MS,
                ..CircuitBreakerConfig::default()
            },
            // Unknown services fall back to the default configuration (the
            // Node spread of an unknown service config is a no-op).
            _ => CircuitBreakerConfig::default(),
        };
        CircuitBreaker::new(service, config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;

    fn fast_config() -> CircuitBreakerConfig {
        CircuitBreakerConfig {
            failure_threshold: 3,
            timeout_ms: 1_000,
            recovery_timeout_ms: 40,
            monitoring_period_ms: 60_000,
            half_open_max_requests: 3,
        }
    }

    #[test]
    fn starts_closed_and_allows_requests() {
        let mut cb = CircuitBreaker::with_default_config("test");
        assert_eq!(cb.state(), CircuitState::Closed);
        assert!(!cb.is_open());
        assert!(cb.allow_request());
        assert_eq!(cb.metrics().total_requests, 1);
    }

    #[test]
    fn opens_after_failure_threshold() {
        let mut cb = CircuitBreaker::new("test", fast_config());
        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.state(), CircuitState::Closed);
        cb.record_failure();
        assert_eq!(cb.state(), CircuitState::Open);
        assert!(cb.is_open());
        assert!(!cb.allow_request());
        assert_eq!(cb.metrics().circuit_open_count, 1);
        assert!(cb.time_until_next_attempt() > 0);
        assert!(cb.time_until_next_attempt() <= 40);
    }

    #[test]
    fn success_resets_failure_count() {
        let mut cb = CircuitBreaker::new("test", fast_config());
        cb.record_failure();
        cb.record_failure();
        cb.record_success();
        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.state(), CircuitState::Closed);
    }

    #[test]
    fn transitions_to_half_open_after_recovery_timeout() {
        let mut cb = CircuitBreaker::new("test", fast_config());
        for _ in 0..3 {
            cb.record_failure();
        }
        assert_eq!(cb.state(), CircuitState::Open);
        sleep(std::time::Duration::from_millis(50));
        assert!(cb.allow_request());
        assert_eq!(cb.state(), CircuitState::HalfOpen);
    }

    #[test]
    fn half_open_success_closes_circuit() {
        let mut cb = CircuitBreaker::new("test", fast_config());
        for _ in 0..3 {
            cb.record_failure();
        }
        sleep(std::time::Duration::from_millis(50));
        assert!(cb.allow_request());
        cb.record_success();
        assert_eq!(cb.state(), CircuitState::Closed);
        assert!(cb.allow_request());
    }

    #[test]
    fn half_open_failure_reopens_circuit() {
        let mut cb = CircuitBreaker::new("test", fast_config());
        for _ in 0..3 {
            cb.record_failure();
        }
        sleep(std::time::Duration::from_millis(50));
        assert!(cb.allow_request());
        assert_eq!(cb.state(), CircuitState::HalfOpen);
        cb.record_failure();
        assert_eq!(cb.state(), CircuitState::Open);
        assert_eq!(cb.metrics().circuit_open_count, 2);
        assert!(!cb.allow_request());
    }

    #[test]
    fn monitoring_period_resets_failure_count() {
        let config = CircuitBreakerConfig {
            monitoring_period_ms: 30,
            ..fast_config()
        };
        let mut cb = CircuitBreaker::new("test", config);
        cb.record_failure();
        cb.record_failure();
        sleep(std::time::Duration::from_millis(40));
        assert!(cb.allow_request()); // resets failure count
        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.state(), CircuitState::Closed);
    }

    #[test]
    fn metrics_and_response_time_window() {
        let mut cb = CircuitBreaker::new("test", fast_config());
        cb.allow_request();
        cb.record_success_with_response_time(Some(100.0));
        cb.allow_request();
        cb.record_failure_with_response_time(Some(300.0));
        let m = cb.metrics();
        assert_eq!(m.total_requests, 2);
        assert_eq!(m.successful_requests, 1);
        assert_eq!(m.failed_requests, 1);
        assert!((m.average_response_time_ms - 200.0).abs() < f64::EPSILON);
        assert_eq!(cb.success_rate(), 50.0);
    }

    #[test]
    fn reset_clears_state_but_keeps_metrics() {
        let mut cb = CircuitBreaker::new("test", fast_config());
        for _ in 0..3 {
            cb.record_failure();
        }
        let opens = cb.metrics().circuit_open_count;
        cb.reset();
        assert_eq!(cb.state(), CircuitState::Closed);
        assert_eq!(cb.time_until_next_attempt(), 0);
        assert_eq!(cb.metrics().circuit_open_count, opens);
    }

    #[test]
    fn force_open_and_force_close() {
        let mut cb = CircuitBreaker::new("test", fast_config());
        cb.force_open();
        assert!(cb.is_open());
        cb.force_close();
        assert_eq!(cb.state(), CircuitState::Closed);
        assert!(cb.allow_request());
    }

    #[test]
    fn factory_service_presets() {
        let openai = CircuitBreakerFactory::create_for_service("openai");
        assert_eq!(
            openai.config(),
            CircuitBreakerConfig {
                failure_threshold: 3,
                timeout_ms: 45_000,
                recovery_timeout_ms: 120_000,
                monitoring_period_ms: 60_000,
                half_open_max_requests: 3,
            }
        );
        let gemini = CircuitBreakerFactory::create_for_service("gemini");
        assert_eq!(
            gemini.config(),
            CircuitBreakerConfig {
                failure_threshold: 4,
                timeout_ms: 30_000,
                recovery_timeout_ms: 90_000,
                monitoring_period_ms: 60_000,
                half_open_max_requests: 3,
            }
        );
        let mistral = CircuitBreakerFactory::create_for_service("mistral");
        assert_eq!(
            mistral.config(),
            CircuitBreakerConfig {
                failure_threshold: 5,
                timeout_ms: 30_000,
                recovery_timeout_ms: 60_000,
                monitoring_period_ms: 60_000,
                half_open_max_requests: 3,
            }
        );
        let openrouter = CircuitBreakerFactory::create_for_service("openrouter");
        assert_eq!(
            openrouter.config(),
            CircuitBreakerConfig {
                failure_threshold: 3,
                timeout_ms: 60_000,
                recovery_timeout_ms: 180_000,
                monitoring_period_ms: 60_000,
                half_open_max_requests: 3,
            }
        );
        // Unknown service falls back to defaults.
        assert_eq!(
            CircuitBreakerFactory::create_for_service("unknown").config(),
            CircuitBreakerConfig::default()
        );
    }

    #[test]
    fn factory_openai_threshold_opens_after_three_failures() {
        let mut cb = CircuitBreakerFactory::create_for_service("openai");
        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.state(), CircuitState::Closed);
        cb.record_failure();
        assert_eq!(cb.state(), CircuitState::Open);
    }
}
