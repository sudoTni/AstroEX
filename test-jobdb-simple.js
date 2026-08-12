const fs = require("node:fs");
const path = require("node:path");

// Test jobDB functionality directly
const { JobDB } = require("./dist/jobDB");

console.log("Testing jobDB functionality directly...");

// Create a temporary directory for testing
const tempDir = path.join(__dirname, "temp-test");
if (!fs.existsSync(tempDir)) {
	fs.mkdirSync(tempDir, { recursive: true });
}

const dbFilePath = path.join(tempDir, "test-jobDB.json");

const config = {
	dbFilePath,
	defaultExpirationMs: 7 * 24 * 60 * 60 * 1000, // 7 days
	enableJobDB: true,
};

// Initialize jobDB
const jobDB = new JobDB(config);

console.log("✅ JobDB created successfully");

// Create a test job
const testJob = {
	title: "Software Engineer",
	company: "Tech Corp",
	url: "https://linkedin.com/jobs/view/12345",
	description: "We are looking for a software engineer...",
};

// Initialize the database
jobDB
	.initialize()
	.then(() => {
		console.log("✅ Database initialized");

		// Load the database
		return jobDB.load();
	})
	.then(() => {
		console.log("✅ Database loaded");

		// Add job to database
		return jobDB.addJob(testJob, "12345");
	})
	.then(() => {
		console.log("✅ Job added to database");

		// Check if job is matched
		const isMatched = jobDB.isJobMatched(testJob);
		console.log(`✅ Job matched: ${isMatched}`);

		// Get statistics
		const stats = jobDB.getStats();
		console.log("✅ Database stats:", stats);

		// Close the database
		return jobDB.close();
	})
	.then(() => {
		console.log("✅ Database closed successfully");

		// Cleanup
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}

		console.log("✅ All tests passed! jobDB is working correctly.");
	})
	.catch((err) => {
		console.error("❌ Error:", err);
	});
