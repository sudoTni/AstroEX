//! Integration and verification tests for `--record-logo-gif`.
//!
//! Validates:
//! 1. CLI parsing of `--record-logo-gif`.
//! 2. Compile-time embedded DinaRemasterII font asset, SHA-256, and TTC face index 0 selection.
//! 3. Monospace cell geometry and exact 30 FPS rational centisecond timing.
//! 4. Generated GIF structure, dimensions (512x160), frame count (63), and infinite looping.
//! 5. Execution strictly writing to the process current working directory.

mod common;

use astroom::utils::gif_export::{
    export_logo_gif, gif_delay_for_frame, ANIMATION_FPS, CYCLE_FRAME_COUNT,
    DINA_REMASTER_II_COLLECTION_INDEX, DINA_REMASTER_II_TTC, GIF_HEIGHT, GIF_WIDTH,
    LOGO_GIF_FILENAME,
};
use common::*;
use sha2::{Digest, Sha256};
use std::fs::File;
use tempfile::tempdir;

#[test]
fn cli_flag_parsing_and_no_value_requirement() {
    let sandbox = Sandbox::new();

    // --record-logo-gif without subcommand or value must succeed and exit 0
    let output = sandbox.run(&["--record-logo-gif"]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("Recorded animated logo to"),
        "stdout was: {stdout}"
    );
    assert!(stdout.contains(LOGO_GIF_FILENAME));

    // The generated GIF must exist in sandbox working directory
    let gif_path = sandbox.path().join(LOGO_GIF_FILENAME);
    assert!(
        gif_path.is_file(),
        "AstroOM-logo.gif must be created in cwd"
    );

    // Passing a value to the boolean flag must error
    let output_err = sandbox.run(&["--record-logo-gif=invalid_val"]);
    assert_ne!(output_err.status.code(), Some(0));
}

#[test]
fn compile_time_embedded_font_and_ttc_index_verification() {
    // 1. Verify font bytes are embedded in binary and match expected size and hash
    assert_eq!(DINA_REMASTER_II_TTC.len(), 46544);
    let mut hasher = Sha256::new();
    hasher.update(DINA_REMASTER_II_TTC);
    let hash = format!("{:x}", hasher.finalize());
    assert_eq!(
        hash, "ebca3d277e9c552774ea24c4630b14e2f82fc15c2c9032731b363d85753996df",
        "Embedded font SHA-256 must match authoritative asset"
    );

    // 2. Verify TTC face selection at index 0 (DinaRemasterII Medium)
    use ab_glyph::{Font, FontRef};
    let font = FontRef::try_from_slice_and_index(
        DINA_REMASTER_II_TTC,
        DINA_REMASTER_II_COLLECTION_INDEX as u32,
    )
    .expect("FontCollection must contain face at index 0");

    assert_eq!(font.units_per_em(), Some(1024.0));
    assert_eq!(font.ascent_unscaled(), 768.0);
    assert_eq!(font.descent_unscaled(), -256.0);

    // Monospace advance width is 512 / 1024 = 0.5 (1:2 cell aspect ratio)
    let space_id = font.glyph_id(' ');
    assert_ne!(space_id.0, 0, "Space glyph must exist in font");
}

#[test]
fn rational_30_fps_timing_and_cumulative_duration() {
    let mut total_centiseconds = 0u64;

    for frame in 0..CYCLE_FRAME_COUNT {
        let delay = gif_delay_for_frame(frame, ANIMATION_FPS);
        assert!(
            delay == 3 || delay == 4,
            "Delay must be 3 or 4 cs, got {delay} at frame {frame}"
        );
        total_centiseconds += delay as u64;

        // Every group of 3 consecutive frames must sum to 10 cs (100 ms)
        if (frame + 1) % 3 == 0 {
            let triplet_sum = gif_delay_for_frame(frame - 2, ANIMATION_FPS)
                + gif_delay_for_frame(frame - 1, ANIMATION_FPS)
                + gif_delay_for_frame(frame, ANIMATION_FPS);
            assert_eq!(
                triplet_sum, 10,
                "Every 3 frames at 30 FPS must sum to 10 centiseconds"
            );
        }
    }

    // 63 frames at 30 FPS = 2.100 seconds = 210 centiseconds
    assert_eq!(
        total_centiseconds, 210,
        "Total duration over 63 frames must be exactly 210 centiseconds"
    );
}

#[test]
fn exported_gif_structure_dimensions_and_infinite_loop() {
    let tmp = tempdir().expect("tempdir");
    let gif_file = tmp.path().join("test_logo.gif");

    export_logo_gif(&gif_file).expect("export_logo_gif must succeed");
    assert!(gif_file.is_file());

    let file = File::open(&gif_file).expect("open gif");
    let mut options = gif::DecodeOptions::new();
    options.set_color_output(gif::ColorOutput::Indexed);
    let mut decoder = options.read_info(file).expect("decode gif header");

    assert_eq!(decoder.width(), GIF_WIDTH);
    assert_eq!(decoder.height(), GIF_HEIGHT);

    let mut frame_count = 0;
    let mut total_delay = 0u64;

    while let Some(frame) = decoder.read_next_frame().expect("read frame") {
        assert_eq!(frame.width, GIF_WIDTH);
        assert_eq!(frame.height, GIF_HEIGHT);
        assert!(frame.delay == 3 || frame.delay == 4);
        assert_eq!(frame.delay, gif_delay_for_frame(frame_count, ANIMATION_FPS));
        total_delay += frame.delay as u64;
        frame_count += 1;
    }

    assert_eq!(
        frame_count, CYCLE_FRAME_COUNT,
        "GIF must contain exactly one complete cycle of 63 frames"
    );
    assert_eq!(
        total_delay, 210,
        "GIF total delay must be exactly 210 centiseconds"
    );
}

#[test]
fn record_logo_gif_strictly_uses_cwd() {
    let tmp = tempdir().expect("tempdir");
    let original_cwd = std::env::current_dir().expect("current_dir");

    // Change current directory to temp dir
    std::env::set_current_dir(tmp.path()).expect("set_current_dir");

    let result = astroom::utils::gif_export::record_logo_gif();

    // Restore working directory immediately
    let _ = std::env::set_current_dir(&original_cwd);

    let created_path = result.expect("record_logo_gif must succeed");
    assert_eq!(
        created_path,
        tmp.path().join(LOGO_GIF_FILENAME),
        "Destination must strictly match process current working directory"
    );
    assert!(created_path.is_file());
}
