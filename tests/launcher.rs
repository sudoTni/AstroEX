//! `astro_launcher.bash` launcher integration: argv assembly, policy flags,
//! logs cleanup, key gating, deploy gating and argument forwarding.

#![cfg(unix)]

mod common;

use common::*;
use std::path::{Path, PathBuf};
use std::process::Command;

struct Launcher {
    sandbox: Sandbox,
    dump: PathBuf,
}

impl Launcher {
    fn new(env_contents: &str) -> Self {
        let sandbox = Sandbox::new();
        let script_src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("astro_launcher.bash");
        std::fs::copy(&script_src, sandbox.path().join("astro_launcher.bash")).unwrap();
        std::fs::write(sandbox.path().join(".env"), env_contents).unwrap();

        let profile = sandbox.sub("profile");
        std::fs::write(profile.join("search_terms.txt"), "engineer\n").unwrap();

        // A pre-existing log file must be wiped by the launcher.
        let logs = sandbox.sub("logs");
        std::fs::write(logs.join("stale.log"), "stale").unwrap();

        // Fake `astroom` binary that records its argv and exits 0.
        let bin_dir = sandbox.path().join("target/release");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let shim = bin_dir.join("astroom");
        let dump = sandbox.path().join("argv.txt");
        std::fs::write(
            &shim,
            format!(
                "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > '{}'\n",
                dump.display()
            ),
        )
        .unwrap();
        set_executable(&shim);

        Self { sandbox, dump }
    }

    fn argv(&self) -> Vec<String> {
        std::fs::read_to_string(&self.dump)
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn run(&self) -> std::process::Output {
        Command::new("bash")
            .arg(self.sandbox.path().join("astro_launcher.bash"))
            .current_dir(self.sandbox.path())
            .output()
            .expect("run launcher")
    }
}

fn has_pair(argv: &[String], flag: &str, value: &str) -> bool {
    argv.windows(2)
        .any(|window| window[0] == flag && window[1] == value)
}

#[test]
fn launcher_assembles_policy_argv_and_wipes_logs() {
    let launcher = Launcher::new("AOM_OR_API_KEY=test-key\n");
    let output = launcher.run();
    assert!(
        output.status.success(),
        "launcher failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let argv = launcher.argv();
    assert_eq!(argv.first().map(String::as_str), Some("run-pipeline"));
    assert!(has_pair(&argv, "--job-provider", "indeed,linkedin"));
    assert!(has_pair(&argv, "--api-key", "test-key"));
    assert!(has_pair(&argv, "--jc-provider", "astro_auto_provider"));
    assert!(has_pair(&argv, "--jc-provider-quant", "fp8"));
    assert!(has_pair(&argv, "--j-provider-quant", "fp8"));
    assert!(has_pair(&argv, "--astro_auto_provider-top", "3"));
    assert!(has_pair(&argv, "--remote-only", "true"));
    assert!(argv.iter().any(|arg| arg == "--track-or-costs"));
    assert!(argv.iter().any(|arg| arg == "--internet-watchdog"));
    assert!(argv.iter().any(|arg| arg == "--log-cool-offs"));
    assert!(!launcher.sandbox.path().join("logs/stale.log").exists());
}

#[test]
fn launcher_forwards_extra_arguments_last() {
    let launcher = Launcher::new("AOM_OR_API_KEY=test-key\n");
    let output = Command::new("bash")
        .arg(launcher.sandbox.path().join("astro_launcher.bash"))
        .arg("--batch")
        .arg("99")
        .current_dir(launcher.sandbox.path())
        .output()
        .unwrap();
    assert!(output.status.success());
    let argv = launcher.argv();
    assert!(has_pair(&argv, "--batch", "99"));
}

#[test]
fn launcher_gates_clean_and_deploy() {
    let launcher = Launcher::new(
        "AOM_OR_API_KEY=test-key\nAOM_CLEAN=1\nAOM_DEPLOY=1\nAOM_DEPLOY_DESTINATION=GoogleDrive:/dest\n",
    );
    let output = launcher.run();
    assert!(output.status.success());
    let argv = launcher.argv();
    assert!(argv.iter().any(|arg| arg == "--clean"));
    assert!(argv.iter().any(|arg| arg == "--deploy"));
    assert!(has_pair(&argv, "--deploy-destination", "GoogleDrive:/dest"));
}

#[test]
fn launcher_requires_api_key() {
    let launcher = Launcher::new("AOM_CLEAN=0\n");
    let output = launcher.run();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("AOM_OR_API_KEY"), "stderr: {stderr}");
    assert!(!launcher.dump.exists(), "shim must not run without a key");
}

#[test]
fn launcher_requires_destination_when_deploying() {
    let launcher = Launcher::new("AOM_OR_API_KEY=test-key\nAOM_DEPLOY=1\n");
    let output = launcher.run();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("AOM_DEPLOY_DESTINATION"),
        "stderr: {stderr}"
    );
}

#[test]
fn launcher_propagates_absolute_dir_flags() {
    let sandbox = Sandbox::new();
    let script_src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("astro_launcher.bash");
    std::fs::copy(&script_src, sandbox.path().join("astro_launcher.bash")).unwrap();
    let data = sandbox.sub("custom-data");
    let logs = sandbox.sub("logs");
    std::fs::write(
        sandbox.path().join(".env"),
        format!(
            "AOM_OR_API_KEY=test-key\nAOM_DATA_DIR={}\nAOM_LOG_DIR={}\n",
            data.display(),
            logs.display()
        ),
    )
    .unwrap();
    let profile = sandbox.sub("profile");
    std::fs::write(profile.join("search_terms.txt"), "engineer\n").unwrap();
    let env_path = sandbox.path().join(".env");
    let mut contents = std::fs::read_to_string(&env_path).unwrap();
    contents.push_str(&format!("AOM_PROFILE_DIR={}\n", profile.display()));
    std::fs::write(&env_path, contents).unwrap();

    let bin_dir = sandbox.path().join("target/release");
    std::fs::create_dir_all(&bin_dir).unwrap();
    let shim = bin_dir.join("astroom");
    let dump = sandbox.path().join("argv.txt");
    std::fs::write(
        &shim,
        format!(
            "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > '{}'\n",
            dump.display()
        ),
    )
    .unwrap();
    set_executable(&shim);

    let output = Command::new("bash")
        .arg(sandbox.path().join("astro_launcher.bash"))
        .current_dir(sandbox.path())
        .output()
        .unwrap();
    assert!(output.status.success());
    let argv: Vec<String> = std::fs::read_to_string(&dump)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect();
    assert!(has_pair(&argv, "--data-dir", data.to_str().unwrap()));
    assert!(has_pair(&argv, "--log-dir", logs.to_str().unwrap()));
    assert!(has_pair(&argv, "--profile-dir", profile.to_str().unwrap()));
    let search_terms = profile.join("search_terms.txt");
    assert!(has_pair(
        &argv,
        "--search-terms-file",
        search_terms.to_str().unwrap()
    ));
}

#[allow(dead_code)]
fn assert_script_exists(path: &Path) {
    assert!(path.exists());
}
