import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { JobInterface } from "./models";

// Security constants
const MAX_DB_SIZE = 10000; // Prevent memory exhaustion attacks
const MAX_JOB_TITLE_LENGTH = 200;
const MAX_JOB_COMPANY_LENGTH = 100;
const LINKEDIN_URL_REGEX =
	/^https?:\/\/(www\.)?linkedin\.com\/jobs\/view\/[^/]+\/(\d+)([?&]|$)/;
const LINKEDIN_ID_REGEX = /-(\d+)\?$/;

export interface JobDBEntry {
	linkedInJobId: string;
	company: string;
	title: string;
	admitTime: number; // Unix timestamp in milliseconds
	lastProcessed?: number; // Unix timestamp in milliseconds
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
				console.warn(
					"Some database entries were invalid and were filtered out",
				);
			}

			this.db = validatedEntries;
			this.isLoaded = true;
			this.operationsCount++;
		} catch (error) {
			const errorCode = (error as { code?: string }).code;
			if (errorCode === "ENOENT") {
				// File doesn't exist, start with empty database
				this.db = [];
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
			await fs.promises.writeFile(this.config.dbFilePath, fileContent, "utf-8");
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
		const validEntries = entries.filter((entry) => this.validateEntry(entry));
		this.db.push(...validEntries);
		await this.save();
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
			await this.save();
		}

		return removedCount;
	}

	/**
	 * Check if a job matches any entry in the database (by company + title)
	 * @param job The job to check
	 * @param excludeId Optional LinkedIn job ID to exclude from matching (for updates)
	 * @returns True if job is found in database, false otherwise
	 */
	isJobMatched(job: JobInterface, excludeId?: string): boolean {
		if (!this.config.enableJobDB) {
			return false;
		}

		if (!this.isLoaded) {
			throw new Error("Job database not loaded. Call load() first.");
		}

		if (!this.validateJobInput(job)) {
			return false;
		}

		const normalizedCompany = this.normalizeString(job.company || "");
		const normalizedTitle = this.normalizeString(job.title || "");

		return this.db.some((entry) => {
			// Skip if this is the same LinkedIn job ID we're excluding
			if (excludeId && entry.linkedInJobId === excludeId) {
				return false;
			}

			const entryCompany = this.normalizeString(entry.company);
			const entryTitle = this.normalizeString(entry.title);

			return (
				entryCompany === normalizedCompany && entryTitle === normalizedTitle
			);
		});
	}

	/**
	 * Add a job to the database with validation
	 * @param job The job to add
	 * @param linkedInJobId The LinkedIn job ID (can be extracted from job.url if not provided)
	 */
	async addJob(job: JobInterface, linkedInJobId?: string): Promise<void> {
		if (!this.config.enableJobDB) {
			return;
		}

		if (!this.isLoaded) {
			throw new Error("Job database not loaded. Call load() first.");
		}

		if (!this.validateJobInput(job)) {
			throw new Error("Invalid job input: missing required fields");
		}

		// Check database size limit
		if (this.db.length >= (this.config.maxDbSize ?? Number.MAX_SAFE_INTEGER)) {
			await this.cleanupExpired();
			if (
				this.db.length >= (this.config.maxDbSize ?? Number.MAX_SAFE_INTEGER)
			) {
				throw new Error(
					`Database size limit (${this.config.maxDbSize}) reached`,
				);
			}
		}

		if (!linkedInJobId) {
			linkedInJobId = this.extractLinkedInJobId(job);
		}

		const entry: JobDBEntry = {
			linkedInJobId,
			company: job.company || "",
			title: job.title || "",
			admitTime: Date.now(),
			lastProcessed: Date.now(),
		};

		this.db.push(entry);
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
	getEntriesPaginated(page: number = 0, pageSize: number = 100): JobDBEntry[] {
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
	 * Extract LinkedIn job ID from job URL with security validation
	 */
	private extractLinkedInJobId(job: JobInterface): string {
		if (job.id) {
			return this.sanitizeJobId(job.id);
		}

		if (job.url) {
			// Validate URL format first
			if (!this.isValidLinkedInUrl(job.url)) {
				throw new Error(`Invalid LinkedIn URL: ${job.url}`);
			}

			// Try to extract ID using the specific LinkedIn pattern
			const linkedinIdMatch = job.url.match(LINKEDIN_ID_REGEX);
			if (linkedinIdMatch) {
				return this.sanitizeJobId(linkedinIdMatch[1]);
			}

			// Try to extract ID from URL pattern
			const urlMatch = job.url.match(LINKEDIN_URL_REGEX);
			if (urlMatch) {
				return this.sanitizeJobId(urlMatch[2]);
			}
		}

		// Generate secure hash as fallback
		return this.generateSecureHash(job.title || "unknown", job.url || "");
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

		return {
			totalEntries: this.db.length,
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
			console.log(`Database backup created: ${backupPath}`);
		} catch (error) {
			console.error(
				`Failed to create database backup: ${this.formatError(error)}`,
			);
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
				console.log("JobDB: Saving pending changes before closing...");
				await this.save();
			}

			// Mark as unloaded to prevent further operations
			this.isLoaded = false;
			console.log("JobDB: Closed successfully");
		} catch (error) {
			console.error(`Error closing job database: ${this.formatError(error)}`);
			// Don't throw - we want to ensure the process can exit
		}
	}

	// Private helper methods

	/**
	 * Validate job input
	 */
	private validateJobInput(job: JobInterface): boolean {
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
	private generateSecureHash(title: string, url: string): string {
		const data = `${title}:${url}:${Date.now()}`;
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
		console.log("JobDB: Backup timer disabled to prevent freezing");
		/*
    this.backupTimer = setInterval(() => {
      this.createBackup();
    }, this.config.backupIntervalMs);
    */
	}
}
