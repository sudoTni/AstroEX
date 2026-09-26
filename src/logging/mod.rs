//! Logging subsystem. Port of AstroEX-node src/logging/ (levels, logger,
//! formatter, fader, redaction, transports, execution log, payload logs).

pub mod console_output;
pub mod execution_log;
pub mod fader;
pub mod formatter;
pub mod llm_formatter;
pub mod payload_logs;
pub mod redaction;
pub mod types;

use crate::types::{LogFormat, LogLevel};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use types::LogRecord;

pub use execution_log::flush_execution_log;
pub use fader::{apply_banner_rainbow, is_color_supported, strip_ansi};
pub use redaction::{sanitize_context, sanitize_string};

struct LoggingState {
    min_level: LogLevel,
    format: LogFormat,
    use_color: bool,
}

static STATE: OnceLock<Mutex<LoggingState>> = OnceLock::new();
static CONFIGURED: AtomicBool = AtomicBool::new(false);

fn state() -> &'static Mutex<LoggingState> {
    STATE.get_or_init(|| {
        Mutex::new(LoggingState {
            min_level: LogLevel::Info,
            format: LogFormat::Pretty,
            use_color: false,
        })
    })
}

static ONCE_KEYS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

/// Configure the global logger. Called once from main() after CLI parsing.
pub fn configure_logging(format: LogFormat, min_level: LogLevel, use_color: bool) {
    {
        let mut s = state().lock().unwrap();
        s.min_level = min_level;
        s.format = format;
        s.use_color = use_color;
    }
    fader::set_color_decision(use_color);
    CONFIGURED.store(true, Ordering::SeqCst);
}

pub fn current_format() -> LogFormat {
    state().lock().unwrap().format
}

pub fn use_color() -> bool {
    state().lock().unwrap().use_color
}

pub fn is_level_enabled(level: LogLevel) -> bool {
    if !CONFIGURED.load(Ordering::SeqCst) {
        return level.severity() >= LogLevel::Info.severity();
    }
    level.severity() >= state().lock().unwrap().min_level.severity()
}

fn dispatch(record: LogRecord) {
    let (fmt, use_color) = {
        let s = state().lock().unwrap();
        (s.format, s.use_color)
    };
    if record.component.is_empty() || record.message.is_empty() {
        console_output::write_internal_console_failure(&format!(
            "[AstroOM] invalid log: component={:?} message={:?}",
            record.component, record.message
        ));
        return;
    }
    let line = match fmt {
        LogFormat::Json => formatter::format_json(&record),
        LogFormat::Pretty => formatter::format_terminal(&record, use_color),
    };
    match record.level {
        LogLevel::Warn | LogLevel::Error | LogLevel::Fatal => {
            console_output::write_stderr_line(&line);
        }
        _ => {
            console_output::write_stdout_line(&line);
        }
    }
}

/// Core logging entry point.
pub fn log_record(record: LogRecord) {
    if !is_level_enabled(record.level) {
        return;
    }
    let sanitized_context = record.context.as_ref().map(sanitize_context);
    let mut record = record;
    record.context = sanitized_context;
    dispatch(record);
}

pub fn log(component: &str, message: &str, level: LogLevel) {
    log_record(LogRecord::now(level, component, message));
}

pub fn log_ctx(component: &str, message: &str, level: LogLevel, context: Map<String, Value>) {
    let mut record = LogRecord::now(level, component, message);
    record.context = Some(context);
    log_record(record);
}

/// Convenience: log with key=value context pairs.
pub fn log_kv(component: &str, message: &str, level: LogLevel, pairs: &[(&str, Value)]) {
    let mut map = Map::new();
    for (k, v) in pairs {
        map.insert(k.to_string(), v.clone());
    }
    log_ctx(component, message, level, map);
}

/// Deduplicated logging keyed by `component:key`.
pub fn log_once(component: &str, key: &str, message: &str, level: LogLevel) {
    let cache = ONCE_KEYS.get_or_init(|| Mutex::new(HashSet::new()));
    let dedup_key = format!("{component}:{key}");
    {
        let mut c = cache.lock().unwrap();
        if !c.insert(dedup_key) {
            return;
        }
    }
    log(component, message, level);
}

pub fn clear_once_keys() {
    let cache = ONCE_KEYS.get_or_init(|| Mutex::new(HashSet::new()));
    cache.lock().unwrap().clear();
}

/// Log an AppError at the given level with error context attached.
pub fn log_error(component: &str, error: &crate::error::AppError, level: LogLevel) {
    let mut err_obj = Map::new();
    err_obj.insert("name".to_string(), json!("AppError"));
    err_obj.insert("message".to_string(), json!(error.message));
    err_obj.insert("code".to_string(), json!(error.code));
    err_obj.insert("statusCode".to_string(), json!(error.status_code));
    if let Some(ctx) = &error.context {
        err_obj.insert("context".to_string(), ctx.as_ref().clone());
    }
    let mut context = Map::new();
    context.insert("error".to_string(), Value::Object(err_obj));
    log_ctx(component, &error.message.clone(), level, context);
}

// Convenience wrappers matching Node's logger API.
pub fn trace(component: &str, message: &str) {
    log(component, message, LogLevel::Trace);
}
pub fn debug(component: &str, message: &str) {
    log(component, message, LogLevel::Debug);
}
pub fn info(component: &str, message: &str) {
    log(component, message, LogLevel::Info);
}
pub fn success(component: &str, message: &str) {
    log(component, message, LogLevel::Success);
}
pub fn warn(component: &str, message: &str) {
    log(component, message, LogLevel::Warn);
}
pub fn error(component: &str, message: &str) {
    log(component, message, LogLevel::Error);
}
pub fn fatal(component: &str, message: &str) {
    log(component, message, LogLevel::Fatal);
}
pub fn section(component: &str, message: &str) {
    let mut map = Map::new();
    map.insert(
        formatter::CONTEXT_KEY_SECTION_BOUNDARY.to_string(),
        Value::Bool(true),
    );
    log_ctx(component, message, LogLevel::Info, map);
}
