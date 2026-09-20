const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { llmService } = require("../dist/llmService");
const { JobRepository } = require("../dist/jobRepository");
const { runJobJudge } = require("../dist/commands/jobJudge");
const { executePipeline } = require("../dist/commands/runPipeline");
const { buildPipelineConfig } = require("../dist/pipelineConfig");
const {
	RemoteEvalResultsSchema,
	runRemoteEval,
	sanitizeJobForRemoteEvaluation,
} = require("../dist/commands/remoteEval");

async function setup(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "astroex-remote-eval-"));
	const dataDir = path.join(root, "data");
	const logsDir = path.join(root, "logs");
	const profileDir = path.join(root, "profile");
	await Promise.all([
		fs.mkdir(dataDir, { recursive: true }),
		fs.mkdir(logsDir, { recursive: true }),
		fs.mkdir(profileDir, { recursive: true }),
	]);
	await fs.writeFile(path.join(profileDir, "my_resume.txt"), "Security resume");
	await fs.writeFile(path.join(profileDir, "my_testimonials.txt"), "Excellent");
	await fs.writeFile(
		path.join(profileDir, "search_terms.txt"),
		"security engineer",
	);

	const prior = {
		ASTROEX_DATA_DIR: process.env.ASTROEX_DATA_DIR,
		ASTROEX_LOG_DIR: process.env.ASTROEX_LOG_DIR,
		ASTROEX_PROFILE_DIR: process.env.ASTROEX_PROFILE_DIR,
	};
	process.env.ASTROEX_DATA_DIR = dataDir;
	process.env.ASTROEX_LOG_DIR = logsDir;
	process.env.ASTROEX_PROFILE_DIR = profileDir;
	t.after(async () => {
		for (const [key, value] of Object.entries(prior)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await fs.rm(root, { recursive: true, force: true });
	});
	return { root, dataDir, logsDir, profileDir };
}

async function captureConsole(run) {
	const originalStdoutWrite = process.stdout.write;
	const originalStderrWrite = process.stderr.write;
	let output = "";
	process.stdout.write = (chunk) => {
		output += String(chunk);
		return true;
	};
	process.stderr.write = (chunk) => {
		output += String(chunk);
		return true;
	};
	try {
		return { result: await run(), output };
	} finally {
		process.stdout.write = originalStdoutWrite;
		process.stderr.write = originalStderrWrite;
	}
}

function job(id, title, descriptionText, overrides = {}) {
	return {
		id: `indeed:${id}`,
		source: "indeed",
		sourceJobId: id,
		title,
		company: "Example Corp",
		location: "Remote",
		url: `https://www.indeed.com/viewjob?jk=${id}`,
		descriptionText,
		remoteOk: true,
		isRemote: true,
		...overrides,
	};
}

test("remoteEval schema requires isConfirmedRemote and follows tolerant response conventions", () => {
	assert.equal(
		RemoteEvalResultsSchema.parse([
			{
				job_title: "Remote Engineer",
				isConfirmedRemote: "true",
				rationale: "Explicitly remote.",
				confidence: 95,
			},
		])[0].isConfirmedRemote,
		true,
	);
	assert.equal(
		RemoteEvalResultsSchema.parse({
			results: [
				{
					title: "Hybrid Engineer",
					isConfirmedRemote: false,
				},
			],
		})[0].isConfirmedRemote,
		false,
	);
	assert.equal(
		RemoteEvalResultsSchema.safeParse([{ jobTitle: "Missing verdict" }])
			.success,
		false,
	);
});

test("remoteEval removes prior remote assertions, filters failures, and persists passing metadata", async (t) => {
	const env = await setup(t);
	const inputFile = path.join(env.dataDir, "enriched.json");
	const outputFile = path.join(env.dataDir, "remote_eval_pass.json");
	await fs.writeFile(
		inputFile,
		JSON.stringify([
			job("pass", "Pass Role", "This is a fully remote US role.", {
				confidence: 0.88,
				rationale: "Prior JobCloth rationale.",
				isWorthInvestigating: true,
				isVeryHighlyAligned: true,
				isHighlyAligned: true,
			}),
			job("fail", "Fail Role", "This role is hybrid in New York."),
			job("missing", "Missing Description", ""),
		]),
	);

	const originalCall = llmService.call;
	const calls = [];
	llmService.call = async (request, options) => {
		calls.push({ request, options });
		const userMessage = request.messages.find(
			(message) => message.role === "user",
		).content;
		const passes = userMessage.includes('"title": "Pass Role"');
		return {
			content: [
				{
					jobTitle: passes ? "Pass Role" : "Fail Role",
					isConfirmedRemote: passes,
					rationale: passes
						? "Explicitly remote."
						: "Hybrid attendance required.",
					confidence: 0.98,
				},
			],
		};
	};
	t.after(() => {
		llmService.call = originalCall;
	});

	const result = await runRemoteEval({
		apiKey: "test-key",
		inputFile,
		outputFile,
		preset: "re_glm-5.3-flash",
		sleep: 0,
		reasoningLevel: "high",
		providerRouting: { only: ["anthropic", "google-vertex"] },
		useCheckpoints: false,
	});

	assert.deepEqual(
		{
			jobs: result.jobs,
			evaluated: result.evaluated,
			passed: result.passed,
			failed: result.failed,
		},
		{ jobs: 3, evaluated: 2, passed: 1, failed: 2 },
	);
	assert.equal(calls.length, 2);
	assert.ok(
		calls.every((call) => call.options.payloadLogStage === "remoteEval"),
	);
	assert.ok(calls.every((call) => call.request.reasoning_effort === "high"));
	for (const call of calls) {
		assert.equal(call.request.provider, "openrouter");
		assert.equal(call.request.model, "z-ai/glm-5.3-flash");
		assert.equal(call.request.temperature, 1);
		assert.equal(call.request.topP, 0.95);
		assert.deepEqual(call.request.providerRouting, {
			only: ["anthropic", "google-vertex"],
		});
	}
	for (const call of calls) {
		const prompt = call.request.messages.find(
			(message) => message.role === "user",
		).content;
		assert.doesNotMatch(prompt, /"remoteOk"/);
		assert.doesNotMatch(prompt, /"isRemote"/);
		assert.doesNotMatch(prompt, /0\.88/);
		assert.doesNotMatch(prompt, /Prior JobCloth rationale\./);
		assert.doesNotMatch(prompt, /"isWorthInvestigating"/);
		assert.doesNotMatch(prompt, /"isVeryHighlyAligned"/);
		assert.doesNotMatch(prompt, /"isHighlyAligned"/);
		assert.match(prompt, /"descriptionText"/);
		assert.doesNotMatch(prompt, /\{targJD\}/);
	}

	const output = JSON.parse(await fs.readFile(outputFile, "utf8"));
	assert.equal(output.length, 1);
	assert.equal(output[0].id, "indeed:pass");
	assert.equal(output[0].isConfirmedRemote, true);
	assert.equal(output[0].remoteEvalMetadata.jobTitle, "Pass Role");
	assert.equal(output[0].remoteEvalMetadata.fallbackUsed, false);
	assert.equal(output[0].remoteEvalMetadata.retryCount, 0);
	assert.equal(typeof output[0].remoteEvalMetadata.timestamp, "string");
	assert.equal(output[0].remoteOk, true);
	const manifest = JSON.parse(
		await fs.readFile(`${outputFile}.manifest.json`, "utf8"),
	);
	assert.equal(manifest.command, "remoteEval");
	assert.equal(manifest.passed, 1);
});

test("remoteEval retries malformed results and conservatively filters after exhaustion", async (t) => {
	const env = await setup(t);
	const inputFile = path.join(env.dataDir, "enriched.json");
	const outputFile = path.join(env.dataDir, "remote_eval_pass.json");
	await fs.writeFile(
		inputFile,
		JSON.stringify([job("malformed", "Malformed Role", "Remote role")]),
	);
	const originalCall = llmService.call;
	let calls = 0;
	llmService.call = async (request) => {
		calls++;
		assert.equal(
			"reasoning_effort" in request,
			false,
			"Unset remoteEval reasoning effort must be omitted from the request",
		);
		return { content: [{ jobTitle: "Malformed Role" }] };
	};
	t.after(() => {
		llmService.call = originalCall;
	});

	const result = await runRemoteEval({
		apiKey: "test-key",
		inputFile,
		outputFile,
		preset: "re_glm-5.3-flash",
		sleep: 0,
		retryDelayMs: 0,
		useCheckpoints: false,
	});
	assert.equal(calls, 3);
	assert.equal(result.passed, 0);
	assert.deepEqual(JSON.parse(await fs.readFile(outputFile, "utf8")), []);
});

test("remoteEval reuses durable checkpoints without marking jobs as judged duplicates", async (t) => {
	const env = await setup(t);
	const inputFile = path.join(env.dataDir, "enriched.json");
	const outputFile = path.join(env.dataDir, "remote_eval_pass.json");
	const targetJob = job("checkpoint", "Checkpoint Role", "Fully remote role");
	await fs.writeFile(inputFile, JSON.stringify([targetJob]));
	const originalCall = llmService.call;
	let calls = 0;
	llmService.call = async () => {
		calls++;
		return {
			content: [
				{
					jobTitle: targetJob.title,
					isConfirmedRemote: true,
					rationale: "Remote.",
					confidence: 1,
				},
			],
		};
	};
	t.after(() => {
		llmService.call = originalCall;
	});
	const options = {
		apiKey: "test-key",
		inputFile,
		outputFile,
		preset: "re_glm-5.3-flash",
		sleep: 0,
		useCheckpoints: true,
	};
	await runRemoteEval(options);
	const repeated = await runRemoteEval(options);
	assert.equal(calls, 1);
	assert.equal(repeated.passed, 1);

	const repository = new JobRepository({
		dbFilePath: path.join(env.dataDir, "jobDB.sqlite"),
		defaultExpirationMs: 30 * 24 * 60 * 60 * 1000,
		enableJobDB: true,
	});
	await repository.initialize();
	try {
		assert.equal(
			repository.isJobMatched({
				id: targetJob.id,
				source: "indeed",
				sourceJobId: targetJob.sourceJobId,
				title: targetJob.title,
				company: targetJob.company,
				url: targetJob.url,
			}),
			false,
		);
	} finally {
		await repository.close();
	}
});

test("jobJudge receives isConfirmedRemote and remoteEval metadata in targJD", async (t) => {
	const env = await setup(t);
	const inputFile = path.join(env.dataDir, "enriched.json");
	const remoteOutput = path.join(env.dataDir, "remote_eval_pass.json");
	await fs.writeFile(
		inputFile,
		JSON.stringify([
			job("flow", "Remote Security Engineer", "Fully remote in the US"),
		]),
	);
	const originalCall = llmService.call;
	let judgePrompt = "";
	llmService.call = async (request, options) => {
		if (options.payloadLogStage === "remoteEval") {
			return {
				content: [
					{
						jobTitle: "Remote Security Engineer",
						isConfirmedRemote: true,
						rationale: "Explicit remote arrangement.",
						confidence: 0.99,
					},
				],
			};
		}
		judgePrompt = request.messages.find(
			(message) => message.role === "user",
		).content;
		return {
			content: [
				{
					jobTitle: "Remote Security Engineer",
					isVeryHighlyAligned: true,
					rationale: "Aligned.",
					confidence: 0.9,
				},
			],
		};
	};
	t.after(() => {
		llmService.call = originalCall;
	});

	await runRemoteEval({
		apiKey: "test-key",
		inputFile,
		outputFile: remoteOutput,
		preset: "re_glm-5.3-flash",
		sleep: 0,
		useCheckpoints: false,
	});
	await runJobJudge({
		preset: "jep_glm-5.3-flash",
		"api-key": "test-key",
		"base-url": "",
		"model-id": "",
		"input-file": remoteOutput,
		"output-file": path.join(env.dataDir, "astroapply_eval_"),
		"use-jobdb": false,
		"strict-parsing": false,
		sleep: 0,
		"eval-mode": 1,
	});
	assert.match(judgePrompt, /"isConfirmedRemote": true/);
	assert.match(judgePrompt, /"remoteEvalMetadata"/);
	assert.doesNotMatch(judgePrompt, /"remoteOk"/);
});

test("remote evaluation sanitizer prevents existing remote verdicts from biasing reevaluation", () => {
	const sanitized = sanitizeJobForRemoteEvaluation(
		job("sanitize", "Role", "Description", {
			confidence: 0.9,
			rationale: "Prior JobCloth rationale.",
			isWorthInvestigating: true,
			isVeryHighlyAligned: true,
			isHighlyAligned: true,
			isConfirmedRemote: true,
			remoteEvalMetadata: { rationale: "old" },
		}),
	);
	assert.equal("remoteOk" in sanitized, false);
	assert.equal("isRemote" in sanitized, false);
	assert.equal("confidence" in sanitized, false);
	assert.equal("rationale" in sanitized, false);
	assert.equal("isWorthInvestigating" in sanitized, false);
	assert.equal("isVeryHighlyAligned" in sanitized, false);
	assert.equal("isHighlyAligned" in sanitized, false);
	assert.equal("isConfirmedRemote" in sanitized, false);
	assert.equal("remoteEvalMetadata" in sanitized, false);
});

test("pipeline runs remoteEval only for remote-only and sends only confirmed jobs to jobJudge", async (t) => {
	const env = await setup(t);
	const clothedFile = path.join(env.dataDir, "clothed_jobs.json");
	const remoteOutput = path.join(env.dataDir, "remote_eval_pass.json");
	await fs.writeFile(
		clothedFile,
		JSON.stringify([
			job("pipeline-pass", "Pipeline Pass", "Fully remote US role."),
			job("pipeline-fail", "Pipeline Fail", "Hybrid role."),
		]),
	);

	const originalCall = llmService.call;
	const stages = [];
	let requireOnlyPass = true;
	llmService.call = async (request, options) => {
		stages.push(options.payloadLogStage);
		const prompt = request.messages.find(
			(message) => message.role === "user",
		).content;
		if (options.payloadLogStage === "remoteEval") {
			assert.equal(request.reasoning_effort, "pipeline-level");
			assert.deepEqual(request.providerRouting, { only: ["anthropic"] });
			const passes = prompt.includes('"title": "Pipeline Pass"');
			return {
				content: [
					{
						jobTitle: passes ? "Pipeline Pass" : "Pipeline Fail",
						isConfirmedRemote: passes,
						rationale: passes ? "Remote." : "Hybrid.",
						confidence: 0.95,
					},
				],
			};
		}
		if (requireOnlyPass) {
			assert.match(prompt, /"title": "Pipeline Pass"/);
			assert.doesNotMatch(prompt, /"title": "Pipeline Fail"/);
		}
		return {
			content: [
				{
					jobTitle: "Pipeline Pass",
					isVeryHighlyAligned: true,
					rationale: "Aligned.",
					confidence: 0.9,
				},
			],
		};
	};
	t.after(() => {
		llmService.call = originalCall;
	});

	const config = buildPipelineConfig({
		search: { sites: ["indeed"], remoteOnly: true },
		paths: {
			dataDir: env.dataDir,
			profileDir: env.profileDir,
			clothedJobsFile: clothedFile,
			remoteEvalOutputFile: remoteOutput,
		},
		providers: { apiKey: "test-key" },
		deployment: { enabled: false },
		options: { clean: false, sleep: 0, useCheckpoints: false },
		reasoningEffort: { remoteEval: "pipeline-level" },
		providerRouting: { remoteEval: { only: ["anthropic"] } },
	});
	const { result, output: pipelineOutput } = await captureConsole(() =>
		executePipeline(config, {
			resume: "remoteEval",
			skipMaterials: true,
		}),
	);
	assert.equal(result.stages.remoteEval.passed, 1);
	assert.equal(result.stages.jobJudge.jobs, 1);
	assert.deepEqual(stages, ["remoteEval", "remoteEval", "jobJudge"]);
	assert.match(
		pipelineOutput,
		/Pipeline progress initialized — tracking 8 planned stages\./,
	);
	for (let stage = 1; stage <= 8; stage++) {
		assert.match(
			pipelineOutput,
			new RegExp(`Pipeline progress — stage ${stage}\\/8 complete`),
		);
	}

	stages.length = 0;
	requireOnlyPass = false;
	const nonRemoteConfig = buildPipelineConfig({
		search: { sites: ["indeed"], remoteOnly: false },
		paths: {
			dataDir: env.dataDir,
			profileDir: env.profileDir,
			clothedJobsFile: clothedFile,
			remoteEvalOutputFile: remoteOutput,
		},
		providers: { apiKey: "test-key" },
		deployment: { enabled: false },
		options: { clean: false, sleep: 0, useCheckpoints: false },
	});
	const nonRemoteResult = await executePipeline(nonRemoteConfig, {
		resume: "jobJudge",
		skipMaterials: true,
	});
	assert.deepEqual(nonRemoteResult.stages.remoteEval, {
		skipped: true,
		reason: "remote-only-disabled",
	});
	assert.equal(stages.includes("remoteEval"), false);
});

test("remote-only resume after remoteEval requires its filtered artifact", async (t) => {
	const env = await setup(t);
	const clothedFile = path.join(env.dataDir, "clothed_jobs.json");
	await fs.writeFile(
		clothedFile,
		JSON.stringify([job("resume", "Resume Role", "Fully remote")]),
	);
	const config = buildPipelineConfig({
		search: { sites: ["indeed"], remoteOnly: true },
		paths: {
			dataDir: env.dataDir,
			profileDir: env.profileDir,
			clothedJobsFile: clothedFile,
			remoteEvalOutputFile: path.join(env.dataDir, "missing_remote_eval.json"),
		},
		providers: { apiKey: "test-key" },
		deployment: { enabled: false },
		options: { clean: false, sleep: 0 },
	});
	await assert.rejects(
		() =>
			executePipeline(config, {
				resume: "jobJudge",
				skipMaterials: true,
			}),
		/required remoteEval artifact is missing/,
	);
});
