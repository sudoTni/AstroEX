//! Pipeline cancellation plumbing. Port of AstroEX-node
//! src/pipelineCancellation.ts.

use crate::error::AppError;
use tokio_util::sync::CancellationToken;

/// The reason a pipeline run was cancelled.
#[derive(Debug, Clone)]
pub enum CancellationCause {
    Watchdog {
        error: AppError,
    },
    Signal {
        signal: &'static str,
        error: AppError,
    },
}

pub struct PipelineCancellationController {
    token: CancellationToken,
    cause: std::sync::Mutex<Option<CancellationCause>>,
    finished: std::sync::atomic::AtomicBool,
}

impl Default for PipelineCancellationController {
    fn default() -> Self {
        Self::new()
    }
}

impl PipelineCancellationController {
    pub fn new() -> Self {
        Self {
            token: CancellationToken::new(),
            cause: std::sync::Mutex::new(None),
            finished: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub fn token(&self) -> CancellationToken {
        self.token.clone()
    }

    /// Cancel the pipeline; idempotent-once (returns false if already
    /// cancelled or finished).
    pub fn cancel(&self, cause: CancellationCause) -> bool {
        if self.token.is_cancelled() || self.finished.load(std::sync::atomic::Ordering::SeqCst) {
            return false;
        }
        {
            let mut c = self.cause.lock().unwrap();
            if c.is_none() {
                *c = Some(cause);
            }
        }
        self.token.cancel();
        true
    }

    pub fn cause(&self) -> Option<CancellationCause> {
        self.cause.lock().unwrap().clone()
    }

    pub fn is_cancelled(&self) -> bool {
        self.token.is_cancelled()
    }

    /// Marks the run as finished (prevents later cancels from mattering).
    pub fn finish(&self) {
        self.finished
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Throws (returns Err) if the signal is cancelled, using its reason.
pub fn throw_if_cancelled(token: &CancellationToken) -> crate::error::Result<()> {
    if token.is_cancelled() {
        return Err(AppError::message(
            "Pipeline cancelled before operation started",
        ));
    }
    Ok(())
}

/// In a catch block: swallow the original error and rethrow the
/// cancellation reason when aborted (prevents retry loops from masking
/// cancellation). Returns the original error otherwise.
pub fn rethrow_if_cancelled(
    original: AppError,
    token: &CancellationToken,
) -> crate::error::Result<()> {
    if token.is_cancelled() {
        return Err(AppError::message(format!(
            "Pipeline cancelled (original error: {})",
            original.message
        )));
    }
    Err(original)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signal_cause(name: &'static str) -> CancellationCause {
        CancellationCause::Signal {
            signal: name,
            error: AppError::new(name, 1, format!("cancelled by {name}")),
        }
    }

    #[test]
    fn cancel_is_idempotent_and_first_writer_wins() {
        let controller = PipelineCancellationController::new();
        assert!(!controller.is_cancelled());
        assert!(controller.cancel(signal_cause("SIGINT")));
        assert!(controller.is_cancelled());
        assert!(!controller.cancel(signal_cause("SIGTERM")));
        match controller.cause() {
            Some(CancellationCause::Signal { signal, .. }) => assert_eq!(signal, "SIGINT"),
            other => panic!("expected first cause, got {other:?}"),
        }
    }

    #[test]
    fn finish_prevents_later_cancellation() {
        let controller = PipelineCancellationController::new();
        controller.finish();
        assert!(!controller.cancel(signal_cause("SIGINT")));
        assert!(!controller.is_cancelled());
        assert!(controller.cause().is_none());
    }

    #[test]
    fn throw_if_cancelled_reports_only_after_cancel() {
        let token = CancellationToken::new();
        assert!(throw_if_cancelled(&token).is_ok());
        token.cancel();
        assert!(throw_if_cancelled(&token).is_err());
    }

    #[test]
    fn rethrow_prefers_cancellation_but_keeps_original_otherwise() {
        let token = CancellationToken::new();
        let original = AppError::new("BOOM", 500, "original failure");
        let error = rethrow_if_cancelled(original, &token).expect_err("error");
        assert_eq!(error.message, "original failure");

        token.cancel();
        let error = rethrow_if_cancelled(AppError::new("BOOM", 500, "original failure"), &token)
            .expect_err("cancelled");
        assert!(error.message.starts_with("Pipeline cancelled"));
    }
}
