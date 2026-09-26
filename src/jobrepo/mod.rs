//! SQLite-backed duplicate protection and durable stage checkpoints.

pub mod repository;
pub mod stage_checkpoint;

pub use repository::{
    create_indeed_identity, create_job_cloth_match_key, normalize_job_match_value,
    JobClothIdentity, JobIdentity, JobRecord, JobRepository, JobRepositoryConfig,
    JobRepositoryHealth, JobRepositoryStats, StageCheckpointRecord,
};
