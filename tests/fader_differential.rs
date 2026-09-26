//! Differential parity test for the fader surface against Node
//! `src/logging/fader.ts`: `stripAnsi`, `applyRainbowText`,
//! `applyBannerRainbow`, and the stateful `StreamFader`.
//!
//! Goldens are produced by `tests/differential/generate_fader_oracle.js`.

use astroom::logging::fader::{
    apply_banner_rainbow, apply_rainbow_text, strip_ansi, FadeOptions, GradientKey, StreamFader,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct StripCase {
    input: String,
    output: String,
}

#[derive(Deserialize)]
struct RainbowCase {
    text: String,
    #[serde(rename = "startHue")]
    start_hue: f64,
    #[serde(rename = "useColor")]
    use_color: bool,
    output: String,
}

#[derive(Deserialize)]
struct BannerCase {
    line: String,
    #[serde(rename = "useColor")]
    use_color: bool,
    #[serde(rename = "faderWidth")]
    fader_width: usize,
    output: String,
}

#[derive(Deserialize)]
struct StreamCase {
    chunks: Vec<String>,
    steps: Vec<String>,
    position: usize,
}

#[derive(Deserialize)]
struct Oracle {
    #[serde(rename = "stripAnsi")]
    strip_ansi: Vec<StripCase>,
    rainbow: Vec<RainbowCase>,
    banner: Vec<BannerCase>,
    streams: Vec<StreamCase>,
}

fn load_oracle() -> Oracle {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/fader_oracle.json"
    );
    let raw = std::fs::read_to_string(path).expect("read fader oracle fixture");
    serde_json::from_str(&raw).expect("parse fader oracle fixture")
}

#[test]
fn strip_ansi_matches_node_oracle() {
    let oracle = load_oracle();
    for (index, case) in oracle.strip_ansi.iter().enumerate() {
        assert_eq!(
            strip_ansi(&case.input),
            case.output,
            "strip_ansi divergence at case #{index}"
        );
    }
}

#[test]
fn apply_rainbow_text_matches_node_oracle() {
    let oracle = load_oracle();
    for (index, case) in oracle.rainbow.iter().enumerate() {
        assert_eq!(
            apply_rainbow_text(&case.text, case.start_hue, case.use_color),
            case.output,
            "apply_rainbow_text divergence at case #{index}"
        );
    }
}

#[test]
fn apply_banner_rainbow_matches_node_oracle() {
    let oracle = load_oracle();
    for (index, case) in oracle.banner.iter().enumerate() {
        assert_eq!(
            apply_banner_rainbow(&case.line, case.use_color, case.fader_width),
            case.output,
            "apply_banner_rainbow divergence at case #{index}"
        );
    }
}

#[test]
fn stream_fader_matches_node_oracle() {
    let oracle = load_oracle();
    for (index, case) in oracle.streams.iter().enumerate() {
        let mut fader = StreamFader::new(GradientKey::LegacyStreaming, 80, FadeOptions::default());
        assert_eq!(case.chunks.len(), case.steps.len());
        for (step_index, (chunk, expected)) in case.chunks.iter().zip(case.steps.iter()).enumerate()
        {
            let actual = fader.fade_chunk(chunk, true);
            assert_eq!(
                &actual, expected,
                "stream fader divergence at stream #{index} step #{step_index}"
            );
        }
        assert_eq!(
            fader.position(),
            case.position,
            "stream fader position divergence at stream #{index}"
        );
    }
}
