//! Artifact manifest round-trip and `artifact verify` CLI contract.

mod common;

use astroom::artifact_manifest::{verify_artifact_manifest, write_artifact_manifest};
use common::*;
use serde_json::json;

#[test]
fn manifest_round_trip_and_tamper_detection() {
    let sandbox = Sandbox::new();
    let artifact = sandbox.path().join("sample.json");
    std::fs::write(&artifact, br#"{"hello":"world"}"#).unwrap();
    write_artifact_manifest(&artifact, "test", json!({"extra": 1})).unwrap();

    let manifest = artifact.with_extension("json.manifest.json");
    assert!(manifest.exists());
    assert_eq!(mode_of(&manifest), 0o600);

    let verified = verify_artifact_manifest(&artifact).unwrap();
    assert_eq!(verified["ok"], true);
    assert_eq!(verified["details"], "ok");

    std::fs::write(&artifact, br#"{"hello":"tampered"}"#).unwrap();
    let verified = verify_artifact_manifest(&artifact).unwrap();
    assert_eq!(verified["ok"], false);
    assert_eq!(verified["details"], "artifact hash mismatch");
}

#[test]
fn missing_manifest_is_an_error() {
    let sandbox = Sandbox::new();
    let artifact = sandbox.path().join("unmanifested.json");
    std::fs::write(&artifact, b"{}").unwrap();
    assert!(verify_artifact_manifest(&artifact).is_err());
}

#[test]
fn artifact_verify_cli_exit_codes_and_machine_json() {
    let sandbox = Sandbox::new();
    let artifact = sandbox.path().join("sample.json");
    std::fs::write(&artifact, br#"{"hello":"world"}"#).unwrap();
    write_artifact_manifest(&artifact, "test", json!({})).unwrap();

    let logs = sandbox.sub("logs");
    let data = sandbox.sub("data");
    let ok = sandbox.run(&[
        "--no-banner",
        "--log-dir",
        logs.to_str().unwrap(),
        "--data-dir",
        data.to_str().unwrap(),
        "artifact",
        "verify",
        artifact.to_str().unwrap(),
    ]);
    assert_eq!(ok.status.code(), Some(0));
    let parsed: serde_json::Value =
        serde_json::from_slice(&ok.stdout).expect("machine json on stdout");
    assert_eq!(parsed["ok"], true);

    std::fs::write(&artifact, b"tampered").unwrap();
    let bad = sandbox.run(&[
        "--no-banner",
        "--log-dir",
        logs.to_str().unwrap(),
        "--data-dir",
        data.to_str().unwrap(),
        "artifact",
        "verify",
        artifact.to_str().unwrap(),
    ]);
    assert_eq!(bad.status.code(), Some(1));
    let parsed: serde_json::Value =
        serde_json::from_slice(&bad.stdout).expect("machine json on stdout");
    assert_eq!(parsed["ok"], false);
}
