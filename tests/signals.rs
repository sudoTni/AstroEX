//! Signal-handling parity tests (migration plan section 8.2): SIGINT/SIGTERM
//! must cancel the pipeline gracefully and map to exit codes 130/143. A slow
//! mock LLM keeps a request in flight so the signal is delivered mid-run.

#![cfg(unix)]

mod common;

use common::*;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn acquire_fixture(data: &std::path::Path) {
    let fixture = serde_json::json!([
        {
            "id": "indeed:signal-job-1",
            "source": "indeed",
            "sourceJobId": "signal-job-1",
            "canonicalUrl": "https://www.indeed.com/viewjob?jk=signal-job-1",
            "title": "Cloud Security Engineer",
            "company": "Acme Security",
            "location": "New York, NY, USA",
            "description": "Full job description requiring cloud security experience.",
            "descriptionRepresentation": "markdown",
            "acquiredAt": "2024-01-01T00:00:00.000Z"
        }
    ]);
    std::fs::write(
        data.join("acquired_jobs_indeed.json"),
        serde_json::to_vec_pretty(&fixture).unwrap(),
    )
    .expect("write acquisition fixture");
}

fn wait_for_llm_call(server: &MockLlmServer) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while server.calls() == 0 {
        assert!(
            Instant::now() < deadline,
            "pipeline never reached an LLM call"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn run_and_signal(signal: i32) -> (i32, String) {
    let sandbox = Sandbox::new();
    let data = sandbox.sub("data");
    let logs = sandbox.sub("logs");
    let materials = sandbox.sub("materials");
    let profile = sandbox.sub("profile");
    populate_full_profile(&profile);
    acquire_fixture(&data);

    // Long delay so the request is still in flight when the signal lands; the
    // client aborts cooperatively, so the test itself does not wait it out.
    let server = MockLlmServer::start_slow(30_000);

    let mut child = Command::new(bin())
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
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn astroom");

    wait_for_llm_call(&server);

    let pid = child.id() as libc::pid_t;
    // SAFETY: pid is a live child of this process.
    let rc = unsafe { libc::kill(pid, signal) };
    assert_eq!(rc, 0, "kill({pid}, {signal}) failed");

    let status = child.wait().expect("wait for astroom");
    let code = status.code().unwrap_or(-1);
    let log_file = find_file_starting_with(&logs, "astroom_run-pipeline_")
        .or_else(|| find_file_starting_with(&logs, "astroom_"))
        .expect("execution log");
    let contents = std::fs::read_to_string(&log_file).unwrap_or_default();
    (code, contents)
}

#[test]
fn sigint_cancels_gracefully_and_exits_130() {
    let (code, log) = run_and_signal(libc::SIGINT);
    assert_eq!(code, 130, "SIGINT must map to exit 130; log:\n{log}");
    assert!(
        log.contains("Received SIGINT"),
        "execution log should record the graceful SIGINT cancellation:\n{log}"
    );
}

#[test]
fn sigterm_cancels_gracefully_and_exits_143() {
    let (code, log) = run_and_signal(libc::SIGTERM);
    assert_eq!(code, 143, "SIGTERM must map to exit 143; log:\n{log}");
    assert!(
        log.contains("Received SIGTERM"),
        "execution log should record the graceful SIGTERM cancellation:\n{log}"
    );
}
