const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");
const { z } = require("zod");

const { defaultLoggingManager } = require("../dist/logging");
const { LLMService } = require("../dist/llmService");
const { OpenRouterUsageTracker } = require("../dist/openRouterUsage");

const execFileAsync = promisify(execFile);

function usage(overrides = {}) {
	return {
		requestId: "gen-test",
		timestamp: "2026-09-16T12:00:00.000Z",
		model: "test/model",
		stage: "jobJudge",
		inputTokens: 100,
		outputTokens: 25,
		totalTokens: 125,
		costUsd: 0.00427,
		...overrides,
	};
}

function responseFor(request, overrides = {}) {
	return {
		content: "ok",
		provider: request.provider,
		model: request.model,
		usage: { promptTokens: 100, completionTokens: 25, totalTokens: 125 },
		billingUsage: usage({ model: request.model }),
		duration: 0,
		timestamp: "2026-09-16T12:00:00.000Z",
		requestId: "gen-test",
		...overrides,
	};
}

function request(overrides = {}) {
	return {
		provider: "openrouter",
		model: "test/model",
		messages: [{ role: "user", content: "hello" }],
		maxTokens: 100,
		...overrides,
	};
}

function createService(callOpenAI) {
	const service = new LLMService();
	service.initialize(
		[
			{
				name: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				apiKey: "test-key",
				model: "test/model",
			},
		],
		"openrouter",
	);
	service.callOpenAI = callOpenAI;
	return service;
}

async function captureRecords(operation) {
	const records = [];
	const originalDispatch = defaultLoggingManager.dispatch;
	defaultLoggingManager.dispatch = (record) => records.push(record);
	try {
		await operation();
		return records;
	} finally {
		defaultLoggingManager.dispatch = originalDispatch;
	}
}

test("run-pipeline help declares the opt-in --track-or-costs flag", async () => {
	const { stdout, stderr } = await execFileAsync(process.execPath, [
		path.join(__dirname, "../dist/index.js"),
		"run-pipeline",
		"--help",
		"--no-banner",
		"--no-color",
	]);
	assert.equal(stderr, "");
	assert.match(stdout, /--track-or-costs/);
});

test("the CLI flag enables a zero-call pipeline summary end to end", async (t) => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-or-usage-cli-"),
	);
	const profileDir = path.join(root, "profile");
	await fs.mkdir(profileDir, { recursive: true });
	await Promise.all([
		fs.writeFile(path.join(profileDir, "search_terms.txt"), "engineer\n"),
		fs.writeFile(path.join(profileDir, "my_resume.txt"), "Resume\n"),
	]);
	t.after(() => fs.rm(root, { recursive: true, force: true }));

	const result = await execFileAsync(
		process.execPath,
		[
			path.join(__dirname, "../dist/index.js"),
			"run-pipeline",
			"--resume",
			"deployment",
			"--track-or-costs",
			"--no-banner",
			"--no-color",
		],
		{
			env: {
				...process.env,
				ASTROEX_DATA_DIR: path.join(root, "data"),
				ASTROEX_LOG_DIR: path.join(root, "logs"),
				ASTROEX_MATERIALS_DIR: path.join(root, "materials"),
				ASTROEX_PROFILE_DIR: profileDir,
				AEX_DEPLOY: "0",
			},
		},
	);
	assert.match(
		`${result.stdout}\n${result.stderr}`,
		/OpenRouter pipeline usage summary/,
	);
});

test("OpenRouterUsageTracker accumulates authoritative values and deduplicates accounting IDs", () => {
	const tracker = new OpenRouterUsageTracker();
	const first = tracker.record("call-1", usage());
	const second = tracker.record(
		"call-2",
		usage({
			requestId: "gen-other",
			model: "other/model",
			inputTokens: 50,
			outputTokens: 30,
			totalTokens: 81,
			costUsd: 0.0019,
		}),
	);
	const duplicate = tracker.record("call-2", usage({ costUsd: 99 }));

	assert.equal(first.recorded, true);
	assert.equal(second.recorded, true);
	assert.equal(duplicate.recorded, false);
	assert.deepEqual(tracker.getSummary(), {
		accountedCalls: 2,
		unavailableUsageCalls: 0,
		inputTokens: 150,
		outputTokens: 55,
		totalTokens: 206,
		costUsd: 0.00617,
	});
});

test("OpenRouterUsageTracker handles zero-token summaries and unavailable usage", () => {
	const tracker = new OpenRouterUsageTracker();
	tracker.markUsageUnavailable();
	assert.deepEqual(tracker.getSummary(), {
		accountedCalls: 0,
		unavailableUsageCalls: 1,
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		costUsd: 0,
	});
});

test("LLMService emits per-call usage and running totals only inside a tracking context", async () => {
	const service = createService(async (_provider, req) => responseFor(req));
	const tracker = new OpenRouterUsageTracker();

	const records = await captureRecords(async () => {
		await service.call(request());
		await service.runWithUsageTracker(tracker, async () => {
			await service.call(request({ model: "first/model" }), {
				payloadLogStage: "jobCloth",
			});
			service.callOpenAI = async (_provider, req) =>
				responseFor(req, {
					billingUsage: usage({
						requestId: "gen-second",
						model: req.model,
						inputTokens: 20,
						outputTokens: 10,
						totalTokens: 30,
						costUsd: 0.0005,
					}),
				});
			await service.call(request({ model: "second/model" }));
		});
	});

	const usageRecords = records.filter(
		(record) => record.context?.event === "openrouter.usage.call",
	);
	assert.equal(usageRecords.length, 2);
	assert.equal(usageRecords[0].context.model, "first/model");
	assert.equal(usageRecords[0].context.pipelineTotalTokens, 125);
	assert.equal(usageRecords[1].context.model, "second/model");
	assert.equal(usageRecords[1].context.pipelineTotalTokens, 155);
	assert.equal(usageRecords[1].context.pipelineCostUsd, 0.00477);
	assert.equal(tracker.getSummary().accountedCalls, 2);
});

test("a billed provider response is accounted before application response parsing fails", async () => {
	const service = createService(async (_provider, req) =>
		responseFor(req, { content: "not-json" }),
	);
	const tracker = new OpenRouterUsageTracker();

	await captureRecords(async () => {
		await assert.rejects(
			service.runWithUsageTracker(tracker, () =>
				service.call(
					request({ responseSchema: z.object({ ok: z.boolean() }) }),
				),
			),
			/Response parsing\/validation failed/,
		);
	});

	assert.equal(tracker.getSummary().accountedCalls, 1);
	assert.equal(tracker.getSummary().totalTokens, 125);
});

test("provider failures do not increment totals, while missing billing usage is marked unavailable", async () => {
	const failedService = createService(async () => {
		throw new Error("provider unavailable");
	});
	const failedTracker = new OpenRouterUsageTracker();
	await captureRecords(async () => {
		await assert.rejects(
			failedService.runWithUsageTracker(failedTracker, () =>
				failedService.call(request()),
			),
			/provider unavailable/,
		);
	});
	assert.deepEqual(failedTracker.getSummary(), {
		accountedCalls: 0,
		unavailableUsageCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		costUsd: 0,
	});

	const incompleteService = createService(async (_provider, req) => {
		const response = responseFor(req);
		Reflect.deleteProperty(response, "billingUsage");
		return response;
	});
	const incompleteTracker = new OpenRouterUsageTracker();
	const records = await captureRecords(() =>
		incompleteService.runWithUsageTracker(incompleteTracker, () =>
			incompleteService.call(request()),
		),
	);
	assert.equal(incompleteTracker.getSummary().accountedCalls, 0);
	assert.equal(incompleteTracker.getSummary().unavailableUsageCalls, 1);
	assert.equal(
		records.filter(
			(record) => record.context?.event === "openrouter.usage.unavailable",
		).length,
		1,
	);
});

test("concurrent calls update one tracker atomically and concurrent contexts remain isolated", async () => {
	const service = createService(async (_provider, req) => {
		const number = Number(req.messages[0].content);
		await new Promise((resolve) => setTimeout(resolve, (4 - number) * 2));
		return responseFor(req, {
			billingUsage: usage({
				requestId: `gen-${number}`,
				inputTokens: number,
				outputTokens: number,
				totalTokens: number * 2,
				costUsd: number / 1000,
			}),
		});
	});
	const firstTracker = new OpenRouterUsageTracker();
	const secondTracker = new OpenRouterUsageTracker();

	await captureRecords(() =>
		Promise.all([
			service.runWithUsageTracker(firstTracker, () =>
				Promise.all(
					[1, 2, 3].map((number) =>
						service.call(
							request({
								messages: [{ role: "user", content: String(number) }],
							}),
						),
					),
				),
			),
			service.runWithUsageTracker(secondTracker, () =>
				service.call(request({ messages: [{ role: "user", content: "4" }] })),
			),
		]),
	);

	assert.equal(firstTracker.getSummary().accountedCalls, 3);
	assert.equal(firstTracker.getSummary().totalTokens, 12);
	assert.equal(firstTracker.getSummary().costUsd, 0.006);
	assert.equal(secondTracker.getSummary().accountedCalls, 1);
	assert.equal(secondTracker.getSummary().totalTokens, 8);
	assert.equal(secondTracker.getSummary().costUsd, 0.004);
});
