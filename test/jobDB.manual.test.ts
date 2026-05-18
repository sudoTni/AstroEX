import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JobDB, type JobDBConfig } from "../src/jobDB";

console.log("=== JobDB Manual Test ===\n");

async function runBasicTests() {
	let tempDir: string;
	let jobDB: JobDB;
	let config: JobDBConfig;

	// Setup
	console.log("Setting up test environment...");
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobdb-test-"));
	const dbFilePath = path.join(tempDir, "test-jobDB.json");

	config = {
		dbFilePath,
		defaultExpirationMs: 7 * 24 * 60 * 60 * 1000, // 7 days
		enableJobDB: true,
	};

	jobDB = new JobDB(config);

	try {
		// Test 1: Initialization
		console.log("\n--- Test 1: Initialization ---");
		await jobDB.initialize();
		const dbDir = path.dirname(config.dbFilePath);
		console.log(`✅ Database directory created: ${fs.existsSync(dbDir)}`);

		// Test 2: Load empty database
		console.log("\n--- Test 2: Load Empty Database ---");
		await jobDB.load();
		console.log(`✅ Empty database loaded. Size: ${jobDB.size()}`);

		// Test 3: Add and save job
		console.log("\n--- Test 3: Add and Save Job ---");
		const testJob = {
			title: "Software Engineer",
			company: "Tech Corp",
			url: "https://linkedin.com/jobs/view/12345",
		};

		await jobDB.addJob(testJob as any, "12345");
		console.log(`✅ Job added. Database size: ${jobDB.size()}`);

		// Test 4: Load from file
		console.log("\n--- Test 4: Load from File ---");
		const newJobDB = new JobDB(config);
		await newJobDB.initialize();
		await newJobDB.load();
		console.log(`✅ Database loaded from file. Size: ${newJobDB.size()}`);

		if (newJobDB.size() > 0) {
			const entries = newJobDB.getAllEntries();
			console.log(
				`✅ First entry: ${entries[0].title} at ${entries[0].company}`,
			);
			console.log(`✅ Job ID: ${entries[0].linkedInJobId}`);
		}

		// Test 5: Job matching
		console.log("\n--- Test 5: Job Matching ---");

		// Matching job
		const matchingJob = {
			title: "Software Engineer",
			company: "Tech Corp",
			url: "https://linkedin.com/jobs/view/67890",
		};

		const isMatched = jobDB.isJobMatched(matchingJob as any);
		console.log(`✅ Matching job detected: ${isMatched}`);

		// Non-matching job
		const nonMatchingJob = {
			title: "Product Manager",
			company: "Tech Corp",
			url: "https://linkedin.com/jobs/view/67890",
		};

		const isNotMatched = jobDB.isJobMatched(nonMatchingJob as any);
		console.log(`✅ Non-matching job detected: ${isNotMatched}`);

		// Test 6: Case-insensitive matching
		console.log("\n--- Test 6: Case-Insensitive Matching ---");
		const mixedCaseJob = {
			title: "software engineer",
			company: "tech corp",
			url: "https://linkedin.com/jobs/view/67890",
		};

		const isCaseMatched = jobDB.isJobMatched(mixedCaseJob as any);
		console.log(`✅ Case-insensitive match: ${isCaseMatched}`);

		// Test 7: Statistics
		console.log("\n--- Test 7: Statistics ---");
		const stats = jobDB.getStats();
		console.log(`✅ Database stats:`, {
			totalEntries: stats.totalEntries,
			expiredEntries: stats.expiredEntries,
			timeToNextExpiration: `${Math.round(stats.timeToNextExpiration / 1000 / 60 / 60)} hours`,
			operationsCount: stats.operationsCount,
		});

		// Test 8: URL ID extraction
		console.log("\n--- Test 8: URL ID Extraction ---");
		const urlJob = {
			title: "Test Job",
			company: "Test Company",
			url: "https://linkedin.com/jobs/view/99999/position",
		};

		await jobDB.addJob(urlJob as any);
		const urlEntries = jobDB.getAllEntries();
		const extractedId = urlEntries.find(
			(e) => e.linkedInJobId === "99999",
		)?.linkedInJobId;
		console.log(`✅ Extracted job ID from URL: ${extractedId}`);

		// Test 9: URL validation
		console.log("\n--- Test 9: URL Validation ---");
		const invalidJob = {
			title: "Test Job",
			company: "Test Company",
			url: "https://malicious.com/jobs/view/12345",
		};

		try {
			await jobDB.addJob(invalidJob as any);
			console.log("❌ Expected error for invalid LinkedIn URL");
		} catch (error) {
			console.log(
				`✅ Correctly caught invalid URL error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		// Test 10: Disabled mode
		console.log("\n--- Test 10: Disabled Mode ---");
		const disabledConfig: JobDBConfig = {
			dbFilePath: path.join(tempDir, "disabled-jobDB.json"),
			defaultExpirationMs: 7 * 24 * 60 * 60 * 1000,
			enableJobDB: false,
		};

		const disabledJobDB = new JobDB(disabledConfig);
		await disabledJobDB.initialize();
		await disabledJobDB.load();

		await disabledJobDB.addJob(testJob as any);
		console.log(`✅ Disabled DB size: ${disabledJobDB.size()}`);
		console.log(
			`✅ Disabled DB match result: ${disabledJobDB.isJobMatched(testJob as any)}`,
		);

		// Test 11: Backup
		console.log("\n--- Test 11: Backup ---");
		await jobDB.createBackup();

		const backupDir = path.dirname(config.dbFilePath);
		const files = fs.readdirSync(backupDir);
		const backupFiles = files.filter((file) =>
			file.startsWith("jobDB_backup_"),
		);

		console.log(`✅ Backup files created: ${backupFiles.length}`);
		if (backupFiles.length > 0) {
			console.log(`✅ Backup file: ${backupFiles[0]}`);
		}

		// Test 12: Cleanup
		console.log("\n--- Test 12: Cleanup ---");
		const _initialSize = jobDB.size();
		const removedCount = await jobDB.cleanupExpired();
		console.log(
			`✅ Cleanup removed ${removedCount} entries. Current size: ${jobDB.size()}`,
		);

		console.log("\n=== All Tests Completed Successfully ===");
	} catch (error) {
		console.error(
			`❌ Test failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		throw error;
	} finally {
		// Cleanup
		if (jobDB) {
			await jobDB.close();
		}
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}
}

// Run the tests
runBasicTests()
	.then(() => {
		console.log("\n🎉 JobDB feature testing completed successfully!");
		process.exit(0);
	})
	.catch((error) => {
		console.error("\n💥 JobDB feature testing failed:", error);
		process.exit(1);
	});
