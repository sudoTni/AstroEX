//! Internet watchdog: pings a target on an interval and escalates when
//! connectivity is lost. Port of AstroEX-node src/internetWatchdog.ts.

use crate::constants::{
    WATCHDOG_FAILURE_THRESHOLD, WATCHDOG_INTERVAL_MS, WATCHDOG_PROBE_TIMEOUT_MS,
    WATCHDOG_STARTUP_ATTEMPTS, WATCHDOG_STARTUP_RETRY_DELAY_MS,
};
use crate::context::abortable_delay;
use crate::error::{AppError, Result};
use crate::logging::{log_error, log_kv};
use crate::pipeline::cancellation::throw_if_cancelled;
use crate::types::LogLevel;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// Capability failure: the system ping binary cannot be executed.
pub fn capability_error(message: impl Into<String>) -> AppError {
    AppError::new("INTERNET_WATCHDOG_UNAVAILABLE", 500, message)
}

/// Startup failure: the target was unreachable during the bounded startup
/// validation attempts.
pub fn startup_error(target: &str, attempts: u32) -> AppError {
    AppError::new(
        "INTERNET_WATCHDOG_STARTUP_FAILED",
        500,
        format!("Internet watchdog target {target} was unreachable during startup after {attempts} attempts."),
    )
}

/// Sustained connectivity loss after the configured failure threshold.
pub fn connectivity_lost_error(
    target: &str,
    consecutive_failures: u32,
    outage_duration_ms: u64,
) -> AppError {
    let seconds = outage_duration_ms.div_ceil(1000);
    AppError::new(
        "INTERNET_WATCHDOG_CONNECTIVITY_LOST",
        500,
        format!("Internet watchdog lost contact with {target} after {consecutive_failures} consecutive probe failures ({seconds}s)."),
    )
    .with_context(json!({
        "target": target,
        "consecutive_failures": consecutive_failures,
        "outage_duration_ms": outage_duration_ms,
    }))
}

fn is_valid_hostname(value: &str) -> bool {
    if value.is_empty() || value.len() > 253 || value.ends_with('.') {
        return false;
    }
    value.split('.').all(|label| {
        let bytes = label.as_bytes();
        if bytes.is_empty() || bytes.len() > 63 {
            return false;
        }
        bytes[0].is_ascii_alphanumeric()
            && bytes[bytes.len() - 1].is_ascii_alphanumeric()
            && bytes
                .iter()
                .all(|&b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

fn json_quote(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Validate and normalize a probe target: bare IP address or hostname only.
pub fn validate_and_normalize_probe_target(value: &str) -> Result<String> {
    let target = value.trim();
    if target.is_empty() || target.chars().any(|c| c.is_whitespace()) || target.starts_with('-') {
        return Err(AppError::message(
            "--internet-watchdog must be a valid IP address or hostname",
        ));
    }
    if let Ok(_ip) = target.parse::<std::net::IpAddr>() {
        return Ok(target.to_lowercase());
    }
    if target.contains(':') || target.contains('/') || target.contains('?') {
        return Err(AppError::message(
            "--internet-watchdog accepts a hostname or IP address, not a URL or host:port value",
        ));
    }
    let ascii = target.to_lowercase();
    if !is_valid_hostname(&ascii) {
        return Err(AppError::message(format!(
            "Invalid internet watchdog target: {}",
            json_quote(value)
        )));
    }
    Ok(ascii)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

struct WatchdogInner {
    target: String,
    interval_ms: u64,
    probe_timeout_ms: u64,
    failure_threshold: u32,
    startup_attempts: u32,
    startup_retry_delay_ms: u64,
    stop_token: CancellationToken,
    loop_handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
    stopped: AtomicBool,
}

impl WatchdogInner {
    async fn probe_once(&self) -> Result<()> {
        let mut command = tokio::process::Command::new("ping");
        if self.target.contains(':') {
            command.arg("-6");
        }
        #[cfg(unix)]
        command.arg("-c").arg("1");
        #[cfg(windows)]
        command.arg("-n").arg("1");
        command.arg(&self.target);
        // Node runs ping through execFile, which captures (and discards)
        // stdout/stderr; do the same so probes do not pollute the console.
        command.stdout(std::process::Stdio::null());
        command.stderr(std::process::Stdio::null());
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err)
                if matches!(
                    err.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
                ) =>
            {
                return Err(capability_error(format!(
                    "Internet watchdog cannot execute ping: {err}"
                )));
            }
            Err(err) => {
                return Err(AppError::message(format!("Failed to spawn ping: {err}")));
            }
        };
        tokio::select! {
            status = child.wait() => match status {
                Ok(exit) if exit.success() => Ok(()),
                Ok(exit) => Err(AppError::message(format!(
                    "Ping probe for {} failed: {}",
                    self.target, exit
                ))),
                Err(err) => Err(AppError::message(err.to_string())),
            },
            _ = tokio::time::sleep(Duration::from_millis(self.probe_timeout_ms)) => {
                let _ = child.start_kill();
                Err(AppError::message(format!(
                    "Probe to {} timed out after {}ms",
                    self.target, self.probe_timeout_ms
                )))
            }
            _ = self.stop_token.cancelled() => {
                let _ = child.start_kill();
                Err(AppError::message("Internet watchdog probe cancelled"))
            }
        }
    }
}

async fn run_loop<F>(inner: Arc<WatchdogInner>, signal: CancellationToken, on_connectivity_lost: F)
where
    F: Fn(AppError) + Send + 'static,
{
    let mut consecutive_failures: u32 = 0;
    let mut outage_started_at: u64 = 0;
    while !inner.stopped.load(Ordering::SeqCst) && !signal.is_cancelled() {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(inner.interval_ms)) => {}
            _ = inner.stop_token.cancelled() => return,
        }
        if signal.is_cancelled() {
            return;
        }
        match inner.probe_once().await {
            Ok(()) => {
                if consecutive_failures > 0 {
                    log_kv(
                        "InternetWatchdog",
                        &format!(
                            "Internet watchdog connectivity restored for {}.",
                            inner.target
                        ),
                        LogLevel::Info,
                        &[
                            ("target", json!(inner.target)),
                            ("failedProbes", json!(consecutive_failures)),
                            (
                                "outageDurationMs",
                                json!(now_ms().saturating_sub(outage_started_at)),
                            ),
                        ],
                    );
                }
                consecutive_failures = 0;
                outage_started_at = 0;
            }
            Err(err) => {
                if inner.stopped.load(Ordering::SeqCst)
                    || inner.stop_token.is_cancelled()
                    || signal.is_cancelled()
                {
                    return;
                }
                if outage_started_at == 0 {
                    outage_started_at = now_ms();
                }
                consecutive_failures += 1;
                log_kv(
                    "InternetWatchdog",
                    &format!(
                        "Internet watchdog probe failed for {} ({}/{}).",
                        inner.target, consecutive_failures, inner.failure_threshold
                    ),
                    LogLevel::Warn,
                    &[
                        ("target", json!(inner.target)),
                        ("consecutiveFailures", json!(consecutive_failures)),
                        ("error", json!(err.message)),
                    ],
                );
                if err.code == "INTERNET_WATCHDOG_UNAVAILABLE" {
                    log_error("InternetWatchdog", &err, LogLevel::Error);
                    on_connectivity_lost(err);
                    return;
                }
                if consecutive_failures >= inner.failure_threshold {
                    let lost = connectivity_lost_error(
                        &inner.target,
                        consecutive_failures,
                        now_ms().saturating_sub(outage_started_at),
                    );
                    log_error("InternetWatchdog", &lost, LogLevel::Error);
                    on_connectivity_lost(lost);
                    return;
                }
            }
        }
    }
}

pub struct InternetWatchdog {
    inner: Arc<WatchdogInner>,
}

impl InternetWatchdog {
    pub fn new(target: &str) -> Result<Self> {
        Ok(Self {
            inner: Arc::new(WatchdogInner {
                target: validate_and_normalize_probe_target(target)?,
                interval_ms: WATCHDOG_INTERVAL_MS,
                probe_timeout_ms: WATCHDOG_PROBE_TIMEOUT_MS,
                failure_threshold: WATCHDOG_FAILURE_THRESHOLD,
                startup_attempts: WATCHDOG_STARTUP_ATTEMPTS,
                startup_retry_delay_ms: WATCHDOG_STARTUP_RETRY_DELAY_MS,
                stop_token: CancellationToken::new(),
                loop_handle: Mutex::new(None),
                stopped: AtomicBool::new(false),
            }),
        })
    }

    pub fn target(&self) -> &str {
        &self.inner.target
    }

    /// Probe the target up to `startup_attempts` times before the run starts.
    pub async fn validate_startup(&self, token: &CancellationToken) -> Result<()> {
        let inner = &self.inner;
        for attempt in 1..=inner.startup_attempts {
            throw_if_cancelled(token)?;
            match inner.probe_once().await {
                Ok(()) => {
                    log_kv(
                        "InternetWatchdog",
                        &format!("Internet watchdog activated for {}.", inner.target),
                        LogLevel::Info,
                        &[
                            ("target", json!(inner.target)),
                            ("probeIntervalMs", json!(inner.interval_ms)),
                            ("probeTimeoutMs", json!(inner.probe_timeout_ms)),
                            ("failureThreshold", json!(inner.failure_threshold)),
                        ],
                    );
                    return Ok(());
                }
                Err(err) => {
                    throw_if_cancelled(token)?;
                    if err.code == "INTERNET_WATCHDOG_UNAVAILABLE" {
                        return Err(err);
                    }
                    log_kv(
                        "InternetWatchdog",
                        &format!(
                            "Initial internet watchdog probe {}/{} failed for {}.",
                            attempt, inner.startup_attempts, inner.target
                        ),
                        LogLevel::Warn,
                        &[
                            ("target", json!(inner.target)),
                            ("attempt", json!(attempt)),
                            ("error", json!(err.message)),
                        ],
                    );
                    if attempt < inner.startup_attempts {
                        abortable_delay(inner.startup_retry_delay_ms, token).await?;
                    }
                }
            }
        }
        Err(startup_error(&inner.target, inner.startup_attempts))
    }

    /// Spawn the background probe loop. No-op if already running or stopped.
    pub fn start<F>(&self, signal: CancellationToken, on_connectivity_lost: F)
    where
        F: Fn(AppError) + Send + 'static,
    {
        let mut handle_slot = self.inner.loop_handle.lock().unwrap();
        if self.inner.stopped.load(Ordering::SeqCst) || handle_slot.is_some() {
            return;
        }
        let inner = Arc::clone(&self.inner);
        *handle_slot = Some(tokio::spawn(run_loop(inner, signal, on_connectivity_lost)));
    }

    /// Stop the probe loop and abort any in-flight probe. Idempotent.
    pub fn stop(&self) {
        if !self.inner.stopped.swap(true, Ordering::SeqCst) {
            self.inner.stop_token.cancel();
        }
        if let Some(handle) = self.inner.loop_handle.lock().unwrap().take() {
            handle.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::DEFAULT_WATCHDOG_TARGET;

    #[test]
    fn target_validation_accepts_ip_addresses_and_hostnames() {
        assert_eq!(
            validate_and_normalize_probe_target(" 8.8.8.8 ").unwrap(),
            "8.8.8.8"
        );
        assert_eq!(
            validate_and_normalize_probe_target("Example.COM").unwrap(),
            "example.com"
        );
        assert_eq!(
            validate_and_normalize_probe_target("2001:DB8::1").unwrap(),
            "2001:db8::1"
        );
        assert_eq!(
            validate_and_normalize_probe_target("sub.example-domain.com").unwrap(),
            "sub.example-domain.com"
        );
        assert_eq!(DEFAULT_WATCHDOG_TARGET, "8.8.8.8");
    }

    #[test]
    fn target_validation_rejects_urls_ports_and_option_like_values() {
        for value in [
            "",
            "https://example.com",
            "example.com:443",
            "example.com/path",
            "-c",
            "bad host",
            "under_score.example.com",
            "example.com.",
            "a..b",
            "-leading",
        ] {
            assert!(
                validate_and_normalize_probe_target(value).is_err(),
                "expected rejection: {value}"
            );
        }
    }

    #[test]
    fn target_validation_enforces_label_and_total_length_limits() {
        let long_label = "a".repeat(64);
        assert!(validate_and_normalize_probe_target(&long_label).is_err());
        let label63 = format!("{}.com", "a".repeat(63));
        assert!(validate_and_normalize_probe_target(&label63).is_ok());
        let too_long = format!("{}.example.com", "a".repeat(249));
        assert!(validate_and_normalize_probe_target(&too_long).is_err());
    }

    #[test]
    fn constructor_normalizes_target_and_rejects_invalid() {
        let watchdog = InternetWatchdog::new(" 8.8.8.8 ").unwrap();
        assert_eq!(watchdog.target(), "8.8.8.8");
        assert!(InternetWatchdog::new("https://example.com").is_err());
        assert!(InternetWatchdog::new("-c").is_err());
    }

    #[test]
    fn connectivity_lost_error_message_and_context() {
        let err = connectivity_lost_error("8.8.8.8", 3, 1500);
        assert_eq!(err.code, "INTERNET_WATCHDOG_CONNECTIVITY_LOST");
        assert_eq!(
            err.message,
            "Internet watchdog lost contact with 8.8.8.8 after 3 consecutive probe failures (2s)."
        );
        let context = err.context.expect("missing context");
        assert_eq!(context["target"], "8.8.8.8");
        assert_eq!(context["consecutive_failures"], 3);
        assert_eq!(context["outage_duration_ms"], 1500);
    }

    #[test]
    fn startup_error_message() {
        let err = startup_error("unreachable.example", 3);
        assert_eq!(err.code, "INTERNET_WATCHDOG_STARTUP_FAILED");
        assert_eq!(
            err.message,
            "Internet watchdog target unreachable.example was unreachable during startup after 3 attempts."
        );
    }

    #[test]
    fn capability_error_code() {
        let err = capability_error("Internet watchdog cannot execute ping: not found");
        assert_eq!(err.code, "INTERNET_WATCHDOG_UNAVAILABLE");
    }
}
