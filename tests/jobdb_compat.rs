//! On-disk SQLite compatibility: the Rust repository must open and operate on
//! a jobDB created by the real Node implementation.
//!
//! `tests/fixtures/node_jobdb.sqlite` is produced by
//! `tests/differential/generate_jobdb_fixture.js` using
//! `AstroEX-node`'s `JobRepository` (schema v3, WAL). The Node run reported:
//! `{"schemaVersion":"3","integrity":"ok"}` and
//! `{totalEntries:4, discoveryOnlyEntries:2, judgedEntries:2, capacity:250000}`.

mod common;

use common::*;
use std::path::PathBuf;

fn seed_node_database(sandbox: &Sandbox) -> PathBuf {
    let data = sandbox.sub("data");
    let fixture =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/node_jobdb.sqlite");
    std::fs::copy(&fixture, data.join("jobDB.sqlite")).expect("copy Node jobDB fixture");
    data
}

fn parse_stdout_json(output: &std::process::Output) -> serde_json::Value {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let start = stdout.find('{').expect("json output");
    serde_json::from_str(&stdout[start..]).expect("valid json")
}

#[test]
fn status_reads_node_created_repository() {
    let sandbox = Sandbox::new();
    let data = seed_node_database(&sandbox);
    let output = sandbox.run(&[
        "--no-banner",
        "jobdb",
        "status",
        "--data-dir",
        data.to_str().unwrap(),
    ]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json = parse_stdout_json(&output);
    assert_eq!(json["totalEntries"], serde_json::json!(4));
    assert_eq!(json["discoveryOnlyEntries"], serde_json::json!(2));
    assert_eq!(json["judgedEntries"], serde_json::json!(2));
    assert_eq!(json["capacity"], serde_json::json!(250000));
}

#[test]
fn verify_and_backup_operate_on_node_created_repository() {
    let sandbox = Sandbox::new();
    let data = seed_node_database(&sandbox);
    let verify = sandbox.run(&[
        "--no-banner",
        "jobdb",
        "verify",
        "--data-dir",
        data.to_str().unwrap(),
    ]);
    assert_eq!(
        verify.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&verify.stderr)
    );
    let json = parse_stdout_json(&verify);
    assert_eq!(json["schemaVersion"], serde_json::json!("3"));
    assert_eq!(json["integrity"], serde_json::json!("ok"));

    let backup = sandbox.run(&[
        "--no-banner",
        "jobdb",
        "backup",
        "--data-dir",
        data.to_str().unwrap(),
    ]);
    assert_eq!(
        backup.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&backup.stderr)
    );
    let backups: Vec<_> = std::fs::read_dir(&data)
        .expect("data dir")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.contains(".bak"))
        .collect();
    assert!(!backups.is_empty(), "backup file should exist: {backups:?}");
    // Node's `jobdb backup` prints the integrity report as machine JSON.
    let backup_json = parse_stdout_json(&backup);
    assert_eq!(backup_json["integrity"], serde_json::json!("ok"));
    assert_eq!(backup_json["schemaVersion"], serde_json::json!("3"));

    let rotate = sandbox.run(&[
        "--no-banner",
        "jobdb",
        "rotate-backups",
        "--keep",
        "1",
        "--data-dir",
        data.to_str().unwrap(),
    ]);
    assert_eq!(
        rotate.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&rotate.stderr)
    );
}
