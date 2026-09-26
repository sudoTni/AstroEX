//! Global clap arguments and explicit RunContext construction.

use clap::{ArgAction, Args};
use std::path::PathBuf;

use crate::context::{Diagnostics, DisplayConfig, LlmBudgets, Paths, RunContext};
use crate::error::{AppError, Result};
use crate::runtime_paths;
use crate::types::{LogFormat, LogLevel};

#[derive(Debug, Clone, Args)]
pub struct GlobalArgs {
    #[arg(long, global = true, value_name = "PATH")]
    pub data_dir: Option<PathBuf>,
    #[arg(long, global = true, value_name = "PATH")]
    pub profile_dir: Option<PathBuf>,
    #[arg(long, global = true, value_name = "PATH")]
    pub log_dir: Option<PathBuf>,
    #[arg(long, global = true, value_name = "PATH")]
    pub materials_dir: Option<PathBuf>,
    #[arg(long, global = true, action = ArgAction::SetTrue)]
    pub no_banner: bool,
    #[arg(
        long = "record-logo-gif",
        global = true,
        action = ArgAction::SetTrue,
        help = "Record the animated logo to AstroOM-logo.gif in the current working directory and exit"
    )]
    pub record_logo_gif: bool,
    #[arg(long, global = true, default_value_t = 4, value_name = "COUNT")]
    pub banner_loops: u32,
    #[arg(long, global = true, action = ArgAction::SetTrue)]
    pub json: bool,
    #[arg(long, global = true, action = ArgAction::SetTrue, short = 'v')]
    pub verbose: bool,
    #[arg(long = "no-verbose", global = true, action = ArgAction::SetTrue, conflicts_with = "verbose")]
    pub no_verbose: bool,
    #[arg(long, global = true, action = ArgAction::SetTrue, conflicts_with = "verbose")]
    pub quiet: bool,
    #[arg(long, global = true, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    pub color: Option<bool>,
    #[arg(long = "no-color", visible_alias = "no-colors", global = true, action = ArgAction::SetTrue)]
    pub no_color: bool,
    #[arg(long, global = true, action = ArgAction::SetTrue, visible_aliases = ["hr", "hide-reasoning-tokens", "no-show-reasoning"])]
    pub hide_reasoning: bool,
    #[arg(long = "show-reasoning", global = true, visible_alias = "sr", num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    pub show_reasoning: Option<bool>,
    #[arg(long = "show-reasoning-tokens", global = true, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    pub show_reasoning_tokens: Option<bool>,
    #[arg(long, global = true, action = ArgAction::SetTrue)]
    pub show_fetch_url: bool,
    #[arg(long, global = true, value_parser = parse_log_level)]
    pub log_level: Option<LogLevel>,
    #[arg(long, global = true, default_value = "pretty", value_parser = parse_log_format)]
    pub log_format: LogFormat,
    #[arg(long, global = true, action = ArgAction::SetTrue)]
    pub log_llm_payloads: bool,
    #[arg(long, global = true)]
    pub log_max_payload_length: Option<usize>,
    #[arg(long, global = true)]
    pub max_llm_requests: Option<u64>,
    #[arg(long, global = true, default_value_t = crate::constants::DEFAULT_MAX_OUTPUT_TOKENS)]
    pub max_llm_output_tokens: u32,
    #[arg(long, global = true)]
    pub max_total_llm_output_tokens: Option<u64>,
    #[arg(long, global = true)]
    pub llm_deadline_ms: Option<u64>,
    #[arg(
        long,
        global = true,
        value_name = "KEY",
        conflicts_with = "api_key_file"
    )]
    pub api_key: Option<String>,
    #[arg(long, global = true, value_name = "PATH", conflicts_with = "api_key")]
    pub api_key_file: Option<PathBuf>,
    #[arg(long, global = true, value_name = "KEY")]
    pub indeed_api_key: Option<String>,
    #[arg(long, global = true, value_name = "URL")]
    pub llm_base_url: Option<String>,
}

pub fn parse_bool(value: &str) -> std::result::Result<bool, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        _ => Err("expected true, false, 1, or 0".to_string()),
    }
}

fn parse_log_level(value: &str) -> std::result::Result<LogLevel, String> {
    LogLevel::parse(value)
        .ok_or_else(|| "expected trace, debug, info, success, warn, error, or fatal".to_string())
}

fn parse_log_format(value: &str) -> std::result::Result<LogFormat, String> {
    match value {
        "pretty" => Ok(LogFormat::Pretty),
        "json" => Ok(LogFormat::Json),
        _ => Err("expected pretty or json".to_string()),
    }
}

impl GlobalArgs {
    pub fn into_context(self) -> Result<RunContext> {
        let api_key = match (self.api_key, self.api_key_file) {
            (Some(key), None) => Some(require_non_empty("--api-key", key)?),
            (None, Some(path)) => Some(require_non_empty(
                "--api-key-file",
                std::fs::read_to_string(&path).map_err(|error| {
                    AppError::message(format!(
                        "Failed to read API key file {}: {error}",
                        path.display()
                    ))
                })?,
            )?),
            (None, None) => None,
            (Some(_), Some(_)) => unreachable!("clap validates conflicts"),
        };
        let machine_json = self.json;
        let hide_reasoning = self.hide_reasoning
            || self.show_reasoning == Some(false)
            || self.show_reasoning_tokens == Some(false);
        let show_reasoning =
            self.show_reasoning == Some(true) || self.show_reasoning_tokens == Some(true);
        let display = DisplayConfig {
            verbose: self.verbose && !self.no_verbose && !self.quiet && !machine_json,
            color: if self.no_color {
                Some(false)
            } else {
                self.color
            },
            hide_reasoning,
            show_reasoning,
            show_fetch_url: self.show_fetch_url,
            log_level: if machine_json {
                Some(LogLevel::Error)
            } else {
                self.log_level
            },
            log_format: if machine_json {
                LogFormat::Json
            } else {
                self.log_format
            },
            machine_json,
            banner_loops: self.banner_loops,
        };
        Ok(RunContext {
            paths: Paths {
                project_root: runtime_paths::project_root(),
                data_dir: runtime_paths::data_dir(self.data_dir.as_deref()),
                log_dir: runtime_paths::log_dir(self.log_dir.as_deref()),
                materials_dir: runtime_paths::materials_dir(self.materials_dir.as_deref()),
                profile_dir: runtime_paths::profile_dir(self.profile_dir.as_deref()),
            },
            display,
            budgets: LlmBudgets {
                max_llm_requests: self.max_llm_requests,
                max_llm_output_tokens: Some(self.max_llm_output_tokens),
                max_total_llm_output_tokens: self.max_total_llm_output_tokens,
                llm_deadline_ms: self.llm_deadline_ms,
            },
            diagnostics: Diagnostics {
                log_llm_payloads: self.log_llm_payloads,
                log_max_payload_length: self.log_max_payload_length,
            },
            api_key,
            llm_base_url_override: self
                .llm_base_url
                .map(|url| url.trim().to_owned())
                .filter(|url| !url.is_empty()),
            indeed_api_key: self
                .indeed_api_key
                .map(|key| key.trim().to_owned())
                .filter(|key| !key.is_empty()),
            usage_tracker: None,
            cancellation: tokio_util::sync::CancellationToken::new(),
            run_started_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0),
        })
    }
}

fn require_non_empty(flag: &str, value: String) -> Result<String> {
    let value = value.trim().to_owned();
    if value.is_empty() {
        Err(AppError::message(format!("{flag} must not be empty")))
    } else {
        Ok(value)
    }
}
