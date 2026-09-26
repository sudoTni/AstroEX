//! Offline Stage 2 (`processData`) integration: artifact discovery, dedup,
//! atomic private output + manifest, and JobDB checkpoint side effects.

mod common;

use astroom::jobrepo::{JobClothIdentity, JobRepository, JobRepositoryConfig};
use common::*;
use serde_json::json;

#[test]
fn process_data_dedups_normalizes_and_writes_manifested_artifact() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let profile = sandbox.sub("profile");

    std::fs::write(
        data.join("acquired_jobs_indeed.json"),
        serde_json::to_vec_pretty(&json!([
            {
                "id": "indeed-1",
                "title": "Staff Engineer",
                "company": "Acme",
                "url": "https://www.indeed.com/viewjob?jk=indeed-1",
                "source": "indeed",
                "description": "Full description here",
                "descriptionText": "Full description here"
            }
        ]))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        data.join("acquired_jobs_linkedin.json"),
        serde_json::to_vec_pretty(&json!([
            {
                "id": "linkedin-1",
                "title": "Staff Engineer",
                "company": "Acme",
                "url": "https://www.linkedin.com/jobs/view/123456789",
                "source": "linkedin"
            }
        ]))
        .unwrap(),
    )
    .unwrap();

    let output = sandbox.run(&[
        "--no-banner",
        "--data-dir",
        data.to_str().unwrap(),
        "--log-dir",
        logs.to_str().unwrap(),
        "--profile-dir",
        profile.to_str().unwrap(),
        "processData",
    ]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let processed = data.join("processed_jobs.json");
    assert!(processed.exists(), "processed artifact missing");
    let jobs: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&processed).unwrap()).unwrap();
    let jobs = jobs.as_array().expect("array artifact");
    assert_eq!(jobs.len(), 1, "title/company duplicate should be removed");
    assert_eq!(jobs[0]["id"], "indeed-1", "Indeed record is preferred");

    // Atomic private write.
    assert_eq!(mode_of(&processed), 0o600);
    let manifest = processed.with_extension("json.manifest.json");
    assert!(manifest.exists());
    assert_eq!(mode_of(&manifest), 0o600);

    // JobDB created next to the output artifact.
    assert!(data.join("jobDB.sqlite").exists());
}

#[test]
fn process_data_writes_cool_off_suppression_log() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let profile = sandbox.sub("profile");

    std::fs::write(
        data.join("acquired_jobs_indeed.json"),
        serde_json::to_vec_pretty(&json!([
            {
                "id": "indeed-1",
                "title": "Staff Engineer",
                "company": "Acme",
                "url": "https://www.indeed.com/viewjob?jk=indeed-1",
                "source": "indeed",
                "description": "Full description here",
                "descriptionText": "Full description here"
            }
        ]))
        .unwrap(),
    )
    .unwrap();

    // Seed a recent jobCloth history entry so the job is inside the cool-off window.
    let mut repo = JobRepository::new(JobRepositoryConfig {
        db_file_path: data.join("jobDB.sqlite"),
        legacy_json_path: None,
        default_expiration_ms: None,
        enable_job_db: true,
        max_records: None,
        now: None,
    });
    repo.initialize().unwrap();
    repo.record_job_cloth_processed(
        &[JobClothIdentity {
            title: "Staff Engineer".to_string(),
            company: "Acme".to_string(),
        }],
        None,
    )
    .unwrap();
    repo.close().unwrap();

    let output = sandbox.run(&[
        "--no-banner",
        "--data-dir",
        data.to_str().unwrap(),
        "--log-dir",
        logs.to_str().unwrap(),
        "--profile-dir",
        profile.to_str().unwrap(),
        "processData",
        "--log-cool-offs",
    ]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let processed: serde_json::Value =
        serde_json::from_slice(&std::fs::read(data.join("processed_jobs.json")).unwrap()).unwrap();
    assert_eq!(
        processed.as_array().map(Vec::len),
        Some(0),
        "cool-off job should be suppressed"
    );

    let log_file = find_file_starting_with(&logs, "processData_cool_off_suppressions_")
        .expect("cool-off suppression log");
    assert_eq!(mode_of(&log_file), 0o600);
    let report: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&log_file).unwrap()).unwrap();
    assert_eq!(report["count"], json!(1));
    assert_eq!(report["coolOffDays"], json!(30));
    assert_eq!(report["jobs"][0]["title"], json!("Staff Engineer"));
    assert_eq!(report["jobs"][0]["company"], json!("Acme"));

    let exec_log = find_file_starting_with(&logs, "astroom_processData_")
        .or_else(|| find_file_starting_with(&logs, "astroom_"))
        .expect("execution log");
    let exec_log_contents = std::fs::read_to_string(&exec_log).unwrap();
    assert!(
        exec_log_contents.contains("Suppressed 1 job(s) from pipeline due to 30-day cool-off"),
        "execution log should contain cool-off suppression log: {exec_log_contents}"
    );
}

#[test]
fn pipeline_stage_2_emits_cool_off_suppressed_count() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let profile = sandbox.sub("profile");
    populate_profile(&profile);

    std::fs::write(
        data.join("acquired_jobs_indeed.json"),
        serde_json::to_vec_pretty(&json!([
            {
                "id": "indeed-1",
                "title": "Staff Engineer",
                "company": "Acme",
                "url": "https://www.indeed.com/viewjob?jk=indeed-1",
                "source": "indeed",
                "description": "Full description here",
                "descriptionText": "Full description here"
            },
            {
                "id": "indeed-2",
                "title": "Security Analyst",
                "company": "Globex",
                "url": "https://www.indeed.com/viewjob?jk=indeed-2",
                "source": "indeed",
                "description": "Another description",
                "descriptionText": "Another description"
            }
        ]))
        .unwrap(),
    )
    .unwrap();

    let mut repo = JobRepository::new(JobRepositoryConfig {
        db_file_path: data.join("jobDB.sqlite"),
        legacy_json_path: None,
        default_expiration_ms: None,
        enable_job_db: true,
        max_records: None,
        now: None,
    });
    repo.initialize().unwrap();
    repo.record_job_cloth_processed(
        &[JobClothIdentity {
            title: "Staff Engineer".to_string(),
            company: "Acme".to_string(),
        }],
        None,
    )
    .unwrap();
    repo.close().unwrap();

    let server = MockLlmServer::start();

    let output = sandbox.run(&[
        "--no-banner",
        "--data-dir",
        data.to_str().unwrap(),
        "--log-dir",
        logs.to_str().unwrap(),
        "--profile-dir",
        profile.to_str().unwrap(),
        "--llm-base-url",
        &server.base_url,
        "run-pipeline",
        "--api-key",
        "test-key",
        "--resume",
        "processData",
    ]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let exec_log = find_file_starting_with(&logs, "astroom_run-pipeline_")
        .or_else(|| find_file_starting_with(&logs, "astroom_"))
        .expect("execution log");
    let exec_log_contents = std::fs::read_to_string(&exec_log).unwrap();

    assert!(
        exec_log_contents.contains("coolOffSuppressed=1"),
        "Stage 2 completion log must emit coolOffSuppressed=1: {exec_log_contents}"
    );
    assert!(
        exec_log_contents.contains("Suppressed 1 job(s) from pipeline due to 30-day cool-off"),
        "Execution log must contain informational cool-off suppression log: {exec_log_contents}"
    );
}
