//! Stage 8 deployment contract with a fake `rclone` shim on PATH.

#![cfg(unix)]

mod common;

use common::*;
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::process::Stdio;
use std::time::{Duration, Instant};

#[test]
fn deployment_invokes_rclone_and_archives_materials() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let profile = sandbox.sub("profile");
    populate_profile(&profile);
    let materials = sandbox.sub("materials");
    let archive = sandbox.sub("materials-deployed");
    std::fs::create_dir_all(materials.join("job1")).unwrap();
    std::fs::write(materials.join("job1/resume.txt"), "resume").unwrap();
    std::fs::write(materials.join("job1/cover.txt"), "cover").unwrap();
    std::fs::write(materials.join("job1/notes.md"), "ignored").unwrap();

    // Fake rclone on PATH.
    let shim_dir = sandbox.sub("shim");
    let shim = shim_dir.join("rclone");
    let dump = sandbox.path().join("rclone-argv.txt");
    std::fs::write(
        &shim,
        format!(
            "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > '{}'\nexit 0\n",
            dump.display()
        ),
    )
    .unwrap();
    set_executable(&shim);

    let search_path = format!(
        "{}:{}",
        shim_dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let output = Command::new(bin())
        .args([
            "--no-banner",
            "--data-dir",
            data.to_str().unwrap(),
            "--log-dir",
            logs.to_str().unwrap(),
            "--profile-dir",
            profile.to_str().unwrap(),
            "run-pipeline",
            "--api-key",
            "test-key",
            "--resume",
            "deployment",
            "--deploy",
            "--deploy-destination",
            "GoogleDrive:/dest",
            "--materials-dir",
            materials.to_str().unwrap(),
            "--deployed-materials-dir",
            archive.to_str().unwrap(),
        ])
        .env("PATH", search_path)
        .current_dir(sandbox.path())
        .output()
        .expect("run deployment");

    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let argv: Vec<String> = std::fs::read_to_string(&dump)
        .expect("rclone invoked")
        .lines()
        .map(str::to_owned)
        .collect();
    assert!(argv.iter().any(|arg| arg == "-v"));
    assert!(argv.iter().any(|arg| arg == "--fast-list"));
    assert!(argv.iter().any(|arg| arg == "copy"));
    assert!(argv.iter().any(|arg| arg == "GoogleDrive:/dest"));
    let staging = &argv[3];
    assert!(
        staging.contains("astroom-deploy-"),
        "staging dir: {staging}"
    );

    assert!(
        archive.join("job1/resume.txt").exists(),
        "materials must be archived"
    );
    let remaining: Vec<_> = std::fs::read_dir(&materials).unwrap().collect();
    assert!(remaining.is_empty(), "materials dir should be drained");
}

#[test]
fn deployment_failure_propagates_exit_code() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let profile = sandbox.sub("profile");
    populate_profile(&profile);
    let materials = sandbox.sub("materials");
    std::fs::write(materials.join("resume.txt"), "resume").unwrap();

    let shim_dir = sandbox.sub("shim");
    let shim = shim_dir.join("rclone");
    std::fs::write(&shim, "#!/usr/bin/env bash\nexit 17\n").unwrap();
    set_executable(&shim);

    let search_path = format!(
        "{}:{}",
        shim_dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let output = Command::new(bin())
        .args([
            "--no-banner",
            "--data-dir",
            data.to_str().unwrap(),
            "--log-dir",
            logs.to_str().unwrap(),
            "--profile-dir",
            profile.to_str().unwrap(),
            "run-pipeline",
            "--api-key",
            "test-key",
            "--resume",
            "deployment",
            "--deploy",
            "--deploy-destination",
            "GoogleDrive:/dest",
            "--materials-dir",
            materials.to_str().unwrap(),
        ])
        .env("PATH", search_path)
        .current_dir(sandbox.path())
        .output()
        .expect("run deployment");

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("rclone"), "stderr: {stderr}");
}

/// Spawns a deploy run whose fake rclone blocks on `copy`, sends `signal`
/// (`-INT`/`-TERM`), and returns the child's exit code.
fn cancel_during_deploy(signal: &str) -> i32 {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let profile = sandbox.sub("profile");
    populate_profile(&profile);
    let materials = sandbox.sub("materials");
    let archive = sandbox.sub("materials-deployed");
    std::fs::write(materials.join("resume.txt"), "resume").unwrap();

    // Fake rclone: answer `version` immediately (preflight) and block on
    // `copy` so the signal must cancel the awaited subprocess.
    let shim_dir = sandbox.sub("shim");
    let shim = shim_dir.join("rclone");
    std::fs::write(
        &shim,
        "#!/usr/bin/env bash\nif [[ \"$1\" == \"version\" ]]; then exit 0; fi\nsleep 30\n",
    )
    .unwrap();
    set_executable(&shim);

    let search_path = format!(
        "{}:{}",
        shim_dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let mut command = Command::new(bin());
    command
        .args([
            "--no-banner",
            "--data-dir",
            data.to_str().unwrap(),
            "--log-dir",
            logs.to_str().unwrap(),
            "--profile-dir",
            profile.to_str().unwrap(),
            "run-pipeline",
            "--api-key",
            "test-key",
            "--resume",
            "deployment",
            "--deploy",
            "--deploy-destination",
            "GoogleDrive:/dest",
            "--materials-dir",
            materials.to_str().unwrap(),
            "--deployed-materials-dir",
            archive.to_str().unwrap(),
        ])
        .env("PATH", search_path)
        .current_dir(sandbox.path())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // The test harness may run with these signals ignored; restore defaults so
    // the child can observe them.
    unsafe {
        command.pre_exec(|| {
            libc::signal(libc::SIGINT, libc::SIG_DFL);
            libc::signal(libc::SIGTERM, libc::SIG_DFL);
            Ok(())
        });
    }
    let mut child = command.spawn().expect("spawn astroom");

    std::thread::sleep(Duration::from_millis(900));
    let started = Instant::now();
    Command::new("kill")
        .args([signal, &child.id().to_string()])
        .status()
        .expect("send signal");
    let status = child.wait().expect("wait astroom");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "cancellation must not wait for the full rclone sleep"
    );
    status.code().unwrap_or(-1)
}

#[test]
fn deployment_cancels_on_sigint_and_kills_rclone() {
    assert_eq!(cancel_during_deploy("-INT"), 130);
}

#[test]
fn deployment_cancels_on_sigterm_and_kills_rclone() {
    assert_eq!(cancel_during_deploy("-TERM"), 143);
}

#[test]
fn deployment_emits_command_output_before_stage_completion_log() {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let profile = sandbox.sub("profile");
    populate_profile(&profile);
    let materials = sandbox.sub("materials");
    let archive = sandbox.sub("materials-deployed");
    std::fs::write(materials.join("resume.txt"), "resume").unwrap();

    let shim_dir = sandbox.sub("shim");
    let shim = shim_dir.join("rclone");
    std::fs::write(
        &shim,
        r#"#!/usr/bin/env bash
if [[ "$1" == "version" ]]; then exit 0; fi
for i in $(seq 1 40); do
  echo "2026/09/24 19:12:31 INFO  : Test_File_Number_${i}_With_Very_Long_Name_To_Pad_Line_Length_And_Exceed_Buffers.txt: Copied (new)" >&2
done
echo "Transferred:   22 / 22, 100%" >&2
echo "Elapsed time:  5.9s" >&2
exit 0
"#,
    )
    .unwrap();
    set_executable(&shim);

    let search_path = format!(
        "{}:{}",
        shim_dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let output = Command::new(bin())
        .args([
            "--no-banner",
            "--data-dir",
            data.to_str().unwrap(),
            "--log-dir",
            logs.to_str().unwrap(),
            "--profile-dir",
            profile.to_str().unwrap(),
            "run-pipeline",
            "--api-key",
            "test-key",
            "--resume",
            "deployment",
            "--deploy",
            "--deploy-destination",
            "GoogleDrive:/dest",
            "--materials-dir",
            materials.to_str().unwrap(),
            "--deployed-materials-dir",
            archive.to_str().unwrap(),
        ])
        .env("PATH", search_path)
        .current_dir(sandbox.path())
        .output()
        .expect("run deployment");

    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let log_file = find_file_starting_with(&logs, "astroom_run-pipeline_")
        .or_else(|| find_file_starting_with(&logs, "astroom_"))
        .expect("execution log file must exist");
    let contents = std::fs::read_to_string(&log_file).expect("read execution log");

    let marker_last_rclone_line = "Elapsed time:  5.9s";
    let marker_stage_completion = "Stage 8/8: Deployment completed";

    let pos_rclone = contents
        .find(marker_last_rclone_line)
        .expect("rclone summary line must be in execution log");
    let pos_completion = contents
        .find(marker_stage_completion)
        .expect("Stage 8/8 completion line must be in execution log");

    assert!(
        pos_completion > pos_rclone,
        "Stage completion log ({pos_completion}) must appear AFTER rclone command output has completely finished ({pos_rclone}). Contents:\n{contents}"
    );

    for i in 1..=40 {
        let line_marker = format!("Test_File_Number_{i}_With_Very_Long_Name_To_Pad_Line_Length_And_Exceed_Buffers.txt: Copied (new)");
        assert!(
            contents.contains(&line_marker),
            "Line {i} must be intact in execution log"
        );
    }
}
