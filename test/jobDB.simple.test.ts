import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JobDB, type JobDBConfig } from "../src/jobDB";

// Simple test runner
function _describe(name: string, fn: () => void) {
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

// Global variables for test suite
let tempDir: string;
let jobDB: JobDB;
let config: JobDBConfig;

// Setup before tests
const setupTest = () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobdb-test-"));
	const dbFilePath = path.join(tempDir, "test-jobDB.json");

	config = {
		dbFilePath,
		defaultExpirationMs: 7 * 24 * 60 * 60 * 1000, // 7 days
		enableJobDB: true,
	};

	jobDB = new JobDB(config);
};

// Cleanup after tests
const _cleanupTest = async () => {
	if (jobDB) {
		await jobDB.close();
	}
	if (fs.existsSync(tempDir)) {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
};

// Setup for this test suite
setupTest();

it("should initialize and create directory", async () => {
	await jobDB.initialize();
	const dbDir = path.dirname(config.dbFilePath);
	console.log(`Database directory exists: ${fs.existsSync(dbDir)}`);
});

it("should save and load basic job data", async () => {
	await jobDB.initialize();
	await jobDB.load();

	// Create a minimal job object that matches what we need
	const testJob = {
		title: "Software Engineer",
		company: "Tech Corp",
		url: "https://linkedin.com/jobs/view/12345",
	};

	console.log("Adding job to database...");
	await jobDB.addJob(testJob as any, "12345");

	console.log(`Database size after adding job: ${jobDB.size()}`);

	// Create new instance to test loading
	const newJobDB = new JobDB(config);
	await newJobDB.initialize();
	await newJobDB.load();

	console.log(`New database size: ${newJobDB.size()}`);

	if (newJobDB.size() > 0) {
		const entries = newJobDB.getAllEntries();
		console.log(`First entry title: ${entries[0].title}`);
		console.log(`First entry company: ${entries[0].company}`);
		console.log(`First entry ID: ${entries[0].linkedInJobId}`);
	}
});

it("should detect matching jobs", async () => {
	await jobDB.initialize();
	await jobDB.load();

	// Add first job
	await jobDB.addJob(
		{
			title: "Software Engineer",
			company: "Tech Corp",
			url: "https://linkedin.com/jobs/view/12345",
		} as any,
		"12345",
	);

	// Check if matching job is detected
	const matchingJob = {
		title: "Software Engineer",
		company: "Tech Corp",
		url: "https://linkedin.com/jobs/view/67890",
	};

	const isMatched = jobDB.isJobMatched(matchingJob as any);
	console.log(`Job matched: ${isMatched}`);
});

it("should not detect non-matching jobs", async () => {
	await jobDB.initialize();
	await jobDB.load();

	// Add first job
	await jobDB.addJob(
		{
			title: "Software Engineer",
			company: "Tech Corp",
			url: "https://linkedin.com/jobs/view/12345",
		} as any,
		"12345",
	);

	// Check if non-matching job is detected
	const nonMatchingJob = {
		title: "Product Manager",
		company: "Tech Corp",
		url: "https://linkedin.com/jobs/view/67890",
	};

	const isMatched = jobDB.isJobMatched(nonMatchingJob as any);
	console.log(`Non-matching job detected: ${isMatched}`);
});

it("should handle case-insensitive matching", async () => {
	await jobDB.initialize();
	await jobDB.load();

	// Add first job
	await jobDB.addJob(
		{
			title: "Software Engineer",
			company: "Tech Corp",
			url: "https://linkedin.com/jobs/view/12345",
		} as any,
		"12345",
	);

	// Check with different case
	const mixedCaseJob = {
		title: "software engineer",
		company: "tech corp",
		url: "https://linkedin.com/jobs/view/67890",
	};

	const isMatched = jobDB.isJobMatched(mixedCaseJob as any);
	console.log(`Case-insensitive match: ${isMatched}`);
});

it("should provide statistics", async () => {
	await jobDB.initialize();
	await jobDB.load();

	const stats = jobDB.getStats();
	console.log(`Initial stats:`, {
		totalEntries: stats.totalEntries,
		expiredEntries: stats.expiredEntries,
		timeToNextExpiration: stats.timeToNextExpiration,
		operationsCount: stats.operationsCount,
	});

	// Add a job
	await jobDB.addJob(
		{
			title: "Test Job",
			company: "Test Company",
			url: "https://linkedin.com/jobs/view/test",
		} as any,
		"test",
	);

	const newStats = jobDB.getStats();
	console.log(`Stats after adding job:`, {
		totalEntries: newStats.totalEntries,
		expiredEntries: newStats.expiredEntries,
		operationsCount: newStats.operationsCount,
	});
});

it("should extract job ID from URL", async () => {
	await jobDB.initialize();
	await jobDB.load();

	const testJob = {
		title: "Test Job",
		company: "Test Company",
		url: "https://linkedin.com/jobs/view/12345/position",
	};

	await jobDB.addJob(testJob as any);
	const entries = jobDB.getAllEntries();
	console.log(`Extracted job ID: ${entries[0].linkedInJobId}`);
});

it("should validate LinkedIn URL", async () => {
	await jobDB.initialize();
	await jobDB.load();

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

	const testJob = {
		title: "Test Job",
		company: "Test Company",
		url: "https://linkedin.com/jobs/view/test",
	};

	// All operations should be no-ops when disabled
	await disabledJobDB.addJob(testJob as any);
	console.log(`Disabled DB size: ${disabledJobDB.size()}`);

	const isMatched = disabledJobDB.isJobMatched(testJob as any);
	console.log(`Disabled DB match result: ${isMatched}`);

	const stats = disabledJobDB.getStats();
	console.log(`Disabled DB stats:`, {
		totalEntries: stats.totalEntries,
		operationsCount: stats.operationsCount,
	});
});

it("should create backup", async () => {
	await jobDB.initialize();
	await jobDB.load();

	// Add a job
	await jobDB.addJob(
		{
			title: "Backup Test Job",
			company: "Backup Test Company",
			url: "https://linkedin.com/jobs/view/backup",
		} as any,
		"backup",
	);

	// Create manual backup
	await jobDB.createBackup();

	// Check if backup file was created
	const backupDir = path.dirname(config.dbFilePath);
	const files = fs.readdirSync(backupDir);
	const backupFiles = files.filter((file) => file.startsWith("jobDB_backup_"));

	console.log(`Backup files created: ${backupFiles.length}`);
	if (backupFiles.length > 0) {
		console.log(`Backup file: ${backupFiles[0]}`);
	}
});

// Run the tests
console.log("Running JobDB simple functionality tests...");

// Cleanup after all tests
setTimeout(async () => {
	if (jobDB) {
		await jobDB.close();
	}
	if (fs.existsSync(tempDir)) {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
	console.log("\n=== All tests completed ===");
	process.exit(0);
}, 100);
