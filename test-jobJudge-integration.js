const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

console.log("Testing jobJudge integration with jobDB...");

// Create a temporary directory for testing
const tempDir = path.join(__dirname, "temp-jobjudge-test");
if (!fs.existsSync(tempDir)) {
	fs.mkdirSync(tempDir, { recursive: true });
}

// Create test job data
const testJobs = [
	{
		id: "12345",
		title: "Software Engineer",
		company: "Tech Corp",
		url: "https://linkedin.com/jobs/view/12345",
		description: "We are looking for a software engineer...",
		location: "San Francisco, CA",
		employmentType: "Full-time",
		seniorityLevel: "Mid-Senior level",
		jobFunction: "Engineering",
		industries: "Computer Software",
		postedDate: "2023-01-01",
		applicants: 50,
		salaryRange: "$120,000 - $180,000",
		salaryCurrency: "USD",
		salaryMin: 120000,
		salaryMax: 180000,
		remoteOk: true,
	},
	{
		id: "67890",
		title: "Product Manager",
		company: "Innovation Inc",
		url: "https://linkedin.com/jobs/view/67890",
		description: "We are seeking a product manager...",
		location: "New York, NY",
		employmentType: "Full-time",
		seniorityLevel: "Director",
		jobFunction: "Product Management",
		industries: "Internet",
		postedDate: "2023-01-02",
		applicants: 25,
		salaryRange: "$150,000 - $200,000",
		salaryCurrency: "USD",
		salaryMin: 150000,
		salaryMax: 200000,
		remoteOk: false,
	},
];

// Write test job data to file
const testJobFile = path.join(tempDir, "test_jobs.json");
fs.writeFileSync(testJobFile, JSON.stringify(testJobs, null, 2));

console.log("✅ Test job data created");

// Test jobJudge with jobDB enabled
console.log("\n--- Testing jobJudge with jobDB enabled ---");
try {
	const command = `node dist/index.js jobJudge --input-file "${testJobFile}" --preset jep_ds-v3-0324 --eval-mode 4 --use-jobdb true --strict-parsing false --sleep 0`;
	console.log("Running command:", command);

	const startTime = Date.now();
	const _output = execSync(command, {
		encoding: "utf8",
		timeout: 30000, // 30 second timeout
	});
	const endTime = Date.now();

	console.log("✅ Command completed successfully");
	console.log("Execution time:", (endTime - startTime) / 1000, "seconds");

	// Check if jobDB file was created
	const jobDbPath = path.join("./data", "jobDB.json");
	if (fs.existsSync(jobDbPath)) {
		console.log("✅ jobDB file created successfully");
		const jobDbContent = JSON.parse(fs.readFileSync(jobDbPath, "utf8"));
		console.log("jobDB entries:", jobDbContent.length);
		console.log("Latest entry:", jobDbContent[jobDbContent.length - 1]);
	} else {
		console.log("❌ jobDB file not found");
	}
} catch (error) {
	if (error.signal === "SIGTERM" || error.signal === "SIGKILL") {
		console.log(
			"❌ Command timed out or was killed - this indicates the freezing issue is NOT fixed",
		);
	} else {
		console.log("❌ Command failed:", error.message);
	}
}

// Cleanup
if (fs.existsSync(tempDir)) {
	fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("\n✅ Integration test completed");
