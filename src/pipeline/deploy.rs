//! Stage 8: stage flattened material files, invoke rclone, then archive them.

use crate::context::RunContext;
use crate::error::{AppError, Result};
use crate::logging::console_output::write_external_command_output;
use crate::types::LogLevel;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct DeployResult {
    pub deployed: usize,
    pub destination: String,
}
fn collect(dir: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    match std::fs::read_dir(dir) {
        Ok(entries) => {
            for entry in entries {
                let path = entry?.path();
                if path.is_dir() {
                    collect(&path, files)?;
                } else if path.extension().is_some_and(|e| e == "txt")
                    && !path.to_string_lossy().ends_with(".manifest.json")
                {
                    files.push(path);
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}
fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let dst = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &dst)?
        } else {
            std::fs::copy(entry.path(), dst)?;
        }
    }
    Ok(())
}
pub async fn deploy(
    ctx: &RunContext,
    materials: &Path,
    archive: &Path,
    destination: &str,
) -> Result<DeployResult> {
    crate::pipeline::cancellation::throw_if_cancelled(&ctx.cancellation)?;
    std::fs::create_dir_all(archive)?;
    let mut files = Vec::new();
    collect(materials, &mut files)?;
    if !files.is_empty() {
        let staging = std::env::temp_dir().join(format!(
            "astroom-deploy-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&staging)?;
        let outcome = async {
            let mut names = HashSet::new();
            for source in &files {
                let base = source.file_name().unwrap().to_string_lossy().to_string();
                let mut target = base.clone();
                let (stem, ext) = match base.rsplit_once('.') {
                    Some((s, e)) => (s, format!(".{e}")),
                    None => (base.as_str(), String::new()),
                };
                let mut n = 1;
                while names.contains(&target) {
                    target = format!("{stem}_{n}{ext}");
                    n += 1;
                }
                names.insert(target.clone());
                std::fs::copy(source, staging.join(target))?;
            }
            let child = tokio::process::Command::new("rclone")
                .args(["-v", "--fast-list", "copy"])
                .arg(&staging)
                .arg(destination)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .map_err(|e| AppError::message(format!("Failed to execute rclone: {e}")))?;
            let output = tokio::select! {
                result = child.wait_with_output() => result
                    .map_err(|e| AppError::message(format!("Failed to execute rclone: {e}")))?,
                _ = ctx.cancellation.cancelled() => {
                    // Dropping the child (kill_on_drop) terminates rclone, then
                    // surface the cancellation cause like Node's AbortSignal.
                    crate::pipeline::cancellation::throw_if_cancelled(&ctx.cancellation)?;
                    return Err(AppError::new("CANCELLED", 130, "Deployment cancelled"));
                }
            };
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            write_external_command_output(Some(&stdout), Some(&stderr));
            if !output.status.success() {
                return Err(AppError::message(format!(
                    "rclone exited with {}",
                    output.status
                )));
            }
            Ok::<(), AppError>(())
        }
        .await;
        let _ = std::fs::remove_dir_all(&staging);
        outcome?;
    } else {
        crate::logging::log(
            "Deployment",
            "No material text files found in materials directory to deploy.",
            LogLevel::Warn,
        );
    }
    for entry in std::fs::read_dir(materials)? {
        let entry = entry?;
        let target = archive.join(entry.file_name());
        if std::fs::rename(entry.path(), &target).is_err() {
            if entry.path().is_dir() {
                copy_dir(&entry.path(), &target)?
            } else {
                std::fs::copy(entry.path(), &target)?;
            }
            std::fs::remove_dir_all(entry.path())
                .or_else(|_| std::fs::remove_file(entry.path()))?;
        }
    }
    crate::logging::flush_execution_log();
    Ok(DeployResult {
        deployed: files.len(),
        destination: destination.into(),
    })
}
