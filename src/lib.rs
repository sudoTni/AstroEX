//! AstroOM - Indeed job acquisition, filtering, evaluation, and
//! materials-generation pipeline. Rust port of AstroEX-node.

pub mod acquisition;
pub mod artifact_manifest;
pub mod astro_auto_provider;
pub mod circuit_breaker;
pub mod cli;
pub mod commands;
pub mod constants;
pub mod context;
pub mod error;
pub mod internet_watchdog;
pub mod jobrepo;
pub mod llm;
pub mod logging;
pub mod models;
pub mod pipeline;
pub mod presets;
pub mod runtime_paths;
pub mod stages;
pub mod statistics;
pub mod types;
pub mod utils;

/// Entry point: parse CLI, build the RunContext, dispatch, map exit codes.
pub fn run() -> i32 {
    cli::run_cli()
}
