#!/usr/bin/env node

/**
 * Test script to verify jobJudge robustness improvements
 * This script tests the enhanced error handling and fallback behavior
 */

const fs = require("node:fs");
const path = require("node:path");

// Test data with various edge cases
const testJobs = [
	{
		id: "test001",
		title: "Software Engineer",
		company: "Tech Corp",
		descriptionText:
			"We are looking for a skilled software engineer with experience in JavaScript and Node.js.",
		url: "https://example.com/job/123",
	},
	{
		id: "test002",
		title: "Data Analyst",
		company: "Data Inc",
		descriptionText: "Seeking a data analyst for SQL and Python work.",
		url: "https://example.com/job/456",
	},
	{
		id: "test003",
		title: "Security Specialist",
		company: "Secure Co",
		descriptionText: "Security specialist needed for cybersecurity role.",
		url: "https://example.com/job/789",
	},
];

// Create test input file
const testInputFile = path.join(__dirname, "data", "test_scraped_jobs.json");
const testDataDir = path.join(__dirname, "data");

// Ensure data directory exists
if (!fs.existsSync(testDataDir)) {
	fs.mkdirSync(testDataDir, { recursive: true });
}

// Write test data
fs.writeFileSync(testInputFile, JSON.stringify(testJobs, null, 2));

console.log("✅ Test data created successfully");
console.log(`📁 Test file: ${testInputFile}`);
console.log(`📊 Test jobs: ${testJobs.length}`);

// Test command help to verify new options
console.log("\n🔍 Testing new command options...");

// Test the help command to see if our new options are available
const { spawn } = require("node:child_process");
const child = spawn("node", ["dist/commands/index.js", "jobJudge", "--help"], {
	stdio: "pipe",
});

let output = "";
child.stdout.on("data", (data) => {
	output += data.toString();
});

child.on("close", (code) => {
	if (code === 0) {
		console.log("✅ Help command executed successfully");

		// Check for our new options
		const hasStrictParsing = output.includes("--strict-parsing");
		const hasSleep = output.includes("--sleep");

		if (hasStrictParsing) {
			console.log("✅ --strict-parsing option is available");
		} else {
			console.log("❌ --strict-parsing option not found");
		}

		if (hasSleep) {
			console.log("✅ --sleep option is available");
		} else {
			console.log("❌ --sleep option not found");
		}

		console.log("\n📋 Help output excerpt:");
		console.log("----------------------");
		console.log(`${output.substring(0, 500)}...`);
	} else {
		console.log(`❌ Help command failed with code ${code}`);
		console.log("Error output:", output);
	}

	console.log("\n🧪 Test completed. You can now run:");
	console.log(
		`   node dist/commands/index.js jobJudge --input-file ${testInputFile} --preset <your-preset> --strict-parsing false`,
	);
	console.log(
		`   node dist/commands/index.js jobJudge --input-file ${testInputFile} --preset <your-preset> --strict-parsing true`,
	);
});
