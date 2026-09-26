use crate::constants::JOB_DB_RETENTION_MS;
use crate::error::Result;
use crate::jobrepo::{JobRepository, JobRepositoryConfig};
use crate::logging::console_output::write_machine_json;

pub fn run(action: &str, keep: usize, data_dir: &std::path::Path) -> Result<bool> {
    let mut repository = JobRepository::new(JobRepositoryConfig {
        db_file_path: data_dir.join("jobDB.sqlite"),
        legacy_json_path: None,
        default_expiration_ms: Some(JOB_DB_RETENTION_MS as i64),
        enable_job_db: true,
        max_records: None,
        now: None,
    });
    repository.initialize()?;
    let result = match action {
        "status" => {
            write_machine_json(&serde_json::to_value(repository.get_stats()?).unwrap());
            true
        }
        "verify" => {
            let health = repository.verify_integrity()?;
            let ok = health.integrity == "ok";
            write_machine_json(&serde_json::to_value(health).unwrap());
            ok
        }
        "backup" => {
            // Node creates the backup and then prints the integrity report
            // (the same payload as `verify`, without the exit-code gate).
            repository.create_backup()?;
            let health = repository.verify_integrity()?;
            write_machine_json(&serde_json::to_value(health).unwrap());
            true
        }
        "rotate-backups" => {
            let removed = repository.rotate_backups(keep)?;
            write_machine_json(&serde_json::json!({"removed": removed, "keep": keep}));
            true
        }
        _ => unreachable!("clap action validation"),
    };
    repository.close()?;
    Ok(result)
}
