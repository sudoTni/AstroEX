//! SQLite repository compatible with AstroEX's `jobDB.sqlite` schema v3.
//!
//! The repository deliberately owns a single synchronous SQLite connection.
//! Callers that share it between async stages should put it behind a mutex;
//! SQLite work is short and all state transitions use `BEGIN IMMEDIATE`, just
//! like the Node implementation.

use crate::constants::{
    DEFAULT_MAX_RECORDS, JOB_COMPANY_MAX_LENGTH, JOB_DB_RETENTION_MS, JOB_TITLE_MAX_LENGTH,
};
use crate::error::{AppError, Result};
use reqwest::Url;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const SCHEMA_VERSION: &str = "3";
const LATEST_JOB_CHECKPOINT_SQL: &str = "MAX(admit_time, COALESCE(description_scraped_at, admit_time), COALESCE(last_processed, admit_time))";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobRecord {
    pub id: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_job_id: Option<String>,
    pub company: String,
    pub title: String,
    pub admit_time: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description_scraped_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_processed: Option<i64>,
    /// Node omits this property for completed entries rather than serializing false.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_only: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobIdentity {
    pub id: Option<String>,
    pub source: Option<String>,
    pub source_job_id: Option<String>,
    pub title: String,
    pub company: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobClothIdentity {
    pub title: String,
    pub company: String,
}

#[derive(Debug, Clone)]
pub struct JobRepositoryConfig {
    pub db_file_path: PathBuf,
    pub legacy_json_path: Option<PathBuf>,
    pub default_expiration_ms: Option<i64>,
    pub enable_job_db: bool,
    pub max_records: Option<i64>,
    /// Deterministic clock for tests. Production callers should leave it absent.
    pub now: Option<fn() -> i64>,
}

impl JobRepositoryConfig {
    pub fn enabled(db_file_path: impl Into<PathBuf>) -> Self {
        Self {
            db_file_path: db_file_path.into(),
            legacy_json_path: None,
            default_expiration_ms: None,
            enable_job_db: true,
            max_records: None,
            now: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRepositoryStats {
    pub total_entries: i64,
    pub discovery_only_entries: i64,
    pub description_checkpoint_entries: i64,
    pub judged_entries: i64,
    pub capacity: i64,
    pub expired_entries: i64,
    pub time_to_next_expiration: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobRepositoryHealth {
    #[serde(rename = "schemaVersion")]
    pub schema_version: String,
    pub integrity: String,
    pub details: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageCheckpointRecord {
    pub stage: String,
    pub input_path: String,
    pub input_hash: String,
    pub output_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_hash: Option<String>,
    pub preset: String,
    pub model: String,
    pub status: String,
    pub processed_job_ids: Vec<String>,
    pub completed_jobs: i64,
    pub total_jobs: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct JobRepository {
    config: JobRepositoryConfig,
    default_expiration_ms: i64,
    max_records: i64,
    database: Option<Connection>,
    initialized: bool,
}

pub fn normalize_job_match_value(value: &str) -> String {
    value
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn create_job_cloth_match_key(job: &JobClothIdentity) -> Option<String> {
    let title = normalize_job_match_value(&job.title);
    let company = normalize_job_match_value(&job.company);
    (!title.is_empty() && !company.is_empty()).then(|| format!("{title}\0{company}"))
}

/// Stable opaque fallback used by callers that need an ID for an Indeed URL.
pub fn create_indeed_identity(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())[..16].to_owned()
}

impl JobRepository {
    pub fn new(config: JobRepositoryConfig) -> Self {
        let default_expiration_ms = config
            .default_expiration_ms
            .unwrap_or(JOB_DB_RETENTION_MS as i64);
        let max_records = config.max_records.unwrap_or(DEFAULT_MAX_RECORDS);
        Self {
            config,
            default_expiration_ms,
            max_records,
            database: None,
            initialized: false,
        }
    }

    fn now(&self) -> i64 {
        self.config.now.map(|clock| clock()).unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
        })
    }

    pub fn initialize(&mut self) -> Result<()> {
        if !self.config.enable_job_db || self.initialized {
            return Ok(());
        }
        let parent = self
            .config
            .db_file_path
            .parent()
            .unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)?;
        let connection = Connection::open(&self.config.db_file_path)?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;
             CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;",
        )?;
        let current_version: Option<String> = connection
            .query_row(
                "SELECT value FROM metadata WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .optional()?;

        if current_version.as_deref() == Some("1") {
            connection.execute_batch("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;")?;
            let migration = connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS jobs_v2 (
                    identity_key TEXT PRIMARY KEY,
                    source TEXT NOT NULL CHECK(source IN ('indeed', 'linkedin')),
                    source_job_id TEXT, company TEXT NOT NULL, title TEXT NOT NULL,
                    admit_time INTEGER NOT NULL, description_scraped_at INTEGER,
                    last_processed INTEGER, search_only INTEGER NOT NULL DEFAULT 1 CHECK(search_only IN (0, 1))
                 ) STRICT;
                 INSERT INTO jobs_v2 SELECT * FROM jobs;
                 DROP TABLE jobs; ALTER TABLE jobs_v2 RENAME TO jobs;
                 CREATE UNIQUE INDEX IF NOT EXISTS jobs_source_id ON jobs(source, source_job_id) WHERE source_job_id IS NOT NULL;
                 CREATE INDEX IF NOT EXISTS jobs_expiry ON jobs(admit_time);
                 CREATE INDEX IF NOT EXISTS jobs_discovery_eviction ON jobs(search_only, description_scraped_at, admit_time);
                 CREATE INDEX IF NOT EXISTS jobs_judged ON jobs(last_processed); COMMIT;"
            );
            if let Err(error) = migration {
                let _ = connection.execute_batch("ROLLBACK;");
                let _ = connection.execute_batch("PRAGMA foreign_keys = ON;");
                return Err(error.into());
            }
            connection.execute_batch("PRAGMA foreign_keys = ON;")?;
        }

        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS jobs (
                identity_key TEXT PRIMARY KEY,
                source TEXT NOT NULL CHECK(source IN ('indeed', 'linkedin')),
                source_job_id TEXT, company TEXT NOT NULL, title TEXT NOT NULL,
                admit_time INTEGER NOT NULL, description_scraped_at INTEGER,
                last_processed INTEGER, search_only INTEGER NOT NULL DEFAULT 1 CHECK(search_only IN (0, 1))
             ) STRICT;
             CREATE UNIQUE INDEX IF NOT EXISTS jobs_source_id ON jobs(source, source_job_id) WHERE source_job_id IS NOT NULL;
             CREATE INDEX IF NOT EXISTS jobs_expiry ON jobs(admit_time);
             CREATE INDEX IF NOT EXISTS jobs_discovery_eviction ON jobs(search_only, description_scraped_at, admit_time);
             CREATE INDEX IF NOT EXISTS jobs_judged ON jobs(last_processed);
             CREATE TABLE IF NOT EXISTS stage_checkpoints (
                stage TEXT NOT NULL, input_path TEXT NOT NULL, input_hash TEXT NOT NULL,
                output_path TEXT NOT NULL, output_hash TEXT, preset TEXT NOT NULL, model TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('in_progress', 'completed', 'failed')),
                processed_job_ids TEXT NOT NULL, completed_jobs INTEGER NOT NULL DEFAULT 0,
                total_jobs INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                PRIMARY KEY (stage, input_hash, preset, model)
             ) STRICT;
             CREATE INDEX IF NOT EXISTS stage_checkpoints_lookup ON stage_checkpoints(stage, input_hash, preset, model);
             CREATE TABLE IF NOT EXISTS job_cloth_history (
                normalized_title TEXT NOT NULL, normalized_company TEXT NOT NULL,
                title TEXT NOT NULL, company TEXT NOT NULL, last_processed_at INTEGER NOT NULL,
                PRIMARY KEY (normalized_title, normalized_company)
             ) STRICT;
             CREATE INDEX IF NOT EXISTS job_cloth_history_processed_at ON job_cloth_history(last_processed_at);",
        )?;
        self.database = Some(connection);
        self.initialized = true;
        self.import_legacy_json_once()?;
        if current_version.as_deref() != Some(SCHEMA_VERSION) {
            self.backfill_job_cloth_history()?;
        }
        self.db()?.execute(
            "INSERT INTO metadata(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [SCHEMA_VERSION],
        )?;
        Ok(())
    }

    pub fn load(&self) -> Result<()> {
        if self.config.enable_job_db {
            self.db()?;
        }
        Ok(())
    }

    pub fn close(&mut self) -> Result<()> {
        if let Some(connection) = self.database.take() {
            let checkpoint = connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
            self.initialized = false;
            checkpoint?;
        }
        Ok(())
    }

    pub fn cleanup_expired(&self) -> Result<usize> {
        if !self.config.enable_job_db {
            return Ok(0);
        }
        Ok(self.db()?.execute(
            &format!("DELETE FROM jobs WHERE {LATEST_JOB_CHECKPOINT_SQL} <= ?"),
            [self.now() - self.default_expiration_ms],
        )?)
    }

    pub fn is_job_seen(&self, job: &JobIdentity) -> Result<bool> {
        Ok(self.find_active(job)?.is_some())
    }
    pub fn is_job_description_scraped(&self, job: &JobIdentity) -> Result<bool> {
        Ok(self.find_active(job)?.is_some_and(|entry| {
            entry.description_scraped_at.is_some() || entry.search_only != Some(true)
        }))
    }
    pub fn is_job_matched(&self, job: &JobIdentity) -> Result<bool> {
        Ok(self
            .find_entry(job)?
            .and_then(|entry| entry.last_processed)
            .is_some_and(|time| self.now() - time < self.default_expiration_ms))
    }

    pub fn record_job_cloth_processed(
        &mut self,
        jobs: &[JobClothIdentity],
        processed_at: Option<i64>,
    ) -> Result<usize> {
        if !self.config.enable_job_db {
            return Ok(0);
        }
        let processed_at = processed_at.unwrap_or_else(|| self.now());
        if processed_at < 0 {
            return Err(AppError::message(
                "jobCloth processing timestamp must be a non-negative integer",
            ));
        }
        let unique: BTreeMap<String, &JobClothIdentity> = jobs
            .iter()
            .filter_map(|job| create_job_cloth_match_key(job).map(|key| (key, job)))
            .collect();
        if unique.is_empty() {
            return Ok(0);
        }
        self.db()?.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<()> {
            let mut statement = self.db()?.prepare(
                "INSERT INTO job_cloth_history (normalized_title, normalized_company, title, company, last_processed_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(normalized_title, normalized_company) DO UPDATE SET
                   title = CASE WHEN excluded.last_processed_at >= job_cloth_history.last_processed_at THEN excluded.title ELSE job_cloth_history.title END,
                   company = CASE WHEN excluded.last_processed_at >= job_cloth_history.last_processed_at THEN excluded.company ELSE job_cloth_history.company END,
                   last_processed_at = MAX(job_cloth_history.last_processed_at, excluded.last_processed_at)",
            )?;
            for (key, job) in &unique {
                let (title, company) = key.split_once('\0').expect("match key separator");
                statement.execute(params![
                    title,
                    company,
                    job.title,
                    job.company,
                    processed_at
                ])?;
            }
            Ok(())
        })();
        self.finish_transaction(result)?;
        Ok(unique.len())
    }

    pub fn get_recent_job_cloth_processing_keys(
        &self,
        jobs: &[JobClothIdentity],
        cool_off_ms: i64,
    ) -> Result<HashSet<String>> {
        if !self.config.enable_job_db {
            return Ok(HashSet::new());
        }
        if cool_off_ms <= 0 {
            return Err(AppError::message(
                "jobCloth cool-off duration must be a positive integer",
            ));
        }
        let unique: HashSet<String> = jobs.iter().filter_map(create_job_cloth_match_key).collect();
        let threshold = self.now() - cool_off_ms;
        let mut statement = self.db()?.prepare("SELECT 1 FROM job_cloth_history WHERE normalized_title = ? AND normalized_company = ? AND last_processed_at > ?")?;
        let mut recent = HashSet::new();
        for key in unique {
            let (title, company) = key.split_once('\0').expect("match key separator");
            if statement.exists(params![title, company, threshold])? {
                recent.insert(key);
            }
        }
        Ok(recent)
    }

    pub fn add_searched_jobs(&mut self, jobs: &[JobIdentity]) -> Result<usize> {
        if !self.config.enable_job_db {
            return Ok(0);
        }
        let unique: HashMap<String, &JobIdentity> = jobs
            .iter()
            .filter(|job| self.is_valid_job(job))
            .map(|job| (self.identity_key(job), job))
            .collect();
        self.db()?.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<usize> {
            let mut added = 0;
            for job in unique.values() {
                if self.find_active(job)?.is_some() {
                    continue;
                }
                if let Err(error) = self.ensure_capacity(1) {
                    if error.message.starts_with("Database size limit (") {
                        break;
                    }
                    return Err(error);
                }
                self.insert_discovery(job)?;
                added += 1;
            }
            Ok(added)
        })();
        let added = self.finish_transaction(result)?;
        Ok(added)
    }

    pub fn mark_job_description_scraped(&mut self, job: &JobIdentity) -> Result<()> {
        if !self.config.enable_job_db {
            return Ok(());
        }
        self.assert_valid_job(job)?;
        let now = self.now();
        self.db()?.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<()> {
            if let Some(current) = self.find_entry(job)? {
                let expired = now - current.admit_time >= self.default_expiration_ms;
                self.db()?.execute("UPDATE jobs SET company = ?, title = ?, admit_time = ?, description_scraped_at = ?, last_processed = ?, search_only = ? WHERE identity_key = ?",
                    params![job.company, job.title, if expired { now } else { current.admit_time }, now, current.last_processed, if current.last_processed.is_some() { 0 } else { 1 }, self.identity_key(job)])?;
            } else {
                self.ensure_capacity(1)?;
                self.insert(job, now, Some(now), None, true)?;
            }
            Ok(())
        })();
        self.finish_transaction(result)
    }

    pub fn add_job(&mut self, job: &JobIdentity) -> Result<()> {
        if !self.config.enable_job_db {
            return Ok(());
        }
        self.assert_valid_job(job)?;
        let now = self.now();
        self.db()?.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<()> {
            if let Some(current) = self.find_entry(job)? {
                let expired = now - current.admit_time >= self.default_expiration_ms;
                self.db()?.execute("UPDATE jobs SET company = ?, title = ?, admit_time = ?, description_scraped_at = ?, last_processed = ?, search_only = 0 WHERE identity_key = ?",
                    params![job.company, job.title, if expired { now } else { current.admit_time }, if expired { None } else { current.description_scraped_at }, now, self.identity_key(job)])?;
            } else {
                self.ensure_capacity(1)?;
                self.insert(job, now, None, Some(now), false)?;
            }
            Ok(())
        })();
        self.finish_transaction(result)
    }

    pub fn size(&self) -> Result<i64> {
        if !self.config.enable_job_db {
            return Ok(0);
        }
        Ok(self
            .db()?
            .query_row("SELECT COUNT(*) FROM jobs", [], |row| row.get(0))?)
    }

    pub fn get_all_entries(&self) -> Result<Vec<JobRecord>> {
        self.entries_query("SELECT identity_key, source, source_job_id, company, title, admit_time, description_scraped_at, last_processed, search_only FROM jobs ORDER BY admit_time ASC", [])
    }
    pub fn get_entries_paginated(&self, page: i64, page_size: i64) -> Result<Vec<JobRecord>> {
        if page < 0 {
            return Err(AppError::message("page must be non-negative"));
        }
        if page_size <= 0 {
            return Err(AppError::message("pageSize must be positive"));
        }
        self.entries_query("SELECT identity_key, source, source_job_id, company, title, admit_time, description_scraped_at, last_processed, search_only FROM jobs ORDER BY admit_time ASC LIMIT ? OFFSET ?", params![page_size, page * page_size])
    }

    pub fn get_stats(&self) -> Result<JobRepositoryStats> {
        if !self.config.enable_job_db {
            return Ok(JobRepositoryStats {
                total_entries: 0,
                discovery_only_entries: 0,
                description_checkpoint_entries: 0,
                judged_entries: 0,
                capacity: self.max_records,
                expired_entries: 0,
                time_to_next_expiration: 0,
            });
        }
        let now = self.now();
        let threshold = now - self.default_expiration_ms;
        let sql = format!("SELECT COUNT(*) AS total, SUM(CASE WHEN search_only = 1 AND description_scraped_at IS NULL THEN 1 ELSE 0 END), SUM(CASE WHEN search_only = 1 AND description_scraped_at IS NOT NULL THEN 1 ELSE 0 END), SUM(CASE WHEN {LATEST_JOB_CHECKPOINT_SQL} <= ? THEN 1 ELSE 0 END), MIN(CASE WHEN {LATEST_JOB_CHECKPOINT_SQL} > ? THEN {LATEST_JOB_CHECKPOINT_SQL} + ? ELSE NULL END) FROM jobs");
        let (total, discovery, described, expired, next): (
            i64,
            Option<i64>,
            Option<i64>,
            Option<i64>,
            Option<i64>,
        ) = self.db()?.query_row(
            &sql,
            params![threshold, threshold, self.default_expiration_ms],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?;
        let discovery = discovery.unwrap_or(0);
        let described = described.unwrap_or(0);
        Ok(JobRepositoryStats {
            total_entries: total,
            discovery_only_entries: discovery,
            description_checkpoint_entries: described,
            judged_entries: total - discovery - described,
            capacity: self.max_records,
            expired_entries: expired.unwrap_or(0),
            time_to_next_expiration: next.map_or(0, |value| (value - now).max(0)),
        })
    }

    pub fn create_backup(&self) -> Result<PathBuf> {
        if !self.config.enable_job_db {
            return Ok(self.config.db_file_path.clone());
        }
        self.db()?.execute_batch("PRAGMA wal_checkpoint(FULL)")?;
        let backup_path = PathBuf::from(format!(
            "{}.{}.bak",
            self.config.db_file_path.display(),
            self.now()
        ));
        fs::copy(&self.config.db_file_path, &backup_path)?;
        Ok(backup_path)
    }

    pub fn rotate_backups(&self, keep: usize) -> Result<usize> {
        if keep == 0 {
            return Err(AppError::message(
                "Backup retention count must be a positive integer",
            ));
        }
        let parent = self
            .config
            .db_file_path
            .parent()
            .unwrap_or_else(|| Path::new("."));
        let prefix = format!(
            "{}.",
            self.config
                .db_file_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("jobDB.sqlite")
        );
        let mut backups: Vec<PathBuf> = fs::read_dir(parent)?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".bak"))
            })
            .collect();
        backups.sort();
        backups.reverse();
        let obsolete = backups.into_iter().skip(keep).collect::<Vec<_>>();
        for backup in &obsolete {
            fs::remove_file(backup)?;
        }
        Ok(obsolete.len())
    }

    pub fn get_stage_checkpoint(
        &self,
        stage: &str,
        input_hash: &str,
        preset: &str,
        model: &str,
    ) -> Result<Option<StageCheckpointRecord>> {
        if !self.config.enable_job_db {
            return Ok(None);
        }
        self.db()?.query_row("SELECT stage, input_path, input_hash, output_path, output_hash, preset, model, status, processed_job_ids, completed_jobs, total_jobs, created_at, updated_at FROM stage_checkpoints WHERE stage = ? AND input_hash = ? AND preset = ? AND model = ?", params![stage, input_hash, preset, model], |row| {
            let ids: String = row.get(8)?;
            Ok(StageCheckpointRecord { stage: row.get(0)?, input_path: row.get(1)?, input_hash: row.get(2)?, output_path: row.get(3)?, output_hash: row.get(4)?, preset: row.get(5)?, model: row.get(6)?, status: row.get(7)?, processed_job_ids: serde_json::from_str(&ids).unwrap_or_default(), completed_jobs: row.get(9)?, total_jobs: row.get(10)?, created_at: row.get(11)?, updated_at: row.get(12)? })
        }).optional().map_err(Into::into)
    }

    pub fn save_stage_checkpoint(&self, record: &StageCheckpointRecord) -> Result<()> {
        if !self.config.enable_job_db {
            return Ok(());
        }
        let now = self.now();
        self.db()?.execute("INSERT INTO stage_checkpoints (stage, input_path, input_hash, output_path, output_hash, preset, model, status, processed_job_ids, completed_jobs, total_jobs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(stage, input_hash, preset, model) DO UPDATE SET output_path = excluded.output_path, output_hash = excluded.output_hash, status = excluded.status, processed_job_ids = excluded.processed_job_ids, completed_jobs = excluded.completed_jobs, total_jobs = excluded.total_jobs, updated_at = excluded.updated_at", params![record.stage, record.input_path, record.input_hash, record.output_path, record.output_hash, record.preset, record.model, record.status, serde_json::to_string(&record.processed_job_ids)?, record.completed_jobs, record.total_jobs, if record.created_at == 0 { now } else { record.created_at }, now])?;
        Ok(())
    }

    pub fn record_job_in_checkpoint(
        &self,
        stage: &str,
        input_hash: &str,
        preset: &str,
        model: &str,
        job_id: &str,
    ) -> Result<()> {
        let Some(mut existing) = self.get_stage_checkpoint(stage, input_hash, preset, model)?
        else {
            return Ok(());
        };
        if !existing.processed_job_ids.iter().any(|id| id == job_id) {
            existing.processed_job_ids.push(job_id.to_owned());
        }
        existing.completed_jobs = existing.processed_job_ids.len() as i64;
        self.save_stage_checkpoint(&existing)
    }

    pub fn complete_stage_checkpoint(
        &self,
        stage: &str,
        input_hash: &str,
        preset: &str,
        model: &str,
        output_hash: &str,
        completed_jobs: i64,
    ) -> Result<()> {
        let Some(mut existing) = self.get_stage_checkpoint(stage, input_hash, preset, model)?
        else {
            return Ok(());
        };
        existing.status = "completed".into();
        existing.output_hash = Some(output_hash.to_owned());
        existing.completed_jobs = completed_jobs;
        self.save_stage_checkpoint(&existing)
    }

    pub fn verify_integrity(&self) -> Result<JobRepositoryHealth> {
        if !self.config.enable_job_db {
            return Ok(JobRepositoryHealth {
                schema_version: SCHEMA_VERSION.into(),
                integrity: "ok".into(),
                details: "repository disabled".into(),
            });
        }
        let version: Option<String> = self
            .db()?
            .query_row(
                "SELECT value FROM metadata WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let details: String = self
            .db()?
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        let integrity = if details.eq_ignore_ascii_case("ok") {
            "ok"
        } else {
            "failed"
        };
        Ok(JobRepositoryHealth {
            schema_version: version.unwrap_or_else(|| "unknown".into()),
            integrity: integrity.into(),
            details,
        })
    }

    fn db(&self) -> Result<&Connection> {
        self.database
            .as_ref()
            .filter(|_| self.initialized)
            .ok_or_else(|| {
                AppError::message("Job repository is not initialized. Call initialize() first.")
            })
    }
    fn finish_transaction<T>(&self, result: Result<T>) -> Result<T> {
        match result {
            Ok(value) => {
                self.db()?.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.db()?.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }
    fn find_active(&self, job: &JobIdentity) -> Result<Option<JobRecord>> {
        Ok(self
            .find_entry(job)?
            .filter(|entry| self.now() - entry.admit_time < self.default_expiration_ms))
    }
    fn find_entry(&self, job: &JobIdentity) -> Result<Option<JobRecord>> {
        if !self.config.enable_job_db || !self.is_valid_job(job) {
            return Ok(None);
        }
        self.db()?.query_row("SELECT identity_key, source, source_job_id, company, title, admit_time, description_scraped_at, last_processed, search_only FROM jobs WHERE identity_key = ?", [self.identity_key(job)], Self::row_to_record).optional().map_err(Into::into)
    }
    fn insert_discovery(&self, job: &JobIdentity) -> Result<()> {
        self.insert(job, self.now(), None, None, true)
    }
    fn insert(
        &self,
        job: &JobIdentity,
        admit_time: i64,
        described: Option<i64>,
        processed: Option<i64>,
        search_only: bool,
    ) -> Result<()> {
        self.db()?.execute("INSERT INTO jobs(identity_key, source, source_job_id, company, title, admit_time, description_scraped_at, last_processed, search_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(identity_key) DO UPDATE SET company = excluded.company, title = excluded.title, admit_time = CASE WHEN (excluded.admit_time - jobs.admit_time) >= ? THEN excluded.admit_time ELSE MIN(jobs.admit_time, excluded.admit_time) END, description_scraped_at = CASE WHEN (excluded.admit_time - jobs.admit_time) >= ? THEN excluded.description_scraped_at WHEN jobs.description_scraped_at IS NULL THEN excluded.description_scraped_at WHEN excluded.description_scraped_at IS NULL THEN jobs.description_scraped_at ELSE MAX(jobs.description_scraped_at, excluded.description_scraped_at) END, last_processed = CASE WHEN jobs.last_processed IS NULL THEN excluded.last_processed WHEN excluded.last_processed IS NULL THEN jobs.last_processed ELSE MAX(jobs.last_processed, excluded.last_processed) END, search_only = CASE WHEN jobs.last_processed IS NOT NULL OR excluded.last_processed IS NOT NULL THEN 0 ELSE excluded.search_only END", params![self.identity_key(job), self.source(job), self.source_id(job), job.company, job.title, admit_time, described, processed, if search_only { 1 } else { 0 }, self.default_expiration_ms, self.default_expiration_ms])?;
        Ok(())
    }
    fn ensure_capacity(&self, required: i64) -> Result<()> {
        let current = self.size()?;
        if current + required <= self.max_records {
            return Ok(());
        }
        self.db()?.execute(
            &format!("DELETE FROM jobs WHERE {LATEST_JOB_CHECKPOINT_SQL} <= ?"),
            [self.now() - self.default_expiration_ms],
        )?;
        let after_expiry = self.size()?;
        if after_expiry + required <= self.max_records {
            return Ok(());
        }
        let excess = after_expiry + required - self.max_records;
        self.db()?.execute("DELETE FROM jobs WHERE identity_key IN (SELECT identity_key FROM jobs WHERE search_only = 1 AND description_scraped_at IS NULL ORDER BY admit_time ASC LIMIT ?)", [excess])?;
        if self.size()? + required > self.max_records {
            return Err(AppError::message(format!("Database size limit ({}) reached; all retained entries are description or judgment checkpoints", self.max_records)));
        }
        Ok(())
    }
    fn source<'a>(&self, job: &'a JobIdentity) -> &'a str {
        job.source.as_deref().unwrap_or("indeed")
    }
    fn identity_key(&self, job: &JobIdentity) -> String {
        self.source_id(job)
            .map(|id| format!("id:{}:{id}", self.source(job)))
            .unwrap_or_else(|| {
                format!(
                    "fallback:{}:{}:{}",
                    self.source(job),
                    normalize_job_match_value(&job.company),
                    normalize_job_match_value(&job.title)
                )
            })
    }
    fn source_id(&self, job: &JobIdentity) -> Option<String> {
        let explicit = job
            .source_job_id
            .as_deref()
            .or(job.id.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(value) = explicit {
            return Some(
                value
                    .strip_prefix("indeed:")
                    .or_else(|| value.strip_prefix("linkedin:"))
                    .unwrap_or(value)
                    .chars()
                    .take(512)
                    .collect(),
            );
        }
        let url = Url::parse(job.url.as_deref()?).ok()?;
        for key in ["jk", "vjk", "jobId", "id"] {
            if let Some(value) = url
                .query_pairs()
                .find(|(name, value)| name == key && !value.is_empty())
                .map(|(_, value)| value.into_owned())
            {
                return Some(value.chars().take(512).collect());
            }
        }
        let path = url.path();
        if let Some(index) = path.find("/jobs/view/") {
            let digits: String = path[index + 11..]
                .chars()
                .take_while(|character| character.is_ascii_digit())
                .collect();
            if !digits.is_empty() {
                return Some(digits.chars().take(512).collect());
            }
        }
        let path = url.path().trim_end_matches('/');
        Some(format!("url:{}{}", url.host_str()?.to_lowercase(), path))
    }
    fn is_valid_job(&self, job: &JobIdentity) -> bool {
        !job.title.trim().is_empty()
            && !job.company.trim().is_empty()
            && job.title.encode_utf16().count() <= JOB_TITLE_MAX_LENGTH
            && job.company.encode_utf16().count() <= JOB_COMPANY_MAX_LENGTH
            && job
                .source
                .as_deref()
                .is_none_or(|source| source == "indeed" || source == "linkedin")
    }
    fn assert_valid_job(&self, job: &JobIdentity) -> Result<()> {
        self.is_valid_job(job)
            .then_some(())
            .ok_or_else(|| AppError::message("Invalid job identity"))
    }
    fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<JobRecord> {
        let search_only: i64 = row.get(8)?;
        Ok(JobRecord {
            id: row.get(0)?,
            source: row.get(1)?,
            source_job_id: row.get(2)?,
            company: row.get(3)?,
            title: row.get(4)?,
            admit_time: row.get(5)?,
            description_scraped_at: row.get(6)?,
            last_processed: row.get(7)?,
            search_only: (search_only == 1).then_some(true),
        })
    }
    fn entries_query<P: rusqlite::Params>(&self, sql: &str, params: P) -> Result<Vec<JobRecord>> {
        if !self.config.enable_job_db {
            return Ok(Vec::new());
        }
        let mut statement = self.db()?.prepare(sql)?;
        let records = statement
            .query_map(params, Self::row_to_record)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(records)
    }
    fn import_legacy_json_once(&mut self) -> Result<()> {
        if self
            .db()?
            .query_row(
                "SELECT 1 FROM metadata WHERE key = 'legacy_json_import_complete'",
                [],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            return Ok(());
        }
        let legacy_path = self.config.legacy_json_path.clone().unwrap_or_else(|| {
            self.config
                .db_file_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("jobDB.json")
        });
        let entries: Vec<LegacyJobEntry> = match fs::read_to_string(&legacy_path) {
            Ok(contents) => serde_json::from_str(&contents)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error.into()),
        };
        let mut migrated = 0;
        let mut skipped = 0;
        self.db()?.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<()> {
            for entry in entries.iter() {
                if entry.source.as_deref() != Some("indeed") {
                    skipped += 1;
                    continue;
                }
                let job = JobIdentity {
                    id: entry
                        .source_job_id
                        .clone()
                        .or(entry.linked_in_job_id.clone()),
                    source: Some("indeed".into()),
                    source_job_id: entry.source_job_id.clone(),
                    title: entry.title.clone().unwrap_or_default(),
                    company: entry.company.clone().unwrap_or_default(),
                    url: None,
                };
                if !self.is_valid_job(&job) {
                    skipped += 1;
                    continue;
                }
                self.insert(
                    &job,
                    entry.admit_time.unwrap_or_else(|| self.now()),
                    entry.description_scraped_at,
                    entry.last_processed,
                    entry.last_processed.is_none(),
                )?;
                migrated += 1;
            }
            self.db()?.execute(
                "INSERT INTO metadata(key, value) VALUES (?, ?)",
                params![
                    "legacy_json_import_complete",
                    serde_json::json!({"migrated": migrated, "skipped": skipped}).to_string()
                ],
            )?;
            Ok(())
        })();
        self.finish_transaction(result)
    }
    fn backfill_job_cloth_history(&mut self) -> Result<()> {
        let rows: Vec<(String, String, i64)> = {
            let mut statement = self.db()?.prepare(
                "SELECT title, company, last_processed FROM jobs WHERE last_processed IS NOT NULL",
            )?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                .collect::<rusqlite::Result<_>>()?;
            rows
        };
        let identities: Vec<JobClothIdentity> = rows
            .iter()
            .map(|(title, company, _)| JobClothIdentity {
                title: title.clone(),
                company: company.clone(),
            })
            .collect();
        self.db()?.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<()> {
            let mut statement = self.db()?.prepare("INSERT INTO job_cloth_history (normalized_title, normalized_company, title, company, last_processed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(normalized_title, normalized_company) DO UPDATE SET title = CASE WHEN excluded.last_processed_at >= job_cloth_history.last_processed_at THEN excluded.title ELSE job_cloth_history.title END, company = CASE WHEN excluded.last_processed_at >= job_cloth_history.last_processed_at THEN excluded.company ELSE job_cloth_history.company END, last_processed_at = MAX(job_cloth_history.last_processed_at, excluded.last_processed_at)")?;
            for (identity, (_, _, at)) in identities.iter().zip(rows.iter()) {
                if let Some(key) = create_job_cloth_match_key(identity) {
                    let (title, company) = key.split_once('\0').expect("match key separator");
                    statement.execute(params![
                        title,
                        company,
                        identity.title,
                        identity.company,
                        at
                    ])?;
                }
            }
            Ok(())
        })();
        self.finish_transaction(result)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyJobEntry {
    #[serde(default)]
    linked_in_job_id: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    source_job_id: Option<String>,
    #[serde(default)]
    company: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    admit_time: Option<i64>,
    #[serde(default)]
    description_scraped_at: Option<i64>,
    #[serde(default)]
    last_processed: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn repo() -> JobRepository {
        let directory = tempdir().unwrap();
        let path = directory.keep().join("jobDB.sqlite");
        let mut repo = JobRepository::new(JobRepositoryConfig {
            db_file_path: path,
            legacy_json_path: None,
            default_expiration_ms: Some(1_000),
            enable_job_db: true,
            max_records: Some(3),
            now: Some(|| 10_000),
        });
        repo.initialize().unwrap();
        repo
    }
    fn job(id: &str) -> JobIdentity {
        JobIdentity {
            id: Some(id.into()),
            source: Some("indeed".into()),
            source_job_id: None,
            title: "Rust Engineer".into(),
            company: "AstroOM".into(),
            url: None,
        }
    }

    #[test]
    fn identity_keys_match_node_rules() {
        let repository = repo();
        assert_eq!(repository.identity_key(&job("indeed:abc")), "id:indeed:abc");
        let linked_in = JobIdentity {
            id: None,
            source: Some("linkedin".into()),
            source_job_id: None,
            title: "T".into(),
            company: "C".into(),
            url: Some("https://www.linkedin.com/jobs/view/12345678/?x=1".into()),
        };
        assert_eq!(repository.identity_key(&linked_in), "id:linkedin:12345678");
        assert_eq!(
            create_indeed_identity("https://example.test/job"),
            "b13db7b96f1c83e2"
        );
    }

    #[test]
    fn transitions_and_checkpoints_are_durable() {
        let mut repository = repo();
        let item = job("one");
        repository
            .add_searched_jobs(std::slice::from_ref(&item))
            .unwrap();
        assert!(repository.is_job_seen(&item).unwrap());
        assert!(!repository.is_job_description_scraped(&item).unwrap());
        repository.mark_job_description_scraped(&item).unwrap();
        assert!(repository.is_job_description_scraped(&item).unwrap());
        repository.add_job(&item).unwrap();
        assert!(repository.is_job_matched(&item).unwrap());
        let checkpoint = StageCheckpointRecord {
            stage: "jobCloth".into(),
            input_path: "in.json".into(),
            input_hash: "abc".into(),
            output_path: "out.json".into(),
            output_hash: None,
            preset: "p".into(),
            model: "m".into(),
            status: "in_progress".into(),
            processed_job_ids: vec![],
            completed_jobs: 0,
            total_jobs: 1,
            created_at: 0,
            updated_at: 0,
        };
        repository.save_stage_checkpoint(&checkpoint).unwrap();
        repository
            .record_job_in_checkpoint("jobCloth", "abc", "p", "m", "one")
            .unwrap();
        repository
            .complete_stage_checkpoint("jobCloth", "abc", "p", "m", "hash", 1)
            .unwrap();
        let saved = repository
            .get_stage_checkpoint("jobCloth", "abc", "p", "m")
            .unwrap()
            .unwrap();
        assert_eq!(saved.status, "completed");
        assert_eq!(saved.processed_job_ids, ["one"]);
        assert_eq!(repository.verify_integrity().unwrap().integrity, "ok");
    }

    #[test]
    fn job_cloth_cool_off_normalizes_whitespace() {
        let mut repository = repo();
        repository
            .record_job_cloth_processed(
                &[JobClothIdentity {
                    title: " Senior  Rust Engineer ".into(),
                    company: "  AstroOM\n".into(),
                }],
                Some(9_999),
            )
            .unwrap();
        let recent = repository
            .get_recent_job_cloth_processing_keys(
                &[JobClothIdentity {
                    title: "senior rust engineer".into(),
                    company: "astroom".into(),
                }],
                100,
            )
            .unwrap();
        assert_eq!(recent.len(), 1);
    }
}
