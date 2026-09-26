//! Differential parity test for the HTML→Markdown and HTML→plain-text
//! transforms against Turndown/Cheerio.
//!
//! Goldens in `tests/fixtures/markdown_oracle.json` are produced by the real
//! Node implementation (`descriptionToFormat` in
//! `AstroEX-node/src/acquisition/jobspy/http.ts`, i.e. Turndown configured
//! with `{ headingStyle: "atx", codeBlockStyle: "fenced" }`) via
//! `tests/differential/generate_markdown_oracle.js`. Regenerate with:
//!
//! ```sh
//! node tests/differential/generate_markdown_oracle.js /path/to/AstroEX-node \
//!   > tests/fixtures/markdown_oracle.json
//! ```
//!
//! This test does not require Node at test time.

use astroom::acquisition::http::description_to_format;
use astroom::acquisition::types::DescriptionFormat;
use serde::Deserialize;

#[derive(Deserialize)]
struct OracleEntry {
    html: String,
    markdown: String,
    plain: String,
}

fn load_oracle() -> Vec<OracleEntry> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/markdown_oracle.json"
    );
    let raw = std::fs::read_to_string(path).expect("read markdown oracle fixture");
    serde_json::from_str(&raw).expect("parse markdown oracle fixture")
}

#[test]
fn markdown_matches_turndown_oracle() {
    let oracle = load_oracle();
    assert!(!oracle.is_empty(), "fixture should not be empty");
    for (index, entry) in oracle.iter().enumerate() {
        let actual = description_to_format(&entry.html, DescriptionFormat::Markdown);
        assert_eq!(
            actual, entry.markdown,
            "markdown divergence at fixture #{index} for html: {:?}",
            entry.html
        );
    }
}

#[test]
fn plaintext_matches_cheerio_oracle() {
    let oracle = load_oracle();
    for (index, entry) in oracle.iter().enumerate() {
        let actual = description_to_format(&entry.html, DescriptionFormat::Plain);
        assert_eq!(
            actual, entry.plain,
            "plain divergence at fixture #{index} for html: {:?}",
            entry.html
        );
    }
}

#[test]
fn html_format_is_a_verbatim_passthrough() {
    let oracle = load_oracle();
    for entry in &oracle {
        assert_eq!(
            description_to_format(&entry.html, DescriptionFormat::Html),
            entry.html
        );
    }
}
