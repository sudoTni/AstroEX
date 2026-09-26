//! Stream repetition detector, ported from AstroEX-node
//! src/repetitionDetector.ts.
//!
//! Incrementally inspects streamed text (specifically reasoning tokens /
//! chain-of-thought) for pathological periodic repetition loops to abort
//! runaway model generations early.
//!
//! The algorithm operates on UTF-16 code units (like JavaScript string
//! indices) so thresholds and detected periods match the Node implementation
//! exactly, including for multi-byte scripts.

use crate::error::AppError;

#[derive(Debug, Clone, Copy, Default)]
pub struct RepetitionDetectorOptions {
    /// Maximum number of recent characters to retain in the sliding window. Default: 1024
    pub max_window_chars: Option<usize>,
    /// Maximum repeating period (in characters) to test for. Default: 128
    pub max_period: Option<usize>,
    /// Minimum total repeated characters required to declare a loop. Default: 64
    pub min_total_chars: Option<u64>,
}

/// A detected pathological repetition loop.
#[derive(Debug, Clone, PartialEq)]
pub struct RepetitionMatch {
    pub detected: bool,
    pub period: usize,
    pub repeats: u64,
    pub repeated_text: String,
    pub total_chars: u64,
}

/// Details carried on a [`create_repetition_error`] error context.
#[derive(Debug, Clone)]
pub struct RepetitionErrorDetails {
    pub provider: String,
    pub model: String,
    pub period: usize,
    pub repeats: u64,
    pub repeated_text: String,
    pub total_chars: u64,
    pub attempt: Option<u32>,
}

/// Build the retryable `PATHOLOGICAL_REASONING_REPETITION` error for a
/// detected match, mirroring the Node `PathologicalReasoningRepetitionError`.
pub fn create_repetition_error(
    provider: &str,
    model: &str,
    attempt: Option<u32>,
    details: &RepetitionMatch,
) -> AppError {
    let snippet = details.repeated_text.replace('\n', "\\n");
    let message = format!(
        "Pathological reasoning repetition detected for {}/{}: \"{}\" repeated {} times (period={}, chars={}).",
        provider, model, snippet, details.repeats, details.period, details.total_chars
    );
    let context = serde_json::json!({
        "provider": provider,
        "model": model,
        "period": details.period,
        "repeats": details.repeats,
        "repeatedText": details.repeated_text,
        "totalChars": details.total_chars,
        "attempt": attempt,
    });
    AppError::new("PATHOLOGICAL_REASONING_REPETITION", 500, message).with_context(context)
}

/// Incremental detector for pathological periodic repetition in streamed text.
pub struct StreamRepetitionDetector {
    /// Sliding window over UTF-16 code units (JS string semantics).
    buffer: Vec<u16>,
    max_window_chars: usize,
    max_period: usize,
    min_total_chars: u64,
    total_chars_seen: u64,
    last_match: Option<RepetitionMatch>,
}

impl Default for StreamRepetitionDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamRepetitionDetector {
    pub fn new() -> Self {
        Self::with_options(RepetitionDetectorOptions::default())
    }

    pub fn with_options(options: RepetitionDetectorOptions) -> Self {
        Self {
            buffer: Vec::new(),
            max_window_chars: options.max_window_chars.unwrap_or(1024),
            max_period: options.max_period.unwrap_or(128),
            min_total_chars: options.min_total_chars.unwrap_or(64),
            total_chars_seen: 0,
            last_match: None,
        }
    }

    /// Reset state for a new request or stream attempt.
    pub fn reset(&mut self) {
        self.buffer.clear();
        self.total_chars_seen = 0;
        self.last_match = None;
    }

    /// Total characters processed across all chunks in this stream session.
    pub fn total_observed(&self) -> u64 {
        self.total_chars_seen
    }

    /// Current buffered text length in the sliding window.
    pub fn buffered_length(&self) -> usize {
        self.buffer.len()
    }

    /// The last detected repetition match, if any.
    pub fn current_match(&self) -> Option<&RepetitionMatch> {
        self.last_match.as_ref()
    }

    /// Creates a `PATHOLOGICAL_REASONING_REPETITION` error based on the
    /// latest detected repetition (or an empty match if none was detected).
    pub fn create_error(&self, provider: &str, model: &str, attempt: Option<u32>) -> AppError {
        let fallback = RepetitionMatch {
            detected: false,
            period: 0,
            repeats: 0,
            repeated_text: String::new(),
            total_chars: 0,
        };
        create_repetition_error(
            provider,
            model,
            attempt,
            self.last_match.as_ref().unwrap_or(&fallback),
        )
    }

    /// Feed a new text chunk and check for pathological repetition.
    /// Returns `Some(RepetitionMatch)` if a periodic loop is found.
    pub fn feed(&mut self, chunk: &str) -> Option<RepetitionMatch> {
        if chunk.is_empty() {
            return None;
        }

        let units: Vec<u16> = chunk.encode_utf16().collect();
        self.total_chars_seen += units.len() as u64;
        self.buffer.extend_from_slice(&units);
        if self.buffer.len() > self.max_window_chars {
            let cutoff = self.buffer.len() - self.max_window_chars;
            self.buffer.drain(0..cutoff);
        }

        let buf_len = self.buffer.len();
        let max_p = self.max_period.min(buf_len / 2);

        // Scan candidate periods from smallest to largest to find the
        // fundamental period first
        for p in 1..=max_p {
            // Fast path check: do the characters at the boundary even match?
            if self.buffer[buf_len - 1] != self.buffer[buf_len - 1 - p] {
                continue;
            }

            // Count consecutive matching characters backwards from the end
            let mut matched_chars: usize = 0;
            let max_lookback = buf_len - p;
            for i in 0..max_lookback {
                if self.buffer[buf_len - 1 - i] == self.buffer[buf_len - 1 - p - i] {
                    matched_chars += 1;
                } else {
                    break;
                }
            }

            let total_chars = (matched_chars + p) as u64;
            let repeats = total_chars / p as u64;
            let first_unit = self.buffer[buf_len - p];

            // Check against period-specific pathological thresholds
            if self.is_pathological(p as u64, repeats, total_chars, first_unit) {
                let pattern = String::from_utf16_lossy(&self.buffer[buf_len - p..]);
                let matched = RepetitionMatch {
                    detected: true,
                    period: p,
                    repeats,
                    repeated_text: pattern,
                    total_chars,
                };
                self.last_match = Some(matched.clone());
                return Some(matched);
            }
        }

        None
    }

    fn is_pathological(
        &self,
        period: u64,
        repeats: u64,
        total_chars: u64,
        pattern_first_unit: u16,
    ) -> bool {
        if period == 1 {
            // Pure whitespace (spaces, tabs, newlines)
            if is_js_whitespace_unit(pattern_first_unit) {
                return repeats >= 80;
            }
            // Punctuation / markdown divider symbols (hyphens, equals, asterisks, etc.)
            if !is_ascii_alnum_unit(pattern_first_unit) {
                return repeats >= 80;
            }
            // Alphanumeric letters or digits (e.g. 'aaaa...')
            return repeats >= 40;
        }

        if period == 2 {
            // e.g. "..", "=-", "ab"
            return repeats >= 24 && total_chars >= 48;
        }

        // Minimum total characters requirement (overall floor for p >= 3)
        if total_chars < self.min_total_chars {
            return false;
        }

        if (3..=8).contains(&period) {
            // e.g. "lock" (p=4), "word " (p=5), "thinking" (p=8)
            return repeats >= 8 && total_chars >= 64;
        }

        if (9..=32).contains(&period) {
            // e.g. "let me verify " (p=14), "the candidate has " (p=18)
            return repeats >= 4 && total_chars >= 72;
        }

        // period >= 33 (long phrases, sentences, or structured clauses)
        repeats >= 3 && total_chars >= 120
    }
}

/// JavaScript `/\s/` (UTF-16 code unit level).
fn is_js_whitespace_unit(u: u16) -> bool {
    matches!(
        u,
        0x09 | 0x0A | 0x0B | 0x0C | 0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000
            ..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF
    )
}

/// JavaScript `/[a-zA-Z0-9]/` (UTF-16 code unit level).
fn is_ascii_alnum_unit(u: u16) -> bool {
    matches!(u, 0x30..=0x39 | 0x41..=0x5A | 0x61..=0x7A)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_motivating_lock_pattern_quickly() {
        let mut detector = StreamRepetitionDetector::new();
        assert!(detector
            .feed("Initial reasoning about the job title: Senior Cloud Security Engineer. ")
            .is_none());

        // Feed "lock" repeated in small stream chunks
        let mut matched = None;
        for _ in 0..20 {
            if let Some(m) = detector.feed("lock") {
                matched = Some(m);
                break;
            }
        }

        let m = matched.expect("expected detection");
        assert_eq!(m.period, 4);
        assert_eq!(m.repeated_text, "lock");
        assert!(m.repeats >= 16);
        assert!(m.total_chars >= 64);
        // Total observed characters before detection should be very small
        assert!(detector.total_observed() < 150);
    }

    #[test]
    fn detects_repeated_single_alphanumeric_characters() {
        let mut detector = StreamRepetitionDetector::new();
        assert!(detector
            .feed("Evaluating candidate background... ")
            .is_none());

        // 40+ identical letters triggers alphanumeric p=1 threshold
        let m = detector.feed(&"a".repeat(45)).expect("expected detection");
        assert_eq!(m.period, 1);
        assert_eq!(m.repeated_text, "a");
        assert!(m.repeats >= 40);
    }

    #[test]
    fn detects_repeated_multi_character_substring() {
        let mut detector = StreamRepetitionDetector::new();
        detector.feed("Some prelude text. ");

        // 25 repeats of "xyz" = 75 characters (p=3, threshold: repeats >= 8 && totalChars >= 64)
        let m = detector
            .feed(&"xyz".repeat(25))
            .expect("expected detection");
        assert_eq!(m.period, 3);
        assert_eq!(m.repeated_text, "xyz");
        assert!(m.repeats >= 8);
        assert!(m.total_chars >= 64);
    }

    #[test]
    fn detects_repetition_across_arbitrary_chunk_boundaries() {
        let mut detector = StreamRepetitionDetector::new();
        // Chunks split in irregular pieces
        let chunks = [
            "Intro thought. ",
            "lo",
            "cklock",
            "loc",
            "klock",
            "locklock",
            "locklocklock",
            "locklocklocklock",
            "locklocklocklock",
        ];

        let mut matched = None;
        for chunk in chunks {
            if let Some(m) = detector.feed(chunk) {
                matched = Some(m);
                break;
            }
        }

        let m = matched.expect("expected detection");
        assert_eq!(m.period, 4);
        assert_eq!(m.repeated_text, "lock");
    }

    #[test]
    fn detects_periodic_sentence_repetition() {
        let mut detector = StreamRepetitionDetector::new();
        let phrase = "Let me verify the candidate's clearance requirements. ";
        // 4 repeats of the sentence (p=54, threshold: repeats >= 3 && totalChars >= 120)
        let mut matched = None;
        for _ in 0..4 {
            if let Some(m) = detector.feed(phrase) {
                matched = Some(m);
                break;
            }
        }

        let m = matched.expect("expected detection");
        assert_eq!(m.period, phrase.encode_utf16().count());
        assert_eq!(m.repeated_text, phrase);
        assert!(m.repeats >= 3);
        assert!(m.total_chars >= 120);
    }

    #[test]
    fn does_not_trigger_on_realistic_reasoning_prose() {
        let mut detector = StreamRepetitionDetector::new();
        let realistic_reasoning = [
            "First, let me carefully review the candidate's resume for Cloud Security credentials. ",
            "The job description specifies AWS, Terraform, and Kubernetes experience. ",
            "Looking at the candidate's experience: ",
            "He worked at ExampleCorp as a Security Engineer from 2021 to 2024. ",
            "His key accomplishments include deploying Carbon Black EDR across 500+ endpoints, ",
            "configuring Splunk SIEM alerts, and mitigating critical vulnerabilities. ",
            "However, the job explicitly requires Secret clearance. ",
            "Checking the resume for clearance: the candidate has Public Trust suitability only. ",
            "Since the job mandates an active Secret clearance prior to start date, this triggers Gate 3 failure. ",
            "Therefore, the candidate is not eligible for this specific position.",
        ];

        for chunk in realistic_reasoning {
            assert!(detector.feed(chunk).is_none());
        }
        assert!(detector.total_observed() > 500);
    }

    #[test]
    fn does_not_trigger_on_legitimate_markdown() {
        let mut detector = StreamRepetitionDetector::new();
        // Standard 60-character markdown divider line
        assert!(detector
            .feed(&format!("Section 1\n{}\nSection 2\n", "-".repeat(60)))
            .is_none());

        // Standard markdown table header
        assert!(detector
            .feed(
                "| Candidate Skill | JD Requirement | Match Status |\n\
                 |---|---|---|\n\
                 | AWS | Required | Match |\n\
                 | SIEM | Required | Match |\n\
                 | CISSP | Preferred | Lacking |\n"
            )
            .is_none());
    }

    #[test]
    fn maintains_bounded_memory_on_long_non_repeating_streams() {
        let mut detector = StreamRepetitionDetector::with_options(RepetitionDetectorOptions {
            max_window_chars: Some(1024),
            ..Default::default()
        });

        // Deterministic pseudo-random, non-repeating stream (50,000+ chars)
        let mut state: u64 = 0x2545F4914F6CDD1D;
        for i in 0..1000usize {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let chunk = format!(
                "Step {}: verifying parameter {} against schema. ",
                i,
                state % 1_000_000_007
            );
            assert!(detector.feed(&chunk).is_none());
            assert!(detector.buffered_length() <= 1024);
        }

        assert!(detector.total_observed() > 40_000);
        assert!(detector.buffered_length() <= 1024);
    }

    #[test]
    fn detects_unicode_multibyte_repetitive_loops() {
        let mut detector = StreamRepetitionDetector::new();
        // 35 repeats of "好的" (p=2, threshold: repeats >= 24 && totalChars >= 48)
        let m = detector
            .feed(&"好的".repeat(35))
            .expect("expected detection");
        assert_eq!(m.period, 2);
        assert_eq!(m.repeated_text, "好的");
        assert!(m.repeats >= 24);
    }

    #[test]
    fn repetition_error_structure_and_metadata() {
        let details = RepetitionMatch {
            detected: true,
            period: 4,
            repeats: 16,
            repeated_text: "lock".to_string(),
            total_chars: 64,
        };
        let error = create_repetition_error("openrouter", "z-ai/glm-5.3-flash", Some(1), &details);

        assert_eq!(error.code, "PATHOLOGICAL_REASONING_REPETITION");
        assert_eq!(error.status_code, 500);
        assert!(error.is_retryable());
        assert!(error.message.contains("lock"));
        assert!(error.message.contains("period=4"));
        assert!(error.message.contains("z-ai/glm-5.3-flash"));
        assert!(error.message.contains("repeated 16 times"));
        assert!(error.message.contains("chars=64"));
        let ctx = error.context.expect("context present");
        assert_eq!(ctx["period"], 4);
        assert_eq!(ctx["repeats"], 16);
        assert_eq!(ctx["repeatedText"], "lock");
        assert_eq!(ctx["totalChars"], 64);
        assert_eq!(ctx["attempt"], 1);
    }

    #[test]
    fn create_error_uses_last_match_and_newlines_are_escaped() {
        let mut detector = StreamRepetitionDetector::new();
        detector.feed("prelude ");
        detector.feed(&"ab\n".repeat(25));
        let error = detector.create_error("openai", "some-model", Some(2));
        assert_eq!(error.code, "PATHOLOGICAL_REASONING_REPETITION");
        assert!(!error.message.contains('\n'));
        assert!(error.message.contains("\\n"));
        assert_eq!(error.context.as_ref().unwrap()["attempt"], 2);
    }

    #[test]
    fn reset_clears_state() {
        let mut detector = StreamRepetitionDetector::new();
        detector.feed("some text ");
        detector.reset();
        assert_eq!(detector.total_observed(), 0);
        assert_eq!(detector.buffered_length(), 0);
        assert!(detector.current_match().is_none());
        assert!(detector.feed("x").is_none());
    }
}
