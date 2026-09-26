//! Standalone jobCloth command contract tests that avoid live LLM calls.

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
fn default_input_requires_processed_files() {
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
    args.extend(["jobCloth", "--preset", "jc_glm-5.3-flash"]);
    let output = sandbox.run(&args);
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("No processed_jobs*.json files found"),
        "stderr: {stderr}"
    );
}
