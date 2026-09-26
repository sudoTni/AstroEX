//! Console output primitives. Port of AstroEX-node src/logging/transports.ts
//! and src/logging/consoleOutput.ts. All process output flows through here so
//! the execution log tee (execution_log.rs) can mirror it.

use super::fader::{apply_hsv_fade, FadeOptions, GradientKey};
use serde_json::Value;
use std::io::Write;
use std::sync::Mutex;

pub static CONSOLE_OUTPUT_LOCK: Mutex<()> = Mutex::new(());

/// Helper to execute a closure while holding the global console output lock.
pub fn with_console_lock<F, R>(f: F) -> R
where
    F: FnOnce() -> R,
{
    let _guard = CONSOLE_OUTPUT_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    f()
}

pub fn lock_console() -> std::sync::MutexGuard<'static, ()> {
    CONSOLE_OUTPUT_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Pretty-printed machine JSON to stdout, always uncolored.
pub fn write_machine_json(value: &Value) {
    let body = serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_string());
    let _guard = lock_console();
    let mut out = std::io::stdout();
    let _ = out.write_all(body.as_bytes());
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

/// Internal logging failure fallback to stderr.
pub fn write_internal_console_failure(message: &str) {
    let styled = apply_hsv_fade(
        message,
        GradientKey::ErrorFallback,
        FadeOptions {
            use_color: Some(super::use_color()),
            ..Default::default()
        },
    );
    let _guard = lock_console();
    let mut err = std::io::stderr();
    let _ = err.write_all(styled.as_bytes());
    let _ = err.write_all(b"\n");
    let _ = err.flush();
}

pub fn write_stdout_line(line: &str) {
    if !super::execution_log::is_tee_active() {
        let _guard = lock_console();
        let mut out = std::io::stdout();
        let _ = out.write_all(line.as_bytes());
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    } else {
        let mut out = std::io::stdout();
        let _ = out.write_all(line.as_bytes());
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }
}

pub fn write_stderr_line(line: &str) {
    if !super::execution_log::is_tee_active() {
        let _guard = lock_console();
        let mut err = std::io::stderr();
        let _ = err.write_all(line.as_bytes());
        let _ = err.write_all(b"\n");
        let _ = err.flush();
    } else {
        let mut err = std::io::stderr();
        let _ = err.write_all(line.as_bytes());
        let _ = err.write_all(b"\n");
        let _ = err.flush();
    }
}

/// Re-emit external (child process) command output through the HSV styling:
/// stderr uses the "errorFallback" gradient, stdout uses the "activity" gradient.
pub fn write_external_command_output(stdout_chunk: Option<&str>, stderr_chunk: Option<&str>) {
    let use_color = super::use_color();
    if let Some(chunk) = stdout_chunk {
        if !chunk.is_empty() {
            let styled = apply_hsv_fade(
                chunk,
                GradientKey::Activity,
                FadeOptions {
                    use_color: Some(use_color),
                    ..Default::default()
                },
            );
            if !super::execution_log::is_tee_active() {
                let _guard = lock_console();
                let mut out = std::io::stdout();
                let _ = out.write_all(styled.as_bytes());
                let _ = out.flush();
            } else {
                let mut out = std::io::stdout();
                let _ = out.write_all(styled.as_bytes());
                let _ = out.flush();
            }
        }
    }
    if let Some(chunk) = stderr_chunk {
        if !chunk.is_empty() {
            let styled = apply_hsv_fade(
                chunk,
                GradientKey::ErrorFallback,
                FadeOptions {
                    use_color: Some(use_color),
                    ..Default::default()
                },
            );
            if !super::execution_log::is_tee_active() {
                let _guard = lock_console();
                let mut err = std::io::stderr();
                let _ = err.write_all(styled.as_bytes());
                let _ = err.flush();
            } else {
                let mut err = std::io::stderr();
                let _ = err.write_all(styled.as_bytes());
                let _ = err.flush();
            }
        }
    }
    super::execution_log::flush_execution_log();
}
