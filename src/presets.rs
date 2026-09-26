//! Presets and prompt template loading. Ported from AstroEX-node src/presets.ts.
//! Also provides getPreset/getAvailablePresets from src/types.ts.

use crate::error::{AppError, Result};
use crate::types::Provider;
use indexmap::IndexMap;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub name: String,
    pub provider: String,
    #[serde(rename = "base_url", alias = "baseUrl")]
    pub base_url: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    #[serde(rename = "promptTemplate")]
    pub prompt_template: String,
    pub temperature: f64,
    #[serde(rename = "topP")]
    pub top_p: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl Preset {
    pub fn provider(&self) -> Result<Provider> {
        Provider::parse(&self.provider).ok_or_else(|| {
            AppError::message(format!("Unknown provider in preset: {}", self.provider))
        })
    }
}

/// Presets are keyed in `config/presets.json` insertion order, matching Node's
/// `Object.keys` traversal (observable in preflight's machine JSON and preset
/// listings).
pub type PresetConfig = IndexMap<String, IndexMap<String, Preset>>;

fn presets_cache() -> &'static Mutex<Option<PresetConfig>> {
    static CACHE: OnceLock<Mutex<Option<PresetConfig>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn template_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn veritas_cache() -> &'static Mutex<Option<String>> {
    static CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

pub fn clear_presets_cache() {
    if let Ok(mut c) = presets_cache().lock() {
        *c = None;
    }
    if let Ok(mut c) = template_cache().lock() {
        c.clear();
    }
    if let Ok(mut c) = veritas_cache().lock() {
        *c = None;
    }
}

pub fn load_presets() -> Result<PresetConfig> {
    {
        let cache = presets_cache().lock().unwrap();
        if let Some(config) = cache.as_ref() {
            return Ok(config.clone());
        }
    }
    let path = crate::runtime_paths::project_root()
        .join("config")
        .join("presets.json");
    let raw = std::fs::read_to_string(&path).map_err(|err| {
        AppError::message(format!(
            "Failed to load presets: {}",
            describe_io(&path, &err)
        ))
    })?;
    let config: PresetConfig = serde_json::from_str(&raw)
        .map_err(|err| AppError::message(format!("Failed to load presets: {err}")))?;
    let mut cache = presets_cache().lock().unwrap();
    *cache = Some(config.clone());
    Ok(config)
}

fn describe_io(path: &Path, err: &std::io::Error) -> String {
    format!("{} ({})", err, path.display())
}

pub fn get_available_presets(stage: &str, config: &PresetConfig) -> Vec<String> {
    config
        .get(stage)
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}

pub fn get_preset(stage: &str, name: &str, config: &PresetConfig) -> Result<Preset> {
    config
        .get(stage)
        .and_then(|m| m.get(name))
        .cloned()
        .ok_or_else(|| AppError::message(format!("Unknown {stage} preset: {name}")))
}

/// Loads the Veritas system prompt (sysprompts/veritas_sys_prompt.txt), trimmed.
pub fn load_veritas_system_prompt() -> Result<String> {
    {
        let cache = veritas_cache().lock().unwrap();
        if let Some(prompt) = cache.as_ref() {
            return Ok(prompt.clone());
        }
    }
    let path = crate::runtime_paths::project_root()
        .join("sysprompts")
        .join("veritas_sys_prompt.txt");
    let raw = std::fs::read_to_string(&path).map_err(|err| {
        AppError::message(format!(
            "Failed to load Veritas system prompt: {}",
            describe_io(&path, &err)
        ))
    })?;
    let trimmed = raw.trim().to_string();
    let mut cache = veritas_cache().lock().unwrap();
    *cache = Some(trimmed.clone());
    Ok(trimmed)
}

/// Resolves a preset's promptTemplate path (relative to the project root).
pub fn template_path(template: &str) -> PathBuf {
    let trimmed = template.trim();
    if trimmed.starts_with("./") || trimmed.starts_with(".\\") {
        crate::runtime_paths::project_root().join(&trimmed[2..])
    } else {
        PathBuf::from(trimmed)
    }
}

pub fn load_prompt_template(template: &str) -> Result<String> {
    let path = template_path(template);
    let key = path.to_string_lossy().to_string();
    {
        let cache = template_cache().lock().unwrap();
        if let Some(t) = cache.get(&key) {
            return Ok(t.clone());
        }
    }
    let raw = std::fs::read_to_string(&path).map_err(|err| {
        AppError::message(format!(
            "Failed to load prompt template: {}",
            describe_io(&path, &err)
        ))
    })?;
    let mut cache = template_cache().lock().unwrap();
    cache.insert(key, raw.clone());
    Ok(raw)
}

/// Loads a template and replaces `{key}` placeholders. Uses a replace callback
/// (like the Node `replaceAll(pattern, () => value)`) so `$` sequences in
/// values are never interpreted.
pub fn load_and_replace_prompt_template(
    template: &str,
    placeholder_data: &HashMap<String, String>,
) -> Result<String> {
    let raw = load_prompt_template(template)?;
    Ok(interpolate_template(&raw, placeholder_data))
}

pub fn interpolate_template(template: &str, placeholder_data: &HashMap<String, String>) -> String {
    let re = regex::Regex::new(r"\{([a-zA-Z0-9_]+)\}").unwrap();
    let result = re.replace_all(template, |caps: &regex::Captures| {
        match placeholder_data.get(&caps[1]) {
            Some(value) => value.clone(),
            None => caps[0].to_string(),
        }
    });
    result.trim().to_string()
}
