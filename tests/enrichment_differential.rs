//! Differential parity test for LinkedIn enrichment HTML parsing against the
//! pure (network-free) portion of Node's `fetchLinkedInJobDetails`.
//!
//! Goldens are produced by `tests/differential/generate_enrichment_oracle.js`.

use astroom::acquisition::enrichment::parse_details_html;
use astroom::acquisition::types::DescriptionFormat;
use serde::Deserialize;

#[derive(Deserialize)]
struct Output {
    description: Option<String>,
    #[serde(rename = "descriptionHtml")]
    description_html: Option<String>,
    #[serde(rename = "directUrl")]
    direct_url: Option<String>,
    #[serde(rename = "seniorityLevel")]
    seniority_level: Option<String>,
    #[serde(rename = "employmentType")]
    employment_type: Option<String>,
    #[serde(rename = "jobFunction")]
    job_function: Option<String>,
    industries: Option<String>,
    img: Option<String>,
}

#[derive(Deserialize)]
struct Case {
    html: String,
    format: String,
    output: Output,
}

#[derive(Deserialize)]
struct Oracle {
    cases: Vec<Case>,
}

fn load_oracle() -> Oracle {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/enrichment_oracle.json"
    );
    let raw = std::fs::read_to_string(path).expect("read enrichment oracle fixture");
    serde_json::from_str(&raw).expect("parse enrichment oracle fixture")
}

#[test]
fn enrichment_parsing_matches_node_oracle() {
    let oracle = load_oracle();
    assert!(!oracle.cases.is_empty());
    for (index, case) in oracle.cases.iter().enumerate() {
        let format = DescriptionFormat::parse(&case.format).expect("valid format");
        let details = parse_details_html(&case.html, format);
        assert_eq!(
            details.description, case.output.description,
            "description divergence at case #{index} ({})",
            case.format
        );
        assert_eq!(
            details.description_html, case.output.description_html,
            "descriptionHtml divergence at case #{index} ({})",
            case.format
        );
        assert_eq!(
            details.direct_url, case.output.direct_url,
            "directUrl divergence at case #{index} ({})",
            case.format
        );
        assert_eq!(
            details.seniority_level, case.output.seniority_level,
            "seniorityLevel divergence at case #{index} ({})",
            case.format
        );
        assert_eq!(
            details.employment_type, case.output.employment_type,
            "employmentType divergence at case #{index} ({})",
            case.format
        );
        assert_eq!(
            details.job_function, case.output.job_function,
            "jobFunction divergence at case #{index} ({})",
            case.format
        );
        assert_eq!(
            details.industries, case.output.industries,
            "industries divergence at case #{index} ({})",
            case.format
        );
        assert_eq!(
            details.img, case.output.img,
            "img divergence at case #{index} ({})",
            case.format
        );
    }
}
