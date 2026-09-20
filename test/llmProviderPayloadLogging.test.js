const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { z } = require("zod");

const { LLMService } = require("../dist/llmService");
const { OpenRouterUsageTracker } = require("../dist/openRouterUsage");

const stageDirectories = {
	jobCloth: "jc_payload_logs",
	remoteEval: "re_payload_logs",
	jobJudge: "jj_payload_logs",
	makeMaterials: "mm_payload_logs",
};

function openAiResponse(content = '{"ok":true}') {
	return {
		id: "chatcmpl-test",
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: "test-model",
		choices: [
			{
				index: 0,
				message: { role: "assistant", content },
				finish_reason: "stop",
			},
		],
		usage: {
			prompt_tokens: 8,
			completion_tokens: 4,
			total_tokens: 12,
			cost: 0.00427,
		},
	};
}

async function startProvider(handler) {
	const requests = [];
	const server = http.createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		requests.push(body);
		await handler(body, response, requests.length);
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");

	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requests,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

function sendJson(response, status, value) {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
}

function createService(provider, baseUrl) {
	const service = new LLMService();
	service.initialize(
		[
			{
				name: provider,
				baseUrl,
				apiKey: "test-api-key",
				model: "test-model",
			},
		],
		provider,
	);
	return service;
}

function makeRequest(provider, overrides = {}) {
	return {
		provider,
		model: "\u001b[36mtest-model\u001b[0m",
		messages: [
			{ role: "system", content: "\u001b[31msystem instructions\u001b[0m" },
			{ role: "user", content: "\u001b[32muser prompt\u001b[0m" },
		],
		temperature: 0.4,
		topP: 0.8,
		maxTokens: 321,
		timeout: 12_000,
		responseSchema: z.object({ ok: z.boolean() }),
		reasoning_effort: "high",
		...overrides,
	};
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
		await run();
		return output;
	} finally {
		process.stdout.write = originalStdoutWrite;
		process.stderr.write = originalStderrWrite;
	}
}

async function readPayloads(logDirectory, stage) {
	const directory = path.join(logDirectory, stageDirectories[stage]);
	const names = await fs.readdir(directory);
	assert.ok(names.every((name) => name.endsWith(".json")));
	return Promise.all(
		names.map(async (name) => ({
			name,
			path: path.join(directory, name),
			payload: JSON.parse(
				await fs.readFile(path.join(directory, name), "utf8"),
			),
		})),
	);
}

test("stage logs structurally match the exact provider bodies", async (t) => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-provider-log-"),
	);
	const logDirectory = path.join(root, "logs");
	const previousLogDirectory = process.env.ASTROEX_LOG_DIR;
	process.env.ASTROEX_LOG_DIR = logDirectory;

	const provider = await startProvider((_body, response) => {
		sendJson(response, 200, openAiResponse());
	});
	t.after(async () => {
		await provider.close();
		if (previousLogDirectory === undefined) {
			Reflect.deleteProperty(process.env, "ASTROEX_LOG_DIR");
		} else {
			process.env.ASTROEX_LOG_DIR = previousLogDirectory;
		}
		await fs.rm(root, { recursive: true, force: true });
	});

	const cases = [
		{ stage: "jobCloth", provider: "openai", expectsJsonMode: true },
		{ stage: "remoteEval", provider: "openrouter", expectsJsonMode: false },
		{ stage: "jobJudge", provider: "openrouter", expectsJsonMode: false },
		{ stage: "makeMaterials", provider: "poe", expectsJsonMode: true },
		{ stage: "jobCloth", provider: "cerebras", expectsJsonMode: false },
	];

	for (const item of cases) {
		const service = createService(item.provider, provider.baseUrl);
		const response = await service.call(makeRequest(item.provider), {
			payloadLogStage: item.stage,
		});
		assert.deepEqual(response.content, { ok: true });
	}

	const loggedByStage = {};
	for (const stage of Object.keys(stageDirectories)) {
		loggedByStage[stage] = await readPayloads(logDirectory, stage);
	}
	assert.equal(loggedByStage.jobCloth.length, 2);
	assert.equal(loggedByStage.remoteEval.length, 1);
	assert.equal(loggedByStage.jobJudge.length, 1);
	assert.equal(loggedByStage.makeMaterials.length, 1);

	const loggedPayloads = Object.values(loggedByStage)
		.flat()
		.map((entry) => entry.payload);
	assert.deepEqual(
		loggedPayloads.map((payload) => JSON.stringify(payload)).sort(),
		provider.requests.map((payload) => JSON.stringify(payload)).sort(),
	);

	for (let index = 0; index < cases.length; index++) {
		const body = provider.requests[index];
		assert.equal(body.model, "test-model");
		assert.deepEqual(body.messages, [
			{ role: "system", content: "system instructions" },
			{ role: "user", content: "user prompt" },
		]);
		assert.equal(body.temperature, 0.4);
		assert.equal(body.top_p, 0.8);
		assert.equal(body.max_tokens, 321);
		assert.equal(body.reasoning_effort, "high");
		assert.equal(
			body.response_format?.type,
			cases[index].expectsJsonMode ? "json_object" : undefined,
		);
		assert.equal(body.provider, undefined);
		assert.equal(body.timeout, undefined);
		assert.equal(body.responseSchema, undefined);
		assert.equal(body.content, undefined);
	}

	for (const entry of Object.values(loggedByStage).flat()) {
		assert.match(entry.name, /^[a-z]+_payload_.*\.json$/);
		if (process.platform !== "win32") {
			assert.equal((await fs.stat(entry.path)).mode & 0o077, 0);
		}
	}
});

test("LLM diagnostics report the effective reasoning_effort sent to the provider", async (t) => {
	const provider = await startProvider((_body, response) => {
		sendJson(response, 200, openAiResponse("success"));
	});
	t.after(() => provider.close());
	const service = createService("openrouter", provider.baseUrl);

	const explicitOutput = await captureConsole(() =>
		service.call(
			makeRequest("openrouter", {
				responseSchema: undefined,
				reasoning_effort: "high",
			}),
		),
	);
	assert.equal(provider.requests[0].reasoning_effort, "high");
	assert.match(explicitOutput, /reasoning_effort=high/);

	const unsetOutput = await captureConsole(() =>
		service.call(
			makeRequest("openrouter", {
				responseSchema: undefined,
				reasoning_effort: undefined,
			}),
		),
	);
	assert.equal("reasoning_effort" in provider.requests[1], false);
	assert.doesNotMatch(unsetOutput, /reasoning_effort/);
});

test("OpenRouter provider routing is serialized only when configured", async (t) => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-openrouter-routing-"),
	);
	const previousLogDirectory = process.env.ASTROEX_LOG_DIR;
	process.env.ASTROEX_LOG_DIR = root;
	const provider = await startProvider((_body, response) => {
		sendJson(response, 200, openAiResponse("success"));
	});

	t.after(async () => {
		await provider.close();
		if (previousLogDirectory === undefined)
			Reflect.deleteProperty(process.env, "ASTROEX_LOG_DIR");
		else process.env.ASTROEX_LOG_DIR = previousLogDirectory;
		await fs.rm(root, { recursive: true, force: true });
	});

	const service = createService("openrouter", provider.baseUrl);
	await service.call(
		makeRequest("openrouter", {
			responseSchema: undefined,
			providerRouting: { only: ["anthropic"] },
		}),
		{ payloadLogStage: "jobCloth" },
	);
	await service.call(
		makeRequest("openrouter", {
			responseSchema: undefined,
			providerRouting: {
				only: ["anthropic", "amazon-bedrock", "google-vertex"],
			},
		}),
		{ payloadLogStage: "jobJudge" },
	);
	await service.call(makeRequest("openrouter", { responseSchema: undefined }), {
		payloadLogStage: "makeMaterials",
	});

	assert.deepEqual(provider.requests[0].provider, { only: ["anthropic"] });
	assert.deepEqual(provider.requests[1].provider, {
		only: ["anthropic", "amazon-bedrock", "google-vertex"],
	});
	assert.equal("provider" in provider.requests[2], false);

	for (const [stage, expected] of [
		["jobCloth", { only: ["anthropic"] }],
		["jobJudge", { only: ["anthropic", "amazon-bedrock", "google-vertex"] }],
	]) {
		const entries = await readPayloads(root, stage);
		assert.equal(entries.length, 1);
		assert.deepEqual(entries[0].payload.provider, expected);
	}
	const defaultEntries = await readPayloads(root, "makeMaterials");
	assert.equal("provider" in defaultEntries[0].payload, false);
});

test("OpenRouter routing is not sent to other OpenAI-compatible providers", async (t) => {
	const provider = await startProvider((_body, response) => {
		sendJson(response, 200, openAiResponse("success"));
	});
	t.after(() => provider.close());

	for (const providerName of ["openai", "cerebras", "poe"]) {
		const service = createService(providerName, provider.baseUrl);
		await service.call(
			makeRequest(providerName, {
				responseSchema: undefined,
				providerRouting: { only: ["anthropic"] },
			}),
		);
	}

	assert.equal(provider.requests.length, 3);
	for (const body of provider.requests) {
		assert.equal("provider" in body, false);
	}
});

test("tracked non-streaming OpenRouter responses preserve authoritative cost and unclamped total usage", async (t) => {
	const provider = await startProvider((_body, response) => {
		sendJson(response, 200, {
			...openAiResponse("success"),
			usage: {
				prompt_tokens: 500,
				completion_tokens: 20,
				total_tokens: 520,
				cost: 0.01234567,
			},
		});
	});
	t.after(() => provider.close());
	const service = createService("openrouter", provider.baseUrl);
	const tracker = new OpenRouterUsageTracker();

	const result = await service.runWithUsageTracker(tracker, () =>
		service.call(
			makeRequest("openrouter", {
				responseSchema: undefined,
				maxTokens: 100,
			}),
		),
	);

	assert.equal(result.usage.totalTokens, 100);
	assert.deepEqual(result.billingUsage, {
		requestId: "chatcmpl-test",
		timestamp: result.billingUsage.timestamp,
		model: "test-model",
		inputTokens: 500,
		outputTokens: 20,
		totalTokens: 520,
		costUsd: 0.01234567,
	});
	assert.equal(tracker.getSummary().totalTokens, 520);
	assert.equal(tracker.getSummary().costUsd, 0.01234567);
});

test("tracked OpenRouter responses without usage are reported as unavailable", async (t) => {
	const provider = await startProvider((_body, response) => {
		const { usage: _usage, ...responseWithoutUsage } =
			openAiResponse("success");
		sendJson(response, 200, responseWithoutUsage);
	});
	t.after(() => provider.close());
	const service = createService("openrouter", provider.baseUrl);
	const tracker = new OpenRouterUsageTracker();

	await assert.rejects(
		service.runWithUsageTracker(tracker, () =>
			service.call(makeRequest("openrouter", { responseSchema: undefined })),
		),
		/No usage information returned from OpenRouter API/,
	);
	assert.equal(tracker.getSummary().accountedCalls, 0);
	assert.equal(tracker.getSummary().unavailableUsageCalls, 1);
});

test("tracked OpenRouter streams request and consume the final authoritative usage chunk", async (t) => {
	const provider = await startProvider((body, response) => {
		assert.equal(body.stream, true);
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		const base = {
			id: "gen-stream-test",
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: "stream-model",
		};
		response.write(
			`data: ${JSON.stringify({
				...base,
				choices: [
					{
						index: 0,
						delta: { role: "assistant", content: "streamed success" },
						finish_reason: null,
					},
				],
				usage: null,
			})}\n\n`,
		);
		response.write(
			`data: ${JSON.stringify({
				...base,
				choices: [],
				usage: {
					prompt_tokens: 40,
					completion_tokens: 6,
					total_tokens: 46,
					cost: 0.00091,
				},
			})}\n\n`,
		);
		response.end("data: [DONE]\n\n");
	});
	t.after(() => provider.close());
	const service = createService("openrouter", provider.baseUrl);
	const tracker = new OpenRouterUsageTracker();

	const result = await service.runWithUsageTracker(tracker, () =>
		service.call(
			makeRequest("openrouter", {
				responseSchema: undefined,
				showResponseStream: true,
			}),
		),
	);

	assert.deepEqual(provider.requests[0].stream_options, {
		include_usage: true,
	});
	assert.equal(result.content, "streamed success");
	assert.equal(result.requestId, "gen-stream-test");
	assert.equal(result.usage.totalTokens, 46);
	assert.equal(result.billingUsage.costUsd, 0.00091);
	assert.equal(tracker.getSummary().totalTokens, 46);
	assert.equal(tracker.getSummary().costUsd, 0.00091);
});

test("stream fallback logs both provider attempts with collision-resistant names", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "astroex-stream-log-"));
	const previousLogDirectory = process.env.ASTROEX_LOG_DIR;
	process.env.ASTROEX_LOG_DIR = root;
	const provider = await startProvider((body, response) => {
		if (body.stream) {
			sendJson(response, 400, {
				error: { message: "stream unsupported", type: "invalid_request_error" },
			});
			return;
		}
		sendJson(response, 200, openAiResponse());
	});

	t.after(async () => {
		await provider.close();
		if (previousLogDirectory === undefined)
			Reflect.deleteProperty(process.env, "ASTROEX_LOG_DIR");
		else process.env.ASTROEX_LOG_DIR = previousLogDirectory;
		await fs.rm(root, { recursive: true, force: true });
	});

	const service = createService("openrouter", provider.baseUrl);
	await service.call(
		makeRequest("openrouter", {
			showResponseStream: true,
			providerRouting: { only: ["google-vertex", "anthropic"] },
		}),
		{ payloadLogStage: "jobJudge" },
	);

	const entries = await readPayloads(root, "jobJudge");
	assert.equal(entries.length, 2);
	assert.equal(new Set(entries.map((entry) => entry.name)).size, 2);
	assert.deepEqual(
		entries.map((entry) => JSON.stringify(entry.payload)).sort(),
		provider.requests.map((request) => JSON.stringify(request)).sort(),
	);
	assert.equal(
		entries.filter((entry) => entry.payload.stream === true).length,
		1,
	);
	assert.equal(
		entries.filter((entry) => entry.payload.stream === undefined).length,
		1,
	);
	assert.ok(
		entries.every(
			(entry) =>
				JSON.stringify(entry.payload.provider) ===
				JSON.stringify({ only: ["google-vertex", "anthropic"] }),
		),
	);
});

test("payload-log I/O failure does not block the provider request", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "astroex-log-failure-"));
	const invalidLogDirectory = path.join(root, "not-a-directory");
	await fs.writeFile(invalidLogDirectory, "file", "utf8");
	const previousLogDirectory = process.env.ASTROEX_LOG_DIR;
	process.env.ASTROEX_LOG_DIR = invalidLogDirectory;
	const provider = await startProvider((_body, response) => {
		sendJson(response, 200, openAiResponse("success"));
	});

	t.after(async () => {
		await provider.close();
		if (previousLogDirectory === undefined)
			Reflect.deleteProperty(process.env, "ASTROEX_LOG_DIR");
		else process.env.ASTROEX_LOG_DIR = previousLogDirectory;
		await fs.rm(root, { recursive: true, force: true });
	});

	const service = createService("openai", provider.baseUrl);
	const response = await service.call(
		makeRequest("openai", { responseSchema: undefined }),
		{ payloadLogStage: "makeMaterials" },
	);
	assert.equal(response.content, "success");
	assert.equal(provider.requests.length, 1);
});

test("unimplemented providers do not create a payload log without an API request", async (t) => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-no-provider-request-"),
	);
	const previousLogDirectory = process.env.ASTROEX_LOG_DIR;
	process.env.ASTROEX_LOG_DIR = root;
	t.after(async () => {
		if (previousLogDirectory === undefined)
			Reflect.deleteProperty(process.env, "ASTROEX_LOG_DIR");
		else process.env.ASTROEX_LOG_DIR = previousLogDirectory;
		await fs.rm(root, { recursive: true, force: true });
	});

	for (const [providerName, stage] of [
		["gemini", "jobCloth"],
		["mistral", "jobJudge"],
	]) {
		const service = createService(providerName, "https://api.example.com/v1");
		await assert.rejects(
			service.call(makeRequest(providerName, { responseSchema: undefined }), {
				payloadLogStage: stage,
			}),
			/requires/,
		);
		await assert.rejects(
			fs.access(path.join(root, stageDirectories[stage])),
			(error) => error.code === "ENOENT",
		);
	}
});
