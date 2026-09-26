//! RunContext: the single, explicit runtime configuration object that
//! replaces every environment-variable read in the Node implementation.
//! Parsed once from CLI flags in main.rs and threaded through every stage.

use crate::llm::usage::OpenRouterUsageTracker;
use crate::types::{LogFormat, LogLevel};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

/// Resolved filesystem locations (from --data-dir/--log-dir/--materials-dir/
/// --profile-dir or install-root defaults).
#[derive(Debug, Clone)]
pub struct Paths {
    pub project_root: PathBuf,
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
    pub materials_dir: PathBuf,
    pub profile_dir: PathBuf,
}

/// Display/verbosity controls (from --verbose, --color, --hide-reasoning,
/// --show-fetch-url, --log-level, --log-format, --json).
#[derive(Debug, Clone)]
pub struct DisplayConfig {
    pub verbose: bool,
    /// None = auto (TTY detection); Some(true/false) = forced by --color/--no-color.
    pub color: Option<bool>,
    pub hide_reasoning: bool,
    /// Explicit `--show-reasoning`/`--show-reasoning-tokens` request (does not
    /// include the run-pipeline default, which is resolved by the pipeline).
    pub show_reasoning: bool,
    pub show_fetch_url: bool,
    pub log_level: Option<LogLevel>,
    pub log_format: LogFormat,
    /// --json: machine mode (banner suppressed, log level error, verbose off).
    pub machine_json: bool,
    pub banner_loops: u32,
}

impl DisplayConfig {
    /// The initial minimum log level, matching logger.resolveInitialConfig:
    /// explicit --log-level wins; else debug if verbose; else info.
    pub fn initial_log_level(&self) -> LogLevel {
        if let Some(level) = self.log_level {
            return level;
        }
        if self.machine_json {
            return LogLevel::Error;
        }
        if self.verbose {
            LogLevel::Debug
        } else {
            LogLevel::Info
        }
    }

    pub fn use_color(&self) -> bool {
        if self.machine_json || self.log_format == LogFormat::Json {
            return false;
        }
        self.color
            .unwrap_or_else(crate::logging::execution_log::is_stdout_terminal)
    }
}

impl Default for DisplayConfig {
    fn default() -> Self {
        Self {
            verbose: false,
            color: None,
            hide_reasoning: false,
            show_reasoning: false,
            show_fetch_url: false,
            log_level: None,
            log_format: LogFormat::Pretty,
            machine_json: false,
            banner_loops: 4,
        }
    }
}

/// LLM safety budgets (from --max-llm-requests / --max-llm-output-tokens /
/// --max-total-llm-output-tokens / --llm-deadline-ms).
#[derive(Debug, Clone)]
pub struct LlmBudgets {
    pub max_llm_requests: Option<u64>,
    pub max_llm_output_tokens: Option<u32>,
    pub max_total_llm_output_tokens: Option<u64>,
    pub llm_deadline_ms: Option<u64>,
}

impl Default for LlmBudgets {
    fn default() -> Self {
        Self {
            max_llm_requests: None,
            max_llm_output_tokens: Some(crate::constants::DEFAULT_MAX_OUTPUT_TOKENS),
            max_total_llm_output_tokens: None,
            llm_deadline_ms: None,
        }
    }
}

/// Diagnostics (from --log-llm-payloads / --log-max-payload-length).
#[derive(Debug, Clone)]
pub struct Diagnostics {
    pub log_llm_payloads: bool,
    pub log_max_payload_length: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct RunContext {
    pub paths: Paths,
    pub display: DisplayConfig,
    pub budgets: LlmBudgets,
    pub diagnostics: Diagnostics,
    /// OpenAI-compatible credential resolved from an explicit CLI value or
    /// key file. The application never reads it from the environment.
    pub api_key: Option<String>,
    /// Optional explicit override for the OpenAI-compatible endpoint used by
    /// every stage (defaults to the selected preset's `base_url`). Exposed as
    /// `--llm-base-url`; `None` preserves preset behavior.
    pub llm_base_url_override: Option<String>,
    pub indeed_api_key: Option<String>,
    /// When `run-pipeline --track-or-costs` is set, the shared OpenRouter
    /// usage tracker attached to every stage's LLM service for the run.
    pub usage_tracker: Option<Arc<Mutex<OpenRouterUsageTracker>>>,
    /// Cooperative cancellation for the whole run (signals, watchdog).
    pub cancellation: CancellationToken,
    /// Timestamp (epoch ms) the run started; used for LLM deadline checks.
    pub run_started_at_ms: u64,
}

impl RunContext {
    pub fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// Resolve the endpoint for a stage: an explicit `--llm-base-url` override
    /// wins, otherwise the preset's `base_url` is used unchanged.
    pub fn resolve_llm_base_url(&self, preset_base_url: &str) -> String {
        match self.llm_base_url_override.as_deref() {
            Some(url) if !url.trim().is_empty() => url.trim().to_string(),
            _ => preset_base_url.to_string(),
        }
    }
}

/// Abortable sleep: no-op for <= 0 ms; aborts when the token is cancelled.
pub async fn abortable_delay(ms: u64, token: &CancellationToken) -> crate::error::Result<()> {
    if ms == 0 {
        if token.is_cancelled() {
            crate::pipeline::cancellation::throw_if_cancelled(token)?;
        }
        return Ok(());
    }
    tokio::select! {
        _ = tokio::time::sleep(std::time::Duration::from_millis(ms)) => {}
        _ = token.cancelled() => {
            crate::pipeline::cancellation::throw_if_cancelled(token)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn abortable_delay_noop_for_non_positive() {
        let token = CancellationToken::new();
        assert!(abortable_delay(0, &token).await.is_ok());
    }

    #[tokio::test]
    async fn abortable_delay_aborts_promptly_when_cancelled() {
        let token = CancellationToken::new();
        let canceller = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            canceller.cancel();
        });
        let started = std::time::Instant::now();
        let result = abortable_delay(60_000, &token).await;
        assert!(result.is_err());
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[tokio::test]
    async fn abortable_delay_already_cancelled_returns_immediately() {
        let token = CancellationToken::new();
        token.cancel();
        assert!(abortable_delay(0, &token).await.is_err());
    }
}
