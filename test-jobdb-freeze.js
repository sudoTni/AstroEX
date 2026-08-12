const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

// Create a minimal test job file
const testJobData = [
	{
		id: "12345",
		title: "Software Engineer",
		company: "Tech Corp",
		url: "https://linkedin.com/jobs/view/12345",
		description: "We are looking for a software engineer...",
	},
];

// Create test directory and file
const testDataDir = path.join(__dirname, "data");
if (!fs.existsSync(testDataDir)) {
	fs.mkdirSync(testDataDir, { recursive: true });
}

const testJobFile = path.join(testDataDir, "test_jobs.json");
fs.writeFileSync(testJobFile, JSON.stringify(testJobData, null, 2));

console.log("Created test job file:", testJobFile);

// Test jobJudge with jobDB enabled
console.log("Testing jobJudge with jobDB enabled...");
try {
	const result = execSync(
		`npm run job:judge -- --input-file "${testJobFile}" --preset jep_ds-v3-0324 --use-jobdb true`,
		{
			timeout: 30000, // 30 second timeout
			stdio: "pipe",
		},
	);
	console.log("✅ JobJudge completed successfully");
	console.log("Output:", result.toString());
} catch (error) {
	if (error.signal === "SIGTERM") {
		console.log("❌ JobJudge timed out or froze");
	} else {
		console.log("❌ JobJudge failed:", error.message);
		console.log("Stderr:", error.stderr.toString());
	}
} finally {
	// Cleanup
	if (fs.existsSync(testJobFile)) {
		fs.unlinkSync(testJobFile);
	}
	console.log("Test completed");
}
