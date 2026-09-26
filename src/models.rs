//! Canonical job model. Ported from AstroEX-node src/models.ts (JobInterface).
//!
//! Field names serialize in camelCase to match Node artifacts byte-for-byte
//! (semantic JSON equality). Unknown fields round-trip through `extra`
//! (Node's JSON.stringify preserves unknown properties; so must we).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum SalaryCurrency {
    #[serde(rename = "USD")]
    #[default]
    Usd,
    #[serde(rename = "EUR")]
    Eur,
    #[serde(rename = "GBP")]
    Gbp,
    #[serde(rename = "RON")]
    Ron,
    #[serde(rename = "CHF")]
    Chf,
    #[serde(rename = "")]
    Empty,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEvalMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_used: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_count: Option<i64>,
}

/// The full job artifact shape that flows through the pipeline.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct JobInterface {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub img: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub company_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub posted_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub company: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub country_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub country_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description_html: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub city: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ok: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub salary_min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub salary_max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub salary_currency: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack_required: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applicants: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seniority_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub employment_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_function: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub industries: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub salary_range: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub posted_time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direct_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acquired_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_remote: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_confirmed_remote: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_eval_metadata: Option<RemoteEvalMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_worth_investigating: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_very_highly_aligned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_highly_aligned: Option<bool>,
    /// Unknown fields preserved for round-trip parity with Node JSON.
    #[serde(default, flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl JobInterface {
    pub fn company_display(&self) -> &str {
        self.company.as_deref().unwrap_or("")
    }

    pub fn title_display(&self) -> &str {
        self.title.as_deref().unwrap_or("")
    }
}

/// Simple helper: build a JobInterface from a JSON value, tolerating any shape.
pub fn job_from_value(value: serde_json::Value) -> Option<JobInterface> {
    serde_json::from_value(value).ok()
}
