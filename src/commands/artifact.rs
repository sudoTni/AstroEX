use crate::artifact_manifest::verify_artifact_manifest;
use crate::error::Result;
use crate::logging::console_output::write_machine_json;
use std::path::Path;

/// `artifact verify <file>` always emits machine JSON and uses exit code 1
/// when a manifest is absent, invalid, or does not match.
pub fn verify(file: &Path) -> Result<bool> {
    let result = verify_artifact_manifest(file)?;
    let ok = result
        .get("ok")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    write_machine_json(&result);
    Ok(ok)
}
