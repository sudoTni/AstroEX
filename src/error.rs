//! Application error type, ported from AstroEX-node src/utils.ts AppError.

use serde_json::Value;

#[derive(Debug, Clone)]
pub struct AppError {
    pub code: String,
    pub status_code: u16,
    pub message: String,
    /// Boxed to keep the `Result` error variant small (clippy
    /// `result_large_err`); `serde_json::Value` grew with `preserve_order`.
    pub context: Option<Box<Value>>,
}

impl AppError {
    pub fn new(code: &str, status_code: u16, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            status_code,
            message: message.into(),
            context: None,
        }
    }

    pub fn with_context(mut self, context: Value) -> Self {
        self.context = Some(Box::new(context));
        self
    }

    pub fn message(message: impl Into<String>) -> Self {
        Self::new("APP_ERROR", 500, message)
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new("TIMEOUT", 408, message)
    }

    pub fn circuit_open(message: impl Into<String>) -> Self {
        Self::new("CIRCUIT_OPEN", 503, message)
    }

    pub fn is_retryable(&self) -> bool {
        matches!(
            self.code.as_str(),
            "PATHOLOGICAL_REASONING_REPETITION" | "LLM_CALL_FAILED"
        ) && self.status_code >= 500
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError::message(err.to_string())
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        AppError::message(err.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        AppError::message(err.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(err: reqwest::Error) -> Self {
        AppError::new("LLM_CALL_FAILED", 500, err.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
