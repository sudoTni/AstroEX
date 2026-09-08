const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { findJobFiles } = require("../dist/commands/jobJudge");
const { JOB_DB_RETENTION_MS } = require("../dist/constants");

test("job repository retains analyzed jobs for 30 days", () => {
	assert.equal(JOB_DB_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
});

test("clothed-job discovery only matches the requested artifact pattern", async (t) => {
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
			path.join(dataDirectory, "clothed_jobs_20260810_045641.json"),
			"[]",
		),
		fs.promises.writeFile(
			path.join(dataDirectory, "clothed_jobs_20260809_010203.json"),
			"[]",
		),
	]);

	const matches = await findJobFiles("./data/clothed_jobs_*.json", testRoot);

	assert.deepEqual(
		matches.map((filePath) => path.basename(filePath)),
		["clothed_jobs_20260809_010203.json", "clothed_jobs_20260810_045641.json"],
	);
});

test("runJobJudge accepts isWorthInvestigating from LLM response", async (t) => {
	const testRoot = await fs.promises.mkdtemp(
		path.join(os.tmpdir(), "astroex-job-judge-test-"),
	);
	t.after(() => fs.promises.rm(testRoot, { recursive: true, force: true }));

	const dataDirectory = path.join(testRoot, "data");
	await fs.promises.mkdir(dataDirectory);
	const clothedFile = path.join(dataDirectory, "clothed_jobs.json");
	const sampleJobs = [
		{
			id: "judge-1",
			title: "Security Operations Analyst",
			company: "CyberCorp",
			location: "Remote",
			url: "https://www.indeed.com/viewjob?jk=judge1",
			source: "indeed",
			descriptionText: "Security analyst role.",
		},
	];
	await fs.promises.writeFile(clothedFile, JSON.stringify(sampleJobs, null, 2));

	const { runJobJudge } = require("../dist/commands/jobJudge");
	const { llmService } = require("../dist/llmService");
	const originalCall = llmService.call;

	llmService.call = async () => {
		return {
			content: [
				{
					jobTitle: "Security Operations Analyst",
					isWorthInvestigating: true,
					rationale: "Candidate meets all requirements.",
					confidence: 0.95,
				},
			],
			rawResponse: {},
			usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
		};
	};

	try {
		const judgeResult = await runJobJudge({
			"api-key": "mock-api-key",
			"base-url": "https://openrouter.ai/api/v1",
			"model-id": "z-ai/glm-5.3-flash",
			"input-file": clothedFile,
			"output-file": path.join(dataDirectory, "astroapply_eval_"),
			preset: "jep_glm-5.3-flash",
			"use-jobdb": false,
			"strict-parsing": false,
			"log-payload": false,
			sleep: 0,
			"eval-mode": 1,
			"show-reasoning": false,
			"show-stream": false,
			verbose: false,
			logDir: path.join(testRoot, "logs"),
		});

		assert.equal(judgeResult.jobs, 1);
		assert.equal(judgeResult.passed, 1);
	} finally {
		llmService.call = originalCall;
	}
});
