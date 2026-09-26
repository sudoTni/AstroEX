//! Pipeline orchestration contract tests that can run fully offline by
//! resuming at a phase whose stages are gated off.

mod common;

use common::*;

fn base_args<'a>(data: &'a str, logs: &'a str, profile: &'a str) -> Vec<&'a str> {
    vec![
        "--no-banner",
        "--data-dir",
        data,
        "--log-dir",
        logs,
        "--profile-dir",
        profile,
    ]
}

#[test]
fn resume_at_deployment_without_deploy_is_a_clean_noop() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let profile = sandbox.sub("profile");
    populate_profile(&profile);
    let mut args = base_args(
        data.to_str().unwrap(),
        logs.to_str().unwrap(),
        profile.to_str().unwrap(),
    );
    args.extend([
        "run-pipeline",
        "--api-key",
        "test-key",
        "--resume",
        "deployment",
    ]);
    let output = sandbox.run(&args);
    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn run_pipeline_requires_an_api_key() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let profile = sandbox.sub("profile");
    populate_profile(&profile);
    let mut args = base_args(
        data.to_str().unwrap(),
        logs.to_str().unwrap(),
        profile.to_str().unwrap(),
    );
    args.extend(["run-pipeline", "--resume", "jobCloth"]);
    let output = sandbox.run(&args);
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("--api-key"), "stderr: {stderr}");
}

#[test]
fn resume_at_deployment_without_api_key_is_allowed() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let profile = sandbox.sub("profile");
    populate_profile(&profile);
    let mut args = base_args(
        data.to_str().unwrap(),
        logs.to_str().unwrap(),
        profile.to_str().unwrap(),
    );
    args.extend(["run-pipeline", "--resume", "deployment"]);
    let output = sandbox.run(&args);
    assert_eq!(
        output.status.code(),
        Some(0),
        "no LLM stage runs, so no key is required; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn run_pipeline_accepts_explicit_false_boolean_values() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let profile = sandbox.sub("profile");
    populate_profile(&profile);
    let mut args = base_args(
        data.to_str().unwrap(),
        logs.to_str().unwrap(),
        profile.to_str().unwrap(),
    );
    args.extend([
        "run-pipeline",
        "--resume",
        "deployment",
        "--clean",
        "false",
        "--skip-acquisition",
        "0",
        "--skip-materials",
        "false",
        "--deploy",
        "false",
        "--track-or-costs",
        "false",
        "--log-cool-offs",
        "0",
    ]);
    let output = sandbox.run(&args);
    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn later_pipeline_options_override_launcher_policy_values() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let profile = sandbox.sub("profile");
    populate_profile(&profile);
    let mut args = base_args(
        data.to_str().unwrap(),
        logs.to_str().unwrap(),
        profile.to_str().unwrap(),
    );
    args.extend([
        "run-pipeline",
        "--resume",
        "deployment",
        "--batch",
        "10",
        "--remote-only",
        "true",
        "--clean",
        "--batch",
        "1",
        "--remote-only",
        "false",
        "--clean",
        "false",
    ]);
    let output = sandbox.run(&args);
    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn invalid_resume_phase_exits_one() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let profile = sandbox.sub("profile");
    let mut args = base_args(
        data.to_str().unwrap(),
        logs.to_str().unwrap(),
        profile.to_str().unwrap(),
    );
    args.extend([
        "run-pipeline",
        "--api-key",
        "test-key",
        "--resume",
        "notAPhase",
    ]);
    let output = sandbox.run(&args);
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("Invalid --resume phase"),
        "stderr: {stderr}"
    );
}

#[test]
fn deploy_without_destination_exits_one() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let profile = sandbox.sub("profile");
    let mut args = base_args(
        data.to_str().unwrap(),
        logs.to_str().unwrap(),
        profile.to_str().unwrap(),
    );
    args.extend([
        "run-pipeline",
        "--api-key",
        "test-key",
        "--resume",
        "deployment",
        "--deploy",
    ]);
    let output = sandbox.run(&args);
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("--deploy requires --deploy-destination"),
        "stderr: {stderr}"
    );
}

#[test]
fn track_or_costs_logs_pipeline_summary() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let profile = sandbox.sub("profile");
    populate_profile(&profile);
    let mut args = base_args(
        data.to_str().unwrap(),
        logs.to_str().unwrap(),
        profile.to_str().unwrap(),
    );
    args.extend([
        "run-pipeline",
        "--api-key",
        "test-key",
        "--resume",
        "deployment",
        "--track-or-costs",
    ]);
    let output = sandbox.run(&args);
    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("OpenRouter pipeline usage summary"),
        "stdout: {stdout}"
    );
    assert!(stdout.contains("cost=$0"), "stdout: {stdout}");
}

#[test]
fn pipeline_summary_is_absent_without_tracking_flag() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let profile = sandbox.sub("profile");
    populate_profile(&profile);
    let mut args = base_args(
        data.to_str().unwrap(),
        logs.to_str().unwrap(),
        profile.to_str().unwrap(),
    );
    args.extend([
        "run-pipeline",
        "--api-key",
        "test-key",
        "--resume",
        "deployment",
    ]);
    let output = sandbox.run(&args);
    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        !stdout.contains("OpenRouter pipeline usage summary"),
        "stdout: {stdout}"
    );
}

#[test]
fn auto_provider_top_must_be_positive() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let profile = sandbox.sub("profile");
    let mut args = base_args(
        data.to_str().unwrap(),
        logs.to_str().unwrap(),
        profile.to_str().unwrap(),
    );
    args.extend([
        "run-pipeline",
        "--api-key",
        "test-key",
        "--resume",
        "deployment",
        "--astro_auto_provider-top",
        "0",
    ]);
    let output = sandbox.run(&args);
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("--astro_auto_provider-top"),
        "stderr: {stderr}"
    );
}

#[test]
fn resume_past_remote_eval_with_remote_only_requires_artifact() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let profile = sandbox.sub("profile");
    populate_profile(&profile);
    let mut args = base_args(
        data.to_str().unwrap(),
        logs.to_str().unwrap(),
        profile.to_str().unwrap(),
    );
    args.extend([
        "run-pipeline",
        "--api-key",
        "test-key",
        "--remote-only",
        "true",
        "--resume",
        "jobJudge",
    ]);
    let output = sandbox.run(&args);
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("required remoteEval artifact is missing"),
        "stderr: {stderr}"
    );
}
