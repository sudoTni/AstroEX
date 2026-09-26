//! Offline pipeline integration: acquisition artifact -> processing ->
//! clothing -> judging -> materials, with checkpoints and manifests. Mirrors
//! Node's `pipelineIntegration.test.js`, but points every stage at a local
//! mock OpenAI-compatible server via the explicit `RunContext` override.

mod common;

use astroom::artifact_manifest::verify_artifact_manifest;
use astroom::context::{Diagnostics, DisplayConfig, LlmBudgets, Paths, RunContext};
use astroom::stages::job_cloth::{self, JobClothOptions};
use astroom::stages::job_judge::{self, JobJudgeOptions};
use astroom::stages::make_materials::{self, MakeMaterialsOptions};
use astroom::stages::process_data::{self, ProcessDataOptions};
use astroom::types::LogFormat;
use common::*;
use serde_json::json;

fn context(
    data: &std::path::Path,
    logs: &std::path::Path,
    materials: &std::path::Path,
    profile: &std::path::Path,
    base_url: String,
) -> RunContext {
    RunContext {
        paths: Paths {
            project_root: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            data_dir: data.to_path_buf(),
            log_dir: logs.to_path_buf(),
            materials_dir: materials.to_path_buf(),
            profile_dir: profile.to_path_buf(),
        },
        display: DisplayConfig {
            verbose: false,
            color: Some(false),
            // Force the non-streaming path so the mock server can reply with
            // plain JSON completions.
            hide_reasoning: true,
            show_reasoning: false,
            show_fetch_url: false,
            log_level: None,
            log_format: LogFormat::Pretty,
            machine_json: false,
            banner_loops: 4,
        },
        budgets: LlmBudgets::default(),
        diagnostics: Diagnostics {
            log_llm_payloads: false,
            log_max_payload_length: None,
        },
        api_key: Some("mock-api-key".into()),
        llm_base_url_override: Some(base_url),
        indeed_api_key: None,
        usage_tracker: None,
        cancellation: tokio_util::sync::CancellationToken::new(),
        run_started_at_ms: 0,
    }
}

fn canonical_job(id: &str, title: &str, company: &str) -> serde_json::Value {
    json!({
        "id": format!("indeed:{id}"),
        "source": "indeed",
        "sourceJobId": id,
        "canonicalUrl": format!("https://www.indeed.com/viewjob?jk={id}"),
        "title": title,
        "company": company,
        "location": "New York, NY, USA",
        "description": format!("Full job description for {title} at {company}. Requires security experience."),
        "descriptionRepresentation": "markdown",
        "acquiredAt": "2024-01-01T00:00:00.000Z"
    })
}

#[tokio::test]
async fn offline_pipeline_chain_writes_manifests_and_checkpoints() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let materials = sandbox.sub("materials");
    let profile = sandbox.sub("profile");
    populate_full_profile(&profile);

    let server = MockLlmServer::start();

    // Deterministic acquired-jobs fixture (including one exact duplicate and
    // two entries the profile filters must remove).
    let fixture = json!([
        canonical_job("job-pass-1", "Cloud Security Engineer", "Acme Security"),
        canonical_job("job-fail-1", "Sales Associate", "Retail Co"),
        canonical_job("job-filter-company", "Security Engineer", "BlocklistCorp"),
        canonical_job("job-filter-title", "Security Intern", "Good Corp"),
        canonical_job("job-pass-1", "Cloud Security Engineer", "Acme Security"),
    ]);
    let acquired = data.join("acquired_jobs_indeed.json");
    std::fs::write(&acquired, serde_json::to_vec_pretty(&fixture).unwrap()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&acquired).unwrap().permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&acquired, perms).unwrap();
    }

    let ctx = context(&data, &logs, &materials, &profile, server.base_url.clone());

    // === Stage 2: processData ===
    let processed = data.join("processed_jobs_indeed.json");
    let process_result = process_data::run(
        &ctx,
        &ProcessDataOptions {
            input_directory: data.clone(),
            input_files: vec![],
            scan_input_directory: true,
            output_file: processed.clone(),
            company_filters: vec![],
            title_filters: vec![],
            remote_only: false,
            jobcloth_cool_off_days: 30,
            batch_size: 1000,
            sleep_min_ms: 0,
            sleep_max_ms: 0,
            log_cool_offs: false,
        },
    )
    .await
    .expect("processData");

    assert_eq!(process_result.files_processed, 1);
    assert_eq!(process_result.duplicates_removed, 1);
    assert_eq!(process_result.filtered_entries, 2);
    assert_eq!(process_result.output_record_count, 2);
    assert_eq!(mode_of(&processed), 0o600, "processed artifact mode");
    let verified = verify_artifact_manifest(&processed).expect("manifest check");
    assert_eq!(verified["ok"], true, "processed manifest valid");

    // === Stage 3: jobCloth ===
    let clothed = data.join("clothed_jobs_indeed.json");
    let cloth_options = JobClothOptions {
        preset: "jc_glm-5.3-flash".into(),
        batch: 10,
        sleep_ms: 0,
        ..JobClothOptions::default()
    };
    let cloth_jobs = job_cloth::run(
        &ctx,
        std::slice::from_ref(&processed),
        &clothed,
        &cloth_options,
    )
    .await
    .expect("jobCloth");
    assert_eq!(cloth_jobs.len(), 1, "only the security title should pass");
    assert_eq!(
        cloth_jobs[0].title.as_deref(),
        Some("Cloud Security Engineer")
    );
    assert_eq!(mode_of(&clothed), 0o600, "clothed artifact mode");
    assert_eq!(
        verify_artifact_manifest(&clothed).expect("manifest check")["ok"],
        true
    );
    let calls_after_cloth = server.calls();
    assert!(calls_after_cloth > 0, "jobCloth should have called the LLM");

    // Checkpoint idempotency: a second run must not issue more LLM calls.
    let cloth_jobs_again = job_cloth::run(
        &ctx,
        std::slice::from_ref(&processed),
        &clothed,
        &cloth_options,
    )
    .await
    .expect("jobCloth resume");
    assert_eq!(cloth_jobs_again.len(), 1);
    assert_eq!(
        server.calls(),
        calls_after_cloth,
        "completed jobCloth checkpoint must skip LLM calls"
    );

    // === Stage 6: jobJudge ===
    let judge_result = job_judge::run(
        &ctx,
        &JobJudgeOptions {
            input_file: clothed.clone(),
            output_file: data.join("astroapply_eval_"),
            preset: "jep_glm-5.3-flash".into(),
            eval_mode: 1,
            sleep_ms: 0,
            strict_parsing: false,
            use_jobdb: true,
            max_tokens: None,
            reasoning_effort: None,
            provider_routing: None,
            show_reasoning: false,
            show_stream: false,
        },
    )
    .await
    .expect("jobJudge");
    assert_eq!(judge_result.jobs, 1);
    assert_eq!(judge_result.passed, 1);

    let pass_dir = data.join("astroapply_eval_pass");
    let pass_files: Vec<_> = std::fs::read_dir(&pass_dir)
        .expect("pass dir")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().is_some_and(|ext| ext == "json")
                && !path.to_string_lossy().ends_with(".manifest.json")
        })
        .collect();
    assert_eq!(pass_files.len(), 1, "one passing evaluation artifact");

    // === Stage 7: makeMaterials ===
    let materials_result = make_materials::run(
        &ctx,
        &MakeMaterialsOptions {
            preset: "rop_glm-5.3-flash".into(),
            targ_jd: None,
            cover_length: 275,
            sleep_min_ms: 0,
            sleep_max_ms: 0,
            jitter: false,
            temperature: None,
            top_p: None,
            max_tokens: None,
            reasoning_effort: None,
            provider_routing: None,
            resume: None,
            testimonials: None,
            professional_title: None,
            professional_summary: None,
            key_skills: None,
            show_reasoning: false,
            show_stream: false,
            suppress_errors: false,
        },
    )
    .await
    .expect("makeMaterials");
    assert!(
        materials_result.generated >= 1,
        "materials should be generated"
    );
    let material_files: Vec<_> = walk(&materials)
        .into_iter()
        .filter(|path| path.extension().is_some_and(|ext| ext == "txt"))
        .collect();
    assert!(
        !material_files.is_empty(),
        "expected material text files under {materials:?}"
    );
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}

/// End-to-end `run-pipeline` through the real binary with acquisition skipped
/// and a mock LLM server: proves the full offline chain works via CLI config.
#[test]
fn run_pipeline_end_to_end_offline_via_cli() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let materials = sandbox.sub("materials");
    let profile = sandbox.sub("profile");
    populate_full_profile(&profile);

    let server = MockLlmServer::start();

    let fixture = vec![
        canonical_job("job-pass-1", "Cloud Security Engineer", "Acme Security"),
        canonical_job("job-fail-1", "Sales Associate", "Retail Co"),
        canonical_job("job-filter-company", "Security Engineer", "BlocklistCorp"),
        canonical_job("job-filter-title", "Security Intern", "Good Corp"),
        canonical_job("job-pass-1", "Cloud Security Engineer", "Acme Security"),
    ];
    let acquired = data.join("acquired_jobs_indeed.json");
    std::fs::write(&acquired, serde_json::to_vec_pretty(&fixture).unwrap()).unwrap();

    let output = std::process::Command::new(bin())
        .args([
            "--no-banner",
            "--hide-reasoning",
            "--data-dir",
            data.to_str().unwrap(),
            "--log-dir",
            logs.to_str().unwrap(),
            "--profile-dir",
            profile.to_str().unwrap(),
            "--materials-dir",
            materials.to_str().unwrap(),
            "--llm-base-url",
            &server.base_url,
            "run-pipeline",
            "--api-key",
            "mock-api-key",
            "--skip-acquisition",
            "--job-provider",
            "indeed",
            "--batch",
            "10",
            "--sleep",
            "0",
            "--jobcloth-preset",
            "jc_glm-5.3-flash",
            "--jobjudge-preset",
            "jep_glm-5.3-flash",
            "--makematerials-preset",
            "rop_glm-5.3-flash",
        ])
        .current_dir(sandbox.path())
        .output()
        .expect("run astroom run-pipeline");

    assert_eq!(
        output.status.code(),
        Some(0),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    assert!(data.join("processed_jobs_indeed.json").exists());
    assert!(data.join("clothed_jobs_indeed.json").exists());
    assert!(
        data.join("astroapply_eval_pass").is_dir(),
        "jobJudge pass directory must exist"
    );
    assert!(server.calls() > 0, "pipeline must have called the mock LLM");
    for directory in ["jc_payload_logs", "jj_payload_logs", "mm_payload_logs"] {
        let payload_directory = logs.join(directory);
        let payload_files: Vec<_> = std::fs::read_dir(&payload_directory)
            .unwrap_or_else(|error| {
                panic!(
                    "payload log directory {} should exist: {error}",
                    payload_directory.display()
                )
            })
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect();
        assert!(
            !payload_files.is_empty(),
            "{directory} should contain an LLM payload log"
        );
        for payload_file in payload_files {
            assert_eq!(mode_of(&payload_file), 0o600, "payload log mode");
            let payload = std::fs::read_to_string(&payload_file).expect("read payload log");
            assert!(
                !payload.contains("mock-api-key"),
                "payload log must not contain the API key: {}",
                payload_file.display()
            );
            serde_json::from_str::<serde_json::Value>(&payload)
                .expect("payload log must contain valid JSON");
        }
    }
    assert!(
        !walk(&materials).is_empty(),
        "makeMaterials must write material files"
    );
}

/// Node's makeMaterials stage swallows non-cancellation errors inside the
/// pipeline (`runResumeOptimizationMode` returns `{content: [], error}`), so a
/// materials failure still yields a successful pipeline run.
#[test]
fn run_pipeline_succeeds_when_make_materials_fails() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let materials = sandbox.sub("materials");
    let profile = sandbox.sub("profile");
    populate_full_profile(&profile);

    let server = MockLlmServer::start_with_materials(true);

    let fixture = vec![
        canonical_job("job-pass-1", "Cloud Security Engineer", "Acme Security"),
        canonical_job("job-fail-1", "Sales Associate", "Retail Co"),
    ];
    std::fs::write(
        data.join("acquired_jobs_indeed.json"),
        serde_json::to_vec_pretty(&fixture).unwrap(),
    )
    .unwrap();

    let output = std::process::Command::new(bin())
        .args([
            "--no-banner",
            "--data-dir",
            data.to_str().unwrap(),
            "--log-dir",
            logs.to_str().unwrap(),
            "--profile-dir",
            profile.to_str().unwrap(),
            "--materials-dir",
            materials.to_str().unwrap(),
            "--llm-base-url",
            &server.base_url,
            "run-pipeline",
            "--api-key",
            "mock-api-key",
            "--skip-acquisition",
            "--job-provider",
            "indeed",
            "--batch",
            "10",
            "--sleep",
            "0",
            "--jobcloth-preset",
            "jc_glm-5.3-flash",
            "--jobjudge-preset",
            "jep_glm-5.3-flash",
            "--makematerials-preset",
            "rop_glm-5.3-flash",
        ])
        .current_dir(sandbox.path())
        .output()
        .expect("run astroom run-pipeline");

    assert_eq!(
        output.status.code(),
        Some(0),
        "pipeline must tolerate makeMaterials errors\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
