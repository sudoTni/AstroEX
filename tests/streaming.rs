//! Request-streaming parity: standalone commands default to non-streaming
//! requests, `--show-stream` opts in, and run-pipeline streams by default.

mod common;

use common::*;
use std::io::Write as _;
use std::process::Command;

fn write_clothed_jobs(path: &std::path::Path) {
    let job = serde_json::json!([
        {
            "id": "indeed:job-1",
            "source": "indeed",
            "sourceJobId": "job-1",
            "url": "https://www.indeed.com/viewjob?jk=job-1",
            "title": "Cloud Security Engineer",
            "company": "Acme Security",
            "location": "New York, NY, USA",
            "descriptionText": "Full job description for Cloud Security Engineer at Acme Security.",
            "postedDate": "2024-01-01T00:00:00.000Z"
        }
    ]);
    let mut file = std::fs::File::create(path).expect("create input");
    file.write_all(serde_json::to_string_pretty(&job).unwrap().as_bytes())
        .expect("write input");
}

fn run_job_judge(sandbox: &Sandbox, extra: &[&str]) -> std::process::Output {
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let profile = sandbox.sub("profile");
    populate_full_profile(&profile);
    let input = data.join("clothed_jobs_test.json");
    write_clothed_jobs(&input);
    let output_dir = data.join("astroapply_eval_");

    let mut args: Vec<String> = vec![
        "--no-banner".into(),
        "--data-dir".into(),
        data.to_str().unwrap().into(),
        "--log-dir".into(),
        logs.to_str().unwrap().into(),
        "--profile-dir".into(),
        profile.to_str().unwrap().into(),
        "jobJudge".into(),
        "--preset".into(),
        "jep_glm-5.3-flash".into(),
        "--input-file".into(),
        input.to_str().unwrap().into(),
        "--output-file".into(),
        output_dir.to_str().unwrap().into(),
        "--api-key".into(),
        "mock-api-key".into(),
    ];
    args.extend(extra.iter().map(|value| (*value).to_string()));

    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    sandbox.run(&refs)
}

fn has_streambody(bodies: &[String]) -> bool {
    bodies.iter().any(|body| body.contains("\"stream\":true"))
}

#[test]
fn standalone_job_judge_defaults_to_non_streaming() {
    let sandbox = Sandbox::new();
    let server = MockLlmServer::start();
    let output = run_job_judge(&sandbox, &["--llm-base-url", &server.base_url]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let bodies = server.request_bodies.lock().unwrap().clone();
    assert!(!bodies.is_empty(), "jobJudge should call the LLM");
    assert!(
        !has_streambody(&bodies),
        "standalone jobJudge must not stream by default"
    );
}

#[test]
fn standalone_job_judge_streams_with_show_stream_flag() {
    let sandbox = Sandbox::new();
    let server = MockLlmServer::start();
    let output = run_job_judge(
        &sandbox,
        &["--show-stream", "--llm-base-url", &server.base_url],
    );
    assert_eq!(
        output.status.code(),
        Some(0),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let bodies = server.request_bodies.lock().unwrap().clone();
    assert!(
        has_streambody(&bodies),
        "--show-stream must enable streaming requests"
    );
}

#[test]
fn run_pipeline_streams_by_default() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let materials = sandbox.sub("materials");
    let profile = sandbox.sub("profile");
    populate_full_profile(&profile);
    let server = MockLlmServer::start();

    // Seed the acquireJobs artifact and skip acquisition.
    let fixture = serde_json::json!([
        {
            "id": "indeed:job-1",
            "source": "indeed",
            "sourceJobId": "job-1",
            "canonicalUrl": "https://www.indeed.com/viewjob?jk=job-1",
            "title": "Cloud Security Engineer",
            "company": "Acme Security",
            "location": "New York, NY, USA",
            "description": "Full job description for Cloud Security Engineer.",
            "descriptionRepresentation": "markdown",
            "acquiredAt": "2024-01-01T00:00:00.000Z"
        }
    ]);
    std::fs::write(
        data.join("acquired_jobs_indeed.json"),
        serde_json::to_vec_pretty(&fixture).unwrap(),
    )
    .unwrap();

    let output = Command::new(bin())
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
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let bodies = server.request_bodies.lock().unwrap().clone();
    assert!(
        has_streambody(&bodies),
        "run-pipeline must stream by default"
    );
}
