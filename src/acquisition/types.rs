//! Acquisition-layer types. Port of AstroEX-node src/acquisition/types.ts.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Site {
    Indeed,
    Linkedin,
}

impl Site {
    pub fn parse(value: &str) -> Option<Site> {
        match value.trim().to_lowercase().as_str() {
            "indeed" => Some(Site::Indeed),
            "linkedin" => Some(Site::Linkedin),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Site::Indeed => "indeed",
            Site::Linkedin => "linkedin",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DescriptionRepresentation {
    Html,
    Markdown,
    Plain,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DescriptionFormat {
    Markdown,
    Html,
    Plain,
}

impl DescriptionFormat {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_lowercase().as_str() {
            "markdown" => Some(DescriptionFormat::Markdown),
            "html" => Some(DescriptionFormat::Html),
            "plain" => Some(DescriptionFormat::Plain),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CompensationInterval {
    Yearly,
    Monthly,
    Weekly,
    Daily,
    Hourly,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalCompensation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval: Option<CompensationInterval>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_amount: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_amount: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(rename = "source", skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// The canonical shape of a scraped job, pre-normalization.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalAcquiredJob {
    pub id: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direct_url: Option<String>,
    pub title: String,
    pub company: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub company_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub posted_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description_representation: Option<DescriptionRepresentation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_remote: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_function: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub company_industry: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub company_logo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compensation: Option<CanonicalCompensation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acquired_at: Option<String>,
}

impl CanonicalAcquiredJob {
    /// Type guard equivalent of isCanonicalAcquiredJob (normalize.ts).
    pub fn is_valid(value: &serde_json::Value) -> bool {
        let source_ok = value
            .get("source")
            .and_then(|v| v.as_str())
            .map(|s| s == "indeed" || s == "linkedin")
            .unwrap_or(false);
        let str_field = |name: &str| value.get(name).and_then(|v| v.as_str()).is_some();
        source_ok
            && str_field("id")
            && str_field("canonicalUrl")
            && str_field("title")
            && str_field("company")
            && str_field("acquiredAt")
    }
}
