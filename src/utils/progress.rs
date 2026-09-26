//! Logger-based progress reporter. Port of AstroEX-node src/utils/progress.ts.
//!
//! Emits concise, completion-bound progress through the standard logger. A
//! known total is throttled to preserve terminal readability; an unknown total
//! is reported incrementally without fabricating a percentage.

use crate::logging;
use crate::types::LogLevel;
use serde_json::{json, Value};

const DEFAULT_MAX_PROGRESS_UPDATES: u64 = 12;

#[derive(Default)]
pub struct CompleteOptions {
    /// `Some(Warn)` logs at warn level; anything else logs at info.
    pub level: Option<LogLevel>,
    pub suffix: Option<String>,
}

pub struct ProgressReporter {
    label: String,
    unit_label: String,
    total_units: Option<u64>,
    phase: String,
    max_updates: u64,
    started: bool,
    completed: u64,
    last_reported: u64,
    component: String,
}

pub struct ProgressOptions {
    pub label: String,
    pub unit_label: String,
    pub total_units: Option<u64>,
    pub phase: Option<String>,
    pub max_updates: Option<u64>,
    pub component: Option<String>,
}

impl ProgressReporter {
    /// Mirrors createProgressReporter(logger, opts). `maxUpdates` default 12.
    pub fn new(options: ProgressOptions) -> Self {
        Self {
            label: options.label,
            unit_label: options.unit_label,
            total_units: options.total_units,
            phase: options.phase.unwrap_or_else(|| "progress".to_string()),
            max_updates: options.max_updates.unwrap_or(DEFAULT_MAX_PROGRESS_UPDATES),
            started: false,
            completed: 0,
            last_reported: 0,
            component: options.component.unwrap_or_else(|| "AstroOM".to_string()),
        }
    }

    fn report_every(&self) -> u64 {
        match self.total_units {
            Some(total) if total > 0 => {
                (total as f64 / self.max_updates as f64).ceil().max(1.0) as u64
            }
            _ => 1,
        }
    }

    /// Node's `shouldReport` predicate at a given completion count.
    fn should_report_at(&self, completed: u64) -> bool {
        match self.total_units {
            None => true,
            Some(total) => {
                completed == 1
                    || completed == total
                    || completed.saturating_sub(self.last_reported) >= self.report_every()
            }
        }
    }

    /// Builds the initialization `(message, context)` pair (Node `start`).
    fn start_payload(&self, context: &[(&str, Value)]) -> (String, Vec<(String, Value)>) {
        let (description, mut pairs) = if let Some(total) = self.total_units {
            (
                format!(
                    "{total} planned {}{}",
                    self.unit_label,
                    if total == 1 { "" } else { "s" }
                ),
                vec![("totalUnits".to_string(), json!(total))],
            )
        } else {
            (
                format!(
                    "completed {}s; total is determined after eligibility checks",
                    self.unit_label
                ),
                Vec::new(),
            )
        };
        pairs.push(("unitLabel".to_string(), json!(self.unit_label)));
        for (key, value) in context {
            pairs.push((key.to_string(), value.clone()));
        }
        (
            format!(
                "{} {} initialized — tracking {}.",
                self.label, self.phase, description
            ),
            pairs,
        )
    }

    /// Builds a completion `(message, context)` pair (Node `complete`).
    fn complete_payload(
        &self,
        completed: u64,
        suffix: Option<&str>,
    ) -> (String, Vec<(String, Value)>) {
        let suffix = suffix
            .map(|suffix| format!(" ({suffix})"))
            .unwrap_or_default();
        let mut pairs = vec![
            ("completedUnits".to_string(), json!(completed)),
            ("unitLabel".to_string(), json!(self.unit_label)),
        ];
        let message = match self.total_units {
            Some(total) => {
                pairs.push(("totalUnits".to_string(), json!(total)));
                let percent = if total > 0 {
                    (((completed as f64 / total as f64) * 100.0).round()) as i64
                } else {
                    0
                };
                if total > 0 {
                    pairs.push(("percentComplete".to_string(), json!(percent)));
                }
                let percent_text = if total > 0 {
                    percent.to_string()
                } else {
                    "undefined".to_string()
                };
                format!(
                    "{} {} — {} {}/{} complete ({percent_text}%){suffix}.",
                    self.label, self.phase, self.unit_label, completed, total
                )
            }
            None => format!(
                "{} {} — {} {} complete{suffix}.",
                self.label, self.phase, self.unit_label, completed
            ),
        };
        (message, pairs)
    }

    /// `start()` logs the initialization line once.
    pub fn start_with_context(&mut self, context: &[(&str, Value)]) {
        if self.started {
            return;
        }
        self.started = true;
        let (message, pairs) = self.start_payload(context);
        logging::log_kv(&self.component, &message, LogLevel::Info, &to_pairs(&pairs));
    }

    pub fn start(&mut self) {
        self.start_with_context(&[]);
    }

    /// Report a completed unit; throttled to `maxUpdates` reports, always
    /// reporting the first and the final completion.
    pub fn complete_with_context(&mut self, context: &[(&str, Value)], options: CompleteOptions) {
        self.start_with_context(context);
        self.completed += 1;
        if !self.should_report_at(self.completed) {
            return;
        }
        self.last_reported = self.completed;
        let (message, mut pairs) = self.complete_payload(self.completed, options.suffix.as_deref());
        for (key, value) in context {
            pairs.push((key.to_string(), value.clone()));
        }
        let level = match options.level {
            Some(LogLevel::Warn) => LogLevel::Warn,
            _ => LogLevel::Info,
        };
        logging::log_kv(&self.component, &message, level, &to_pairs(&pairs));
    }

    pub fn complete(&mut self) {
        self.complete_with_context(&[], CompleteOptions::default());
    }

    /// Convenience used by callers that only report a unit count.
    pub fn increment(&mut self) {
        self.complete();
    }

    /// Set the known total after construction (used by pre-scanning stages).
    pub fn set_total(&mut self, total: u64) {
        self.total_units = Some(total);
    }

    pub fn completed(&self) -> u64 {
        self.completed
    }
}

fn to_pairs(pairs: &[(String, Value)]) -> Vec<(&str, Value)> {
    pairs
        .iter()
        .map(|(key, value)| (key.as_str(), value.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reporter(total: Option<u64>, max_updates: Option<u64>) -> ProgressReporter {
        ProgressReporter::new(ProgressOptions {
            label: "Stage 5/8: RemoteEval".to_string(),
            unit_label: "job".to_string(),
            total_units: total,
            phase: None,
            max_updates,
            component: Some("Test".to_string()),
        })
    }

    #[test]
    fn known_total_throttles_by_report_interval() {
        let mut progress = reporter(Some(100), Some(12));
        assert_eq!(progress.report_every(), 9);
        assert!(progress.should_report_at(1));
        assert!(!progress.should_report_at(2));
        progress.last_reported = 1;
        assert!(!progress.should_report_at(9));
        assert!(progress.should_report_at(10));
        assert!(
            progress.should_report_at(100),
            "final completion always reports"
        );
    }

    #[test]
    fn unknown_total_always_reports() {
        let progress = reporter(None, None);
        assert!(progress.should_report_at(1));
        assert!(progress.should_report_at(2));
        assert!(progress.should_report_at(1_000));
    }

    #[test]
    fn launcher_style_max_updates_reports_every_unit() {
        let progress = reporter(Some(5), Some(5));
        assert_eq!(progress.report_every(), 1);
    }

    #[test]
    fn zero_total_uses_interval_one() {
        let progress = reporter(Some(0), None);
        assert_eq!(progress.report_every(), 1);
    }

    #[test]
    fn start_payload_matches_node_known_total() {
        let progress = reporter(Some(3), None);
        let (message, pairs) = progress.start_payload(&[]);
        assert_eq!(
            message,
            "Stage 5/8: RemoteEval progress initialized — tracking 3 planned jobs."
        );
        assert_eq!(
            pairs,
            vec![
                ("totalUnits".to_string(), json!(3)),
                ("unitLabel".to_string(), json!("job")),
            ]
        );
    }

    #[test]
    fn start_payload_matches_node_unknown_total() {
        let progress = reporter(None, None);
        let (message, pairs) = progress.start_payload(&[]);
        assert_eq!(message, "Stage 5/8: RemoteEval progress initialized — tracking completed jobs; total is determined after eligibility checks.");
        assert_eq!(pairs, vec![("unitLabel".to_string(), json!("job"))]);
    }

    #[test]
    fn complete_payload_matches_node_known_total() {
        let progress = reporter(Some(4), Some(4));
        let (message, pairs) = progress.complete_payload(2, Some("conservative fallback"));
        assert_eq!(
            message,
            "Stage 5/8: RemoteEval progress — job 2/4 complete (50%) (conservative fallback)."
        );
        assert_eq!(
            pairs,
            vec![
                ("completedUnits".to_string(), json!(2)),
                ("unitLabel".to_string(), json!("job")),
                ("totalUnits".to_string(), json!(4)),
                ("percentComplete".to_string(), json!(50)),
            ]
        );
    }

    #[test]
    fn complete_payload_matches_node_unknown_total() {
        let progress = reporter(None, None);
        let (message, pairs) = progress.complete_payload(7, None);
        assert_eq!(message, "Stage 5/8: RemoteEval progress — job 7 complete.");
        assert_eq!(
            pairs,
            vec![
                ("completedUnits".to_string(), json!(7)),
                ("unitLabel".to_string(), json!("job")),
            ]
        );
    }
}
