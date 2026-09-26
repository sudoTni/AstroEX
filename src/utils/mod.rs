//! Shared utilities. Port of AstroEX-node src/utils.ts (banner, date
//! formatting, retry helpers).

pub mod delay;
pub mod gif_export;
pub mod progress;
pub mod shared;

use crate::error::{AppError, Result};
use crate::logging;
use crate::types::LogLevel;
use std::time::{Duration, Instant};

/// The AstroOM startup banner ("ASTROOM" in the ANSI Shadow figlet face),
/// rendered with the block/fade rainbow effect.
pub const BANNER: &str = r#" █████╗ ███████╗████████╗██████╗  ██████╗  ██████╗ ███╗   ███╗
██╔══██╗██╔════╝╚══██╔══╝██╔══██╗██╔═══██╗██╔═══██╗████╗ ████║
███████║███████╗   ██║   ██████╔╝██║   ██║██║   ██║██╔████╔██║
██╔══██║╚════██║   ██║   ██╔══██╗██║   ██║██║   ██║██║╚██╔╝██║
██║  ██║███████║   ██║   ██║  ██║╚██████╔╝╚██████╔╝██║ ╚═╝ ██║
╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═╝     ╚═╝"#;

pub const CANVAS_WIDTH: usize = 62;

pub const ASTRO_LOGO_RAW: [&str; 9] = [
    "        ▄▄▄       ██████ ▄▄▄█████▓ ██▀███   ▒█████",
    "       ▒████▄   ▒██    ▒ ▓  ██▒ ▓▒▓██ ▒ ██▒▒██▒  ██▒",
    "       ▒██  ▀█▄ ░ ▓██▄   ▒ ▓██░ ▒░▓██ ░▄█ ▒▒██░  ██▒",
    "       ░██▄▄▄▄██  ▒   ██▒░ ▓██▓ ░ ▒██▀▀█▄  ▒██   ██░",
    "        ▓█   ▓██▒██████▒▒  ▒██▒ ░ ░██▓ ▒██▒░ ████▓▒░",
    "        ▒▒   ▓▒█░ ▒▓▒ ▒ ░  ▒ ░░   ░ ▒▓ ░▒▓░░ ▒░▒░▒░",
    "         ▒   ▒▒ ░ ░▒  ░ ░    ░      ░▒ ░ ▒░  ░ ▒ ▒░",
    "         ░   ▒    ░  ░    ░        ░░   ░ ░ ░ ░ ▒",
    "             ░  ░       ░           ░         ░ ░",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct BannerRgb(pub u8, pub u8, pub u8);

impl BannerRgb {
    #[inline]
    fn lerp(self, other: BannerRgb, t: f64) -> BannerRgb {
        let t = t.clamp(0.0, 1.0);
        BannerRgb(
            (self.0 as f64 + (other.0 as f64 - self.0 as f64) * t).round() as u8,
            (self.1 as f64 + (other.1 as f64 - self.1 as f64) * t).round() as u8,
            (self.2 as f64 + (other.2 as f64 - self.2 as f64) * t).round() as u8,
        )
    }

    #[inline]
    fn scale(self, factor: f64) -> BannerRgb {
        BannerRgb(
            (self.0 as f64 * factor).clamp(0.0, 255.0) as u8,
            (self.1 as f64 * factor).clamp(0.0, 255.0) as u8,
            (self.2 as f64 * factor).clamp(0.0, 255.0) as u8,
        )
    }
}

const STRIKE_STOPS: &[(f64, BannerRgb)] = &[
    (0.00, BannerRgb(216, 220, 224)), // Muted strike flash (soft silver-white, matches Info end)
    (0.15, BannerRgb(218, 205, 182)), // Radiant forge heat (warm amber-cream)
    (0.30, BannerRgb(206, 122, 60)),  // Tempered warm ember (matches Warn amber)
    (0.48, BannerRgb(191, 75, 80)),   // Cherry oxide crimson (matches Error crimson)
    (0.65, BannerRgb(95, 155, 208)),  // Slate temper blue wave (matches Badge/Streaming)
    (0.82, BannerRgb(80, 112, 160)),  // Deep quench cobalt (matches Component)
    (1.00, BannerRgb(148, 158, 170)), // Cold steel edge (matches Context slate)
];

fn color_ramp(stops: &[(f64, BannerRgb)], t: f64) -> BannerRgb {
    let t = t.clamp(0.0, 1.0);
    if t <= stops[0].0 {
        return stops[0].1;
    }
    if t >= stops[stops.len() - 1].0 {
        return stops[stops.len() - 1].1;
    }
    for i in 0..stops.len() - 1 {
        let (p1, c1) = stops[i];
        let (p2, c2) = stops[i + 1];
        if t >= p1 && t <= p2 {
            let span = p2 - p1;
            let local_t = if span > 0.0 { (t - p1) / span } else { 0.0 };
            return c1.lerp(c2, local_t);
        }
    }
    stops[stops.len() - 1].1
}

#[inline]
fn density_multiplier(ch: char) -> f64 {
    match ch {
        '█' => 1.05,
        '▀' | '▄' => 1.00,
        '▓' => 0.92,
        '▒' => 0.82,
        '░' => 0.72,
        _ => 1.00,
    }
}

pub fn calculate_strike_char_color(
    ch: char,
    row: usize,
    col: usize,
    time_sec: f64,
    pulse: f64,
    intensity_boost: f64,
    cool_factor: f64,
) -> BannerRgb {
    // Anvil strike center atop the 'T' stem (col 30.0, row 1.5)
    let impact_x = 30.0;
    let impact_y = 1.5;
    let dx = (col as f64 - impact_x) * 0.70;
    let dy = (row as f64 - impact_y) * 1.50;
    let dist = (dx * dx + dy * dy).sqrt();

    // Expanding shockwave ripple and breathing forge pulse
    let ripple = 0.05 * (dist * 0.35 - time_sec * 3.0).sin();
    let t = (dist / 28.0 - pulse + ripple).clamp(0.0, 1.0);

    let base_rgb = color_ramp(STRIKE_STOPS, t);
    let dm = density_multiplier(ch);

    if row == 0 || ch == '▄' || ch == '▀' {
        base_rgb.scale(1.04 * intensity_boost)
    } else if row >= 5 {
        let cool_step = (row - 4) as f64 * 0.12;
        BannerRgb(
            (base_rgb.0 as f64 * (1.0 - cool_step * cool_factor) * dm * intensity_boost)
                .clamp(0.0, 255.0) as u8,
            (base_rgb.1 as f64 * (1.0 - cool_step * cool_factor) * dm * intensity_boost)
                .clamp(0.0, 255.0) as u8,
            (base_rgb.2 as f64 * (1.0 - cool_step * 0.12) * dm * intensity_boost).clamp(0.0, 255.0)
                as u8,
        )
    } else {
        base_rgb.scale(dm * intensity_boost)
    }
}

/// Computes the complete 9x62 grid of character cells and their 24-bit RGB colors
/// at a given time and dynamic parameter set. This pure representation is shared
/// between the ANSI terminal renderer and the deterministic GIF rasterizer.
pub fn strike_frame_cells(
    time_sec: f64,
    pulse: f64,
    intensity_boost: f64,
    cool_factor: f64,
) -> Vec<Vec<(char, BannerRgb)>> {
    let mut rows = Vec::with_capacity(ASTRO_LOGO_RAW.len());
    for (r, raw_line) in ASTRO_LOGO_RAW.iter().enumerate() {
        let shifted = format!("  {}", raw_line);
        let chars: Vec<char> = shifted.chars().collect();
        let mut row = Vec::with_capacity(CANVAS_WIDTH);
        for c in 0..CANVAS_WIDTH {
            let ch = if c < chars.len() { chars[c] } else { ' ' };
            let rgb = if ch == ' ' {
                BannerRgb(0, 0, 0)
            } else {
                calculate_strike_char_color(ch, r, c, time_sec, pulse, intensity_boost, cool_factor)
            };
            row.push((ch, rgb));
        }
        rows.push(row);
    }
    rows
}

pub fn render_strike_frame(no_color: bool, time_sec: f64) -> String {
    let is_static = (time_sec - BANNER_MAX_BLUE_TIME_SEC).abs() < 1e-6;
    let target_pulse = 0.08 * (BANNER_MAX_BLUE_TIME_SEC * 2.5).sin();
    let pulse = if is_static {
        target_pulse
    } else {
        0.08 * (time_sec * 2.5).sin()
    };
    let intensity_boost = if is_static {
        0.96
    } else {
        0.92 + 0.08 * (time_sec * 3.2).sin()
    };
    let cool_factor = if is_static { 0.18 } else { 0.22 };
    render_strike_frame_custom(no_color, time_sec, pulse, intensity_boost, cool_factor)
}

pub fn render_strike_frame_custom(
    no_color: bool,
    time_sec: f64,
    pulse: f64,
    intensity_boost: f64,
    cool_factor: f64,
) -> String {
    let mut out = String::with_capacity(4096);
    let cell_rows = strike_frame_cells(time_sec, pulse, intensity_boost, cool_factor);
    for row in cell_rows {
        for (ch, rgb) in row {
            if ch == ' ' {
                out.push(' ');
            } else if no_color {
                out.push(ch);
            } else {
                out.push_str(&format!(
                    "\x1b[38;2;{};{};{}m{}\x1b[0m",
                    rgb.0, rgb.1, rgb.2, ch
                ));
            }
        }
        out.push('\n');
    }
    out
}

/// Time offset in seconds where the banner shockwave achieves maximum blue visibility
/// (crest of slate temper blue wave #528ebf and deep quench cobalt #42608a).
pub const BANNER_MAX_BLUE_TIME_SEC: f64 = 1.58;

#[cfg(unix)]
pub fn get_terminal_size() -> Option<(u16, u16)> {
    let fd = libc::STDOUT_FILENO;
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    let success = (unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut ws) } == 0
        || unsafe { libc::ioctl(libc::STDERR_FILENO, libc::TIOCGWINSZ, &mut ws) } == 0)
        && ws.ws_row > 0
        && ws.ws_col > 0;
    if success {
        Some((ws.ws_row, ws.ws_col))
    } else {
        None
    }
}

#[cfg(windows)]
pub fn get_terminal_size() -> Option<(u16, u16)> {
    use windows_sys::Win32::System::Console::{
        GetConsoleScreenBufferInfo, GetStdHandle, CONSOLE_SCREEN_BUFFER_INFO, STD_ERROR_HANDLE,
        STD_OUTPUT_HANDLE,
    };
    for handle_id in [STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        let handle = unsafe { GetStdHandle(handle_id) };
        if !handle.is_null() && handle != windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            let mut csbi: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
            if unsafe { GetConsoleScreenBufferInfo(handle, &mut csbi) } != 0 {
                let rows = csbi.srWindow.Bottom - csbi.srWindow.Top + 1;
                let cols = csbi.srWindow.Right - csbi.srWindow.Left + 1;
                if rows > 0 && cols > 0 {
                    return Some((rows as u16, cols as u16));
                }
            }
        }
    }
    None
}

struct CursorGuard;

impl Drop for CursorGuard {
    fn drop(&mut self) {
        use std::io::Write;
        let _ = std::io::stdout().write_all(b"\x1b[?25h");
        let _ = std::io::stdout().flush();
    }
}

/// Plays a bounded in-place banner animation for a specified number of loops,
/// concluding on the maximum-blue frame without setting terminal margins or
/// interfering with native terminal scrollback.
pub fn display_banner(use_color: bool, banner_loops: u32) {
    use std::io::Write;
    let is_terminal = crate::logging::execution_log::is_stdout_terminal();
    if !use_color || !is_terminal || banner_loops == 0 {
        let frame = render_strike_frame(!use_color, BANNER_MAX_BLUE_TIME_SEC);
        let _ = std::io::stdout().write_all(frame.as_bytes());
        let _ = std::io::stdout().flush();
        return;
    }

    let (term_rows, term_cols) = get_terminal_size().unwrap_or((0, 0));
    if term_rows < 10 || term_cols < 64 {
        let frame = render_strike_frame(false, BANNER_MAX_BLUE_TIME_SEC);
        let _ = std::io::stdout().write_all(frame.as_bytes());
        let _ = std::io::stdout().flush();
        return;
    }

    let fps = 30u64;
    let frame_dur = Duration::from_millis(1000 / fps);
    let logo_lines = ASTRO_LOGO_RAW.len();
    // In the strike wave equation, ripple frequency omega is 3.0 rad/s (2pi/3.0 ~= 2.0944s per cycle).
    // The wave reaches maximum blue at BANNER_MAX_BLUE_TIME_SEC (~1.58s).
    // Successive wave crests reach maximum blue every 2pi/3.0 seconds thereafter.
    let wave_period = 2.0 * std::f64::consts::PI / 3.0;
    let total_duration =
        BANNER_MAX_BLUE_TIME_SEC + (banner_loops.saturating_sub(1) as f64) * wave_period;

    let _cursor_guard = CursorGuard;
    let _ = std::io::stdout().write_all(b"\x1b[?25l");
    let _ = std::io::stdout().flush();

    let start_time = Instant::now();
    let mut first_frame = true;
    let target_pulse = 0.08 * (BANNER_MAX_BLUE_TIME_SEC * 2.5).sin();
    let target_boost = 0.96;

    while start_time.elapsed().as_secs_f64() < total_duration {
        let elapsed = start_time.elapsed().as_secs_f64();
        let time_remaining = total_duration - elapsed;

        // In the final 0.5s of animation, smoothly blend pulse, boost, and cool_factor
        // into the exact static resting parameters so that the final frame lands seamlessly.
        let (pulse, intensity_boost, cool_factor) = if time_remaining < 0.5 && time_remaining > 0.0
        {
            let blend = (0.5 - time_remaining) / 0.5;
            let dyn_pulse = 0.08 * (elapsed * 2.5).sin();
            let dyn_boost = 0.92 + 0.08 * (elapsed * 3.2).sin();
            let dyn_cool = 0.22;
            (
                dyn_pulse * (1.0 - blend) + target_pulse * blend,
                dyn_boost * (1.0 - blend) + target_boost * blend,
                dyn_cool * (1.0 - blend) + 0.18 * blend,
            )
        } else {
            (
                0.08 * (elapsed * 2.5).sin(),
                0.92 + 0.08 * (elapsed * 3.2).sin(),
                0.22,
            )
        };

        let frame = render_strike_frame_custom(false, elapsed, pulse, intensity_boost, cool_factor);

        if first_frame {
            let _ = std::io::stdout().write_all(frame.as_bytes());
            first_frame = false;
        } else {
            let rewind = format!("\x1b[{}A\r{frame}", logo_lines);
            let _ = std::io::stdout().write_all(rewind.as_bytes());
        }
        let _ = std::io::stdout().flush();
        std::thread::sleep(frame_dur);
    }

    // Settle cleanly into the approved maximum-blue resting frame
    let final_frame = render_strike_frame(false, BANNER_MAX_BLUE_TIME_SEC);
    if first_frame {
        let _ = std::io::stdout().write_all(final_frame.as_bytes());
    } else {
        let rewind = format!("\x1b[{}A\r{final_frame}", logo_lines);
        let _ = std::io::stdout().write_all(rewind.as_bytes());
    }
    let _ = std::io::stdout().flush();
}

pub struct BannerAnimationHandle;

pub fn start_banner(use_color: bool) -> Option<BannerAnimationHandle> {
    display_banner(use_color, 4);
    None
}

pub use start_banner as start_continuous_banner;

pub fn print_banner(use_color: bool) {
    display_banner(use_color, 0);
}

/// Port of formatDate: "yyyy-mm-dd" (default), "yyyyMMdd_HHmmss",
/// "yyyy-MM-dd HH:mm:ss".
pub fn format_date_now(format: &str) -> String {
    format_date(&chrono::Local::now(), format)
}

pub fn format_date(date: &chrono::DateTime<chrono::Local>, format: &str) -> String {
    match format {
        "yyyyMMdd_HHmmss" => date.format("%Y%m%d_%H%M%S").to_string(),
        "yyyy-MM-dd HH:mm:ss" => date.format("%Y-%m-%d %H:%M:%S").to_string(),
        _ => date.format("%Y-%m-%d").to_string(),
    }
}

/// Port of retryWithBackoff: max 3 retries, 1000 ms initial delay,
/// exponential 2^(attempt-1), warn log each retry.
pub async fn retry_with_backoff<F, Fut, T>(
    component: &str,
    operation_name: &str,
    mut operation: F,
) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let max_retries = 3;
    let mut attempt: u32 = 0;
    loop {
        match operation().await {
            Ok(value) => return Ok(value),
            Err(err) if attempt < max_retries => {
                attempt += 1;
                let delay_ms = 1000u64 * (2u64).pow(attempt - 1);
                logging::log_kv(
                    component,
                    &format!(
                        "Retrying {operation_name} after error (attempt {attempt}/{max_retries}): {}",
                        err.message
                    ),
                    LogLevel::Warn,
                    &[("attempt", serde_json::json!(attempt)), ("delayMs", serde_json::json!(delay_ms))],
                );
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
            Err(err) => {
                return Err(AppError::message(format!(
                    "Operation {operation_name} failed after {max_retries} retries: {}",
                    err.message
                )));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::BANNER;

    /// Golden guard for the startup banner art: it must spell "ASTROOM" in the
    /// ANSI Shadow figlet face (regression: a previous revision rendered
    /// "ATOMOM").
    #[test]
    fn banner_art_spells_astroom() {
        let lines: Vec<&str> = BANNER.lines().collect();
        assert_eq!(lines.len(), 6, "ANSI Shadow is a six-line face");
        assert_eq!(
            lines[0],
            " █████╗ ███████╗████████╗██████╗  ██████╗  ██████╗ ███╗   ███╗"
        );
        // Every row must be the same width.
        let width = lines[0].chars().count();
        assert!(
            lines.iter().all(|line| line.chars().count() == width),
            "banner rows must be aligned"
        );
    }
}
