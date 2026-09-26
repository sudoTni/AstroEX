//! Artifact manifest sidecars. Ported from AstroEX-node src/artifactManifest.ts.

use crate::error::{AppError, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

pub const ARTIFACT_MANIFEST_SCHEMA_VERSION: u32 = 1;

pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

pub fn compute_file_hash(path: &Path) -> Result<String> {
    let data = std::fs::read(path)
        .map_err(|err| AppError::message(format!("Failed to read {}: {}", path.display(), err)))?;
    Ok(sha256_hex(&data))
}

pub fn compute_content_hash(content: &str) -> String {
    sha256_hex(content.as_bytes())
}

/// Writes `<artifactPath>.manifest.json` atomically (mode 0600).
pub fn write_artifact_manifest(artifact_path: &Path, command: &str, metadata: Value) -> Result<()> {
    let artifact_data = std::fs::read(artifact_path).map_err(|err| {
        AppError::message(format!(
            "Failed to read artifact {}: {}",
            artifact_path.display(),
            err
        ))
    })?;
    let manifest_path = artifact_path.with_extension(
        // <name>.json -> <name>.json.manifest.json ; other extensions similarly
        match artifact_path.extension().and_then(|e| e.to_str()) {
            Some(ext) => format!("{ext}.manifest.json"),
            None => "manifest.json".to_string(),
        },
    );
    let mut manifest = json!({
        "schemaVersion": ARTIFACT_MANIFEST_SCHEMA_VERSION,
        "command": command,
        "createdAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "artifact": artifact_path.file_name().and_then(|n| n.to_str()).unwrap_or_default(),
        "sha256": sha256_hex(&artifact_data),
    });
    if let (Some(dst), Some(src)) = (manifest.as_object_mut(), metadata.as_object()) {
        for (k, v) in src {
            if k != "schemaVersion"
                && k != "command"
                && k != "createdAt"
                && k != "artifact"
                && k != "sha256"
            {
                dst.insert(k.clone(), v.clone());
            }
        }
    }
    let body = serde_json::to_string_pretty(&manifest)?;
    // The temporary file must live beside the manifest: cross-device rename
    // fails for redirected data directories, and this preserves atomic replace.
    let tmp = manifest_path.with_file_name(format!(
        "{}.{}.{}.tmp",
        manifest_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("manifest"),
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    write_private_file(&tmp, body.as_bytes())?;
    std::fs::rename(&tmp, &manifest_path).map_err(|err| {
        let _ = std::fs::remove_file(&tmp);
        AppError::message(format!("Failed to rename manifest: {err}"))
    })?;
    Ok(())
}

/// Verifies an artifact against its companion manifest. Returns a machine-JSON
/// serializable result `{ok, details}` (artifact verify command). A missing or
/// unparseable manifest is an error (Node's `JSON.parse`/`readFile` throw).
pub fn verify_artifact_manifest(artifact_path: &Path) -> Result<Value> {
    let manifest_path =
        artifact_path.with_extension(match artifact_path.extension().and_then(|e| e.to_str()) {
            Some(ext) => format!("{ext}.manifest.json"),
            None => "manifest.json".to_string(),
        });
    let raw = std::fs::read(&manifest_path).map_err(|err| {
        AppError::message(format!(
            "Failed to read manifest {}: {}",
            manifest_path.display(),
            err
        ))
    })?;
    let manifest: Value = serde_json::from_slice(&raw).map_err(|err| {
        AppError::message(format!(
            "Failed to parse manifest {}: {}",
            manifest_path.display(),
            err
        ))
    })?;
    let artifact_name = artifact_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let schema_ok = manifest.get("schemaVersion").and_then(|v| v.as_u64()) == Some(1);
    let name_ok = manifest.get("artifact").and_then(|v| v.as_str()) == Some(artifact_name);
    let hash_ok = manifest.get("sha256").and_then(|v| v.as_str()).is_some();
    if !schema_ok || !name_ok || !hash_ok {
        return Ok(json!({
            "ok": false,
            "details": "invalid manifest schema or artifact name",
        }));
    }
    let expected = manifest
        .get("sha256")
        .and_then(|v| v.as_str())
        .expect("hash checked above");
    let data = std::fs::read(artifact_path).map_err(|err| {
        AppError::message(format!(
            "Failed to read artifact {}: {}",
            artifact_path.display(),
            err
        ))
    })?;
    let actual = sha256_hex(&data);
    if actual == expected {
        Ok(json!({ "ok": true, "details": "ok" }))
    } else {
        Ok(json!({ "ok": false, "details": "artifact hash mismatch" }))
    }
}

/// Writes a file with mode 0600 (owner-only on Unix), creating or truncating.
pub fn write_private_file(path: &Path, contents: &[u8]) -> Result<()> {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(path)
        .map_err(|err| AppError::message(format!("Failed to create {}: {err}", path.display())))?;
    file.write_all(contents)
        .map_err(|err| AppError::message(format!("Failed to write {}: {err}", path.display())))?;
    Ok(())
}

/// Atomic write via temp file + rename, mode 0600.
/// Temp name: `<file>.<pid>.<ts>.tmp` (same shape as Node).
pub fn write_json_atomic_private(path: &Path, value: &Value) -> Result<()> {
    let body = serde_json::to_string_pretty(value)?;
    let tmp = path.with_file_name(format!(
        "{}.{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    write_private_file(&tmp, body.as_bytes())?;
    if let Err(err) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::message(format!(
            "Failed to replace {}: {err}",
            path.display()
        )));
    }
    Ok(())
}
