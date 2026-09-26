//! Offline preflight checks. This deliberately reports Rust runtime metadata
//! instead of preserving Node's meaningless version gate (migration D3).

use crate::constants::JOB_DB_RETENTION_MS;
use crate::context::RunContext;
use crate::error::{AppError, Result};
use crate::jobrepo::{JobRepository, JobRepositoryConfig, JobRepositoryHealth};
use crate::presets::load_presets;
use serde::Serialize;
use std::collections::BTreeMap;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

#[derive(Debug, Clone, Default)]
pub struct PreflightOptions {
    pub require_api_key: bool,
    pub check_deployment: bool,
    pub deployment_destination: Option<String>,
    pub selected_presets: Vec<String>,
    /// Category-scoped preset selections (Node `selectedPresetCategories`),
    /// checked against the matching top-level preset category.
    pub selected_preset_categories: Vec<(String, String)>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentResult {
    pub enabled: bool,
    pub destination_set: bool,
    pub rclone_available: bool,
    pub valid: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightResult {
    pub runtime: String,
    pub runtime_valid: bool,
    pub profile_directory: String,
    pub missing_profile_files: Vec<String>,
    pub writable_directories: BTreeMap<String, bool>,
    pub presets: Vec<String>,
    pub selected_presets_valid: bool,
    pub missing_selected_presets: Vec<String>,
    pub api_key_present: bool,
    pub deployment: DeploymentResult,
    pub repository: JobRepositoryHealth,
    pub valid: bool,
    pub errors: Vec<String>,
}

pub fn run_preflight(ctx: &RunContext, options: &PreflightOptions) -> Result<PreflightResult> {
    let mut errors = Vec::new();
    let required_files = ["search_terms.txt", "my_resume.txt"];
    let missing_profile_files: Vec<String> = required_files
        .iter()
        .filter_map(|file| {
            let path = ctx.paths.profile_dir.join(file);
            match std::fs::metadata(path) {
                Ok(metadata) if metadata.len() > 0 => None,
                _ => Some((*file).to_owned()),
            }
        })
        .collect();
    if !missing_profile_files.is_empty() {
        errors.push(format!(
            "Missing or empty required profile files: {} in {}",
            missing_profile_files.join(", "),
            ctx.paths.profile_dir.display()
        ));
    }

    let mut writable_directories = BTreeMap::new();
    for (name, path) in [
        ("data", &ctx.paths.data_dir),
        ("logs", &ctx.paths.log_dir),
        ("materials", &ctx.paths.materials_dir),
    ] {
        let writable = verify_directory_writable(path);
        writable_directories.insert(name.to_owned(), writable);
        if !writable {
            errors.push(format!(
                "Directory is not writable: {} ({name})",
                path.display()
            ));
        }
    }

    let presets_data = load_presets()?;
    // Node reports `Object.keys(presetsData)`, i.e. config/presets.json order.
    let presets: Vec<String> = presets_data.keys().cloned().collect();
    let mut missing_selected_presets: Vec<String> = options
        .selected_presets
        .iter()
        .filter(|name| {
            !presets_data
                .values()
                .any(|category| category.contains_key(name.as_str()))
        })
        .cloned()
        .collect();
    if !missing_selected_presets.is_empty() {
        errors.push(format!(
            "Selected presets not found in config/presets.json: {}",
            missing_selected_presets.join(", ")
        ));
    }
    if !options.selected_preset_categories.is_empty() {
        let mut category_missing = Vec::new();
        for (category, preset_name) in &options.selected_preset_categories {
            if preset_name.is_empty() {
                continue;
            }
            let present = presets_data.get(category).is_some_and(|category_presets| {
                category_presets.contains_key(preset_name.as_str())
            });
            if !present {
                category_missing.push(format!("{category}:{preset_name}"));
            }
        }
        if !category_missing.is_empty() {
            missing_selected_presets.extend(category_missing.iter().cloned());
            if !errors
                .iter()
                .any(|error| error.starts_with("Selected presets"))
            {
                errors.push(format!(
                    "Selected presets not found in their config/presets.json categories: {}",
                    category_missing.join(", ")
                ));
            }
        }
    }

    let api_key_present = ctx
        .api_key
        .as_deref()
        .is_some_and(|key| !key.trim().is_empty());
    if options.require_api_key && !api_key_present {
        errors.push("Missing required API key. Provide --api-key or --api-key-file.".into());
    }

    let destination_set = options
        .deployment_destination
        .as_deref()
        .is_some_and(|destination| !destination.trim().is_empty());
    // Node's execFileSync("rclone", ["version"]) throws on a non-zero exit
    // status, so a present-but-broken rclone is not "available".
    let rclone_available = options.check_deployment
        && std::process::Command::new("rclone")
            .arg("version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
    if options.check_deployment && !destination_set {
        errors.push("Deployment is enabled but --deploy-destination is not set.".into());
    }
    if options.check_deployment && !rclone_available {
        errors.push("Deployment is enabled but 'rclone' executable was not found in PATH.".into());
    }

    let mut repository = JobRepository::new(JobRepositoryConfig {
        db_file_path: ctx.paths.data_dir.join("jobDB.sqlite"),
        legacy_json_path: None,
        default_expiration_ms: Some(JOB_DB_RETENTION_MS as i64),
        enable_job_db: true,
        max_records: None,
        now: None,
    });
    repository.initialize()?;
    let health = repository.verify_integrity()?;
    repository.close()?;
    if health.integrity != "ok" {
        errors.push(format!(
            "SQLite database integrity check failed: {}",
            health.details
        ));
    }

    let deployment = DeploymentResult {
        enabled: options.check_deployment,
        destination_set,
        rclone_available,
        valid: !options.check_deployment || (destination_set && rclone_available),
    };
    Ok(PreflightResult {
        runtime: format!("rust {}", crate::constants::APP_VERSION),
        runtime_valid: true,
        profile_directory: ctx.paths.profile_dir.to_string_lossy().into_owned(),
        missing_profile_files,
        writable_directories,
        presets,
        selected_presets_valid: missing_selected_presets.is_empty(),
        missing_selected_presets,
        api_key_present,
        deployment,
        repository: health,
        valid: errors.is_empty(),
        errors,
    })
}

pub fn assert_preflight(ctx: &RunContext, options: &PreflightOptions) -> Result<PreflightResult> {
    let result = run_preflight(ctx, options)?;
    if result.valid {
        Ok(result)
    } else {
        Err(AppError::message(format!(
            "Pipeline preflight failed:\n{}",
            result
                .errors
                .iter()
                .map(|error| format!("  - {error}"))
                .collect::<Vec<_>>()
                .join("\n")
        )))
    }
}

fn verify_directory_writable(directory: &Path) -> bool {
    if std::fs::create_dir_all(directory).is_err() {
        return false;
    }
    let probe = directory.join(format!(
        ".probe_preflight_{}_{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let result = options
        .open(&probe)
        .and_then(|_| std::fs::remove_file(&probe));
    result.is_ok()
}
