import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "./utils";

// The database is intentionally large enough to retain a busy 30-day search
// window.  A smaller configured limit is still respected, but capacity
// handling evicts discovery-only entries before it ever evicts a JD/judging
// checkpoint.
const MAX_DB_SIZE = 250_000;
const MAX_JOB_TITLE_LENGTH = 200;
const MAX_JOB_COMPANY_LENGTH = 100;
const LINKEDIN_URL_REGEX =
	/^https?:\/\/(www\.)?linkedin\.com\/jobs\/view\/[^/]+\/(\d+)([?&]|$)/;
const LINKEDIN_ID_REGEX = /-(\d+)\?$/;

export interface JobDBEntry {
	linkedInJobId: string;
	/** Legacy field name retained for on-disk compatibility; source disambiguates it. */
	source?: "linkedin" | "indeed";
	sourceJobId?: string;
	company: string;
	title: string;
	admitTime: number; // Unix timestamp in milliseconds
	descriptionScrapedAt?: number; // Set after scrape-jobs successfully persists the JD
	lastProcessed?: number; // Unix timestamp in milliseconds
	searchOnly?: boolean; // True until the job reaches jobJudge
}

export interface JobIdentity {
	id?: string;
	source?: "linkedin" | "indeed";
	sourceJobId?: string;
	title: string;
	company: string;
	url?: string;
	location?: string;
	descriptionHtml?: string;
}

export interface JobDBConfig {
	dbFilePath: string;
	defaultExpirationMs: number;
	enableJobDB: boolean;
	maxDbSize?: number;
	backupEnabled?: boolean;
	backupIntervalMs?: number;
}

export interface JobDBStats {
	totalEntries: number;
	discoveryOnlyEntries: number;
	descriptionCheckpointEntries: number;
	judgedEntries: number;
	capacity: number;
	expiredEntries: number;
	timeToNextExpiration: number;
	lastBackupTime?: number;
	operationsCount: number;
}

export class JobDB {
	private config: JobDBConfig;
	private db: JobDBEntry[] = [];
	private isLoaded = false;
	private pendingSave = false;
	private backupTimer?: NodeJS.Timeout;
	private operationsCount = 0;
	private cache: Map<string, JobDBEntry[]> = new Map();
	private sourceIdIndex: Map<string, JobDBEntry> = new Map();
	private fallbackIndex: Map<string, JobDBEntry> = new Map();
	private lastCacheUpdate = 0;
	private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

	constructor(config: JobDBConfig) {
		this.config = {
			maxDbSize: MAX_DB_SIZE,
			backupEnabled: true,
			backupIntervalMs: 24 * 60 * 60 * 1000, // 24 hours
			...config,
		};

		// Don't start backup timer in constructor - start it after initialization
	}

	/**
	 * Initialize the job database - create directory if it doesn't exist
	 */
	async initialize(): Promise<void> {
		if (!this.config.enableJobDB) {
			return;
		}

		const dbDir = path.dirname(this.config.dbFilePath);
		try {
			await fs.promises.mkdir(dbDir, { recursive: true });
		} catch (error) {
			const errorCode = (error as { code?: string }).code;
			if (errorCode !== "EEXIST") {
				throw new Error(`Failed to create database directory: ${errorCode}`);
			}
		}

		// Start backup timer after initialization
		if (this.config.backupEnabled) {
			this.startBackupTimer();
		}
	}

	/**
	 * Load job database from file with validation
	 */
	async load(): Promise<void> {
		if (!this.config.enableJobDB) {
			this.db = [];
			this.isLoaded = true;
			return;
		}

		try {
			const fileContent = await fs.promises.readFile(
				this.config.dbFilePath,
				"utf-8",
			);
			const data = JSON.parse(fileContent);

			// Validate loaded data structure
			if (!Array.isArray(data)) {
				throw new Error("Invalid database format: expected array");
			}

			// Validate each entry
			const validatedEntries = data.filter((entry) =>
				this.validateEntry(entry),
			);
			if (validatedEntries.length !== data.length) {
				log("JobDB", "Discarded invalid database entries during load", "warn", {
					invalidEntryCount: data.length - validatedEntries.length,
				});
			}

			this.db = validatedEntries;
			this.rebuildIndexes();
			this.isLoaded = true;
			this.operationsCount++;
		} catch (error) {
			const errorCode = (error as { code?: string }).code;
			if (errorCode === "ENOENT") {
				// File doesn't exist, start with empty database
				this.db = [];
				this.rebuildIndexes();
				this.isLoaded = true;
				await this.save(); // Create the file
			} else {
				throw new Error(
					`Failed to load job database: ${this.formatError(error)}`,
				);
			}
		}
	}

	/**
	 * Save job database to file with error handling
	 */
	async save(): Promise<void> {
		if (!this.config.enableJobDB) {
			return;
		}

		if (!this.isLoaded) {
			throw new Error("Job database not loaded. Call load() first.");
		}

		// Debounce saves to prevent excessive I/O
		if (this.pendingSave) {
			return;
		}

		this.pendingSave = true;
		try {
			const fileContent = JSON.stringify(this.db, null, 2);
			const tempPath = `${this.config.dbFilePath}.${process.pid}.${Date.now()}.tmp`;
			await fs.promises.writeFile(tempPath, fileContent, "utf-8");
			await fs.promises.rename(tempPath, this.config.dbFilePath);
			this.pendingSave = false;
			this.operationsCount++;
		} catch (error) {
			this.pendingSave = false;
			throw new Error(
				`Failed to save job database: ${this.formatError(error)}`,
			);
		}
	}

	/**
	 * Batch save multiple entries to reduce I/O operations
	 */
	async batchSave(entries: JobDBEntry[]): Promise<void> {
		if (!this.config.enableJobDB) {
			return;
		}

		if (!this.isLoaded) {
			throw new Error("Job database not loaded. Call load() first.");
		}

		// Validate entries before adding
		let changed = false;
		for (const entry of entries) {
			if (!this.validateEntry(entry)) continue;
			const identity: JobIdentity = {
				id: entry.sourceJobId ?? entry.linkedInJobId,
				source: this.entrySource(entry),
				title: entry.title,
				company: entry.company,
			};
			const existing = this.findEntry(identity);
			if (existing) {
				this.mergeEntry(existing, entry);
				changed = true;
				continue;
			}
			await this.ensureCapacity();
			this.db.push(entry);
			changed = true;
		}
		if (changed) {
			this.rebuildIndexes();
			this.clearCache();
			await this.save();
		}
	}

	/**
	 * Clean up expired entries from the database
	 * @returns Number of entries removed
	 */
	async cleanupExpired(): Promise<number> {
		if (!this.config.enableJobDB) {
			return 0;
		}

		if (!this.isLoaded) {
			throw new Error("Job database not loaded. Call load() first.");
		}

		const now = Date.now();
		const initialLength = this.db.length;

		this.db = this.db.filter((entry) => {
			return now - entry.admitTime < this.config.defaultExpirationMs;
		});

		const removedCount = initialLength - this.db.length;

		if (removedCount > 0) {
			this.rebuildIndexes();
			this.clearCache();
			await this.save();
		}

		return removedCount;
	}

	/**
	 * Check if a job matches a judged entry. Stable source IDs are authoritative;
	 * company + title is used only when an ID is unavailable.
	 * @param job The job to check
	 * @param excludeId Optional LinkedIn job ID to exclude from matching (for updates)
	 * @returns True if job is found in database, false otherwise
	 */
	isJobMatched(job: JobIdentity, excludeId?: string): boolean {
		if (!this.config.enableJobDB) {
			return false;
		}

		if (!this.isLoaded) {
			throw new Error("Job database not loaded. Call load() first.");
		}

		if (!this.validateJobInput(job)) {
			return false;
		}

		const entry = this.findEntry(job);
		if (!entry || !this.entryIsActive(entry) || entry.searchOnly) return false;

		const excludedId = excludeId ? this.sanitizeJobId(excludeId) : undefined;
		return entry.linkedInJobId !== excludedId;
	}

	/**
	 * Check whether this exact LinkedIn job was discovered or judged recently.
	 * Company/title matching is used only when a stable LinkedIn ID is unavailable.
	 */
	isJobSeen(job: JobIdentity): boolean {
		if (!this.config.enableJobDB) {
			return false;
		}

		if (!this.isLoaded) {
			throw new Error("Job database not loaded. Call load() first.");
		}

		if (!this.validateJobInput(job)) {
			return false;
		}

		const entry = this.findEntry(job);
		return !!entry && this.entryIsActive(entry);
	}

	/**
	 * Check whether scrape-jobs has already persisted this job description.
	 * Legacy judged entries are also treated as already scraped. Search-only
	 * entries without a description checkpoint remain eligible for scraping.
	 */
	isJobDescriptionScraped(job: JobIdentity): boolean {
		if (!this.config.enableJobDB) {
			return false;
		}

		if (!this.isLoaded) {
			throw new Error("Job database not loaded. Call load() first.");
		}

		if (!this.validateJobInput(job)) {
			return false;
		}

		const entry = this.findEntry(job);
		return (
			!!entry &&
			this.entryIsActive(entry) &&
			this.entryHasScrapedDescription(entry)
		);
	}

	/**
	 * Check a JD checkpoint when a caller has only the job URL. This is used by
	 * the single-job scraper before the page is fetched; title and company are
	 * unavailable until after that fetch, but the canonical provider URL is
	 * already a stable identity.
	 */
	isJobDescriptionUrlScraped(url: string): boolean {
		if (!this.config.enableJobDB) return false;
		if (!this.isLoaded) {
			throw new Error("Job database not loaded. Call load() first.");
		}
		if (!url?.trim()) return false;

		const linkedInJobId = this.linkedInJobIdFromUrl(url);
		const entry =
			(linkedInJobId
				? this.sourceIdIndex.get(this.sourceIdKey("linkedin", linkedInJobId))
				: undefined) ?? this.findEntry({ title: "", company: "", url });
		return (
			!!entry &&
			this.entryIsActive(entry) &&
			this.entryHasScrapedDescription(entry)
		);
	}

	/**
	 * Record jobs discovered by scrape-search without marking them as judged.
	 * Existing entries and duplicates within the batch are ignored.
	 * @returns Number of new entries added.
	 */
	async addSearchedJobs(jobs: JobIdentity[]): Promise<number> {
		if (!this.config.enableJobDB) {
			return 0;
		}

		if (!this.isLoaded) {
			throw new Error("Job database not loaded. Call load() first.");
		}

		let addedCount = 0;
		const pendingIdentities = new Set<string>();
		for (let index = 0; index < jobs.length; index++) {
			const job = jobs[index];
			if (!this.validateJobInput(job)) continue;
			const identityKey = this.jobIdentityKey(job);
			if (pendingIdentities.has(identityKey) || this.isJobSeen(job)) {
				continue;
			}

			try {
				await this.ensureCapacity();
			} catch (error) {
				if (!this.isCapacityError(error)) throw error;
				log(
					"JobDB",
					"Discovery capacity is reserved for JD and judgment checkpoints; skipped remaining discovery records",
					"warn",
					{ skipped: jobs.length - index, capacity: this.config.maxDbSize },
				);
				break;
			}

			this.db.push({
				linkedInJobId: this.extractLinkedInJobId(job),
				source: this.sourceFor(job),
				sourceJobId: this.stableSourceId(job),
				company: job.company,
				title: job.title,
				admitTime: Date.now(),
				searchOnly: true,
			});
			pendingIdentities.add(identityKey);
			addedCount++;
		}

		if (addedCount > 0) {
			this.rebuildIndexes();
			this.clearCache();
			await this.save();
		}

		return addedCount;
	}

	/**
	 * Mark a successfully persisted JD without marking it as judged. This keeps
	 * the description download and LLM evaluation checkpoints independent.
	 */
	async markJobDescriptionScraped(
		job: JobIdentity,
		linkedInJobId?: string,
	): Promise<void> {
		if (!this.config.enableJobDB) {
			return;
		}

		if (!this.isLoaded) {
			throw new Error("Job database not loaded. Call load() first.");
		}

		if (!this.validateJobInput(job)) {
			throw new Error("Invalid job input: missing required fields");
		}

		const resolvedLinkedInJobId = linkedInJobId
			? this.sanitizeJobId(linkedInJobId)
			: this.extractLinkedInJobId(job);
		const now = Date.now();
		const source = this.sourceFor(job);
		const existingEntry = this.findEntry(job);

		if (existingEntry) {
			existingEntry.company = job.company;
			existingEntry.title = job.title;
			existingEntry.admitTime = now;
			existingEntry.descriptionScrapedAt = now;
		} else {
			await this.ensureCapacity();

			this.db.push({
				linkedInJobId: resolvedLinkedInJobId,
				source,
				sourceJobId: this.stableSourceId(job),
				company: job.company,
				title: job.title,
				admitTime: now,
				descriptionScrapedAt: now,
				searchOnly: true,
			});
		}

		this.rebuildIndexes();
		this.clearCache();
		await this.save();
	}

	/**
	 * Add a job to the database with validation
	 * @param job The job to add
	 * @param linkedInJobId The LinkedIn job ID (can be extracted from job.url if not provided)
	 */
	async addJob(job: JobIdentity, linkedInJobId?: string): Promise<void> {
		if (!this.config.enableJobDB) {
			return;
		}

		if (!this.isLoaded) {
			throw new Error("Job database not loaded. Call load() first.");
		}

		if (!this.validateJobInput(job)) {
			throw new Error("Invalid job input: missing required fields");
		}

		const resolvedLinkedInJobId = linkedInJobId
			? this.sanitizeJobId(linkedInJobId)
			: this.extractLinkedInJobId(job);

		const source = this.sourceFor(job);
		const existingEntry = this.findEntry(job);
		if (existingEntry) {
			const now = Date.now();
			existingEntry.company = job.company || "";
			existingEntry.title = job.title || "";
			existingEntry.admitTime = now;
			existingEntry.lastProcessed = now;
			existingEntry.searchOnly = undefined;
			this.rebuildIndexes();
			this.clearCache();
			await this.save();
			return;
		}

		await this.ensureCapacity();

		const entry: JobDBEntry = {
			linkedInJobId: resolvedLinkedInJobId,
			source,
			sourceJobId: this.stableSourceId(job),
			company: job.company || "",
			title: job.title || "",
			admitTime: Date.now(),
			lastProcessed: Date.now(),
		};

		this.db.push(entry);
		this.rebuildIndexes();
		this.clearCache(); // Clear cache when data changes
		await this.save();
	}

	/**
	 * Remove a job from the database by LinkedIn job ID
	 * @param linkedInJobId The LinkedIn job ID to remove
	 * @returns True if job was found and removed, false otherwise
	 */
	async removeJob(linkedInJobId: string): Promise<boolean> {
		if (!this.config.enableJobDB) {
			return false;
		}

		if (!this.isLoaded) {
			throw new Error("Job database not loaded. Call load() first.");
		}

		const initialLength = this.db.length;
		this.db = this.db.filter((entry) => entry.linkedInJobId !== linkedInJobId);

		if (this.db.length < initialLength) {
			this.rebuildIndexes();
			this.clearCache();
			await this.save();
			return true;
		}

		return false;
	}

	/**
	 * Get the size of the database
	 */
	size(): number {
		if (!this.isLoaded) {
			throw new Error("Job database not loaded. Call load() first.");
		}
		return this.db.length;
	}

	/**
	 * Get all entries in the database
	 */
	getAllEntries(): JobDBEntry[] {
		if (!this.isLoaded) {
			throw new Error("Job database not loaded. Call load() first.");
		}
		return [...this.db];
	}

	/**
	 * Get entries with pagination support and caching
	 * @param page Page number (0-based)
	 * @param pageSize Number of entries per page
	 * @returns Array of entries for the requested page
	 */
	getEntriesPaginated(page = 0, pageSize = 100): JobDBEntry[] {
		if (!this.isLoaded) {
			throw new Error("Job database not loaded. Call load() first.");
		}

		// Check cache first
		const cacheKey = `page_${page}_${pageSize}`;
		const now = Date.now();

		if (
			this.cache.has(cacheKey) &&
			now - this.lastCacheUpdate < this.CACHE_TTL
		) {
			const cached = this.cache.get(cacheKey);
			return cached || [];
		}

		const start = page * pageSize;
		const end = start + pageSize;
		const result = this.db.slice(start, end);

		// Update cache with size limit to prevent memory bloat
		if (this.cache.size > 10) {
			// Clear oldest cache entry
			const firstKey = this.cache.keys().next().value;
			this.cache.delete(firstKey);
		}

		this.cache.set(cacheKey, result);
		this.lastCacheUpdate = now;

		return result;
	}

	/**
	 * Extract the compatibility ID used by older jobDB files. The exact,
	 * source-qualified identifier is retained separately in sourceJobId.
	 */
	private extractLinkedInJobId(job: JobIdentity): string {
		const sourceId = this.stableSourceId(job);
		if (sourceId) return this.sanitizeJobId(sourceId);

		return this.generateSecureHash(
			this.sourceFor(job),
			this.normalizeString(job.company),
			this.normalizeString(job.title),
		);
	}

	/**
	 * Returns the durable provider identity. For source records that lack an
	 * explicit ID, a canonical URL is still a stable identity. Only records
	 * with neither use the company/title fallback.
	 */
	private stableSourceId(job: JobIdentity): string | undefined {
		const explicitId = job.sourceJobId?.trim() || job.id?.trim();
		if (explicitId) {
			const sourcePrefix = `${this.sourceFor(job)}:`;
			return (
				explicitId.startsWith(sourcePrefix)
					? explicitId.slice(sourcePrefix.length)
					: explicitId
			).slice(0, 512);
		}

		if (!job.url) return undefined;
		try {
			const parsed = new URL(job.url);
			const providerId = ["jk", "vjk", "jobId", "currentJobId", "id"]
				.map((name) => [name, parsed.searchParams.get(name)] as const)
				.find(([, value]) => !!value);
			parsed.hash = "";
			parsed.search = "";
			const canonicalUrl = `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/$/, "")}`;
			return providerId
				? `url:${canonicalUrl}?${providerId[0]}=${providerId[1]}`
				: `url:${canonicalUrl}`;
		} catch {
			return undefined;
		}
	}

	/**
	 * Get statistics about the database
	 */
	getStats(): JobDBStats {
		if (!this.isLoaded) {
			throw new Error("Job database not loaded. Call load() first.");
		}

		const now = Date.now();
		const expiredEntries = this.db.filter(
			(entry) => now - entry.admitTime >= this.config.defaultExpirationMs,
		).length;

		// Find the earliest expiration time
		const nextExpiration =
			this.db.length > 0
				? Math.min(
						...this.db.map(
							(entry) => entry.admitTime + this.config.defaultExpirationMs,
						),
					)
				: now;

		const discoveryOnlyEntries = this.db.filter(
			(entry) =>
				entry.searchOnly === true && !this.entryHasScrapedDescription(entry),
		).length;
		const descriptionCheckpointEntries = this.db.filter(
			(entry) =>
				entry.searchOnly === true && this.entryHasScrapedDescription(entry),
		).length;

		return {
			totalEntries: this.db.length,
			discoveryOnlyEntries,
			descriptionCheckpointEntries,
			judgedEntries:
				this.db.length - discoveryOnlyEntries - descriptionCheckpointEntries,
			capacity: this.config.maxDbSize ?? Number.MAX_SAFE_INTEGER,
			expiredEntries,
			timeToNextExpiration: Math.max(0, nextExpiration - now),
			operationsCount: this.operationsCount,
		};
	}

	/**
	 * Create backup of the database
	 */
	async createBackup(): Promise<void> {
		if (!this.config.enableJobDB || !this.config.backupEnabled) {
			return;
		}

		try {
			const backupDir = path.dirname(this.config.dbFilePath);
			const backupFileName = `jobDB_backup_${Date.now()}.json`;
			const backupPath = path.join(backupDir, backupFileName);

			await fs.promises.writeFile(
				backupPath,
				JSON.stringify(this.db, null, 2),
				"utf-8",
			);
			log("JobDB", "Created database backup", "info", { backupPath });
		} catch (error) {
			log("JobDB", "Failed to create database backup", "error", {
				error: this.formatError(error),
			});
		}
	}

	/**
	 * Close the database and cleanup resources
	 */
	async close(): Promise<void> {
		try {
			// Clear backup timer if it exists
			if (this.backupTimer) {
				clearInterval(this.backupTimer);
				this.backupTimer = undefined;
			}

			// Save any pending changes
			if (this.pendingSave) {
				log("JobDB", "Saving pending database changes", "debug");
				await this.save();
			}

			// Mark as unloaded to prevent further operations
			this.isLoaded = false;
			log("JobDB", "Database closed", "debug");
		} catch (error) {
			log("JobDB", "Failed to close database cleanly", "error", {
				error: this.formatError(error),
			});
			// Don't throw - we want to ensure the process can exit
		}
	}

	// Private helper methods

	/**
	 * Validate job input
	 */
	private validateJobInput(job: JobIdentity): boolean {
		if (!job || typeof job !== "object") {
			return false;
		}

		if (!job.title || !job.company) {
			return false;
		}

		if (job.title.length > MAX_JOB_TITLE_LENGTH) {
			return false;
		}

		if (job.company.length > MAX_JOB_COMPANY_LENGTH) {
			return false;
		}

		return true;
	}

	/**
	 * Validate database entry
	 */
	private validateEntry(entry: unknown): entry is JobDBEntry {
		return (
			!!entry &&
			typeof entry === "object" &&
			entry !== null &&
			"linkedInJobId" in entry &&
			"company" in entry &&
			"title" in entry &&
			"admitTime" in entry &&
			typeof entry.linkedInJobId === "string" &&
			typeof entry.company === "string" &&
			typeof entry.title === "string" &&
			typeof entry.admitTime === "number"
		);
	}

	/** Legacy entries without provenance originated in AstroEX's LinkedIn-only flow. */
	private entrySource(entry: JobDBEntry): "linkedin" | "indeed" {
		return entry.source ?? "linkedin";
	}

	private sourceFor(job: JobIdentity): "linkedin" | "indeed" {
		if (job.source) return job.source;
		return job.url && !this.isValidLinkedInUrl(job.url) ? "indeed" : "linkedin";
	}

	/** A judged legacy/current entry necessarily passed the JD download stage. */
	private entryHasScrapedDescription(entry: JobDBEntry): boolean {
		return (
			typeof entry.descriptionScrapedAt === "number" ||
			entry.searchOnly !== true
		);
	}

	private entryIsActive(entry: JobDBEntry): boolean {
		return Date.now() - entry.admitTime < this.config.defaultExpirationMs;
	}

	private sourceIdKey(
		source: "linkedin" | "indeed",
		sourceJobId: string,
	): string {
		return `${source}\u0000${sourceJobId}`;
	}

	private fallbackKey(job: JobIdentity): string {
		return `${this.sourceFor(job)}\u0000${this.normalizeString(job.company)}\u0000${this.normalizeString(job.title)}`;
	}

	private jobIdentityKey(job: JobIdentity): string {
		const source = this.sourceFor(job);
		const sourceId = this.stableSourceId(job);
		return sourceId
			? `id:${this.sourceIdKey(source, sourceId)}`
			: `fallback:${this.fallbackKey(job)}`;
	}

	/** Rebuild O(1) lookup indexes after a database mutation or load. */
	private rebuildIndexes(): void {
		this.sourceIdIndex.clear();
		this.fallbackIndex.clear();
		for (const entry of this.db) {
			const source = this.entrySource(entry);
			const sourceId = entry.sourceJobId?.trim();
			if (sourceId) {
				this.sourceIdIndex.set(this.sourceIdKey(source, sourceId), entry);
			}
			this.sourceIdIndex.set(
				this.sourceIdKey(source, entry.linkedInJobId),
				entry,
			);
			this.fallbackIndex.set(
				this.fallbackKey({
					source,
					company: entry.company,
					title: entry.title,
				}),
				entry,
			);
		}
	}

	/**
	 * Finds by stable source ID when available. Fallback matching is deliberately
	 * limited to records without an ID, so separate listings with the same title
	 * and employer do not block each other.
	 */
	private findEntry(job: JobIdentity): JobDBEntry | undefined {
		const source = this.sourceFor(job);
		const sourceId = this.stableSourceId(job);
		if (sourceId) {
			return (
				this.sourceIdIndex.get(this.sourceIdKey(source, sourceId)) ??
				this.sourceIdIndex.get(
					this.sourceIdKey(source, this.sanitizeJobId(sourceId)),
				)
			);
		}
		return this.fallbackIndex.get(this.fallbackKey(job));
	}

	private mergeEntry(target: JobDBEntry, incoming: JobDBEntry): void {
		target.source = incoming.source ?? target.source;
		target.sourceJobId = incoming.sourceJobId ?? target.sourceJobId;
		target.company = incoming.company;
		target.title = incoming.title;
		target.admitTime = Math.max(target.admitTime, incoming.admitTime);
		target.descriptionScrapedAt =
			Math.max(
				target.descriptionScrapedAt ?? 0,
				incoming.descriptionScrapedAt ?? 0,
			) || undefined;
		target.lastProcessed =
			Math.max(target.lastProcessed ?? 0, incoming.lastProcessed ?? 0) ||
			undefined;
		if (target.lastProcessed || incoming.searchOnly !== true) {
			target.searchOnly = undefined;
		}
	}

	/**
	 * Make room without weakening the 30-day JD/judgment guarantee. Discovery
	 * entries are cheap to reacquire, while description and judged checkpoints
	 * are retained for the full window.
	 */
	private async ensureCapacity(entriesNeeded = 1): Promise<void> {
		const capacity = this.config.maxDbSize ?? Number.MAX_SAFE_INTEGER;
		if (this.db.length + entriesNeeded <= capacity) return;

		await this.cleanupExpired();
		if (this.db.length + entriesNeeded <= capacity) return;

		const excess = this.db.length + entriesNeeded - capacity;
		const disposable = this.db
			.filter(
				(entry) =>
					entry.searchOnly === true && !this.entryHasScrapedDescription(entry),
			)
			.sort((left, right) => left.admitTime - right.admitTime)
			.slice(0, excess);
		if (disposable.length > 0) {
			const removable = new Set(disposable);
			this.db = this.db.filter((entry) => !removable.has(entry));
			this.rebuildIndexes();
			this.clearCache();
			log(
				"JobDB",
				"Evicted discovery-only entries to preserve JD checkpoints",
				"warn",
				{
					evicted: disposable.length,
					capacity,
				},
			);
		}

		if (this.db.length + entriesNeeded > capacity) {
			throw new Error(
				`Database size limit (${capacity}) reached; all retained entries are JD or judgment checkpoints`,
			);
		}
	}

	private isCapacityError(error: unknown): boolean {
		return (
			error instanceof Error &&
			/^Database size limit \(\d+\) reached(?:;|$)/.test(error.message)
		);
	}

	/**
	 * Normalize string for comparison (trim, lowercase, remove extra spaces)
	 */
	private normalizeString(str: string): string {
		return str.toLowerCase().trim().replace(/\s+/g, " ");
	}

	/**
	 * Validate LinkedIn URL format
	 */
	private isValidLinkedInUrl(url: string): boolean {
		try {
			const urlObj = new URL(url);
			return (
				urlObj.hostname === "linkedin.com" ||
				urlObj.hostname === "www.linkedin.com"
			);
		} catch {
			return false;
		}
	}

	private linkedInJobIdFromUrl(url: string): string | undefined {
		try {
			const parsed = new URL(url);
			if (!this.isValidLinkedInUrl(url)) return undefined;
			const match = parsed.pathname.match(/(?:-|\/)(\d+)$/);
			return match?.[1];
		} catch {
			return undefined;
		}
	}

	/**
	 * Sanitize job ID to prevent injection attacks
	 */
	private sanitizeJobId(id: string): string {
		// Remove any non-alphanumeric characters except hyphens
		return id.replace(/[^a-zA-Z0-9-]/g, "").substring(0, 20);
	}

	/**
	 * Generate secure hash for job ID
	 */
	private generateSecureHash(...parts: string[]): string {
		const data = parts.join("\u0000");
		return crypto
			.createHash("sha256")
			.update(data)
			.digest("hex")
			.substring(0, 12);
	}

	/**
	 * Format error consistently
	 */
	private formatError(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	/**
	 * Clear cache when data changes
	 */
	private clearCache(): void {
		this.cache.clear();
		this.lastCacheUpdate = 0;
	}

	/**
	 * Start backup timer
	 */
	private startBackupTimer(): void {
		// Disable backup timer for now to prevent freezing
		log("JobDB", "Periodic backup timer is disabled", "debug");
		/*
    this.backupTimer = setInterval(() => {
      this.createBackup();
    }, this.config.backupIntervalMs);
    */
	}
}
