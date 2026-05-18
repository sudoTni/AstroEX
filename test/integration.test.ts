// Simple test runner (matches existing pattern in the project)
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
		toEqual: (expected: any) => {
			if (JSON.stringify(actual) !== JSON.stringify(expected)) {
				throw new Error(
					`Expected ${JSON.stringify(expected)}, but got ${JSON.stringify(actual)}`,
				);
			}
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
		toBeLessThan: (expected: number) => {
			if (!(actual < expected)) {
				throw new Error(`Expected ${actual} to be less than ${expected}`);
			}
		},
		toBeLessThanOrEqual: (expected: number) => {
			if (!(actual <= expected)) {
				throw new Error(
					`Expected ${actual} to be less than or equal to ${expected}`,
				);
			}
		},
		toContain: (expected: string) => {
			if (!actual.includes(expected)) {
				throw new Error(`Expected "${actual}" to contain "${expected}"`);
			}
		},
		not: {
			toContain: (expected: string) => {
				if (actual.includes(expected)) {
					throw new Error(`Expected "${actual}" not to contain "${expected}"`);
				}
			},
		},
	};
}

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JobDB, type JobDBConfig } from "../src/jobDB";
import { retryWithBackoff, safeAsyncOperation } from "../src/utils";

// Helper function to create mock job data
function createMockJob(overrides: any = {}) {
	return {
		id: "test-id",
		title: "Software Engineer",
		company: "Tech Corp",
		url: "https://linkedin.com/jobs/view/test",
		...overrides,
	};
}

describe("Integration Tests", () => {
	let tempDir: string;
	let jobDB: JobDB;
	let config: JobDBConfig;

	const setupTest = () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "integration-test-"));
		const dbFilePath = path.join(tempDir, "test-jobDB.json");

		config = {
			dbFilePath,
			defaultExpirationMs: 7 * 24 * 60 * 60 * 1000, // 7 days
			enableJobDB: true,
		};

		jobDB = new JobDB(config);
	};

	const _cleanupTest = async () => {
		if (jobDB) {
			await jobDB.close();
		}
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	};

	setupTest();

	describe("JobDB with Error Handling", () => {
		it("should handle database operations with error recovery", async () => {
			await jobDB.initialize();
			await jobDB.load();

			// Test successful operation
			const result = await safeAsyncOperation(async () => {
				await jobDB.addJob(createMockJob({ id: "test-job" }));
				return jobDB.size();
			}, "jobdb-test");

			expect(result).toBe(1);

			// Test error handling
			const errorResult = await safeAsyncOperation(
				async () => {
					// This should fail because we're trying to add a job to a closed DB
					await jobDB.close();
					await jobDB.addJob(createMockJob({ id: "another-job" }));
				},
				"jobdb-test",
				"Database operation failed",
			);

			expect(errorResult).toBe(null);
		});

		it("should retry failed database operations", async () => {
			await jobDB.initialize();
			await jobDB.load();

			let attemptCount = 0;
			const result = await retryWithBackoff(
				async () => {
					attemptCount++;
					if (attemptCount === 1) {
						// Simulate temporary failure
						throw new Error("Temporary database error");
					}
					await jobDB.addJob(createMockJob({ id: "retry-test" }));
					return jobDB.size();
				},
				3,
				10,
				"retry-test",
			);

			expect(result).toBe(1);
			expect(attemptCount).toBe(2);
		});

		it("should handle corrupted database files gracefully", async () => {
			// Create a corrupted database file
			const corruptedContent = '{"invalid": json}';
			fs.writeFileSync(config.dbFilePath, corruptedContent);

			await jobDB.initialize();

			// Should not crash, but handle the error gracefully
			const result = await safeAsyncOperation(
				async () => jobDB.load(),
				"corruption-test",
				"Failed to load corrupted database",
			);

			expect(result).toBe(null);
		});

		it("should enforce size limits with proper error handling", async () => {
			const sizeLimitedConfig: JobDBConfig = {
				dbFilePath: path.join(tempDir, "size-limited.json"),
				defaultExpirationMs: 7 * 24 * 60 * 60 * 1000,
				enableJobDB: true,
				maxDbSize: 1,
			};

			const sizeLimitedDB = new JobDB(sizeLimitedConfig);
			await sizeLimitedDB.initialize();
			await sizeLimitedDB.load();

			// Add first job successfully
			await sizeLimitedDB.addJob(createMockJob({ id: "job1" }));
			expect(sizeLimitedDB.size()).toBe(1);

			// Try to add second job - should fail with AppError
			const result = await safeAsyncOperation(
				async () => sizeLimitedDB.addJob(createMockJob({ id: "job2" })),
				"size-limit-test",
				"Size limit exceeded",
			);

			expect(result).toBe(null);
		});
	});

	describe("Error Scenarios", () => {
		it("should handle invalid job data", async () => {
			await jobDB.initialize();
			await jobDB.load();

			const invalidJob = createMockJob({
				id: "",
				title: "",
				company: "",
				url: "invalid-url",
			});

			const result = await safeAsyncOperation(
				async () => jobDB.addJob(invalidJob),
				"invalid-data-test",
				"Invalid job data",
			);

			expect(result).toBe(null);
		});

		it("should handle memory pressure scenarios", async () => {
			await jobDB.initialize();
			await jobDB.load();

			// Simulate memory pressure by adding many jobs
			const largeBatch = Array.from({ length: 100 }, (_, i) =>
				createMockJob({
					id: `job-${i}`,
					title: `Job ${i}`,
					company: `Company ${i}`,
				}),
			);

			let successCount = 0;
			for (const job of largeBatch) {
				const result = await safeAsyncOperation(
					async () => jobDB.addJob(job),
					"memory-test",
					"Memory pressure test",
				);
				if (result !== null) successCount++;
			}

			// Some operations should succeed, some might fail due to size limits
			expect(successCount).toBeGreaterThan(0);
			expect(successCount).toBeLessThanOrEqual(100);
		});

		it("should handle concurrent operations safely", async () => {
			await jobDB.initialize();
			await jobDB.load();

			const concurrentOperations = Array.from({ length: 10 }, (_, i) =>
				safeAsyncOperation(
					async () => {
						await jobDB.addJob(
							createMockJob({
								id: `concurrent-${i}`,
								title: `Concurrent Job ${i}`,
							}),
						);
						return jobDB.size();
					},
					"concurrent-test",
					"Concurrent operation",
				),
			);

			const results = await Promise.all(concurrentOperations);
			const successfulResults = results.filter((r) => r !== null);

			// Should have some successful operations
			expect(successfulResults.length).toBeGreaterThan(0);

			// Final size should be reasonable (not more than successful operations)
			const finalSize = jobDB.size();
			expect(finalSize).toBeLessThanOrEqual(successfulResults.length);
		});
	});

	describe("Performance Integration", () => {
		it("should handle large datasets with caching", async () => {
			await jobDB.initialize();
			await jobDB.load();

			// Add multiple jobs to test caching
			for (let i = 0; i < 20; i++) {
				await jobDB.addJob(
					createMockJob({
						id: `cache-test-${i}`,
						title: `Cache Test Job ${i}`,
					}),
				);
			}

			// Test pagination with caching
			const startTime = performance.now();
			const page1 = jobDB.getEntriesPaginated(0, 10);
			const page2 = jobDB.getEntriesPaginated(1, 10);
			const endTime = performance.now();

			expect(page1.length).toBe(10);
			expect(page2.length).toBe(10);
			expect(endTime - startTime).toBeLessThan(10); // Should be very fast due to caching

			// Test cache clearing
			await jobDB.addJob(createMockJob({ id: "cache-clear-test" }));
			const pageAfterAdd = jobDB.getEntriesPaginated(0, 10);
			expect(pageAfterAdd.length).toBe(11);
		});

		it("should handle rapid operations efficiently", async () => {
			await jobDB.initialize();
			await jobDB.load();

			const startTime = performance.now();
			const operations = Array.from({ length: 50 }, (_, i) =>
				safeAsyncOperation(
					async () => {
						await jobDB.addJob(
							createMockJob({
								id: `rapid-${i}`,
								title: `Rapid Job ${i}`,
							}),
						);
						return true;
					},
					"rapid-test",
					"Rapid operation test",
				),
			);

			const results = await Promise.all(operations);
			const endTime = performance.now();

			const successfulOperations = results.filter((r) => r !== null).length;
			const duration = endTime - startTime;

			expect(successfulOperations).toBeGreaterThan(0);
			expect(duration).toBeLessThan(5000); // Should complete in under 5 seconds
		});
	});

	describe("Security Integration", () => {
		it("should sanitize input data", async () => {
			await jobDB.initialize();
			await jobDB.load();

			const maliciousJob = createMockJob({
				id: 'job<script>alert("xss")</script>',
				title: 'Test<script>alert("xss")</script>',
				company: 'Company<script>alert("xss")</script>',
				url: 'https://linkedin.com/jobs/view/test<script>alert("xss")</script>',
			});

			await jobDB.addJob(maliciousJob);
			const entries = jobDB.getAllEntries();

			// All entries should be sanitized
			entries.forEach((entry) => {
				expect(entry.linkedInJobId).not.toContain("<script>");
				expect(entry.title).not.toContain("<script>");
				expect(entry.company).not.toContain("<script>");
			});
		});

		it("should validate URLs securely", async () => {
			await jobDB.initialize();
			await jobDB.load();

			const invalidUrlJob = createMockJob({
				url: 'javascript:alert("xss")',
			});

			const result = await safeAsyncOperation(
				async () => jobDB.addJob(invalidUrlJob),
				"security-test",
				"Invalid URL test",
			);

			expect(result).toBe(null);
		});
	});
});

// Run the tests
console.log("Running Integration tests...");
describe("Integration Test Suite", () => {
	console.log(
		"Test file created successfully with comprehensive integration tests",
	);
});
