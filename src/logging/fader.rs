//! HSV terminal color fader. Faithful port of AstroEX-node src/logging/fader.ts
//! (truecolor 24-bit ANSI, gradient profiles, streaming fader, banner rainbow).

use std::sync::OnceLock;

pub const ANSI_RESET: &str = "\x1b[0m";
pub const ANSI_BOLD: &str = "\x1b[1m";
pub const ANSI_DIM: &str = "\x1b[2m";

const ANSI_LIGHT_BANNER_BACKGROUND: &str = "\x1b[48;2;216;216;216m";
const ANSI_BLACK_BANNER_FOREGROUND: &str = "\x1b[38;2;24;24;24m";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GradientDirection {
    Forward,
    Reverse,
    Shortest,
    Longest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GradientMode {
    Continuous,
    PerLine,
    Symmetrical,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Hsv {
    /// Hue in degrees [0.0, 360.0)
    pub h: f64,
    /// Saturation in fraction [0.0, 1.0]
    pub s: f64,
    /// Value/brightness in fraction [0.0, 1.0]
    pub v: f64,
}

impl Hsv {
    pub const fn new(h_deg: f64, s_pct: f64, v_pct: f64) -> Self {
        Self {
            h: h_deg,
            s: s_pct / 100.0,
            v: v_pct / 100.0,
        }
    }

    pub const fn from_fractions(h_deg: f64, s: f64, v: f64) -> Self {
        Self { h: h_deg, s, v }
    }

    #[inline]
    pub fn normalized_hue(self) -> f64 {
        ((self.h % 360.0) + 360.0) % 360.0 / 360.0
    }
}

#[derive(Debug, Clone, Copy)]
pub struct GradientProfile {
    pub start: Hsv,
    pub end: Hsv,
    pub direction: GradientDirection,
}

impl GradientProfile {
    #[inline]
    pub fn start_hue(&self) -> f64 {
        self.start.normalized_hue()
    }

    #[inline]
    pub fn end_hue(&self) -> f64 {
        self.end.normalized_hue()
    }

    #[inline]
    pub fn start_saturation(&self) -> f64 {
        self.start.s
    }

    #[inline]
    pub fn end_saturation(&self) -> f64 {
        self.end.s
    }

    #[inline]
    pub fn start_value(&self) -> f64 {
        self.start.v
    }

    #[inline]
    pub fn end_value(&self) -> f64 {
        self.end.v
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct FadeOptions {
    pub use_color: Option<bool>,
    pub direction: Option<GradientDirection>,
    pub mode: Option<GradientMode>,
    pub phase: Option<f64>,
    pub cycle: Option<f64>,
    pub bold: bool,
    pub dim: bool,
    /// When `Some(false)`, whitespace advances the gradient position (Node
    /// `options.skipWhitespace === false`). Default `None` preserves Node's
    /// default of not advancing on whitespace.
    pub skip_whitespace: Option<bool>,
}

/// Registry keys, mirroring LOG_GRADIENTS in fader.ts and authoritative terminal presets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GradientKey {
    Timestamp,
    Component,
    Context,
    Badge,
    Trace,
    Debug,
    Info,
    Success,
    Warn,
    Error,
    Fatal,
    Reasoning,
    Streaming,
    Activity,
    ErrorFallback,
    Section,
    Value,
    Path,
    Identifier,
    Metric,
    Duration,
    Diagnostic,
    Request,
    Response,
    ToolCall,
    ToolResult,
    Payload,
    Lifecycle,
    Banner,
    LegacyStreaming,
}

pub fn gradient_profile(key: GradientKey) -> GradientProfile {
    use GradientDirection::*;
    match key {
        // Shared terminal record fields
        GradientKey::Timestamp => GradientProfile {
            start: Hsv::new(210.0, 6.0, 58.0),
            end: Hsv::new(210.0, 0.0, 42.0),
            direction: Shortest,
        },
        GradientKey::Component => GradientProfile {
            start: Hsv::new(210.0, 48.0, 72.0),
            end: Hsv::new(210.0, 22.0, 58.0),
            direction: Shortest,
        },
        GradientKey::Context => GradientProfile {
            start: Hsv::new(210.0, 14.0, 70.0),
            end: Hsv::new(210.0, 4.0, 52.0),
            direction: Shortest,
        },
        GradientKey::Badge => GradientProfile {
            start: Hsv::new(210.0, 62.0, 78.0),
            end: Hsv::new(210.0, 32.0, 64.0),
            direction: Shortest,
        },

        // Log message gradients
        GradientKey::Trace => GradientProfile {
            start: Hsv::new(215.0, 18.0, 58.0),
            end: Hsv::new(215.0, 0.0, 38.0),
            direction: Shortest,
        },
        GradientKey::Debug => GradientProfile {
            start: Hsv::new(210.0, 32.0, 66.0),
            end: Hsv::new(210.0, 8.0, 46.0),
            direction: Shortest,
        },
        GradientKey::Info => GradientProfile {
            start: Hsv::new(210.0, 72.0, 82.0),
            end: Hsv::new(210.0, 0.0, 88.0),
            direction: Shortest,
        },
        GradientKey::Success => GradientProfile {
            start: Hsv::new(140.0, 48.0, 82.0),
            end: Hsv::new(140.0, 78.0, 68.0),
            direction: Shortest,
        },
        GradientKey::Warn => GradientProfile {
            start: Hsv::new(30.0, 58.0, 88.0),
            end: Hsv::new(25.0, 88.0, 78.0),
            direction: Shortest,
        },
        GradientKey::Error => GradientProfile {
            start: Hsv::new(355.0, 58.0, 86.0),
            end: Hsv::new(0.0, 82.0, 72.0),
            direction: Shortest,
        },
        GradientKey::Fatal => GradientProfile {
            start: Hsv::new(25.0, 88.0, 76.0),
            end: Hsv::new(0.0, 92.0, 62.0),
            direction: Shortest,
        },

        // Other terminal output gradients
        GradientKey::Reasoning => GradientProfile {
            start: Hsv::new(215.0, 42.0, 72.0),
            end: Hsv::new(215.0, 8.0, 52.0),
            direction: Shortest,
        },
        GradientKey::Streaming => GradientProfile {
            start: Hsv::new(205.0, 72.0, 80.0),
            end: Hsv::new(155.0, 62.0, 72.0),
            direction: Shortest,
        },
        GradientKey::Activity => GradientProfile {
            start: Hsv::new(145.0, 60.0, 72.0),
            end: Hsv::new(205.0, 68.0, 76.0),
            direction: Shortest,
        },
        GradientKey::ErrorFallback => GradientProfile {
            start: Hsv::new(355.0, 58.0, 86.0),
            end: Hsv::new(0.0, 82.0, 72.0),
            direction: Shortest,
        },

        // Legacy / helper profiles
        GradientKey::LegacyStreaming => GradientProfile {
            start: Hsv::from_fractions(0.52 * 360.0, 0.85, 0.98),
            end: Hsv::from_fractions(0.80 * 360.0, 0.85, 0.98),
            direction: Forward,
        },
        GradientKey::Section => GradientProfile {
            start: Hsv::from_fractions(0.72 * 360.0, 0.72, 0.94),
            end: Hsv::from_fractions(0.58 * 360.0, 0.72, 0.94),
            direction: Reverse,
        },
        GradientKey::Value => GradientProfile {
            start: Hsv::from_fractions(0.54 * 360.0, 0.58, 0.92),
            end: Hsv::from_fractions(0.54 * 360.0, 0.58, 0.92),
            direction: Shortest,
        },
        GradientKey::Path => GradientProfile {
            start: Hsv::from_fractions(0.46 * 360.0, 0.64, 0.90),
            end: Hsv::from_fractions(0.46 * 360.0, 0.64, 0.90),
            direction: Shortest,
        },
        GradientKey::Identifier => GradientProfile {
            start: Hsv::from_fractions(0.73 * 360.0, 0.58, 0.94),
            end: Hsv::from_fractions(0.73 * 360.0, 0.58, 0.94),
            direction: Shortest,
        },
        GradientKey::Metric => GradientProfile {
            start: Hsv::from_fractions(0.52 * 360.0, 0.70, 0.96),
            end: Hsv::from_fractions(0.52 * 360.0, 0.70, 0.96),
            direction: Shortest,
        },
        GradientKey::Duration => GradientProfile {
            start: Hsv::from_fractions(0.13 * 360.0, 0.74, 0.96),
            end: Hsv::from_fractions(0.13 * 360.0, 0.74, 0.96),
            direction: Shortest,
        },
        GradientKey::Diagnostic => GradientProfile {
            start: Hsv::from_fractions(0.61 * 360.0, 0.20, 0.68),
            end: Hsv::from_fractions(0.61 * 360.0, 0.20, 0.68),
            direction: Shortest,
        },
        GradientKey::Request => GradientProfile {
            start: Hsv::from_fractions(0.50 * 360.0, 0.85, 0.98),
            end: Hsv::from_fractions(0.78 * 360.0, 0.85, 0.98),
            direction: Forward,
        },
        GradientKey::Response => GradientProfile {
            start: Hsv::from_fractions(0.78 * 360.0, 0.85, 0.98),
            end: Hsv::from_fractions(0.50 * 360.0, 0.85, 0.98),
            direction: Reverse,
        },
        GradientKey::ToolCall => GradientProfile {
            start: Hsv::from_fractions(0.46 * 360.0, 0.85, 0.96),
            end: Hsv::from_fractions(0.60 * 360.0, 0.85, 0.96),
            direction: Forward,
        },
        GradientKey::ToolResult => GradientProfile {
            start: Hsv::from_fractions(0.60 * 360.0, 0.85, 0.96),
            end: Hsv::from_fractions(0.35 * 360.0, 0.85, 0.96),
            direction: Reverse,
        },
        GradientKey::Payload => GradientProfile {
            start: Hsv::from_fractions(0.55 * 360.0, 0.65, 0.88),
            end: Hsv::from_fractions(0.45 * 360.0, 0.65, 0.88),
            direction: Reverse,
        },
        GradientKey::Lifecycle => GradientProfile {
            start: Hsv::from_fractions(0.76 * 360.0, 0.82, 0.96),
            end: Hsv::from_fractions(0.60 * 360.0, 0.82, 0.96),
            direction: Reverse,
        },
        GradientKey::Banner => GradientProfile {
            start: Hsv::from_fractions(0.0, 0.80, 0.98),
            end: Hsv::from_fractions(360.0, 0.80, 0.98),
            direction: Forward,
        },
    }
}

/// Global color decision, set once from CLI flags at startup.
/// None = not yet configured (falls back to TTY detection).
static COLOR_DECISION: OnceLock<bool> = OnceLock::new();

#[cfg(windows)]
pub fn enable_windows_ansi() {
    use windows_sys::Win32::System::Console::{
        GetConsoleMode, GetStdHandle, SetConsoleMode, ENABLE_VIRTUAL_TERMINAL_PROCESSING,
        STD_ERROR_HANDLE, STD_OUTPUT_HANDLE,
    };
    for handle_id in [STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        let handle = unsafe { GetStdHandle(handle_id) };
        if !handle.is_null() && handle != windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            let mut mode = 0u32;
            if unsafe { GetConsoleMode(handle, &mut mode) } != 0 {
                let _ =
                    unsafe { SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING) };
            }
        }
    }
}

pub fn set_color_decision(enabled: bool) {
    #[cfg(windows)]
    if enabled {
        enable_windows_ansi();
    }
    let _ = COLOR_DECISION.set(enabled);
}

pub fn is_color_supported() -> bool {
    let supported = COLOR_DECISION
        .get()
        .copied()
        .unwrap_or_else(super::execution_log::is_stdout_terminal);
    #[cfg(windows)]
    if supported {
        enable_windows_ansi();
    }
    supported
}

fn hsv_to_rgb(h: f64, s: f64, v: f64) -> (u8, u8, u8) {
    let mut normalized_h = h % 1.0;
    if normalized_h < 0.0 {
        normalized_h += 1.0;
    }
    let clamped_s = s.clamp(0.0, 1.0);
    let clamped_v = v.clamp(0.0, 1.0);

    let i = (normalized_h * 6.0).floor();
    let f = normalized_h * 6.0 - i;
    let p = clamped_v * (1.0 - clamped_s);
    let q = clamped_v * (1.0 - clamped_s * f);
    let t = clamped_v * (1.0 - clamped_s * (1.0 - f));

    let (r, g, b) = match (i as i64) % 6 {
        0 => (clamped_v, t, p),
        1 => (q, clamped_v, p),
        2 => (p, clamped_v, t),
        3 => (p, q, clamped_v),
        4 => (t, p, clamped_v),
        _ => (clamped_v, p, q),
    };
    (
        (r * 255.0).round() as u8,
        (g * 255.0).round() as u8,
        (b * 255.0).round() as u8,
    )
}

/// Strip all ANSI escape sequences (OSC, CSI, and 2-char escapes).
pub fn strip_ansi(text: &str) -> String {
    static RE_OS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static RE_CSI: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static RE_TWO: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re_os =
        RE_OS.get_or_init(|| regex::Regex::new("\x1b\\][^\x07]*(?:\x07|\x1b\\\\)").unwrap());
    let re_csi =
        RE_CSI.get_or_init(|| regex::Regex::new("(?:\x1b\\[|\u{9b})[0-?]*[ -/]*[@-~]").unwrap());
    let re_two = RE_TWO.get_or_init(|| regex::Regex::new("\x1b[@-_]").unwrap());
    let s = re_os.replace_all(text, "");
    let s = re_csi.replace_all(&s, "");
    re_two.replace_all(&s, "").to_string()
}

fn interpolate_hue(h1: f64, h2: f64, t: f64, direction: GradientDirection) -> f64 {
    let wrap = |x: f64| ((x % 1.0) + 1.0) % 1.0;
    let start = wrap(h1);
    let end = wrap(h2);
    match direction {
        GradientDirection::Forward => {
            let diff = wrap(end - start);
            wrap(start + diff * t)
        }
        GradientDirection::Reverse => {
            let diff = wrap(start - end);
            wrap(start - diff * t)
        }
        GradientDirection::Longest => {
            let short_diff = ((end - start + 1.5) % 1.0) - 0.5;
            let long_diff = if short_diff >= 0.0 {
                short_diff - 1.0
            } else {
                short_diff + 1.0
            };
            wrap(start + long_diff * t)
        }
        GradientDirection::Shortest => {
            let diff = ((end - start + 1.5) % 1.0) - 0.5;
            wrap(start + diff * t)
        }
    }
}

fn interpolate_hsv(profile: &GradientProfile, t: f64, options: &FadeOptions) -> (u8, u8, u8) {
    let clamped_t = t.clamp(0.0, 1.0);
    let mode = options.mode.unwrap_or(GradientMode::Continuous);
    let cycle = options.cycle.unwrap_or(1.0);
    let phase_opt = options.phase.unwrap_or(0.0);
    let direction = options.direction.unwrap_or(profile.direction);

    let mut progress = (clamped_t * cycle) % 1.0;
    if clamped_t == 1.0 && (cycle == 1.0 || progress == 0.0) {
        progress = 1.0;
    }
    if mode == GradientMode::Symmetrical {
        progress = if progress < 0.5 {
            progress * 2.0
        } else {
            (1.0 - progress) * 2.0
        };
    }

    let h1 = profile.start.normalized_hue();
    let h2 = profile.end.normalized_hue();
    let mut final_hue = interpolate_hue(h1, h2, progress, direction);
    if phase_opt != 0.0 {
        final_hue = ((final_hue + phase_opt) % 1.0 + 1.0) % 1.0;
    }
    let final_sat = profile.start.s + (profile.end.s - profile.start.s) * progress;
    let final_val = profile.start.v + (profile.end.v - profile.start.v) * progress;
    hsv_to_rgb(final_hue, final_sat, final_val)
}

/// Matches ^ESC [ 0-9;]* [a-zA-Z] at the start of `text`; returns byte length.
fn ansi_escape_prefix_len(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    if bytes.len() < 3 || bytes[0] != 0x1b || bytes[1] != b'[' {
        return None;
    }
    let mut i = 2;
    while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b';') {
        i += 1;
    }
    if i < bytes.len() && bytes[i].is_ascii_alphabetic() {
        Some(i + 1)
    } else {
        None
    }
}

struct CharCursor {
    chars: Vec<char>,
    /// byte offset of each char index
    offsets: Vec<usize>,
}

impl CharCursor {
    fn new(text: &str) -> Self {
        let chars: Vec<char> = text.chars().collect();
        let mut offsets = Vec::with_capacity(chars.len());
        let mut off = 0;
        for c in &chars {
            offsets.push(off);
            off += c.len_utf8();
        }
        Self { chars, offsets }
    }

    /// Remaining text (as a &str slice) starting at char index i.
    fn suffix<'a>(&self, text: &'a str, i: usize) -> &'a str {
        &text[self.offsets[i]..]
    }

    fn take_ansi(&self, text: &str, i: usize) -> Option<String> {
        let suffix = self.suffix(text, i);
        let len = ansi_escape_prefix_len(suffix)?;
        let mut taken = 0;
        let mut j = i;
        let mut seq = String::new();
        while j < self.chars.len() && taken < len {
            taken += self.chars[j].len_utf8();
            seq.push(self.chars[j]);
            j += 1;
        }
        if taken == len {
            Some(seq)
        } else {
            None
        }
    }
}

fn apply_hsv_fade_to_chars(
    text: &str,
    profile: &GradientProfile,
    options: &FadeOptions,
    span_override: Option<usize>,
) -> String {
    let cursor = CharCursor::new(text);
    let chars = &cursor.chars;
    let total_len = span_override.unwrap_or_else(|| chars.len().max(1)).max(1);
    let mut out = String::new();
    let mut pos: usize = 0;

    let mut style_prefix = String::new();
    if options.bold {
        style_prefix.push_str(ANSI_BOLD);
    }
    if options.dim {
        style_prefix.push_str(ANSI_DIM);
    }

    let mut i = 0;
    while i < chars.len() {
        if let Some(seq) = cursor.take_ansi(text, i) {
            i += seq.chars().count();
            out.push_str(&seq);
            continue;
        }
        let ch = chars[i];
        if !ch.is_whitespace() && ch != '\u{1b}' {
            let t = if total_len <= 1 {
                0.0
            } else {
                pos as f64 / (total_len - 1) as f64
            };
            let (r, g, b) = interpolate_hsv(profile, t, options);
            out.push_str(&style_prefix);
            out.push_str(&format!("\x1b[38;2;{r};{g};{b}m"));
            out.push(ch);
            out.push_str(ANSI_RESET);
            pos += 1;
        } else {
            out.push(ch);
            if options.skip_whitespace == Some(false) && ch != '\n' && ch != '\r' {
                pos += 1;
            }
        }
        i += 1;
    }
    out
}

/// Apply an HSV gradient to text. Color decisions come from the global
/// setting unless overridden in `options`.
pub fn apply_hsv_fade(text: &str, key: GradientKey, options: FadeOptions) -> String {
    let use_color = options.use_color.unwrap_or_else(is_color_supported);
    if !use_color || text.is_empty() {
        return text.to_string();
    }
    let profile = gradient_profile(key);
    if options.mode == Some(GradientMode::PerLine) {
        let mut options = options;
        options.mode = Some(GradientMode::Continuous);
        return text
            .split('\n')
            .map(|line| {
                apply_hsv_fade_to_chars(line, &profile, &options, Some(line.encode_utf16().count()))
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    apply_hsv_fade_to_chars(text, &profile, &options, None)
}

/// Stateful streaming fader with ping-pong oscillation across chunks.
pub struct StreamFader {
    position: usize,
    cycle_length: usize,
    profile: GradientProfile,
    options: FadeOptions,
}

impl StreamFader {
    pub fn new(key: GradientKey, cycle_length: usize, options: FadeOptions) -> Self {
        Self {
            position: 0,
            cycle_length,
            profile: gradient_profile(key),
            options,
        }
    }

    pub fn new_with_profile(
        profile: GradientProfile,
        cycle_length: usize,
        options: FadeOptions,
    ) -> Self {
        Self {
            position: 0,
            cycle_length,
            profile,
            options,
        }
    }

    pub fn fade_chunk(&mut self, chunk: &str, use_color: bool) -> String {
        if !use_color || chunk.is_empty() {
            return chunk.to_string();
        }
        let cursor = CharCursor::new(chunk);
        let chars = &cursor.chars;
        let mut out = String::new();
        let mut style_prefix = String::new();
        if self.options.bold {
            style_prefix.push_str(ANSI_BOLD);
        }
        if self.options.dim {
            style_prefix.push_str(ANSI_DIM);
        }

        let cycle_length = self.cycle_length.max(1);
        let mode = self.options.mode.unwrap_or(GradientMode::Continuous);
        let start_h = self.profile.start.normalized_hue();
        let end_h = self.profile.end.normalized_hue();
        let is_circular = ((start_h - end_h).abs() == 1.0
            || (start_h % 1.0 - end_h % 1.0).abs() < f64::EPSILON)
            && matches!(
                self.profile.direction,
                GradientDirection::Forward | GradientDirection::Reverse
            );

        let mut i = 0;
        while i < chars.len() {
            if let Some(seq) = cursor.take_ansi(chunk, i) {
                i += seq.chars().count();
                out.push_str(&seq);
                continue;
            }
            let ch = chars[i];
            if !ch.is_whitespace() && ch != '\u{1b}' {
                let t: f64 = if mode == GradientMode::Symmetrical {
                    let half_cycle = (cycle_length as f64 / 2.0).max(0.5);
                    let phase = (self.position % cycle_length) as f64 / half_cycle;
                    if phase <= 1.0 {
                        phase
                    } else {
                        2.0 - phase
                    }
                } else if is_circular {
                    (self.position % cycle_length) as f64 / cycle_length as f64
                } else {
                    let cycle_span = cycle_length * 2;
                    let phase = (self.position % cycle_span) as f64 / cycle_length as f64;
                    if phase <= 1.0 {
                        phase
                    } else {
                        2.0 - phase
                    }
                };
                let mut opts = self.options;
                opts.mode = Some(GradientMode::Continuous);
                opts.cycle = Some(1.0);
                let (r, g, b) = interpolate_hsv(&self.profile, t, &opts);
                out.push_str(&style_prefix);
                out.push_str(&format!("\x1b[38;2;{r};{g};{b}m"));
                out.push(ch);
                out.push_str(ANSI_RESET);
                self.position += 1;
            } else {
                out.push(ch);
            }
            i += 1;
        }
        out
    }

    pub fn reset(&mut self) {
        self.position = 0;
    }

    pub fn position(&self) -> usize {
        self.position
    }
}

/// Rainbow per-character coloring (applyRainbowText in fader.ts).
pub fn apply_rainbow_text(text: &str, start_hue: f64, use_color: bool) -> String {
    if !use_color || text.is_empty() {
        return text.to_string();
    }
    let mut out = String::new();
    let mut pos: usize = 0;
    let total = text.chars().count().max(1);
    for ch in text.chars() {
        if !ch.is_whitespace() && ch != '\u{1b}' {
            let hue = (start_hue + pos as f64 / total as f64) % 1.0;
            let (r, g, b) = hsv_to_rgb(hue, 0.8, 0.98);
            out.push_str(&format!("\x1b[38;2;{r};{g};{b}m{ch}\x1b[0m"));
            pos += 1;
        } else {
            out.push(ch);
        }
    }
    out
}

/// Rebuild one banner row so its fader progresses over visible glyphs,
/// converting each glyph's rainbow foreground into a light block background.
pub fn apply_banner_rainbow(line: &str, use_color: bool, fader_width: usize) -> String {
    if !use_color {
        return line.to_string();
    }
    let visible_glyphs: String = line.chars().filter(|c| !c.is_whitespace()).collect();
    let width = visible_glyphs.chars().count().max(fader_width);
    let mut fader_input = visible_glyphs.clone();
    for _ in visible_glyphs.chars().count()..width {
        fader_input.push(' ');
    }
    let faded = apply_rainbow_text(&fader_input, 0.0, use_color);
    // Extract per-glyph RGB foregrounds from the faded rainbow text.
    let token_re = regex::Regex::new("\x1b\\[38;2;(\\d+);(\\d+);(\\d+)m(.)\x1b\\[0m").unwrap();
    let rgb_tokens: Vec<String> = token_re
        .captures_iter(&faded)
        .map(|c| format!("{};{};{}", &c[1], &c[2], &c[3]))
        .collect();

    let mut glyph_index = 0usize;
    let mut rendered = String::new();
    for ch in line.chars() {
        if !ch.is_whitespace() {
            match rgb_tokens.get(glyph_index) {
                Some(rgb) => {
                    rendered.push_str(&format!(
                        "\x1b[48;2;{rgb}m{ANSI_BLACK_BANNER_FOREGROUND}{ch}{ANSI_RESET}{ANSI_LIGHT_BANNER_BACKGROUND}"
                    ));
                }
                None => rendered.push(ch),
            }
            glyph_index += 1;
        } else {
            rendered.push(ch);
        }
    }
    format!("{ANSI_LIGHT_BANNER_BACKGROUND}{rendered}{ANSI_RESET}")
}
