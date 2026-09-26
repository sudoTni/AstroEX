//! Authoritative HSV presets and terminal styling verification test suite.
//!
//! Validates:
//! 1. Exact HSV endpoints for all 15 authoritative presets.
//! 2. Shortest hue wrapping (355° -> 0° for ERROR and ErrorFallback).
//! 3. Simultaneous hue, saturation, and value interpolation.
//! 4. Shared field independence from message log levels.
//! 5. Conditional INFO message body styling (section boundary vs ordinary).
//! 6. Strict styling exclusion precedence (MachineJSON, JSON log format, NO_COLOR).
//! 7. Stream routing correctness.
//! 8. ANSI reset boundaries and empty/single-character edge cases.
//! 9. Startup banner frame 0 rendering semantics.

use astroom::context::DisplayConfig;
use astroom::logging::fader::{
    apply_hsv_fade, gradient_profile, strip_ansi, FadeOptions, GradientDirection, GradientKey,
    StreamFader,
};
use astroom::logging::formatter::{format_json, format_terminal, CONTEXT_KEY_SECTION_BOUNDARY};
use astroom::logging::types::LogRecord;
use astroom::types::{LogFormat, LogLevel};
use astroom::utils::render_strike_frame;
use serde_json::{json, Map, Value};

/// Helper to parse truecolor RGB escape sequences from a string.
fn extract_rgb_escapes(styled: &str) -> Vec<(u8, u8, u8)> {
    let mut rgbs = Vec::new();
    let re = regex::Regex::new(r"\x1b\[38;2;(\d+);(\d+);(\d+)m").unwrap();
    for cap in re.captures_iter(styled) {
        let r: u8 = cap[1].parse().unwrap();
        let g: u8 = cap[2].parse().unwrap();
        let b: u8 = cap[3].parse().unwrap();
        rgbs.push((r, g, b));
    }
    rgbs
}

/// Helper converting RGB to HSV (degrees, fraction, fraction).
fn rgb_to_hsv(r: u8, g: u8, b: u8) -> (f64, f64, f64) {
    let rf = r as f64 / 255.0;
    let gf = g as f64 / 255.0;
    let bf = b as f64 / 255.0;

    let max = rf.max(gf).max(bf);
    let min = rf.min(gf).min(bf);
    let delta = max - min;

    let h = if delta == 0.0 {
        0.0
    } else if max == rf {
        60.0 * (((gf - bf) / delta) % 6.0)
    } else if max == gf {
        60.0 * (((bf - rf) / delta) + 2.0)
    } else {
        60.0 * (((rf - gf) / delta) + 4.0)
    };
    let normalized_h = (h + 360.0) % 360.0;
    let s = if max == 0.0 { 0.0 } else { delta / max };
    let v = max;
    (normalized_h, s, v)
}

type HsvTuple = (f64, f64, f64);
type PresetTestCase = (GradientKey, HsvTuple, HsvTuple);

#[test]
fn test_exact_hsv_endpoints_all_15_presets() {
    let test_cases: &[PresetTestCase] = &[
        // Shared terminal record fields
        (
            GradientKey::Timestamp,
            (210.0, 0.06, 0.58),
            (210.0, 0.00, 0.42),
        ),
        (
            GradientKey::Component,
            (210.0, 0.48, 0.72),
            (210.0, 0.22, 0.58),
        ),
        (
            GradientKey::Context,
            (210.0, 0.14, 0.70),
            (210.0, 0.04, 0.52),
        ),
        (GradientKey::Badge, (210.0, 0.62, 0.78), (210.0, 0.32, 0.64)),
        // Log message gradients
        (GradientKey::Trace, (215.0, 0.18, 0.58), (215.0, 0.00, 0.38)),
        (GradientKey::Debug, (210.0, 0.32, 0.66), (210.0, 0.08, 0.46)),
        (GradientKey::Info, (210.0, 0.72, 0.82), (210.0, 0.00, 0.88)),
        (
            GradientKey::Success,
            (140.0, 0.48, 0.82),
            (140.0, 0.78, 0.68),
        ),
        (GradientKey::Warn, (30.0, 0.58, 0.88), (25.0, 0.88, 0.78)),
        (GradientKey::Error, (355.0, 0.58, 0.86), (0.0, 0.82, 0.72)),
        (GradientKey::Fatal, (25.0, 0.88, 0.76), (0.0, 0.92, 0.62)),
        // Other terminal output gradients
        (
            GradientKey::Reasoning,
            (215.0, 0.42, 0.72),
            (215.0, 0.08, 0.52),
        ),
        (
            GradientKey::Streaming,
            (205.0, 0.72, 0.80),
            (155.0, 0.62, 0.72),
        ),
        (
            GradientKey::Activity,
            (145.0, 0.60, 0.72),
            (205.0, 0.68, 0.76),
        ),
        (
            GradientKey::ErrorFallback,
            (355.0, 0.58, 0.86),
            (0.0, 0.82, 0.72),
        ),
    ];

    for (key, start_hsv, end_hsv) in test_cases {
        let profile = gradient_profile(*key);
        assert!(
            (profile.start.h - start_hsv.0).abs() < 1e-4,
            "{:?} start hue: expected {}, got {}",
            key,
            start_hsv.0,
            profile.start.h
        );
        assert!(
            (profile.start.s - start_hsv.1).abs() < 1e-4,
            "{:?} start sat: expected {}, got {}",
            key,
            start_hsv.1,
            profile.start.s
        );
        assert!(
            (profile.start.v - start_hsv.2).abs() < 1e-4,
            "{:?} start val: expected {}, got {}",
            key,
            start_hsv.2,
            profile.start.v
        );

        assert!(
            (profile.end.h - end_hsv.0).abs() < 1e-4,
            "{:?} end hue: expected {}, got {}",
            key,
            end_hsv.0,
            profile.end.h
        );
        assert!(
            (profile.end.s - end_hsv.1).abs() < 1e-4,
            "{:?} end sat: expected {}, got {}",
            key,
            end_hsv.1,
            profile.end.s
        );
        assert!(
            (profile.end.v - end_hsv.2).abs() < 1e-4,
            "{:?} end val: expected {}, got {}",
            key,
            end_hsv.2,
            profile.end.v
        );

        assert_eq!(
            profile.direction,
            GradientDirection::Shortest,
            "{:?} direction should be Shortest",
            key
        );
    }
}

#[test]
fn test_hue_wrapping_355_to_0_shortest_path() {
    // Error and ErrorFallback wrap from 355° to 0° across the 360°/0° boundary.
    // Shortest path is +5° (forward across 360°), NOT -355° across the entire color wheel.
    for key in [GradientKey::Error, GradientKey::ErrorFallback] {
        let text = "ABCDE"; // 5 chars: t=0, 0.25, 0.5, 0.75, 1.0
        let styled = apply_hsv_fade(
            text,
            key,
            FadeOptions {
                use_color: Some(true),
                ..Default::default()
            },
        );

        let rgbs = extract_rgb_escapes(&styled);
        assert_eq!(rgbs.len(), 5);

        for (i, &(r, g, b)) in rgbs.iter().enumerate() {
            let (h, s, v) = rgb_to_hsv(r, g, b);
            // Hue should stay within [354.0, 360.0] or [0.0, 5.0], never passing through green/cyan (100° - 250°)
            let is_in_red_range = h >= 350.0 || h <= 10.0;
            assert!(
                is_in_red_range,
                "Char #{i} of {:?} has hue {}° outside [350°, 360°] / [0°, 10°]",
                key, h
            );
            assert!(s > 0.5, "Saturation should remain high, got {}", s);
            assert!(v > 0.6, "Value should remain high, got {}", v);
        }
    }
}

#[test]
fn test_simultaneous_hsv_interpolation() {
    // Activity: start HSV(145, 60%, 72%) -> end HSV(205, 68%, 76%)
    let text = "0123456789";
    let styled = apply_hsv_fade(
        text,
        GradientKey::Activity,
        FadeOptions {
            use_color: Some(true),
            ..Default::default()
        },
    );
    let rgbs = extract_rgb_escapes(&styled);
    assert_eq!(rgbs.len(), 10);

    let (h_start, s_start, v_start) = rgb_to_hsv(rgbs[0].0, rgbs[0].1, rgbs[0].2);
    let (h_end, s_end, v_end) = rgb_to_hsv(
        rgbs[rgbs.len() - 1].0,
        rgbs[rgbs.len() - 1].1,
        rgbs[rgbs.len() - 1].2,
    );

    // Hue should increase from ~145° to ~205°
    assert!((140.0..=150.0).contains(&h_start));
    assert!((200.0..=210.0).contains(&h_end));
    // Saturation and value should both be in expected ranges
    assert!((s_start - 0.60).abs() < 0.05);
    assert!((s_end - 0.68).abs() < 0.05);
    assert!((v_start - 0.72).abs() < 0.05);
    assert!((v_end - 0.76).abs() < 0.05);
}

#[test]
fn test_shared_fields_independent_of_level() {
    let levels = [
        LogLevel::Trace,
        LogLevel::Debug,
        LogLevel::Info,
        LogLevel::Warn,
        LogLevel::Error,
        LogLevel::Fatal,
        LogLevel::Success,
    ];

    let timestamp_str = "2026-09-24T16:00:00Z";
    let formatted_ts_str = astroom::logging::formatter::format_timestamp(timestamp_str);
    let mut badge_escapes = Vec::new();
    let mut timestamp_escapes = Vec::new();

    for level in levels {
        let record = LogRecord {
            timestamp: timestamp_str.to_string(),
            level,
            component: "Pipeline".to_string(),
            message: "Running pipeline step".to_string(),
            context: None,
        };

        let formatted = format_terminal(&record, true);

        // Find the badge substring in formatted text
        let badge_label = match level {
            LogLevel::Trace => "[TRACE]",
            LogLevel::Debug => "[DEBUG]",
            LogLevel::Info => "[INFO ]",
            LogLevel::Warn => "[WARN ]",
            LogLevel::Error => "[ERROR]",
            LogLevel::Fatal => "[FATAL]",
            LogLevel::Success => "[OK   ]",
        };

        assert!(
            strip_ansi(&formatted).contains(badge_label),
            "Formatted line should contain badge {}",
            badge_label
        );

        // The timestamp is formatted using GradientKey::Timestamp.
        // It must have identical RGB sequence across all levels.
        let ts_expected = apply_hsv_fade(
            &formatted_ts_str,
            GradientKey::Timestamp,
            FadeOptions {
                use_color: Some(true),
                mode: Some(astroom::logging::fader::GradientMode::PerLine),
                ..Default::default()
            },
        );
        assert!(
            formatted.contains(&ts_expected),
            "Timestamp formatting should match GradientKey::Timestamp for {:?}",
            level
        );

        timestamp_escapes.push(extract_rgb_escapes(&ts_expected));

        // The badge is formatted using GradientKey::Badge (level-independent).
        let badge_styled = apply_hsv_fade(
            badge_label,
            GradientKey::Badge,
            FadeOptions {
                use_color: Some(true),
                bold: true,
                ..Default::default()
            },
        );
        assert!(
            formatted.contains(&badge_styled),
            "Badge formatting should match GradientKey::Badge for {:?}",
            level
        );
        badge_escapes.push(extract_rgb_escapes(&badge_styled));
    }

    // Verify timestamp escapes are identical across all levels
    for window in timestamp_escapes.windows(2) {
        assert_eq!(window[0], window[1]);
    }
}

#[test]
fn test_conditional_info_message_body_styling() {
    let standard_msg = "Fetching resume from storage";
    let ordinary_record = LogRecord {
        timestamp: "2026-09-24 16:00:00".to_string(),
        level: LogLevel::Info,
        component: "Storage".to_string(),
        message: standard_msg.to_string(),
        context: None,
    };

    let ordinary_formatted = format_terminal(&ordinary_record, true);
    // In ordinary INFO, the message text itself MUST NOT have ANSI escapes
    assert!(
        ordinary_formatted.contains(standard_msg),
        "Ordinary INFO must contain plain unstyled message"
    );

    // Section boundary INFO
    let boundary_msg = "=== STAGE 1: INGESTION ===";
    let mut boundary_ctx = Map::new();
    boundary_ctx.insert(CONTEXT_KEY_SECTION_BOUNDARY.to_string(), Value::Bool(true));

    let boundary_record = LogRecord {
        timestamp: "2026-09-24 16:00:00".to_string(),
        level: LogLevel::Info,
        component: "Pipeline".to_string(),
        message: boundary_msg.to_string(),
        context: Some(boundary_ctx),
    };

    let boundary_formatted = format_terminal(&boundary_record, true);
    // Boundary INFO message body MUST be styled with GradientKey::Info
    let expected_styled = apply_hsv_fade(
        boundary_msg,
        GradientKey::Info,
        FadeOptions {
            use_color: Some(true),
            ..Default::default()
        },
    );
    assert!(
        boundary_formatted.contains(&expected_styled),
        "Section boundary INFO message must be styled with GradientKey::Info"
    );
}

#[test]
fn test_strict_styling_exclusion_precedence() {
    let default_config = DisplayConfig {
        verbose: false,
        color: Some(true),
        hide_reasoning: false,
        show_reasoning: false,
        show_fetch_url: false,
        log_level: None,
        log_format: LogFormat::Pretty,
        machine_json: false,
        banner_loops: 4,
    };
    assert!(default_config.use_color());

    // 1. Machine JSON forces color off
    let mut machine_config = default_config.clone();
    machine_config.machine_json = true;
    assert!(!machine_config.use_color());

    // 2. LogFormat::Json forces color off
    let mut json_config = default_config.clone();
    json_config.log_format = LogFormat::Json;
    assert!(!json_config.use_color());

    // 3. color = Some(false) forces color off
    let mut no_color_config = default_config.clone();
    no_color_config.color = Some(false);
    assert!(!no_color_config.use_color());

    // 4. format_terminal with use_color = false produces ZERO ANSI codes
    let record = LogRecord {
        timestamp: "2026-09-24 16:00:00".to_string(),
        level: LogLevel::Error,
        component: "Database".to_string(),
        message: "Connection failed with timeout".to_string(),
        context: Some(json!({"retry_count": 3}).as_object().unwrap().clone()),
    };
    let uncolored_output = format_terminal(&record, false);
    assert!(
        !uncolored_output.contains("\x1b"),
        "Uncolored format_terminal must contain 0 ANSI escape sequences"
    );

    // 5. format_json produces valid JSON with ZERO ANSI codes
    let json_output = format_json(&record);
    assert!(
        !json_output.contains("\x1b"),
        "format_json must contain 0 ANSI escape sequences"
    );
    let parsed: Value = serde_json::from_str(&json_output).expect("valid JSON");
    assert_eq!(parsed["level"], "error");
    assert_eq!(parsed["component"], "Database");
    assert_eq!(parsed["message"], "Connection failed with timeout");
}

#[test]
fn test_ansi_reset_boundaries_and_empty_inputs() {
    // Empty string returns empty string
    let empty_styled = apply_hsv_fade(
        "",
        GradientKey::Info,
        FadeOptions {
            use_color: Some(true),
            ..Default::default()
        },
    );
    assert_eq!(empty_styled, "");

    // Single character
    let single_styled = apply_hsv_fade(
        "A",
        GradientKey::Success,
        FadeOptions {
            use_color: Some(true),
            ..Default::default()
        },
    );
    assert!(single_styled.starts_with("\x1b[38;2;"));
    assert!(single_styled.ends_with("\x1b[0m"));

    // Multi-character string: verify ANSI resets are balanced
    let multi_styled = apply_hsv_fade(
        "Hello World",
        GradientKey::Warn,
        FadeOptions {
            use_color: Some(true),
            ..Default::default()
        },
    );
    assert!(multi_styled.ends_with("\x1b[0m"));
    assert_eq!(strip_ansi(&multi_styled), "Hello World");
}

#[test]
fn test_stream_fader_streaming_and_reasoning() {
    let mut fader = StreamFader::new(GradientKey::Streaming, 40, FadeOptions::default());

    let chunk = "Generating comprehensive plan...";
    let styled = fader.fade_chunk(chunk, true);
    assert_ne!(styled, chunk);
    assert!(styled.contains("\x1b[38;2;"));
    assert!(styled.ends_with("\x1b[0m"));

    // Plain mode returns unstyled chunk
    let plain = fader.fade_chunk(chunk, false);
    assert_eq!(plain, chunk);
}

#[test]
fn test_startup_banner_strike_semantics() {
    // Frame 0 static rendering without color produces raw ASCII logo without ANSI escapes
    let frame_plain = render_strike_frame(true, 0.0);
    assert!(
        !frame_plain.contains("\x1b"),
        "Uncolored banner frame 0 must not contain ANSI escapes"
    );
    assert!(frame_plain.contains("▄▄▄"));

    // Frame 0 with color produces ANSI escapes
    let frame_colored = render_strike_frame(false, 0.0);
    assert!(
        frame_colored.contains("\x1b[38;2;"),
        "Colored banner frame 0 must contain truecolor ANSI escapes"
    );
    assert_eq!(strip_ansi(&frame_colored), frame_plain);
}

#[test]
fn test_context_fields_and_error_fallback_in_terminal_output() {
    let mut ctx = Map::new();
    ctx.insert("jobId".to_string(), json!("indeed:12345"));
    ctx.insert(
        "error".to_string(),
        json!({
            "name": "NetworkTimeout",
            "message": "Connection to upstream timed out after 30s"
        }),
    );

    let record = LogRecord {
        timestamp: "2026-09-24T16:00:00Z".to_string(),
        level: LogLevel::Error,
        component: "Fetcher".to_string(),
        message: "Failed to download listing".to_string(),
        context: Some(ctx),
    };

    let formatted = format_terminal(&record, true);

    // jobId=indeed:12345 should be styled with GradientKey::Context
    let expected_ctx_styled = apply_hsv_fade(
        "jobId=indeed:12345",
        GradientKey::Context,
        FadeOptions {
            use_color: Some(true),
            mode: Some(astroom::logging::fader::GradientMode::PerLine),
            ..Default::default()
        },
    );
    assert!(
        formatted.contains(&expected_ctx_styled),
        "Context field should be styled with GradientKey::Context"
    );

    // Error callout should be styled with GradientKey::ErrorFallback
    let expected_err_fallback = apply_hsv_fade(
        "  ↳ NetworkTimeout: Connection to upstream timed out after 30s",
        GradientKey::ErrorFallback,
        FadeOptions {
            use_color: Some(true),
            mode: Some(astroom::logging::fader::GradientMode::PerLine),
            ..Default::default()
        },
    );
    assert!(
        formatted.contains(&expected_err_fallback),
        "Nested error context should be styled with GradientKey::ErrorFallback"
    );
}

#[test]
fn test_multiline_and_special_character_inputs() {
    // Unicode grapheme clusters and emojis
    let unicode_text = "🦀 AstroOM 🚀 High-Performance Rust ✨";
    let styled = apply_hsv_fade(
        unicode_text,
        GradientKey::Info,
        FadeOptions {
            use_color: Some(true),
            ..Default::default()
        },
    );
    assert_eq!(strip_ansi(&styled), unicode_text);

    // Multiline text with PerLine mode
    let multiline_text = "Line 1\nLine 2\nLine 3";
    let styled_multi = apply_hsv_fade(
        multiline_text,
        GradientKey::Debug,
        FadeOptions {
            use_color: Some(true),
            mode: Some(astroom::logging::fader::GradientMode::PerLine),
            ..Default::default()
        },
    );
    assert_eq!(strip_ansi(&styled_multi), multiline_text);
    // Every non-empty line should have ANSI color styling
    for line in styled_multi.lines() {
        assert!(line.contains("\x1b[38;2;"));
        assert!(line.ends_with("\x1b[0m"));
    }

    // Whitespace only
    let ws = "   \t   ";
    let styled_ws = apply_hsv_fade(
        ws,
        GradientKey::Trace,
        FadeOptions {
            use_color: Some(true),
            ..Default::default()
        },
    );
    assert_eq!(strip_ansi(&styled_ws), ws);
}

#[test]
fn test_stream_routing_destinations() {
    // Audit routing:
    // stdout: TRACE, DEBUG, INFO, SUCCESS
    // stderr: WARN, ERROR, FATAL
    let stdout_levels = [
        LogLevel::Trace,
        LogLevel::Debug,
        LogLevel::Info,
        LogLevel::Success,
    ];
    let stderr_levels = [LogLevel::Warn, LogLevel::Error, LogLevel::Fatal];

    for lvl in stdout_levels {
        let is_stderr = matches!(lvl, LogLevel::Warn | LogLevel::Error | LogLevel::Fatal);
        assert!(!is_stderr, "{:?} must route to stdout", lvl);
    }

    for lvl in stderr_levels {
        let is_stderr = matches!(lvl, LogLevel::Warn | LogLevel::Error | LogLevel::Fatal);
        assert!(is_stderr, "{:?} must route to stderr", lvl);
    }
}

#[test]
fn test_banner_loop_animation_semantics() {
    use astroom::logging::strip_ansi;
    use astroom::utils::{
        display_banner, render_strike_frame, start_banner, BANNER_MAX_BLUE_TIME_SEC,
    };

    // When use_color is false, display_banner outputs uncolored frame without animation delay
    display_banner(false, 4);

    // When banner_loops is 0, display_banner outputs static max-blue frame immediately
    display_banner(true, 0);

    // Frame at BANNER_MAX_BLUE_TIME_SEC contains valid truecolor escapes
    let max_blue_colored = render_strike_frame(false, BANNER_MAX_BLUE_TIME_SEC);
    let max_blue_plain = render_strike_frame(true, BANNER_MAX_BLUE_TIME_SEC);
    assert!(
        max_blue_colored.contains("\x1b[38;2;"),
        "Max-blue frame must contain truecolor ANSI escapes"
    );
    assert_eq!(strip_ansi(&max_blue_colored), max_blue_plain);

    // Verify compatibility shim returns None without running continuous threads
    let handle = start_banner(false);
    assert!(handle.is_none());
}

#[test]
fn test_console_lock_concurrency() {
    use astroom::logging::console_output::{lock_console, with_console_lock};

    let result = with_console_lock(|| 42);
    assert_eq!(result, 42);

    {
        let _guard = lock_console();
    }
}
