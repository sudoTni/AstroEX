const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { findJobFiles } = require("../dist/commands/jobJudge");
const { JOB_DB_RETENTION_MS } = require("../dist/constants");

test("jobDB retains analyzed jobs for 30 days", () => {
	assert.equal(JOB_DB_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
});

test("scraped job discovery excludes processed job history", async (t) => {
	const testRoot = await fs.promises.mkdtemp(
		path.join(os.tmpdir(), "astroex-job-judge-"),
	);
	t.after(() => fs.promises.rm(testRoot, { recursive: true, force: true }));

	const dataDirectory = path.join(testRoot, "data");
	await fs.promises.mkdir(dataDirectory);
	await Promise.all([
		fs.promises.writeFile(
			path.join(dataDirectory, "processed_jobs.json"),
			"[]",
		),
		fs.promises.writeFile(
			path.join(dataDirectory, "scraped_jobs_20260810_045641.json"),
			"[]",
		),
		fs.promises.writeFile(
			path.join(dataDirectory, "scraped_jobs_20260809_010203.json"),
			"[]",
		),
		fs.promises.writeFile(path.join(dataDirectory, "jobDB.json"), "[]"),
	]);

	const matches = await findJobFiles("./data/scraped_jobs_*.json", testRoot);

	assert.deepEqual(
		matches.map((filePath) => path.basename(filePath)),
		["scraped_jobs_20260809_010203.json", "scraped_jobs_20260810_045641.json"],
	);
});
