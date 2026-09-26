//! Shared types. Ported from AstroEX-node src/types.ts (relevant parts).

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Success,
    Warn,
    Error,
    Fatal,
}

impl LogLevel {
    pub fn severity(self) -> u32 {
        match self {
            LogLevel::Trace => 5,
            LogLevel::Debug => 10,
            LogLevel::Info => 20,
            LogLevel::Success => 25,
            LogLevel::Warn => 30,
            LogLevel::Error => 40,
            LogLevel::Fatal => 50,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            LogLevel::Trace => "TRACE",
            LogLevel::Debug => "DEBUG",
            LogLevel::Info => "INFO ",
            LogLevel::Success => "OK   ",
            LogLevel::Warn => "WARN ",
            LogLevel::Error => "ERROR",
            LogLevel::Fatal => "FATAL",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            LogLevel::Trace => "trace",
            LogLevel::Debug => "debug",
            LogLevel::Info => "info",
            LogLevel::Success => "success",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
            LogLevel::Fatal => "fatal",
        }
    }

    pub fn parse(value: &str) -> Option<LogLevel> {
        match value.trim().to_lowercase().as_str() {
            "trace" => Some(LogLevel::Trace),
            "debug" | "log" => Some(LogLevel::Debug),
            "info" => Some(LogLevel::Info),
            "success" => Some(LogLevel::Success),
            "warn" | "warning" => Some(LogLevel::Warn),
            "error" => Some(LogLevel::Error),
            "fatal" => Some(LogLevel::Fatal),
            _ => None,
        }
    }
}

impl fmt::Display for LogLevel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.name())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogFormat {
    Pretty,
    Json,
}

// ---------------------------------------------------------------------------
// LLM providers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Openai,
    Gemini,
    Mistral,
    Openrouter,
    Cerebras,
    Poe,
}

impl Provider {
    pub fn parse(value: &str) -> Option<Provider> {
        match value.trim().to_lowercase().as_str() {
            "openai" => Some(Provider::Openai),
            "gemini" => Some(Provider::Gemini),
            "mistral" => Some(Provider::Mistral),
            "openrouter" => Some(Provider::Openrouter),
            "cerebras" => Some(Provider::Cerebras),
            "poe" => Some(Provider::Poe),
            _ => None,
        }
    }
}

impl fmt::Display for Provider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Provider::Openai => "openai",
            Provider::Gemini => "gemini",
            Provider::Mistral => "mistral",
            Provider::Openrouter => "openrouter",
            Provider::Cerebras => "cerebras",
            Provider::Poe => "poe",
        };
        write!(f, "{s}")
    }
}

/// OpenRouter provider routing payload.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProviderRouting {
    pub order: Option<Vec<String>>,
    pub only: Option<Vec<String>>,
    pub ignore: Option<Vec<String>>,
    pub quantizations: Option<Vec<String>>,
    pub allow_fallbacks: Option<bool>,
}

impl ProviderRouting {
    /// Normalizes provider routing so that whenever `only` is present:
    /// 1. `order` is present and contains exactly the same provider slugs as `only`, in exactly the same order.
    /// 2. `allow_fallbacks` is `false`.
    pub fn normalize(&mut self) {
        if let Some(only) = &self.only {
            self.order = Some(only.clone());
            self.allow_fallbacks = Some(false);
        }
    }
}

#[derive(Serialize, Deserialize)]
struct ProviderRoutingWire {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub only: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ignore: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantizations: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_fallbacks: Option<bool>,
}

impl Serialize for ProviderRouting {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut wire = ProviderRoutingWire {
            order: self.order.clone(),
            only: self.only.clone(),
            ignore: self.ignore.clone(),
            quantizations: self.quantizations.clone(),
            allow_fallbacks: self.allow_fallbacks,
        };
        if let Some(only) = &wire.only {
            wire.order = Some(only.clone());
            wire.allow_fallbacks = Some(false);
        }
        wire.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ProviderRouting {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let mut wire = ProviderRoutingWire::deserialize(deserializer)?;
        if let Some(only) = &wire.only {
            wire.order = Some(only.clone());
            wire.allow_fallbacks = Some(false);
        }
        Ok(Self {
            order: wire.order,
            only: wire.only,
            ignore: wire.ignore,
            quantizations: wire.quantizations,
            allow_fallbacks: wire.allow_fallbacks,
        })
    }
}

// ---------------------------------------------------------------------------
// Pipeline phases
// ---------------------------------------------------------------------------

pub const PIPELINE_PHASES: [&str; 8] = [
    "acquireJobs",
    "processData",
    "jobCloth",
    "enrichJobs",
    "remoteEval",
    "jobJudge",
    "makeMaterials",
    "deployment",
];

pub fn validate_resume_phase(phase: &str) -> bool {
    PIPELINE_PHASES.contains(&phase)
}

pub fn should_execute_phase(current: &str, resume_phase: Option<&str>) -> bool {
    match resume_phase {
        None => true,
        Some(rp) => {
            let ci = PIPELINE_PHASES.iter().position(|p| *p == current);
            let ri = PIPELINE_PHASES.iter().position(|p| *p == rp);
            match (ci, ri) {
                (Some(c), Some(r)) => c >= r,
                _ => true,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_routing_normalize_sets_order_and_allow_fallbacks_when_only_present() {
        let mut routing = ProviderRouting {
            only: Some(vec!["openai".to_string(), "together".to_string()]),
            ..Default::default()
        };
        routing.normalize();
        assert_eq!(
            routing.order,
            Some(vec!["openai".to_string(), "together".to_string()])
        );
        assert_eq!(
            routing.only,
            Some(vec!["openai".to_string(), "together".to_string()])
        );
        assert_eq!(routing.allow_fallbacks, Some(false));
    }

    #[test]
    fn provider_routing_normalize_updates_mismatched_order_and_non_false_fallbacks() {
        let mut routing = ProviderRouting {
            order: Some(vec!["mismatched".to_string()]),
            only: Some(vec!["openai".to_string()]),
            allow_fallbacks: Some(true),
            ..Default::default()
        };
        routing.normalize();
        assert_eq!(routing.order, Some(vec!["openai".to_string()]));
        assert_eq!(routing.only, Some(vec!["openai".to_string()]));
        assert_eq!(routing.allow_fallbacks, Some(false));
    }

    #[test]
    fn provider_routing_serialize_enforces_order_and_allow_fallbacks_when_only_present() {
        let routing = ProviderRouting {
            only: Some(vec!["openai".to_string(), "together".to_string()]),
            ..Default::default()
        };
        let value = serde_json::to_value(&routing).expect("serialize");
        assert_eq!(value["order"], serde_json::json!(["openai", "together"]));
        assert_eq!(value["only"], serde_json::json!(["openai", "together"]));
        assert_eq!(value["allow_fallbacks"], serde_json::json!(false));
    }

    #[test]
    fn provider_routing_deserialize_enforces_order_and_allow_fallbacks_when_only_present() {
        let json_data = serde_json::json!({
            "only": ["openai", "together"],
            "ignore": ["deepinfra"]
        });
        let routing: ProviderRouting = serde_json::from_value(json_data).expect("deserialize");
        assert_eq!(
            routing.order,
            Some(vec!["openai".to_string(), "together".to_string()])
        );
        assert_eq!(
            routing.only,
            Some(vec!["openai".to_string(), "together".to_string()])
        );
        assert_eq!(routing.allow_fallbacks, Some(false));
        assert_eq!(routing.ignore, Some(vec!["deepinfra".to_string()]));
    }
}
