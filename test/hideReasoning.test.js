const assert = require("node:assert/strict");
const test = require("node:test");
const { buildPipelineConfig } = require("../dist/pipelineConfig");
const { LLMService } = require("../dist/llmService");

test("buildPipelineConfig resolves hideReasoning and overrides showReasoning", () => {
	const defaultConfig = buildPipelineConfig();
	assert.strictEqual(defaultConfig.options.hideReasoning, false);
	assert.strictEqual(defaultConfig.options.showReasoning, true);

	const hiddenConfig = buildPipelineConfig({
		options: {
			hideReasoning: true,
			showReasoning: true,
		},
	});
	assert.strictEqual(hiddenConfig.options.hideReasoning, true);
	assert.strictEqual(hiddenConfig.options.showReasoning, false);
});

test("ASTROEX_HIDE_REASONING environment variable forces hideReasoning in pipeline config", () => {
	const prevEnv = process.env.ASTROEX_HIDE_REASONING;
	try {
		process.env.ASTROEX_HIDE_REASONING = "1";
		const config = buildPipelineConfig({
			options: {
				showReasoning: true,
			},
		});
		assert.strictEqual(config.options.hideReasoning, true);
		assert.strictEqual(config.options.showReasoning, false);
	} finally {
		if (prevEnv === undefined) {
			Reflect.deleteProperty(process.env, "ASTROEX_HIDE_REASONING");
		} else {
			process.env.ASTROEX_HIDE_REASONING = prevEnv;
		}
	}
});

test("LLMService suppresses showReasoningTokens when hideReasoningTokens is true", async () => {
	const service = new LLMService();
	let capturedRequest = null;
	// Mock internal call implementation to inspect validated request
	service.callOpenAI = async (provider, req) => {
		capturedRequest = req;
		return { content: "test", usage: { totalTokens: 10 } };
	};

	service.initialize([
		{
			name: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			apiKey: "test-key",
			model: "test-model",
		},
	]);

	await service.call({
		provider: "openrouter",
		model: "test-model",
		messages: [{ role: "user", content: "hello" }],
		showReasoningTokens: true,
		hideReasoningTokens: true,
	});

	assert.ok(capturedRequest);
	assert.strictEqual(capturedRequest.showReasoningTokens, false);
	assert.strictEqual(capturedRequest.hideReasoningTokens, true);
});

test("LLMService suppresses showReasoningTokens when ASTROEX_HIDE_REASONING=1", async () => {
	const prevEnv = process.env.ASTROEX_HIDE_REASONING;
	try {
		process.env.ASTROEX_HIDE_REASONING = "1";
		const service = new LLMService();
		let capturedRequest = null;
		service.callOpenAI = async (provider, req) => {
			capturedRequest = req;
			return { content: "test", usage: { totalTokens: 10 } };
		};

		service.initialize([
			{
				name: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				apiKey: "test-key",
				model: "test-model",
			},
		]);

		await service.call({
			provider: "openrouter",
			model: "test-model",
			messages: [{ role: "user", content: "hello" }],
			showReasoningTokens: true,
		});

		assert.ok(capturedRequest);
		assert.strictEqual(capturedRequest.showReasoningTokens, false);
	} finally {
		if (prevEnv === undefined) {
			Reflect.deleteProperty(process.env, "ASTROEX_HIDE_REASONING");
		} else {
			process.env.ASTROEX_HIDE_REASONING = prevEnv;
		}
	}
});

test("runJobJudge respects hide-reasoning flag and suppresses reasoning tokens", async (t) => {
	const fs = require("node:fs/promises");
	const os = require("node:os");
	const path = require("node:path");

	const testRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-hide-reasoning-judge-"),
	);
	t.after(() => fs.rm(testRoot, { recursive: true, force: true }));

	const dataDirectory = path.join(testRoot, "data");
	await fs.mkdir(dataDirectory, { recursive: true });
	const clothedFile = path.join(dataDirectory, "clothed_jobs.json");
	const sampleJobs = [
		{
			id: "judge-hr-1",
			title: "Security Analyst",
			company: "Corp",
			location: "Remote",
			url: "https://www.indeed.com/viewjob?jk=hr1",
			source: "indeed",
			descriptionText: "Security analyst role.",
		},
	];
	await fs.writeFile(clothedFile, JSON.stringify(sampleJobs, null, 2));

	const { runJobJudge } = require("../dist/commands/jobJudge");
	const { llmService } = require("../dist/llmService");
	const originalCall = llmService.call;

	let receivedRequest = null;
	llmService.call = async (req) => {
		receivedRequest = req;
		return {
			content: [
				{
					jobTitle: "Security Analyst",
					isWorthInvestigating: true,
					rationale: "Good match",
					confidence: 0.9,
				},
			],
			rawResponse: {},
			usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
		};
	};

	try {
		await runJobJudge({
			"api-key": "mock-key",
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
			"show-reasoning": true,
			"hide-reasoning": true,
			"show-stream": false,
			verbose: false,
			logDir: path.join(testRoot, "logs"),
		});

		assert.ok(receivedRequest);
		assert.strictEqual(receivedRequest.showReasoningTokens, false);
	} finally {
		llmService.call = originalCall;
	}
});
