const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runJobJudge } = require("../dist/commands/jobJudge");
const { JobRepository } = require("../dist/jobRepository");
const { llmService } = require("../dist/llmService");

test("jobJudge conservative fallback does not start analysis suppression", async (t) => {
	const testRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-job-judge-suppression-"),
	);
	const dataDirectory = path.join(testRoot, "data");
	const inputFile = path.join(dataDirectory, "clothed_jobs.json");
	await fs.mkdir(dataDirectory);
	await fs.writeFile(
		inputFile,
		JSON.stringify([
			{
				id: "judge-fallback",
				title: "Fallback Job",
				company: "Example Corp",
				url: "https://www.indeed.com/viewjob?jk=fallback",
				source: "indeed",
				descriptionText: "Detailed job description.",
			},
		]),
	);

	const originalCall = llmService.call;
	llmService.call = async () => ({ content: null });
	t.after(async () => {
		llmService.call = originalCall;
		await fs.rm(testRoot, { recursive: true, force: true });
	});

	await runJobJudge({
		"api-key": "test-key",
		"base-url": "https://api.example.test/v1",
		"model-id": "test-model",
		"input-file": inputFile,
		"output-file": path.join(dataDirectory, "astroapply_eval_"),
		preset: "jep_glm-5.3-flash",
		"use-jobdb": true,
		"strict-parsing": false,
		sleep: 0,
		"eval-mode": 1,
	});

	const repository = new JobRepository({
		dbFilePath: path.join(dataDirectory, "jobDB.sqlite"),
		defaultExpirationMs: 30 * 24 * 60 * 60 * 1000,
		enableJobDB: true,
	});
	await repository.initialize();
	try {
		assert.equal(
			repository.isJobMatched({
				id: "judge-fallback",
				source: "indeed",
				title: "Fallback Job",
				company: "Example Corp",
				url: "https://www.indeed.com/viewjob?jk=fallback",
			}),
			false,
			"A fallback output is not a successfully completed analysis",
		);
	} finally {
		await repository.close();
	}
});
