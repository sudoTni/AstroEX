//! Durable stage-checkpoint helpers.
//!
//! Unlike the Node singleton, the Rust port deliberately receives a repository
//! explicitly. This keeps database lifetime and RunContext ownership visible
//! to every pipeline stage while preserving the on-disk checkpoint contract.

use crate::artifact_manifest::{compute_file_hash, sha256_hex};
use crate::error::Result;
use crate::jobrepo::{JobRepository, StageCheckpointRecord};
use std::collections::HashSet;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct CheckpointMatch {
    pub has_matching_work: bool,
    pub is_completed: bool,
    pub input_hash: String,
    pub output_hash: Option<String>,
    pub processed_job_ids: HashSet<String>,
    pub checkpoint: Option<StageCheckpointRecord>,
}

pub fn compute_content_hash(content: impl AsRef<[u8]>) -> String {
    sha256_hex(content.as_ref())
}

/// Finds a matching checkpoint. A completed checkpoint is usable only while
/// its persisted output file still has the recorded SHA-256 hash.
pub fn check_stage_checkpoint(
    repository: &JobRepository,
    stage: &str,
    input_path: &Path,
    output_path: &Path,
    preset: &str,
    model: &str,
) -> Result<CheckpointMatch> {
    let input_hash = match compute_file_hash(input_path) {
        Ok(hash) => hash,
        Err(_) => {
            return Ok(CheckpointMatch {
                has_matching_work: false,
                is_completed: false,
                input_hash: String::new(),
                output_hash: None,
                processed_job_ids: HashSet::new(),
                checkpoint: None,
            });
        }
    };
    let checkpoint = repository.get_stage_checkpoint(stage, &input_hash, preset, model)?;
    let Some(record) = checkpoint else {
        return Ok(CheckpointMatch {
            has_matching_work: false,
            is_completed: false,
            input_hash,
            output_hash: None,
            processed_job_ids: HashSet::new(),
            checkpoint: None,
        });
    };
    let processed_job_ids = record.processed_job_ids.iter().cloned().collect();
    if record.status == "completed" {
        if let Some(expected_hash) = record.output_hash.as_deref() {
            // Node uses the stored output path when available; output_path is
            // retained for callers that created an older partial record.
            let candidate = if record.output_path.is_empty() {
                output_path
            } else {
                Path::new(&record.output_path)
            };
            if compute_file_hash(candidate).ok().as_deref() == Some(expected_hash) {
                return Ok(CheckpointMatch {
                    has_matching_work: true,
                    is_completed: true,
                    input_hash,
                    output_hash: Some(expected_hash.to_owned()),
                    processed_job_ids,
                    checkpoint: Some(record),
                });
            }
        }
    }
    Ok(CheckpointMatch {
        has_matching_work: !processed_job_ids.is_empty(),
        is_completed: false,
        input_hash,
        output_hash: None,
        processed_job_ids,
        checkpoint: Some(record),
    })
}

#[allow(clippy::too_many_arguments)] // mirrors the Node helper's public call shape
pub fn init_stage_checkpoint(
    repository: &JobRepository,
    stage: &str,
    input_path: &Path,
    input_hash: &str,
    output_path: &Path,
    preset: &str,
    model: &str,
    total_jobs: i64,
    processed_job_ids: Vec<String>,
    created_at: i64,
) -> Result<()> {
    repository.save_stage_checkpoint(&StageCheckpointRecord {
        stage: stage.to_owned(),
        input_path: input_path.to_string_lossy().into_owned(),
        input_hash: input_hash.to_owned(),
        output_path: output_path.to_string_lossy().into_owned(),
        output_hash: None,
        preset: preset.to_owned(),
        model: model.to_owned(),
        status: "in_progress".into(),
        completed_jobs: processed_job_ids.len() as i64,
        processed_job_ids,
        total_jobs,
        created_at,
        updated_at: created_at,
    })
}

/// Marks the checkpoint completed only when the output can be read and
/// hashed, matching the Node helper's intentionally silent no-op otherwise.
pub fn complete_stage_checkpoint(
    repository: &JobRepository,
    stage: &str,
    input_hash: &str,
    output_path: &Path,
    preset: &str,
    model: &str,
    completed_jobs: i64,
) -> Result<()> {
    if let Ok(output_hash) = compute_file_hash(output_path) {
        repository.complete_stage_checkpoint(
            stage,
            input_hash,
            preset,
            model,
            &output_hash,
            completed_jobs,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobrepo::{JobRepository, JobRepositoryConfig};
    use tempfile::tempdir;

    #[test]
    fn completed_checkpoint_requires_unchanged_output() {
        let directory = tempdir().unwrap();
        let input = directory.path().join("input.json");
        let output = directory.path().join("output.json");
        std::fs::write(&input, b"input").unwrap();
        std::fs::write(&output, b"output").unwrap();
        let mut repository = JobRepository::new(JobRepositoryConfig::enabled(
            directory.path().join("jobDB.sqlite"),
        ));
        repository.initialize().unwrap();
        let input_hash = compute_file_hash(&input).unwrap();
        init_stage_checkpoint(
            &repository,
            "jobCloth",
            &input,
            &input_hash,
            &output,
            "preset",
            "model",
            1,
            vec!["a".into()],
            1,
        )
        .unwrap();
        complete_stage_checkpoint(
            &repository,
            "jobCloth",
            &input_hash,
            &output,
            "preset",
            "model",
            1,
        )
        .unwrap();
        assert!(
            check_stage_checkpoint(&repository, "jobCloth", &input, &output, "preset", "model")
                .unwrap()
                .is_completed
        );
        std::fs::write(&output, b"changed").unwrap();
        let match_ =
            check_stage_checkpoint(&repository, "jobCloth", &input, &output, "preset", "model")
                .unwrap();
        assert!(!match_.is_completed);
        assert!(match_.has_matching_work);
    }
}
