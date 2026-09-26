//! Application profile loading and LLM record normalization. Port of
//! AstroEX-node src/utils/sharedCommandUtils.ts.

use crate::context::RunContext;
use crate::logging;
use crate::types::LogLevel;
use serde_json::{Map, Value};

pub struct ApplicationData {
    pub resume: String,
    pub professional_title: String,
    pub professional_summary: String,
    pub key_skills: String,
    pub testimonials: String,
}

/// Loads the applicant profile files, retaining placeholder fallbacks for
/// missing files so a partial profile yields explicit model-visible values.
pub fn load_application_data(ctx: &RunContext) -> ApplicationData {
    let files = [
        "my_resume.txt",
        "my_professional_title.txt",
        "my_professional_summary.txt",
        "my_key_skills.txt",
        "my_testimonials.txt",
    ];
    let contents: Vec<String> = files
        .iter()
        .map(|file| {
            let path = ctx.paths.profile_dir.join(file);
            match std::fs::read_to_string(&path) {
                Ok(content) => content,
                Err(_) => {
                    logging::log(
                        "ApplicationData",
                        &format!("Failed to load {file}, using fallback"),
                        LogLevel::Warn,
                    );
                    let stem = file.split('.').next().unwrap_or(file);
                    format!("[{} content]", stem.replace('_', " ").to_uppercase())
                }
            }
        })
        .collect();
    ApplicationData {
        resume: contents[0].clone(),
        professional_title: contents[1].clone(),
        professional_summary: contents[2].clone(),
        key_skills: contents[3].clone(),
        testimonials: contents[4].clone(),
    }
}

fn normalize_key(key: &str) -> String {
    key.to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

/// Normalizes job evaluation object keys to handle model casing variations,
/// common key typos (jobTtitle), and common alias property names.
pub fn normalize_job_analysis_record(val: &Value) -> Value {
    let Some(obj) = val.as_object() else {
        return val.clone();
    };
    let mut normalized = obj.clone();

    // 1. Resolve jobTitle if missing or empty
    let job_title_ok = normalized
        .get("jobTitle")
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if !job_title_ok {
        let mut resolved: Option<Value> = None;
        if let Some(v) = normalized.get("job_title").and_then(|v| v.as_str()) {
            if !v.trim().is_empty() {
                resolved = Some(Value::String(v.trim().to_string()));
            }
        }
        if resolved.is_none() {
            if let Some(v) = normalized.get("title").and_then(|v| v.as_str()) {
                if !v.trim().is_empty() {
                    resolved = Some(Value::String(v.trim().to_string()));
                }
            }
        }
        if resolved.is_none() {
            for (key, value) in obj {
                let Some(s) = value.as_str() else { continue };
                if s.trim().is_empty() {
                    continue;
                }
                let norm_key = normalize_key(key);
                if [
                    "jobtitle",
                    "jobttitle",
                    "title",
                    "jobname",
                    "jobrole",
                    "role",
                    "position",
                ]
                .contains(&norm_key.as_str())
                    || norm_key.ends_with("title")
                {
                    resolved = Some(Value::String(s.trim().to_string()));
                    break;
                }
            }
        }
        if let Some(v) = resolved {
            normalized.insert("jobTitle".to_string(), v);
        }
    }

    // 2. Resolve alignment boolean if missing
    if !normalized.contains_key("isWorthInvestigating")
        && !normalized.contains_key("isVeryHighlyAligned")
        && !normalized.contains_key("isHighlyAligned")
    {
        for (key, value) in obj {
            let norm_key = normalize_key(key);
            if [
                "isworthinvestigating",
                "worthinvestigating",
                "isveryhighlyaligned",
                "veryhighlyaligned",
                "ishighlyaligned",
                "highlyaligned",
                "isaligned",
                "aligned",
            ]
            .contains(&norm_key.as_str())
            {
                normalized.insert("isWorthInvestigating".to_string(), value.clone());
                break;
            }
        }
    }

    // 3. Resolve rationale if missing
    if !normalized.contains_key("rationale") {
        for (key, value) in obj {
            let norm_key = normalize_key(key);
            if ["rationale", "reasoning", "reason", "explanation"].contains(&norm_key.as_str()) {
                normalized.insert("rationale".to_string(), value.clone());
                break;
            }
        }
    }

    Value::Object(normalized)
}

/// Build a JSON object map from key/value pairs (helper used by stages).
pub fn kv_map(pairs: Vec<(&str, Value)>) -> Map<String, Value> {
    let mut map = Map::new();
    for (k, v) in pairs {
        map.insert(k.to_string(), v);
    }
    map
}
