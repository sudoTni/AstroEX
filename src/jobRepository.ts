import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLogger, log } from "./utils";

const logger = createLogger("JobRepository");

const DEFAULT_MAX_RECORDS = 250_000;
const JOB_REPOSITORY_SCHEMA_VERSION = "1";
const MAX_TITLE_LENGTH = 200;
const MAX_COMPANY_LENGTH = 100;

export interface JobRecord {
	id: string;
	source: "indeed";
	sourceJobId?: string;
	company: string;
	title: string;
	admitTime: number;
	descriptionScrapedAt?: number;
	lastProcessed?: number;
	searchOnly?: boolean;
}

export interface JobIdentity {
	id?: string;
	source?: "indeed";
	sourceJobId?: string;
	title: string;
	company: string;
	url?: string;
}

export interface JobRepositoryConfig {
	dbFilePath: string;
	/** Optional one-time import source from the retired JSON JobDB. */
	legacyJsonPath?: string;
	defaultExpirationMs: number;
	enableJobDB: boolean;
	maxRecords?: number;
	now?: () => number;
}

export interface JobRepositoryStats {
	totalEntries: number;
	discoveryOnlyEntries: number;
	descriptionCheckpointEntries: number;
	judgedEntries: number;
	capacity: number;
	expiredEntries: number;
	timeToNextExpiration: number;
}

export interface JobRepositoryHealth {
	schemaVersion: string;
	integrity: "ok" | "failed";
	details: string;
}

export interface StageCheckpointRecord {
	stage: "jobCloth" | "jobJudge" | "makeMaterials" | string;
	inputPath: string;
	inputHash: string;
	outputPath: string;
	outputHash?: string;
	preset: string;
	model: string;
	status: "in_progress" | "completed" | "failed";
	processedJobIds: string[];
	completedJobs: number;
	totalJobs: number;
	createdAt: number;
	updatedAt: number;
}

type LegacyJobEntry = {
	linkedInJobId?: unknown;
	source?: unknown;
	sourceJobId?: unknown;
	company?: unknown;
	title?: unknown;
	admitTime?: unknown;
	descriptionScrapedAt?: unknown;
	lastProcessed?: unknown;
	searchOnly?: unknown;
};

/**
 * Transactional duplicate-protection repository for the Indeed workflow.
 *
 * Every state transition is an SQLite upsert. The public methods intentionally
 * retain the former JobDB lifecycle so callers can migrate without weakening
 * discovery, description, or evaluation checkpoints.
 */
export class JobRepository {
	private readonly config: Required<
		Pick<JobRepositoryConfig, "defaultExpirationMs" | "enableJobDB">
	> &
		JobRepositoryConfig & { maxRecords: number };
	private database?: DatabaseSync;
	private initialized = false;

	private now(): number {
		return this.config.now ? this.config.now() : Date.now();
	}

	constructor(config: JobRepositoryConfig) {
		this.config = {
			...config,
			legacyJsonPath:
				config.legacyJsonPath ??
				path.join(path.dirname(config.dbFilePath), "jobDB.json"),
			maxRecords: config.maxRecords ?? DEFAULT_MAX_RECORDS,
		};
	}

	async initialize(): Promise<void> {
		if (!this.config.enableJobDB || this.initialized) return;
		await fs.promises.mkdir(path.dirname(this.config.dbFilePath), {
			recursive: true,
		});
		this.database = new DatabaseSync(this.config.dbFilePath, {
			enableForeignKeyConstraints: true,
		});
		this.database.exec("PRAGMA journal_mode = WAL;");
		this.database.exec("PRAGMA synchronous = FULL;");
		this.database.exec("PRAGMA busy_timeout = 5000;");
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS metadata (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS jobs (
				identity_key TEXT PRIMARY KEY,
				source TEXT NOT NULL CHECK(source = 'indeed'),
				source_job_id TEXT,
				company TEXT NOT NULL,
				title TEXT NOT NULL,
				admit_time INTEGER NOT NULL,
				description_scraped_at INTEGER,
				last_processed INTEGER,
				search_only INTEGER NOT NULL DEFAULT 1 CHECK(search_only IN (0, 1))
			) STRICT;
			CREATE UNIQUE INDEX IF NOT EXISTS jobs_source_id
				ON jobs(source, source_job_id) WHERE source_job_id IS NOT NULL;
			CREATE INDEX IF NOT EXISTS jobs_expiry ON jobs(admit_time);
			CREATE INDEX IF NOT EXISTS jobs_discovery_eviction
				ON jobs(search_only, description_scraped_at, admit_time);
			CREATE INDEX IF NOT EXISTS jobs_judged ON jobs(last_processed);
			CREATE TABLE IF NOT EXISTS stage_checkpoints (
				stage TEXT NOT NULL,
				input_path TEXT NOT NULL,
				input_hash TEXT NOT NULL,
				output_path TEXT NOT NULL,
				output_hash TEXT,
				preset TEXT NOT NULL,
				model TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('in_progress', 'completed', 'failed')),
				processed_job_ids TEXT NOT NULL,
				completed_jobs INTEGER NOT NULL DEFAULT 0,
				total_jobs INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (stage, input_hash, preset, model)
			) STRICT;
			CREATE INDEX IF NOT EXISTS stage_checkpoints_lookup
				ON stage_checkpoints(stage, input_hash, preset, model);
		`);
		this.database
			.prepare(
				"INSERT INTO metadata(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.run(JOB_REPOSITORY_SCHEMA_VERSION);
		this.initialized = true;
		this.importLegacyJsonOnce();
	}

	/**
	 * Compatibility stub retained from the legacy in-memory JSON repository.
	 * SQLite state is persisted continuously; this validates database readiness.
	 */
	async load(): Promise<void> {
		if (!this.config.enableJobDB) return;
		this.requireDatabase();
	}

	async close(): Promise<void> {
		if (!this.database) return;
		try {
			this.database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
			this.database.close();
		} finally {
			this.database = undefined;
			this.initialized = false;
		}
	}

	async cleanupExpired(): Promise<number> {
		if (!this.config.enableJobDB) return 0;
		const database = this.requireDatabase();
		const result = database
			.prepare("DELETE FROM jobs WHERE admit_time <= ?")
			.run(this.now() - this.config.defaultExpirationMs);
		return Number(result.changes);
	}

	isJobSeen(job: JobIdentity): boolean {
		return this.findActive(job) !== undefined;
	}

	isJobDescriptionScraped(job: JobIdentity): boolean {
		const entry = this.findActive(job);
		return (
			!!entry && (entry.descriptionScrapedAt !== undefined || !entry.searchOnly)
		);
	}

	isJobMatched(job: JobIdentity): boolean {
		const entry = this.findActive(job);
		return !!entry && entry.lastProcessed !== undefined;
	}

	async addSearchedJobs(jobs: JobIdentity[]): Promise<number> {
		if (!this.config.enableJobDB) return 0;
		const database = this.requireDatabase();
		const unique = new Map<string, JobIdentity>();
		for (const job of jobs) {
			if (this.isValidJob(job)) unique.set(this.identityKey(job), job);
		}
		let added = 0;
		database.exec("BEGIN IMMEDIATE");
		try {
			for (const job of unique.values()) {
				if (this.findActive(job)) continue;
				try {
					this.ensureCapacity(1);
				} catch (error) {
					if (!this.isCapacityError(error)) throw error;
					logger.warn(
						"Discovery capacity is reserved for completed checkpoints; skipped remaining discovery records.",
					);
					break;
				}
				this.insertDiscovery(job);
				added++;
			}
			database.exec("COMMIT");
			return added;
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
	}

	async markJobDescriptionScraped(job: JobIdentity): Promise<void> {
		if (!this.config.enableJobDB) return;
		this.assertValidJob(job);
		const database = this.requireDatabase();
		const now = this.now();
		database.exec("BEGIN IMMEDIATE");
		try {
			const current = this.findEntry(job);
			if (current) {
				const isExpired =
					now - current.admitTime >= this.config.defaultExpirationMs;
				const admitTime = isExpired ? now : current.admitTime;
				const lastProcessed = isExpired
					? null
					: (current.lastProcessed ?? null);
				const searchOnly =
					current.lastProcessed !== undefined && !isExpired ? 0 : 1;
				database
					.prepare(
						"UPDATE jobs SET company = ?, title = ?, admit_time = ?, description_scraped_at = ?, last_processed = ?, search_only = ? WHERE identity_key = ?",
					)
					.run(
						job.company,
						job.title,
						admitTime,
						now,
						lastProcessed,
						searchOnly,
						this.identityKey(job),
					);
			} else {
				this.ensureCapacity(1);
				this.insert(job, now, now, undefined, true);
			}
			database.exec("COMMIT");
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
	}

	async addJob(job: JobIdentity): Promise<void> {
		if (!this.config.enableJobDB) return;
		this.assertValidJob(job);
		const database = this.requireDatabase();
		const now = this.now();
		database.exec("BEGIN IMMEDIATE");
		try {
			const current = this.findEntry(job);
			if (current) {
				const isExpired =
					now - current.admitTime >= this.config.defaultExpirationMs;
				const admitTime = isExpired ? now : current.admitTime;
				const descriptionScrapedAt = isExpired
					? null
					: (current.descriptionScrapedAt ?? null);
				database
					.prepare(
						"UPDATE jobs SET company = ?, title = ?, admit_time = ?, description_scraped_at = ?, last_processed = ?, search_only = 0 WHERE identity_key = ?",
					)
					.run(
						job.company,
						job.title,
						admitTime,
						descriptionScrapedAt,
						now,
						this.identityKey(job),
					);
			} else {
				this.ensureCapacity(1);
				this.insert(job, now, undefined, now, false);
			}
			database.exec("COMMIT");
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
	}

	size(): number {
		if (!this.config.enableJobDB) return 0;
		const row = this.requireDatabase()
			.prepare("SELECT COUNT(*) AS count FROM jobs")
			.get() as { count: number };
		return Number(row.count);
	}

	getAllEntries(): JobRecord[] {
		if (!this.config.enableJobDB) return [];
		return this.requireDatabase()
			.prepare(
				"SELECT identity_key, source, source_job_id, company, title, admit_time, description_scraped_at, last_processed, search_only FROM jobs ORDER BY admit_time ASC",
			)
			.all()
			.map((row) => this.toRecord(row as Record<string, unknown>));
	}

	getEntriesPaginated(page = 0, pageSize = 100): JobRecord[] {
		if (!Number.isInteger(page) || page < 0)
			throw new Error("page must be non-negative");
		if (!Number.isInteger(pageSize) || pageSize <= 0)
			throw new Error("pageSize must be positive");
		if (!this.config.enableJobDB) return [];
		return this.requireDatabase()
			.prepare(
				"SELECT identity_key, source, source_job_id, company, title, admit_time, description_scraped_at, last_processed, search_only FROM jobs ORDER BY admit_time ASC LIMIT ? OFFSET ?",
			)
			.all(pageSize, page * pageSize)
			.map((row) => this.toRecord(row as Record<string, unknown>));
	}

	getStats(): JobRepositoryStats {
		if (!this.config.enableJobDB) {
			return {
				totalEntries: 0,
				discoveryOnlyEntries: 0,
				descriptionCheckpointEntries: 0,
				judgedEntries: 0,
				capacity: this.config.maxRecords,
				expiredEntries: 0,
				timeToNextExpiration: 0,
			};
		}
		const now = this.now();
		const row = this.requireDatabase()
			.prepare(`
				SELECT
					COUNT(*) AS total,
					SUM(CASE WHEN search_only = 1 AND description_scraped_at IS NULL THEN 1 ELSE 0 END) AS discovery,
					SUM(CASE WHEN search_only = 1 AND description_scraped_at IS NOT NULL THEN 1 ELSE 0 END) AS described,
					SUM(CASE WHEN admit_time <= ? THEN 1 ELSE 0 END) AS expired,
					MIN(CASE WHEN admit_time > ? THEN admit_time + ? ELSE NULL END) AS next_expiration
				FROM jobs
			`)
			.get(
				now - this.config.defaultExpirationMs,
				now - this.config.defaultExpirationMs,
				this.config.defaultExpirationMs,
			) as {
			total: number;
			discovery: number | null;
			described: number | null;
			expired: number | null;
			next_expiration: number | null;
		};
		const total = Number(row.total);
		const discovery = Number(row.discovery ?? 0);
		const described = Number(row.described ?? 0);
		return {
			totalEntries: total,
			discoveryOnlyEntries: discovery,
			descriptionCheckpointEntries: described,
			judgedEntries: total - discovery - described,
			capacity: this.config.maxRecords,
			expiredEntries: Number(row.expired ?? 0),
			timeToNextExpiration:
				row.next_expiration !== null && row.next_expiration !== undefined
					? Math.max(0, Number(row.next_expiration) - now)
					: 0,
		};
	}

	async createBackup(): Promise<void> {
		if (!this.config.enableJobDB) return;
		const database = this.requireDatabase();
		database.exec("PRAGMA wal_checkpoint(FULL)");
		const backupPath = `${this.config.dbFilePath}.${this.now()}.bak`;
		await fs.promises.copyFile(this.config.dbFilePath, backupPath);
		logger.info("Created SQLite backup", { backupPath });
	}

	async rotateBackups(keep: number): Promise<number> {
		if (!Number.isSafeInteger(keep) || keep < 1)
			throw new Error("Backup retention count must be a positive integer");
		const directory = path.dirname(this.config.dbFilePath);
		const prefix = `${path.basename(this.config.dbFilePath)}.`;
		const backups = (await fs.promises.readdir(directory))
			.filter((file) => file.startsWith(prefix) && file.endsWith(".bak"))
			.sort()
			.reverse();
		const obsolete = backups.slice(keep);
		for (const file of obsolete)
			await fs.promises.unlink(path.join(directory, file));
		return obsolete.length;
	}

	getStageCheckpoint(
		stage: string,
		inputHash: string,
		preset: string,
		model: string,
	): StageCheckpointRecord | undefined {
		if (!this.config.enableJobDB) return undefined;
		const database = this.requireDatabase();
		const row = database
			.prepare(
				`SELECT stage, input_path, input_hash, output_path, output_hash, preset, model, status, processed_job_ids, completed_jobs, total_jobs, created_at, updated_at
				 FROM stage_checkpoints
				 WHERE stage = ? AND input_hash = ? AND preset = ? AND model = ?`,
			)
			.get(stage, inputHash, preset, model) as
			| Record<string, unknown>
			| undefined;

		if (!row) return undefined;

		let processedJobIds: string[] = [];
		try {
			processedJobIds = JSON.parse(String(row.processed_job_ids ?? "[]"));
		} catch {
			processedJobIds = [];
		}

		return {
			stage: String(row.stage),
			inputPath: String(row.input_path),
			inputHash: String(row.input_hash),
			outputPath: String(row.output_path),
			outputHash: row.output_hash ? String(row.output_hash) : undefined,
			preset: String(row.preset),
			model: String(row.model),
			status: row.status as "in_progress" | "completed" | "failed",
			processedJobIds,
			completedJobs: Number(row.completed_jobs ?? 0),
			totalJobs: Number(row.total_jobs ?? 0),
			createdAt: Number(row.created_at ?? 0),
			updatedAt: Number(row.updated_at ?? 0),
		};
	}

	saveStageCheckpoint(record: StageCheckpointRecord): void {
		if (!this.config.enableJobDB) return;
		const database = this.requireDatabase();
		const now = this.now();
		database
			.prepare(
				`INSERT INTO stage_checkpoints (
					stage, input_path, input_hash, output_path, output_hash, preset, model,
					status, processed_job_ids, completed_jobs, total_jobs, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(stage, input_hash, preset, model) DO UPDATE SET
					output_path = excluded.output_path,
					output_hash = excluded.output_hash,
					status = excluded.status,
					processed_job_ids = excluded.processed_job_ids,
					completed_jobs = excluded.completed_jobs,
					total_jobs = excluded.total_jobs,
					updated_at = excluded.updated_at`,
			)
			.run(
				record.stage,
				record.inputPath,
				record.inputHash,
				record.outputPath,
				record.outputHash ?? null,
				record.preset,
				record.model,
				record.status,
				JSON.stringify(record.processedJobIds),
				record.completedJobs,
				record.totalJobs,
				record.createdAt || now,
				now,
			);
	}

	recordJobInCheckpoint(
		stage: string,
		inputHash: string,
		preset: string,
		model: string,
		jobId: string,
	): void {
		if (!this.config.enableJobDB) return;
		const existing = this.getStageCheckpoint(stage, inputHash, preset, model);
		if (!existing) return;
		const ids = new Set(existing.processedJobIds);
		ids.add(jobId);
		existing.processedJobIds = Array.from(ids);
		existing.completedJobs = existing.processedJobIds.length;
		this.saveStageCheckpoint(existing);
	}

	completeStageCheckpoint(
		stage: string,
		inputHash: string,
		preset: string,
		model: string,
		outputHash: string,
		completedJobs: number,
	): void {
		if (!this.config.enableJobDB) return;
		const existing = this.getStageCheckpoint(stage, inputHash, preset, model);
		if (!existing) return;
		existing.status = "completed";
		existing.outputHash = outputHash;
		existing.completedJobs = completedJobs;
		this.saveStageCheckpoint(existing);
	}

	/** Verify the SQLite file before an operator relies on its checkpoints. */
	verifyIntegrity(): JobRepositoryHealth {
		if (!this.config.enableJobDB) {
			return {
				schemaVersion: JOB_REPOSITORY_SCHEMA_VERSION,
				integrity: "ok",
				details: "repository disabled",
			};
		}
		const database = this.requireDatabase();
		const version = database
			.prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
			.get() as { value?: unknown } | undefined;
		const result = database.prepare("PRAGMA integrity_check").get() as Record<
			string,
			unknown
		>;
		const details = String(Object.values(result)[0] ?? "unknown result");
		return {
			schemaVersion:
				typeof version?.value === "string" ? version.value : "unknown",
			integrity: details.toLowerCase() === "ok" ? "ok" : "failed",
			details,
		};
	}

	private importLegacyJsonOnce(): void {
		const database = this.requireDatabase();
		const imported = database
			.prepare(
				"SELECT value FROM metadata WHERE key = 'legacy_json_import_complete'",
			)
			.get();
		if (imported) return;

		let entries: LegacyJobEntry[] = [];
		try {
			const legacyJsonPath =
				this.config.legacyJsonPath ??
				path.join(path.dirname(this.config.dbFilePath), "jobDB.json");
			const content = fs.readFileSync(legacyJsonPath, "utf8");
			const parsed: unknown = JSON.parse(content);
			if (Array.isArray(parsed)) entries = parsed as LegacyJobEntry[];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		let migrated = 0;
		let skipped = 0;
		database.exec("BEGIN IMMEDIATE");
		try {
			for (const entry of entries) {
				if (entry.source !== "indeed") {
					skipped++;
					continue;
				}
				const job: JobIdentity = {
					id:
						typeof entry.sourceJobId === "string"
							? entry.sourceJobId
							: typeof entry.linkedInJobId === "string"
								? entry.linkedInJobId
								: undefined,
					source: "indeed",
					sourceJobId:
						typeof entry.sourceJobId === "string"
							? entry.sourceJobId
							: undefined,
					title: typeof entry.title === "string" ? entry.title : "",
					company: typeof entry.company === "string" ? entry.company : "",
				};
				if (!this.isValidJob(job)) {
					skipped++;
					continue;
				}
				const admitTime =
					typeof entry.admitTime === "number" ? entry.admitTime : this.now();
				const described =
					typeof entry.descriptionScrapedAt === "number"
						? entry.descriptionScrapedAt
						: undefined;
				const judged =
					typeof entry.lastProcessed === "number"
						? entry.lastProcessed
						: undefined;
				this.insert(job, admitTime, described, judged, judged === undefined);
				migrated++;
			}
			database
				.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)")
				.run(
					"legacy_json_import_complete",
					JSON.stringify({ migrated, skipped }),
				);
			database.exec("COMMIT");
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
		if (entries.length > 0) {
			logger.info("Migrated retired JSON JobDB entries", {
				migrated,
				skipped,
				legacyJsonPath: this.config.legacyJsonPath,
			});
		}
	}

	private findActive(job: JobIdentity): JobRecord | undefined {
		if (!this.config.enableJobDB) return undefined;
		const entry = this.findEntry(job);
		return entry &&
			this.now() - entry.admitTime < this.config.defaultExpirationMs
			? entry
			: undefined;
	}

	private findEntry(job: JobIdentity): JobRecord | undefined {
		if (!this.config.enableJobDB || !this.isValidJob(job)) return undefined;
		const row = this.requireDatabase()
			.prepare(
				"SELECT identity_key, source, source_job_id, company, title, admit_time, description_scraped_at, last_processed, search_only FROM jobs WHERE identity_key = ?",
			)
			.get(this.identityKey(job));
		return row ? this.toRecord(row as Record<string, unknown>) : undefined;
	}

	private insertDiscovery(job: JobIdentity): void {
		this.insert(job, this.now(), undefined, undefined, true);
	}

	private insert(
		job: JobIdentity,
		admitTime: number,
		descriptionScrapedAt: number | undefined,
		lastProcessed: number | undefined,
		searchOnly: boolean,
	): void {
		const expirationMs = this.config.defaultExpirationMs;
		this.requireDatabase()
			.prepare(`
				INSERT INTO jobs(identity_key, source, source_job_id, company, title, admit_time, description_scraped_at, last_processed, search_only)
				VALUES (?, 'indeed', ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(identity_key) DO UPDATE SET
					company = excluded.company,
					title = excluded.title,
					admit_time = CASE
						WHEN (excluded.admit_time - jobs.admit_time) >= ? THEN excluded.admit_time
						ELSE MIN(jobs.admit_time, excluded.admit_time)
					END,
					description_scraped_at = CASE
						WHEN (excluded.admit_time - jobs.admit_time) >= ? THEN excluded.description_scraped_at
						WHEN jobs.description_scraped_at IS NULL THEN excluded.description_scraped_at
						WHEN excluded.description_scraped_at IS NULL THEN jobs.description_scraped_at
						ELSE MAX(jobs.description_scraped_at, excluded.description_scraped_at)
					END,
					last_processed = CASE
						WHEN (excluded.admit_time - jobs.admit_time) >= ? THEN excluded.last_processed
						WHEN jobs.last_processed IS NULL THEN excluded.last_processed
						WHEN excluded.last_processed IS NULL THEN jobs.last_processed
						ELSE MAX(jobs.last_processed, excluded.last_processed)
					END,
					search_only = CASE
						WHEN (excluded.admit_time - jobs.admit_time) >= ? THEN excluded.search_only
						WHEN jobs.last_processed IS NOT NULL OR excluded.last_processed IS NOT NULL THEN 0
						ELSE excluded.search_only
					END
			`)
			.run(
				this.identityKey(job),
				this.sourceId(job) ?? null,
				job.company,
				job.title,
				admitTime,
				descriptionScrapedAt ?? null,
				lastProcessed ?? null,
				searchOnly ? 1 : 0,
				expirationMs,
				expirationMs,
				expirationMs,
				expirationMs,
			);
	}

	private ensureCapacity(required: number): void {
		const database = this.requireDatabase();
		const current = this.size();
		if (current + required <= this.config.maxRecords) return;
		database
			.prepare("DELETE FROM jobs WHERE admit_time <= ?")
			.run(this.now() - this.config.defaultExpirationMs);
		const afterExpiry = this.size();
		if (afterExpiry + required <= this.config.maxRecords) return;
		const excess = afterExpiry + required - this.config.maxRecords;
		database
			.prepare(`
				DELETE FROM jobs WHERE identity_key IN (
					SELECT identity_key FROM jobs
					WHERE search_only = 1 AND description_scraped_at IS NULL
					ORDER BY admit_time ASC LIMIT ?
				)
			`)
			.run(excess);
		if (this.size() + required > this.config.maxRecords) {
			throw new Error(
				`Database size limit (${this.config.maxRecords}) reached; all retained entries are description or judgment checkpoints`,
			);
		}
	}

	private identityKey(job: JobIdentity): string {
		const sourceId = this.sourceId(job);
		return sourceId
			? `id:indeed:${sourceId}`
			: `fallback:indeed:${this.normalize(job.company)}:${this.normalize(job.title)}`;
	}

	private sourceId(job: JobIdentity): string | undefined {
		const explicit = job.sourceJobId?.trim() || job.id?.trim();
		if (explicit) return explicit.replace(/^indeed:/, "").slice(0, 512);
		if (!job.url) return undefined;
		try {
			const url = new URL(job.url);
			const knownId = ["jk", "vjk", "jobId", "id"]
				.map((key) => url.searchParams.get(key))
				.find(Boolean);
			if (knownId) return knownId.slice(0, 512);
			url.search = "";
			url.hash = "";
			return `url:${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, "")}`;
		} catch {
			return undefined;
		}
	}

	private isValidJob(job: JobIdentity): boolean {
		return (
			!!job &&
			typeof job.title === "string" &&
			typeof job.company === "string" &&
			job.title.trim().length > 0 &&
			job.company.trim().length > 0 &&
			job.title.length <= MAX_TITLE_LENGTH &&
			job.company.length <= MAX_COMPANY_LENGTH &&
			(!job.source || job.source === "indeed")
		);
	}

	private assertValidJob(job: JobIdentity): void {
		if (!this.isValidJob(job)) throw new Error("Invalid Indeed job identity");
	}

	private toRecord(row: Record<string, unknown>): JobRecord {
		return {
			id: String(row.identity_key),
			source: "indeed",
			sourceJobId:
				typeof row.source_job_id === "string" ? row.source_job_id : undefined,
			company: String(row.company),
			title: String(row.title),
			admitTime: Number(row.admit_time),
			descriptionScrapedAt:
				typeof row.description_scraped_at === "number"
					? row.description_scraped_at
					: undefined,
			lastProcessed:
				typeof row.last_processed === "number" ? row.last_processed : undefined,
			searchOnly: Number(row.search_only) === 1 ? true : undefined,
		};
	}

	private normalize(value: string): string {
		return value.toLowerCase().trim().replace(/\s+/g, " ");
	}

	private requireDatabase(): DatabaseSync {
		if (!this.database || !this.initialized)
			throw new Error(
				"Job repository is not initialized. Call initialize() first.",
			);
		return this.database;
	}

	private isCapacityError(error: unknown): boolean {
		return (
			error instanceof Error &&
			/^Database size limit \(\d+\) reached/.test(error.message)
		);
	}
}

/** Stable opaque fallback used by callers that require an ID for an Indeed URL. */
export function createIndeedIdentity(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}
