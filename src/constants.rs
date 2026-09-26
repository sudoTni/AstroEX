//! Ported from AstroEX-node src/constants.ts (relevant, used constants).
//! Vestigial Node-era entries (default gemini/mistral AI config, unused file
//! pattern lists) are intentionally not ported.

use std::time::Duration;

pub const APP_NAME: &str = "AstroOM";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

pub const MILLISECONDS_PER_DAY: u64 = 24 * 60 * 60 * 1000;
pub const DEFAULT_JOBCLOTH_COOL_OFF_DAYS: i64 = 30;
pub const JOB_DB_RETENTION_MS: u64 = DEFAULT_JOBCLOTH_COOL_OFF_DAYS as u64 * MILLISECONDS_PER_DAY;

pub const DEFAULT_MAX_RECORDS: i64 = 250_000;
pub const JOB_TITLE_MAX_LENGTH: usize = 200;
pub const JOB_COMPANY_MAX_LENGTH: usize = 100;

pub const DEFAULT_MAX_RETRIES: u32 = 3;
pub const DEFAULT_RETRY_DELAY_MS: u64 = 5000;
pub const EXPONENTIAL_BACKOFF_BASE: u32 = 2;
pub const MAX_RETRY_DELAY_MS: u64 = 30000;

pub const FILE_DATE_FORMAT: &str = "%Y%m%d_%H%M%S";
pub const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024;

// LLM defaults (from llmService.ts)
pub const DEFAULT_MAX_OUTPUT_TOKENS: u32 = 64000;
pub const DEFAULT_TEMPERATURE: f64 = 0.6;
pub const DEFAULT_TOP_P: f64 = 0.95;
pub const DEFAULT_MAX_TOKENS: u32 = 16000;
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// Effective HTTP timeout for LLM calls. Node validates the per-request
/// `timeout` field but never applies it to the OpenAI SDK call, so the SDK
/// default (10 minutes) governs every request; reproduce that behavior.
pub const LLM_HTTP_TIMEOUT_MS: u64 = 600_000;

// Circuit breaker per-service presets (circuitBreaker.ts createForService)
pub const CB_OPENAI_FAILURE_THRESHOLD: u32 = 3;
pub const CB_OPENAI_TIMEOUT_MS: u64 = 45_000;
pub const CB_OPENAI_RECOVERY_MS: u64 = 120_000;
pub const CB_GEMINI_FAILURE_THRESHOLD: u32 = 4;
pub const CB_GEMINI_TIMEOUT_MS: u64 = 30_000;
pub const CB_GEMINI_RECOVERY_MS: u64 = 90_000;
pub const CB_MISTRAL_FAILURE_THRESHOLD: u32 = 5;
pub const CB_MISTRAL_TIMEOUT_MS: u64 = 30_000;
pub const CB_MISTRAL_RECOVERY_MS: u64 = 60_000;
pub const CB_OPENROUTER_FAILURE_THRESHOLD: u32 = 3;
pub const CB_OPENROUTER_TIMEOUT_MS: u64 = 60_000;
pub const CB_OPENROUTER_RECOVERY_MS: u64 = 180_000;

// Internet watchdog (internetWatchdog.ts)
pub const DEFAULT_WATCHDOG_TARGET: &str = "8.8.8.8";
pub const WATCHDOG_INTERVAL_MS: u64 = 5_000;
pub const WATCHDOG_PROBE_TIMEOUT_MS: u64 = 3_000;
pub const WATCHDOG_FAILURE_THRESHOLD: u32 = 3;
pub const WATCHDOG_STARTUP_ATTEMPTS: u32 = 3;
pub const WATCHDOG_STARTUP_RETRY_DELAY_MS: u64 = 2_000;

pub const DEFAULT_SLEEP_SECONDS: f64 = 5.0;

pub fn job_db_retention_duration() -> Duration {
    Duration::from_millis(JOB_DB_RETENTION_MS)
}
