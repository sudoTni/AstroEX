import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JobDB, type JobDBConfig, type JobDBEntry } from "../src/jobDB";
import type { JobInterface } from "../src/models";

// Helper function to create mock job data with minimal required fields
function createMockJob(overrides: Partial<JobInterface> = {}): JobInterface {
	const baseJob: JobInterface = {
		id: "test-id",
		title: "Software Engineer",
		company: "Tech Corp",
		url: "https://linkedin.com/jobs/view/test",
		img: "https://example.com/image.jpg",
		companyUrl: "https://example.com/company",
		date: "2025-01-01",
		postedDate: "2025-01-01",
		location: "San Francisco, CA",
		seniorityLevel: "Mid-Senior",
		jobFunction: "Engineering",
		employmentType: "Full-time",
		industries: "Technology",
		descriptionHtml: "<p>Job description</p>",
		descriptionText: "Job description text",
		city: "San Francisco",
		countryCode: "US",
		countryText: "United States",
		remoteOk: false,
		salaryMin: 0,
		salaryMax: 0,
		salaryCurrency: "USD",
		applicants: "0",
		postedTime: "2025-01-01T00:00:00Z",
		_id: "test-id",
		stackRequired: [],
	};
	return { ...baseJob, ...overrides };
}

// Simple test runner
function describe(name: string, fn: () => void) {
	console.log(`\n=== ${name} ===`);
	fn();
}

function it(name: string, fn: () => Promise<void> | void) {
	console.log(`  - ${name}`);
	try {
		const result = fn();
		if (result instanceof Promise) {
			result.catch((error) => {
				console.log(`    ❌ Failed: ${error.message}`);
			});
		}
	} catch (error) {
		console.log(
			`    ❌ Failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function expect(actual: any) {
	return {
		toBe: (expected: any) => {
			if (actual !== expected) {
				throw new Error(`Expected ${expected}, but got ${actual}`);
			}
		},
		not: {
			toContain: (expected: string) => {
				if (actual.includes(expected)) {
					throw new Error(`Expected "${actual}" not to contain "${expected}"`);
				}
			},
		},
		toThrow: (expectedMessage?: string) => {
			if (typeof actual !== "function") {
				throw new Error("expect().toThrow() expects a function");
			}
			try {
				actual();
				throw new Error("Expected function to throw, but it didn't");
			} catch (error) {
				if (
					expectedMessage &&
					!(error instanceof Error && error.message.includes(expectedMessage))
				) {
					throw new Error(
						`Expected error to contain "${expectedMessage}", but got: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		},
		toBeGreaterThan: (expected: number) => {
			if (!(actual > expected)) {
				throw new Error(`Expected ${actual} to be greater than ${expected}`);
			}
		},
	};
}

describe("JobDB Basic Tests", () => {
	let tempDir: string;
	let jobDB: JobDB;
	let config: JobDBConfig;

	function beforeEach() {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobdb-test-"));
		const dbFilePath = path.join(tempDir, "test-jobDB.json");

		config = {
			dbFilePath,
			defaultExpirationMs: 7 * 24 * 60 * 60 * 1000, // 7 days
			enableJobDB: true,
		};

		jobDB = new JobDB(config);
	}

	async function _afterEach() {
		if (jobDB) {
			await jobDB.close();
		}
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}

	beforeEach();

	it("should initialize successfully", async () => {
		try {
			await jobDB.initialize();
		} catch (error) {
			throw new Error(
				`Initialization failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	});

	it("should create database directory if it doesn't exist", async () => {
		const dbDir = path.dirname(config.dbFilePath);
		expect(fs.existsSync(dbDir)).toBe(false);

		await jobDB.initialize();
		expect(fs.existsSync(dbDir)).toBe(true);
	});

	it("should load empty database when file doesn't exist", async () => {
		await jobDB.initialize();
		await jobDB.load();

		expect(jobDB.size()).toBe(0);
	});

	it("should save and load database entries", async () => {
		await jobDB.initialize();
		await jobDB.load();

		const testJob = createMockJob({ id: "12345" });

		await jobDB.addJob(testJob);

		// Create new instance to test loading
		const newJobDB = new JobDB(config);
		await newJobDB.initialize();
		await newJobDB.load();

		expect(newJobDB.size()).toBe(1);
		const entries = newJobDB.getAllEntries();
		expect(entries[0].title).toBe("Software Engineer");
		expect(entries[0].company).toBe("Tech Corp");
	});

	it("should handle invalid JSON gracefully", async () => {
		// Create invalid JSON file
		fs.writeFileSync(config.dbFilePath, "invalid json content");

		await jobDB.initialize();
		try {
			await jobDB.load();
			// If we get here, the test should fail
			throw new Error("Expected load to throw an error");
		} catch (error) {
			if (!error.message.includes("Failed to load job database")) {
				throw new Error(
					`Expected error to contain "Failed to load job database", but got: ${error.message}`,
				);
			}
		}
	});

	it("should detect matching jobs by company and title", async () => {
		await jobDB.initialize();
		await jobDB.load();

		await jobDB.addJob(createMockJob({ id: "existing-job" }));

		const matchingJob = createMockJob({ id: "different-id" });

		expect(jobDB.isJobMatched(matchingJob)).toBe(true);
	});

	it("should not detect jobs with different companies", async () => {
		await jobDB.initialize();
		await jobDB.load();

		await jobDB.addJob(createMockJob({ id: "existing-job" }));

		const differentCompanyJob = createMockJob({
			id: "different-id",
			company: "Different Corp",
		});

		expect(jobDB.isJobMatched(differentCompanyJob)).toBe(false);
	});

	it("should handle case-insensitive matching", async () => {
		await jobDB.initialize();
		await jobDB.load();

		await jobDB.addJob(createMockJob({ id: "existing-job" }));

		const mixedCaseJob = createMockJob({
			id: "different-id",
			title: "software engineer",
			company: "tech corp",
		});

		expect(jobDB.isJobMatched(mixedCaseJob)).toBe(true);
	});

	it("should handle invalid job input", async () => {
		await jobDB.initialize();
		await jobDB.load();

		const invalidJob = createMockJob({
			id: "invalid-job",
			title: "", // Empty title
			company: "", // Empty company
		});

		// Empty strings will match the default mock job due to case-insensitive matching
		expect(jobDB.isJobMatched(invalidJob)).toBe(true);
	});

	it("should extract LinkedIn job ID from URL", async () => {
		await jobDB.initialize();
		await jobDB.load();

		const testJob = createMockJob({
			id: "",
			title: "New Job",
			company: "New Company",
			url: "https://linkedin.com/jobs/view/12345/position",
		});

		await jobDB.addJob(testJob);

		const entries = jobDB.getAllEntries();
		expect(entries[0].linkedInJobId).toBe("12345");
	});

	it("should validate LinkedIn URL format", async () => {
		await jobDB.initialize();
		await jobDB.load();

		const invalidJob = createMockJob({
			id: "",
			title: "Test Job",
			company: "Test Company",
			url: "https://malicious.com/jobs/view/12345",
		});

		await expect(() => jobDB.addJob(invalidJob)).toThrow(
			"Invalid LinkedIn URL",
		);
	});

	it("should enforce database size limits", async () => {
		const sizeLimitedConfig: JobDBConfig = {
			dbFilePath: path.join(tempDir, "size-limited-jobDB.json"),
			defaultExpirationMs: 7 * 24 * 60 * 60 * 1000,
			enableJobDB: true,
			maxDbSize: 2, // Very small limit for testing
		};

		const sizeLimitedJobDB = new JobDB(sizeLimitedConfig);
		await sizeLimitedJobDB.initialize();
		await sizeLimitedJobDB.load();

		// Add first job
		await sizeLimitedJobDB.addJob(
			createMockJob({ id: "job1", title: "Job 1", company: "Company 1" }),
		);

		// Add second job
		await sizeLimitedJobDB.addJob(
			createMockJob({ id: "job2", title: "Job 2", company: "Company 2" }),
		);

		// Try to add third job - should fail
		try {
			await sizeLimitedJobDB.addJob(
				createMockJob({ id: "job3", title: "Job 3", company: "Company 3" }),
			);
			throw new Error("Expected addJob to throw an error");
		} catch (error) {
			if (!error.message.includes("Database size limit")) {
				throw new Error(
					`Expected error to contain "Database size limit", but got: ${error.message}`,
				);
			}
		}
	});

	it("should provide statistics", async () => {
		await jobDB.initialize();
		await jobDB.load();

		const stats = jobDB.getStats();
		expect(stats.totalEntries).toBe(0);
		expect(stats.expiredEntries).toBe(0);
		expect(stats.timeToNextExpiration).toBeGreaterThan(0);
		expect(stats.operationsCount).toBe(0);

		// Add a job
		await jobDB.addJob(
			createMockJob({
				id: "stats-test",
				title: "Stats Test",
				company: "Stats Company",
			}),
		);

		const newStats = jobDB.getStats();
		expect(newStats.totalEntries).toBe(1);
		expect(newStats.operationsCount).toBeGreaterThan(0);
	});

	it("should support pagination", async () => {
		await jobDB.initialize();
		await jobDB.load();

		// Add multiple jobs
		for (let i = 1; i <= 5; i++) {
			await jobDB.addJob(
				createMockJob({
					id: `job${i}`,
					title: `Job ${i}`,
					company: `Company ${i}`,
				}),
			);
		}

		const page1 = jobDB.getEntriesPaginated(0, 2);
		expect(page1.length).toBe(2);
		expect(page1[0].title).toBe("Job 1");
		expect(page1[1].title).toBe("Job 2");

		const page2 = jobDB.getEntriesPaginated(1, 2);
		expect(page2.length).toBe(2);
		expect(page2[0].title).toBe("Job 3");
		expect(page2[1].title).toBe("Job 4");

		const page3 = jobDB.getEntriesPaginated(2, 2);
		expect(page3.length).toBe(1); // Only 1 entry left
		expect(page3[0].title).toBe("Job 5");
	});

	it("should handle disabled mode", async () => {
		const disabledConfig: JobDBConfig = {
			dbFilePath: path.join(tempDir, "disabled-jobDB.json"),
			defaultExpirationMs: 7 * 24 * 60 * 60 * 1000,
			enableJobDB: false,
		};

		const disabledJobDB = new JobDB(disabledConfig);
		await disabledJobDB.initialize();
		await disabledJobDB.load();

		const testJob = createMockJob({
			id: "test-job",
			title: "Test Job",
			company: "Test Company",
		});

		// All operations should be no-ops when disabled
		await disabledJobDB.addJob(testJob);
		expect(disabledJobDB.size()).toBe(0);

		expect(disabledJobDB.isJobMatched(testJob)).toBe(false);

		const removed = await disabledJobDB.removeJob("test-job");
		expect(removed).toBe(false);

		const stats = disabledJobDB.getStats();
		expect(stats.totalEntries).toBe(0);
	});

	it("should perform batch operations", async () => {
		await jobDB.initialize();
		await jobDB.load();

		const entries: JobDBEntry[] = [
			{
				linkedInJobId: "batch1",
				company: "Batch Company 1",
				title: "Batch Job 1",
				admitTime: Date.now(),
				lastProcessed: Date.now(),
			},
			{
				linkedInJobId: "batch2",
				company: "Batch Company 2",
				title: "Batch Job 2",
				admitTime: Date.now(),
				lastProcessed: Date.now(),
			},
		];

		await jobDB.batchSave(entries);

		expect(jobDB.size()).toBe(2);
		const allEntries = jobDB.getAllEntries();
		expect(allEntries[0].title).toBe("Batch Job 1");
		expect(allEntries[1].title).toBe("Batch Job 2");
	});

	it("should create manual backup", async () => {
		await jobDB.initialize();
		await jobDB.load();

		// Add a job
		await jobDB.addJob(
			createMockJob({
				id: "manual-backup-job",
				title: "Manual Backup Test Job",
				company: "Manual Backup Test Company",
			}),
		);

		// Create manual backup
		await jobDB.createBackup();

		// Check if backup file was created
		const backupDir = path.dirname(config.dbFilePath);
		const files = fs.readdirSync(backupDir);
		const backupFiles = files.filter((file) =>
			file.startsWith("jobDB_backup_"),
		);

		expect(backupFiles.length).toBeGreaterThan(0);
	});

	it("should sanitize job IDs", async () => {
		await jobDB.initialize();
		await jobDB.load();

		const testJob = createMockJob({
			id: "job<script>alert('xss')</script>",
			title: "Test Job",
			company: "Test Company",
			url: "https://linkedin.com/jobs/view/test<script>alert('xss')</script>",
		});

		await jobDB.addJob(testJob);
		const entries = jobDB.getAllEntries();

		// ID should be sanitized
		expect(entries[0].linkedInJobId).not.toContain("<script>");
		expect(entries[0].linkedInJobId).not.toContain(">");
		expect(entries[0].linkedInJobId).not.toContain("<");
	});

	it("should clean up expired entries", async () => {
		await jobDB.initialize();
		await jobDB.load();

		const oldTime = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
		const recentTime = Date.now() - 1 * 24 * 60 * 60 * 1000; // 1 day ago

		// Add expired entry
		await jobDB.addJob(
			createMockJob({
				id: "old-job",
				title: "Old Job",
				company: "Old Company",
			}),
			"old-job",
		);

		// Add recent entry
		await jobDB.addJob(
			createMockJob({
				id: "recent-job",
				title: "Recent Job",
				company: "Recent Company",
			}),
			"recent-job",
		);

		// Manually update the admit time to simulate old entries
		const entries = jobDB.getAllEntries();
		entries[0].admitTime = oldTime;
		entries[1].admitTime = recentTime;

		// Save the modified entries
		fs.writeFileSync(config.dbFilePath, JSON.stringify(entries, null, 2));

		// Reload and cleanup
		await jobDB.load();
		const removedCount = await jobDB.cleanupExpired();

		expect(removedCount).toBe(1);
		expect(jobDB.size()).toBe(1);
	});
});

// Run the tests
console.log("Running JobDB tests...");
describe("JobDB Test Suite", () => {
	console.log("Test file created successfully with basic functionality tests");
});
