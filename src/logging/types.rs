//! Logging subsystem types (LogRecord and related).

use crate::types::LogLevel;
use serde_json::Map;

#[derive(Debug, Clone)]
pub struct LogRecord {
    pub timestamp: String,
    pub level: LogLevel,
    pub component: String,
    pub message: String,
    pub context: Option<Map<String, serde_json::Value>>,
}

impl LogRecord {
    pub fn now(level: LogLevel, component: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            timestamp: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            level,
            component: component.into(),
            message: message.into(),
            context: None,
        }
    }
}
