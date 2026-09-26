//! Preflight command contract tests (offline, machine-JSON output).

mod common;

use common::*;
use std::process::Command;

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

fn parse_stdout_json(output: &std::process::Output) -> serde_json::Value {
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Machine JSON is the last JSON object printed; find its start.
    let start = stdout.find('{').expect("json output");
    serde_json::from_str(&stdout[start..]).expect("valid json")
}

#[test]
fn preflight_succeeds_with_complete_profile() {
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
    args.push("preflight");
    let output = sandbox.run(&args);
    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json = parse_stdout_json(&output);
    assert_eq!(json["valid"], serde_json::json!(true));
    assert_eq!(json["runtimeValid"], serde_json::json!(true));
    assert!(json["runtime"]
        .as_str()
        .unwrap_or_default()
        .starts_with("rust "));
    assert_eq!(json["missingProfileFiles"], serde_json::json!([]));
    assert_eq!(json["apiKeyPresent"], serde_json::json!(false));
}

#[test]
fn preflight_fails_when_required_profile_file_missing() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let profile = sandbox.sub("profile");
    populate_profile(&profile);
    std::fs::remove_file(profile.join("my_resume.txt")).unwrap();
    let mut args = base_args(
        data.to_str().unwrap(),
        logs.to_str().unwrap(),
        profile.to_str().unwrap(),
    );
    args.push("preflight");
    let output = sandbox.run(&args);
    assert_eq!(output.status.code(), Some(1));
    let json = parse_stdout_json(&output);
    assert_eq!(json["valid"], serde_json::json!(false));
    assert_eq!(
        json["missingProfileFiles"],
        serde_json::json!(["my_resume.txt"])
    );
    let errors = json["errors"].to_string();
    assert!(
        errors.contains("Missing or empty required profile files"),
        "errors: {errors}"
    );
}

#[test]
fn preflight_require_api_key_without_key_fails() {
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
    args.extend(["preflight", "--require-api-key"]);
    let output = sandbox.run(&args);
    assert_eq!(output.status.code(), Some(1));
    let json = parse_stdout_json(&output);
    assert_eq!(json["valid"], serde_json::json!(false));
    assert!(json["errors"].to_string().contains("API key"));
}

#[test]
fn preflight_reports_missing_selected_presets() {
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
    args.extend(["preflight", "--presets", "jc_glm-5.3-flash,not-a-preset"]);
    let output = sandbox.run(&args);
    assert_eq!(output.status.code(), Some(1));
    let json = parse_stdout_json(&output);
    assert_eq!(json["selectedPresetsValid"], serde_json::json!(false));
    assert_eq!(
        json["missingSelectedPresets"],
        serde_json::json!(["not-a-preset"])
    );
}

#[test]
fn preflight_deployment_requires_rclone_and_destination() {
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
    args.extend(["preflight", "--check-deployment"]);
    let output = sandbox.run(&args);
    assert_eq!(output.status.code(), Some(1));
    let json = parse_stdout_json(&output);
    assert_eq!(json["deployment"]["enabled"], serde_json::json!(true));
    assert_eq!(
        json["deployment"]["destinationSet"],
        serde_json::json!(false)
    );
    assert!(json["errors"].to_string().contains("--deploy-destination"));
}

#[test]
fn preflight_deployment_passes_with_fake_rclone() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let profile = sandbox.sub("profile");
    populate_profile(&profile);

    let shim_dir = sandbox.sub("shim");
    let shim = shim_dir.join("rclone");
    std::fs::write(&shim, "#!/usr/bin/env bash\nexit 0\n").unwrap();
    set_executable(&shim);
    let search_path = format!(
        "{}:{}",
        shim_dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );

    let mut args = base_args(
        data.to_str().unwrap(),
        logs.to_str().unwrap(),
        profile.to_str().unwrap(),
    );
    args.extend([
        "preflight",
        "--check-deployment",
        "--deploy-destination",
        "GoogleDrive:/dest",
    ]);
    let output = Command::new(bin())
        .args(&args)
        .env("PATH", search_path)
        .current_dir(sandbox.path())
        .output()
        .expect("run preflight");
    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json = parse_stdout_json(&output);
    assert_eq!(json["valid"], serde_json::json!(true));
    assert_eq!(
        json["deployment"]["rcloneAvailable"],
        serde_json::json!(true)
    );
    assert_eq!(json["deployment"]["valid"], serde_json::json!(true));
}

#[test]
fn preflight_treats_nonzero_rclone_as_unavailable() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let profile = sandbox.sub("profile");
    populate_profile(&profile);

    let shim_dir = sandbox.sub("shim");
    let shim = shim_dir.join("rclone");
    std::fs::write(&shim, "#!/usr/bin/env bash\nexit 7\n").unwrap();
    set_executable(&shim);
    let search_path = format!(
        "{}:{}",
        shim_dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );

    let mut args = base_args(
        data.to_str().unwrap(),
        logs.to_str().unwrap(),
        profile.to_str().unwrap(),
    );
    args.extend([
        "preflight",
        "--check-deployment",
        "--deploy-destination",
        "GoogleDrive:/dest",
    ]);
    let output = Command::new(bin())
        .args(&args)
        .env("PATH", search_path)
        .current_dir(sandbox.path())
        .output()
        .expect("run preflight");
    assert_eq!(output.status.code(), Some(1));
    let json = parse_stdout_json(&output);
    assert_eq!(
        json["deployment"]["rcloneAvailable"],
        serde_json::json!(false)
    );
}
