//! Explicit, CLI-derived pipeline configuration.  No environment values are
//! consulted here; callers construct this once and thread it to every stage.

use crate::context::RunContext;
use crate::error::{AppError, Result};
use crate::types::{validate_resume_phase, ProviderRouting};
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct PipelineConfig {
    pub data_dir: PathBuf,
    pub materials_dir: PathBuf,
    pub deployed_materials_dir: PathBuf,
    pub profile_dir: PathBuf,
    pub sites: String,
    pub search_terms_file: PathBuf,
    pub results_wanted: u32,
    pub hours_old: Option<u32>,
    pub remote_only: bool,
    pub batch_size: usize,
    pub sleep_ms: u64,
    pub clean: bool,
    pub resume: Option<String>,
    pub skip_acquisition: bool,
    pub skip_materials: bool,
    pub deploy: bool,
    pub deploy_destination: Option<String>,
    pub internet_watchdog: Option<String>,
    pub track_openrouter_costs: bool,
    pub log_cool_offs: bool,
    pub jobcloth_cool_off_days: i64,
    pub astro_auto_provider_top: u32,
    pub jobcloth_preset: String,
    pub remoteeval_preset: String,
    pub jobjudge_preset: String,
    pub makematerials_preset: String,
    pub reasoning_jobcloth: Option<String>,
    pub reasoning_remoteeval: Option<String>,
    pub reasoning_jobjudge: Option<String>,
    pub reasoning_makematerials: Option<String>,
    pub routing_jobcloth: Option<ProviderRouting>,
    pub routing_remoteeval: Option<ProviderRouting>,
    pub routing_jobjudge: Option<ProviderRouting>,
    pub routing_makematerials: Option<ProviderRouting>,
}

#[derive(Debug, Clone)]
pub struct PipelineConfigArgs {
    pub sites: String,
    pub search_terms_file: Option<PathBuf>,
    pub results_wanted: u32,
    pub hours_old: Option<u32>,
    pub remote_only: bool,
    pub batch_size: usize,
    pub sleep_ms: u64,
    pub clean: bool,
    pub resume: Option<String>,
    pub skip_acquisition: bool,
    pub skip_materials: bool,
    pub deploy: bool,
    pub deploy_destination: Option<String>,
    pub deployed_materials_dir: Option<PathBuf>,
    pub internet_watchdog: Option<String>,
    pub track_openrouter_costs: bool,
    pub log_cool_offs: bool,
    pub jobcloth_cool_off_days: i64,
    pub astro_auto_provider_top: u32,
    pub jobcloth_preset: String,
    pub remoteeval_preset: String,
    pub jobjudge_preset: String,
    pub makematerials_preset: String,
    pub reasoning_jobcloth: Option<String>,
    pub reasoning_remoteeval: Option<String>,
    pub reasoning_jobjudge: Option<String>,
    pub reasoning_makematerials: Option<String>,
    /// Global `--provider-ignore` list applied to every stage routing.
    pub provider_ignore: Option<Vec<String>>,
    /// Per-stage `--jc-provider`/`--re-provider`/... ordered-only lists.
    pub provider_only_jobcloth: Option<Vec<String>>,
    pub provider_only_remoteeval: Option<Vec<String>>,
    pub provider_only_jobjudge: Option<Vec<String>>,
    pub provider_only_makematerials: Option<Vec<String>>,
    /// Per-stage `--jc-provider-quant`/... quantization lists.
    pub provider_quant_jobcloth: Option<Vec<String>>,
    pub provider_quant_remoteeval: Option<Vec<String>>,
    pub provider_quant_jobjudge: Option<Vec<String>>,
    pub provider_quant_makematerials: Option<Vec<String>>,
}

/// Node buildStageRouting: merges a stage's explicit `only` list, its
/// quantization list, and the global ignore list; returns None when empty.
fn build_stage_routing(
    only: Option<Vec<String>>,
    quant: Option<Vec<String>>,
    global_ignore: Option<&Vec<String>>,
) -> Option<ProviderRouting> {
    if only.is_none() && quant.is_none() && global_ignore.is_none() {
        return None;
    }
    let ignore = global_ignore.cloned();
    if only.is_none() && quant.is_none() && ignore.is_none() {
        return None;
    }
    let (order, allow_fallbacks) = match &only {
        Some(slugs) => (Some(slugs.clone()), Some(false)),
        None => (None, None),
    };
    Some(ProviderRouting {
        order,
        only,
        ignore,
        quantizations: quant,
        allow_fallbacks,
    })
}

pub fn build(ctx: &RunContext, args: PipelineConfigArgs) -> Result<PipelineConfig> {
    if args.batch_size == 0 {
        return Err(AppError::message("--batch must be positive"));
    }
    if args.hours_old == Some(0) {
        return Err(AppError::message(
            "--hours-old must be greater than zero when supplied",
        ));
    }
    if let Some(phase) = &args.resume {
        if !validate_resume_phase(phase) {
            return Err(AppError::message(format!(
                "Invalid --resume phase \"{phase}\". Valid phases: {}",
                crate::types::PIPELINE_PHASES.join(", ")
            )));
        }
    }
    if args.deploy
        && args
            .deploy_destination
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
    {
        return Err(AppError::message("--deploy requires --deploy-destination"));
    }
    if args.jobcloth_cool_off_days <= 0 {
        return Err(AppError::message(
            "--jobcloth-cool-off-days must be a positive integer",
        ));
    }
    if args.astro_auto_provider_top < 1 {
        return Err(AppError::message(
            "--astro_auto_provider-top must be an integer of at least 1.",
        ));
    }
    let routing_jobcloth = build_stage_routing(
        args.provider_only_jobcloth,
        args.provider_quant_jobcloth,
        args.provider_ignore.as_ref(),
    );
    let routing_remoteeval = build_stage_routing(
        args.provider_only_remoteeval,
        args.provider_quant_remoteeval,
        args.provider_ignore.as_ref(),
    );
    let routing_jobjudge = build_stage_routing(
        args.provider_only_jobjudge,
        args.provider_quant_jobjudge,
        args.provider_ignore.as_ref(),
    );
    let routing_makematerials = build_stage_routing(
        args.provider_only_makematerials,
        args.provider_quant_makematerials,
        args.provider_ignore.as_ref(),
    );
    let watchdog = args
        .internet_watchdog
        .map(|target| {
            // Node treats an explicit empty value as "enabled with the
            // default target".
            let target = if target.trim().is_empty() {
                crate::constants::DEFAULT_WATCHDOG_TARGET.to_string()
            } else {
                target
            };
            crate::internet_watchdog::validate_and_normalize_probe_target(&target)
        })
        .transpose()?;
    Ok(PipelineConfig {
        data_dir: ctx.paths.data_dir.clone(),
        materials_dir: ctx.paths.materials_dir.clone(),
        deployed_materials_dir: args.deployed_materials_dir.unwrap_or_else(|| {
            ctx.paths
                .materials_dir
                .parent()
                .unwrap_or(&ctx.paths.materials_dir)
                .join("materials-deployed")
        }),
        profile_dir: ctx.paths.profile_dir.clone(),
        sites: args.sites,
        // Node resolves a relative --search-terms-file against the profile
        // directory (path.join(profileDir, file)); absolute paths pass through.
        search_terms_file: match args.search_terms_file {
            Some(path) if path.is_absolute() => path,
            Some(path) => ctx.paths.profile_dir.join(path),
            None => ctx.paths.profile_dir.join("search_terms.txt"),
        },
        results_wanted: args.results_wanted,
        hours_old: args.hours_old,
        remote_only: args.remote_only,
        batch_size: args.batch_size,
        sleep_ms: args.sleep_ms,
        clean: args.clean,
        resume: args.resume,
        skip_acquisition: args.skip_acquisition,
        skip_materials: args.skip_materials,
        deploy: args.deploy,
        deploy_destination: args.deploy_destination,
        internet_watchdog: watchdog,
        track_openrouter_costs: args.track_openrouter_costs,
        log_cool_offs: args.log_cool_offs,
        jobcloth_cool_off_days: args.jobcloth_cool_off_days,
        astro_auto_provider_top: args.astro_auto_provider_top,
        jobcloth_preset: args.jobcloth_preset,
        remoteeval_preset: args.remoteeval_preset,
        jobjudge_preset: args.jobjudge_preset,
        makematerials_preset: args.makematerials_preset,
        reasoning_jobcloth: args.reasoning_jobcloth,
        reasoning_remoteeval: args.reasoning_remoteeval,
        reasoning_jobjudge: args.reasoning_jobjudge,
        reasoning_makematerials: args.reasoning_makematerials,
        routing_jobcloth,
        routing_remoteeval,
        routing_jobjudge,
        routing_makematerials,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(values: &[&str]) -> Option<Vec<String>> {
        Some(values.iter().map(|v| v.to_string()).collect())
    }

    #[test]
    fn stage_routing_merges_only_quant_and_global_ignore() {
        let ignore = vec!["bad".to_string()];
        let routing = build_stage_routing(
            list(&["astro_auto_provider"]),
            list(&["fp8"]),
            Some(&ignore),
        )
        .expect("routing built");
        assert_eq!(routing.order, list(&["astro_auto_provider"]));
        assert_eq!(routing.only, list(&["astro_auto_provider"]));
        assert_eq!(routing.allow_fallbacks, Some(false));
        assert_eq!(routing.quantizations, list(&["fp8"]));
        assert_eq!(routing.ignore, list(&["bad"]));
    }

    #[test]
    fn stage_routing_is_none_when_no_inputs_present() {
        assert!(build_stage_routing(None, None, None).is_none());
    }

    #[test]
    fn global_ignore_alone_builds_routing_without_only() {
        let ignore = vec!["x".to_string()];
        let routing = build_stage_routing(None, None, Some(&ignore)).expect("routing built");
        assert!(routing.order.is_none());
        assert!(routing.only.is_none());
        assert!(routing.allow_fallbacks.is_none());
        assert!(routing.quantizations.is_none());
        assert_eq!(routing.ignore, list(&["x"]));
    }
}
