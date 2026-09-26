//! LLM payload logging. Port of AstroEX-node src/logging/payloadLogs.ts.
//!
//! Persists the already-assembled JSON body of outbound LLM API requests and
//! merges the LLM's output back into those files after the call completes.

use crate::logging::log_kv;
use crate::types::LogLevel;
use serde_json::{json, Value};
use std::fs::OpenOptions;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Payload log subdirectories per LLM payload log stage (see
/// LLM_PAYLOAD_LOG_DIRECTORIES in payloadLogs.ts). Order matches the record.
pub const LLM_PAYLOAD_LOG_DIRECTORIES: [&str; 4] = [
    "jc_payload_logs",
    "re_payload_logs",
    "jj_payload_logs",
    "mm_payload_logs",
];

static PAYLOAD_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

fn stage_directory(stage: &str) -> Option<&'static str> {
    match stage {
        "jobCloth" => Some("jc_payload_logs"),
        "remoteEval" => Some("re_payload_logs"),
        "jobJudge" => Some("jj_payload_logs"),
        "makeMaterials" => Some("mm_payload_logs"),
        _ => None,
    }
}

fn stage_prefix(stage: &str) -> Option<&'static str> {
    match stage {
        "jobCloth" => Some("jc_payload"),
        "remoteEval" => Some("re_payload"),
        "jobJudge" => Some("jj_payload"),
        "makeMaterials" => Some("mm_payload"),
        _ => None,
    }
}

fn timestamp_for_file() -> String {
    chrono::Utc::now()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        .replace(&['-', ':', '.'][..], "")
}

fn warn_payload_failure(message: String, file_path: Option<&str>, error: Option<&str>) {
    let mut pairs: Vec<(&str, Value)> = Vec::new();
    if let Some(path) = file_path {
        pairs.push(("filePath", json!(path)));
    }
    if let Some(err) = error {
        pairs.push(("error", json!(err)));
    }
    log_kv("LLMService", &message, LogLevel::Warn, &pairs);
}

/// Persists the already-assembled JSON body for one outbound LLM API request.
/// Best-effort: on failure logs a warning and returns None.
pub fn write_llm_payload_log(log_directory: &Path, stage: &str, payload: &Value) -> Option<String> {
    let (directory_name, prefix) = match (stage_directory(stage), stage_prefix(stage)) {
        (Some(directory_name), Some(prefix)) => (directory_name, prefix),
        _ => {
            warn_payload_failure(
                format!("Unable to write LLM payload log for unknown stage {stage}"),
                None,
                None,
            );
            return None;
        }
    };
    let directory = log_directory.join(directory_name);
    let mut dir_builder = std::fs::DirBuilder::new();
    dir_builder.recursive(true);
    #[cfg(unix)]
    dir_builder.mode(0o700);
    if let Err(error) = dir_builder.create(&directory) {
        warn_payload_failure(
            format!(
                "Unable to create LLM payload log directory at {}",
                directory.display()
            ),
            None,
            Some(&error.to_string()),
        );
        return None;
    }

    let serialized_payload = match serde_json::to_string_pretty(payload) {
        Ok(serialized) => serialized,
        Err(error) => {
            warn_payload_failure(
                "LLM request payload is not JSON-serializable".to_string(),
                None,
                Some(&error.to_string()),
            );
            return None;
        }
    };

    let sequence = PAYLOAD_SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1;
    let file_name = format!(
        "{prefix}_{}_p{}_c{sequence:06}_{}.json",
        timestamp_for_file(),
        std::process::id(),
        uuid::Uuid::new_v4()
    );
    let file_path = directory.join(file_name);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let write_result = options
        .open(&file_path)
        .and_then(|mut file| file.write_all(serialized_payload.as_bytes()));
    match write_result {
        Ok(()) => Some(file_path.to_string_lossy().to_string()),
        Err(error) => {
            warn_payload_failure(
                format!("Unable to write LLM payload log at {}", file_path.display()),
                Some(&file_path.to_string_lossy()),
                Some(&error.to_string()),
            );
            None
        }
    }
}

/// Updates an existing outbound LLM payload log file to include the LLM's
/// reasoning and response output. Best-effort: on failure logs a warning.
pub fn update_llm_payload_log(stage: &str, file_path: &str, llm_output: &Value) {
    let _stage = stage;
    if let Err(error) = update_llm_payload_log_inner(file_path, llm_output) {
        warn_payload_failure(
            format!("Unable to update LLM payload log with output at {file_path}"),
            Some(file_path),
            Some(&error.to_string()),
        );
    }
}

fn update_llm_payload_log_inner(file_path: &str, llm_output: &Value) -> std::io::Result<()> {
    let existing_content = std::fs::read_to_string(file_path)?;
    let existing_data: Value = serde_json::from_str(&existing_content)?;
    let mut updated_data = match existing_data {
        Value::Object(map) => map,
        other => {
            let mut map = serde_json::Map::new();
            if !other.is_null() {
                // Mirrors JS object spread semantics for non-object roots.
                map.insert("value".to_string(), other);
            }
            map
        }
    };
    let merged_output = merge_llm_output(updated_data.get("llm_output"), llm_output);
    updated_data.insert("llm_output".to_string(), merged_output);

    let random_suffix: String = {
        let mut value: u64 = rand::random();
        if value == 0 {
            "0".to_string()
        } else {
            let mut digits = Vec::new();
            while value > 0 {
                digits.push(std::char::from_digit((value % 36) as u32, 36).unwrap());
                value /= 36;
            }
            digits.into_iter().collect()
        }
    };
    let temp_path = format!(
        "{file_path}.{}.{}.{}.tmp",
        std::process::id(),
        chrono::Utc::now().timestamp_millis(),
        random_suffix
    );
    {
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut temp_file = options.open(&temp_path)?;
        temp_file
            .write_all(serde_json::to_string_pretty(&Value::Object(updated_data))?.as_bytes())?;
    }
    std::fs::rename(&temp_path, file_path)?;
    Ok(())
}

/// Merges a new `llm_output` value into any previously recorded `llm_output`,
/// preserving prior reasoning/response values that the new output omits.
fn merge_llm_output(existing: Option<&Value>, output: &Value) -> Value {
    match (existing, output) {
        (Some(Value::Object(previous)), Value::Object(current)) => {
            let mut merged = current.clone();
            for key in ["reasoning", "response"] {
                if !merged.contains_key(key) {
                    let preserved = previous.get(key).cloned().unwrap_or(Value::Null);
                    merged.insert(key.to_string(), preserved);
                }
            }
            if !merged.contains_key("parsed_response") {
                if let Some(parsed) = previous.get("parsed_response") {
                    merged.insert("parsed_response".to_string(), parsed.clone());
                }
            }
            Value::Object(merged)
        }
        _ => output.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn payload_log_filename_shape_and_update_merge() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = write_llm_payload_log(
            temp.path(),
            "jobCloth",
            &json!({"model": "test-model", "messages": []}),
        )
        .expect("payload log write should succeed");

        let file_name = std::path::Path::new(&path)
            .file_name()
            .expect("file name")
            .to_string_lossy()
            .to_string();
        let pattern = regex::Regex::new(
            r"^jc_payload_\d{8}T\d{9}Z_p\d+_c\d{6}_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$",
        )
        .unwrap();
        assert!(
            pattern.is_match(&file_name),
            "unexpected payload log filename: {file_name}"
        );

        let recorded: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(recorded["model"], "test-model");
        assert!(recorded.get("llm_output").is_none());

        update_llm_payload_log(
            "jobCloth",
            &path,
            &json!({"reasoning": "thinking", "response": "hello"}),
        );
        let updated: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(updated["model"], "test-model");
        assert_eq!(updated["llm_output"]["reasoning"], "thinking");
        assert_eq!(updated["llm_output"]["response"], "hello");

        update_llm_payload_log("jobCloth", &path, &json!({"parsed_response": {"a": 1}}));
        let updated_again: Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(updated_again["llm_output"]["reasoning"], "thinking");
        assert_eq!(updated_again["llm_output"]["response"], "hello");
        assert_eq!(updated_again["llm_output"]["parsed_response"]["a"], 1);

        assert!(write_llm_payload_log(temp.path(), "unknown-stage", &json!({})).is_none());
    }
}
