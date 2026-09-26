//! Internet watchdog probe contract using a fake `ping` shim on PATH.
//!
//! Kept in its own integration binary (and a single test) because it
//! manipulates the process `PATH` environment variable.

#![cfg(unix)]

mod common;

use astroom::internet_watchdog::InternetWatchdog;
use common::*;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

fn write_ping(dir: &std::path::Path, body: &str) {
    std::fs::create_dir_all(dir).unwrap();
    let shim = dir.join("ping");
    std::fs::write(&shim, body).unwrap();
    let mut perms = std::fs::metadata(&shim).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&shim, perms).unwrap();
}

#[tokio::test]
async fn watchdog_probe_paths() {
    let sandbox = Sandbox::new();
    let original_path = std::env::var("PATH").unwrap_or_default();
    let token = CancellationToken::new();

    // Successful probe.
    let ok_dir = sandbox.sub("ping-ok");
    write_ping(&ok_dir, "#!/usr/bin/env bash\nexit 0\n");
    std::env::set_var("PATH", format!("{}:{original_path}", ok_dir.display()));
    let watchdog = InternetWatchdog::new("8.8.8.8").expect("watchdog");
    assert!(watchdog.validate_startup(&token).await.is_ok());

    // Failing probe: startup retries are exhausted.
    let fail_dir = sandbox.sub("ping-fail");
    write_ping(&fail_dir, "#!/usr/bin/env bash\nexit 1\n");
    std::env::set_var("PATH", format!("{}:{original_path}", fail_dir.display()));
    let watchdog = InternetWatchdog::new("8.8.8.8").expect("watchdog");
    let error = watchdog
        .validate_startup(&token)
        .await
        .expect_err("startup should fail");
    assert_eq!(error.code, "INTERNET_WATCHDOG_STARTUP_FAILED");
    assert!(error.message.contains("unreachable during startup"));

    // Missing ping binary: capability error, no retries.
    let empty_dir = sandbox.sub("no-tools");
    std::env::set_var("PATH", empty_dir.display().to_string());
    let watchdog = InternetWatchdog::new("8.8.8.8").expect("watchdog");
    let error = watchdog
        .validate_startup(&token)
        .await
        .expect_err("missing ping");
    assert_eq!(error.code, "INTERNET_WATCHDOG_UNAVAILABLE");

    // Stop is idempotent and aborts the background probe without signalling loss.
    let slow_dir = sandbox.sub("ping-slow");
    write_ping(&slow_dir, "#!/usr/bin/env bash\nsleep 30\nexit 0\n");
    std::env::set_var("PATH", format!("{}:{original_path}", slow_dir.display()));
    let watchdog = InternetWatchdog::new("8.8.8.8").expect("watchdog");
    let signal = CancellationToken::new();
    let lost = Arc::new(AtomicBool::new(false));
    {
        let lost = lost.clone();
        watchdog.start(signal.clone(), move |_error| {
            lost.store(true, Ordering::SeqCst);
        });
    }
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    watchdog.stop();
    watchdog.stop();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(!lost.load(Ordering::SeqCst));

    std::env::set_var("PATH", original_path);
}
