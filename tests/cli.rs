//! CLI-surface integration tests: exit codes, stream routing, banner,
//! execution-log creation/permissions, and environment-variable elimination.

mod common;

use common::*;
use std::process::Command;

#[test]
fn no_args_exits_one_with_usage_on_stderr() {
    let sandbox = Sandbox::new();
    let output = sandbox.run(&[]);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty(), "usage must not go to stdout");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Usage:"), "stderr: {stderr}");
}

#[test]
fn help_exits_zero_on_stdout() {
    let sandbox = Sandbox::new();
    let output = sandbox.run(&["--help"]);
    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Usage:"));
}

#[test]
fn unknown_subcommand_exits_one() {
    let sandbox = Sandbox::new();
    let output = sandbox.run(&["definitely-not-a-command"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("unrecognized subcommand"),
        "stderr: {stderr}"
    );
}

#[test]
fn parse_error_defaults_to_exit_one_not_clap_two() {
    let sandbox = Sandbox::new();
    let output = sandbox.run(&["run-pipeline", "--batch", "not-a-number"]);
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn execution_log_is_created_private_and_directory_is_0700() {
    let sandbox = Sandbox::new();
    // Do not pre-create the log dir: assert the process creates it 0700.
    let logs = sandbox.path().join("fresh-logs");
    let data = sandbox.sub("data");
    let output = sandbox.run(&[
        "jobdb",
        "status",
        "--log-dir",
        logs.to_str().unwrap(),
        "--data-dir",
        data.to_str().unwrap(),
    ]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let log_file = find_file_starting_with(&logs, "astroom_jobdb_").expect("execution log created");
    assert_eq!(mode_of(&log_file), 0o600);
    #[cfg(unix)]
    assert_eq!(mode_of(&logs), 0o700);
}

#[test]
fn banner_is_printed_for_normal_runs() {
    let sandbox = Sandbox::new();
    let logs = sandbox.sub("logs");
    let data = sandbox.sub("data");
    let output = sandbox.run(&[
        "--log-dir",
        logs.to_str().unwrap(),
        "--data-dir",
        data.to_str().unwrap(),
        "jobdb",
        "status",
    ]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("██"), "banner expected: {stdout}");
}

#[test]
fn no_banner_suppresses_banner() {
    let sandbox = Sandbox::new();
    let logs = sandbox.sub("logs");
    let data = sandbox.sub("data");
    let output = sandbox.run(&[
        "--no-banner",
        "--log-dir",
        logs.to_str().unwrap(),
        "--data-dir",
        data.to_str().unwrap(),
        "jobdb",
        "status",
    ]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        !stdout.contains("██"),
        "banner should be suppressed: {stdout}"
    );
}

#[test]
fn json_mode_suppresses_banner() {
    let sandbox = Sandbox::new();
    let logs = sandbox.sub("logs");
    let data = sandbox.sub("data");
    let output = sandbox.run(&[
        "--json",
        "--log-dir",
        logs.to_str().unwrap(),
        "--data-dir",
        data.to_str().unwrap(),
        "jobdb",
        "status",
    ]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(!stdout.contains("██"));
    // -json output must be machine-readable for the command.
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim()).expect("json output");
    assert!(parsed.is_object());
}

#[test]
fn banner_loops_flag_is_accepted_on_pipeline_cli() {
    let sandbox = Sandbox::new();
    let logs = sandbox.sub("logs");
    let data = sandbox.sub("data");
    let output = sandbox.run(&[
        "--banner-loops",
        "0",
        "--log-dir",
        logs.to_str().unwrap(),
        "--data-dir",
        data.to_str().unwrap(),
        "jobdb",
        "status",
    ]);
    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("██"), "banner expected: {stdout}");
}

#[test]
fn scrubbed_environment_behaves_identically() {
    let sandbox = Sandbox::new();
    let logs = sandbox.sub("logs");
    let data = sandbox.sub("data");
    let args = [
        "--no-banner",
        "--data-dir",
        data.to_str().unwrap(),
        "--log-dir",
        logs.to_str().unwrap(),
        "jobdb",
        "status",
    ];
    let normal = sandbox.run(&args);
    // Remove the generated execution log before the scrubbed run so the two
    // runs start from the same state.
    if let Some(log) = find_file_starting_with(&logs, "astroom_") {
        let _ = std::fs::remove_file(log);
    }
    let scrubbed = sandbox.run_scrubbed(&args);
    assert_eq!(normal.status.code(), scrubbed.status.code());
    assert_eq!(normal.stdout, scrubbed.stdout);
    assert_eq!(normal.stderr, scrubbed.stderr);
}

#[test]
fn legacy_application_env_vars_have_no_effect() {
    let sandbox = Sandbox::new();
    let logs = sandbox.sub("logs");
    let data = sandbox.sub("data");
    let args = [
        "--no-banner",
        "--data-dir",
        data.to_str().unwrap(),
        "--log-dir",
        logs.to_str().unwrap(),
        "jobdb",
        "status",
    ];
    let baseline = sandbox.run(&args);
    let with_legacy = Command::new(bin())
        .args(args)
        .current_dir(sandbox.path())
        .env("ASTROEX_DATA_DIR", "/nonexistent/astroex")
        .env("ASTROEX_REMOTE_ONLY", "1")
        .env("ASTROEX_LOG_LEVEL", "trace")
        .env("ASTROEX_NO_COLOR", "1")
        .env("AEX_OR_API_KEY", "should-be-ignored")
        .env("AEX_DEPLOY", "1")
        .env("OPENAI_API_KEY", "should-be-ignored")
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "1")
        .output()
        .expect("run with legacy env");
    assert_eq!(baseline.status.code(), with_legacy.status.code());
    assert_eq!(baseline.stdout, with_legacy.stdout);
}

#[test]
fn api_key_file_and_api_key_conflict() {
    let sandbox = Sandbox::new();
    let key_file = sandbox.path().join("key.txt");
    std::fs::write(&key_file, "file-key").unwrap();
    let logs = sandbox.sub("logs");
    let data = sandbox.sub("data");
    let output = sandbox.run(&[
        "--log-dir",
        logs.to_str().unwrap(),
        "--data-dir",
        data.to_str().unwrap(),
        "--api-key",
        "cli-key",
        "--api-key-file",
        key_file.to_str().unwrap(),
        "artifact",
        "verify",
        "missing.json",
    ]);
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.to_lowercase().contains("cannot be used with"),
        "stderr: {stderr}"
    );
}

#[test]
fn execution_log_mirrors_colored_stdout_without_ansi() {
    let sandbox = Sandbox::new();
    let logs = sandbox.sub("logs");
    let data = sandbox.sub("data");
    let profile = sandbox.sub("profile");
    populate_profile(&profile);
    let output = sandbox.run(&[
        "run-pipeline",
        "--api-key",
        "test-key",
        "--resume",
        "deployment",
        "--color",
        "--data-dir",
        data.to_str().unwrap(),
        "--log-dir",
        logs.to_str().unwrap(),
        "--profile-dir",
        profile.to_str().unwrap(),
    ]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains('\u{1b}'),
        "forced --color should emit ANSI: {stdout:?}"
    );
    let log_file = find_file_starting_with(&logs, "astroom_run-pipeline_")
        .or_else(|| find_file_starting_with(&logs, "astroom_"))
        .expect("execution log");
    let contents = std::fs::read_to_string(&log_file).expect("read execution log");
    assert!(
        !contents.contains('\u{1b}'),
        "execution log must be ANSI-stripped"
    );
    assert!(
        contents.contains("Preflight checks passed") || contents.contains("Pipeline progress"),
        "execution log should mirror stdout: {contents}"
    );
}

#[test]
fn execution_log_mirrors_stderr_error() {
    let sandbox = Sandbox::new();
    let logs = sandbox.sub("logs");
    let data = sandbox.sub("data");
    let profile = sandbox.sub("profile");
    populate_profile(&profile);
    let output = sandbox.run(&[
        "run-pipeline",
        "--api-key",
        "test-key",
        "--resume",
        "notAPhase",
        "--data-dir",
        data.to_str().unwrap(),
        "--log-dir",
        logs.to_str().unwrap(),
        "--profile-dir",
        profile.to_str().unwrap(),
    ]);
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("Invalid --resume phase"),
        "stderr: {stderr}"
    );
    let log_file = find_file_starting_with(&logs, "astroom_").expect("execution log");
    let contents = std::fs::read_to_string(&log_file).expect("read execution log");
    assert!(
        contents.contains("Invalid --resume phase"),
        "execution log should mirror stderr: {contents}"
    );
}

#[test]
fn llm_base_url_override_is_a_global_option() {
    let sandbox = Sandbox::new();
    let output = sandbox.run(&["--help"]);
    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("--llm-base-url"),
        "global endpoint override must be documented: {stdout}"
    );
}
