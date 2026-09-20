const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { z } = require("zod");

const {
	LLMService,
	PathologicalReasoningRepetitionError,
} = require("../dist/llmService");
const { StatisticsCollector } = require("../dist/statistics");

async function startMockProvider(handler) {
	const requests = [];
	const server = http.createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const raw = Buffer.concat(chunks).toString("utf8");
		const body = raw ? JSON.parse(raw) : {};
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

function createTestService(provider, baseUrl) {
	const service = new LLMService();
	service.initialize(
		[
			{
				name: provider,
				baseUrl,
				apiKey: "test-key",
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
		model: "test-model",
		messages: [{ role: "user", content: "hello" }],
		temperature: 1,
		topP: 0.95,
		maxTokens: 1000,
		showReasoningTokens: true,
		showResponseStream: true,
		...overrides,
	};
}

test("streaming repetition detection aborts stream, avoids non-streaming fallback, and recovers on retry", async (t) => {
	let attemptCount = 0;
	const provider = await startMockProvider((body, response) => {
		attemptCount++;
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});

		const base = {
			id: `gen-${attemptCount}`,
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: "test-model",
		};

		if (attemptCount === 1) {
			// Pathological repetition loop: send "lock" 25 times
			for (let i = 0; i < 25; i++) {
				response.write(
					`data: ${JSON.stringify({
						...base,
						choices: [
							{
								index: 0,
								delta: { reasoning_content: "lock" },
								finish_reason: null,
							},
						],
					})}\n\n`,
				);
			}
			response.end();
		} else {
			// Successful recovery on attempt 2
			response.write(
				`data: ${JSON.stringify({
					...base,
					choices: [
						{
							index: 0,
							delta: { reasoning_content: "Checking the problem logically." },
							finish_reason: null,
						},
					],
				})}\n\n`,
			);
			response.write(
				`data: ${JSON.stringify({
					...base,
					choices: [
						{
							index: 0,
							delta: { content: "Final recovered answer." },
							finish_reason: null,
						},
					],
				})}\n\n`,
			);
			response.write(
				`data: ${JSON.stringify({
					...base,
					choices: [],
					usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
				})}\n\n`,
			);
			response.end("data: [DONE]\n\n");
		}
	});
	t.after(() => provider.close());

	const service = createTestService("openrouter", provider.baseUrl);
	const response = await service.call(makeRequest("openrouter"), {
		maxRepetitionRetries: 1,
	});

	assert.equal(response.content, "Final recovered answer.");
	assert.equal(attemptCount, 2);
	// Both attempts were streaming calls; NEVER fell back to non-streaming!
	assert.equal(provider.requests.length, 2);
	assert.equal(provider.requests[0].stream, true);
	assert.equal(provider.requests[1].stream, true);
});

test("streaming repetition detection exhausts retries, throws PathologicalReasoningRepetitionError without non-streaming fallback, and records stats", async (t) => {
	let attemptCount = 0;
	const provider = await startMockProvider((body, response) => {
		attemptCount++;
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});

		const base = {
			id: `gen-${attemptCount}`,
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: "test-model",
		};

		// Pathological repetition loop on every attempt
		for (let i = 0; i < 25; i++) {
			response.write(
				`data: ${JSON.stringify({
					...base,
					choices: [
						{
							index: 0,
							delta: { reasoning_content: "loop " },
							finish_reason: null,
						},
					],
				})}\n\n`,
			);
		}
		response.end();
	});
	t.after(() => provider.close());

	const service = createTestService("openrouter", provider.baseUrl);
	const stats = new StatisticsCollector("test-cmd");

	await assert.rejects(
		() =>
			service.call(makeRequest("openrouter"), {
				maxRepetitionRetries: 1,
				stats,
			}),
		(err) => {
			assert.ok(
				err instanceof PathologicalReasoningRepetitionError ||
					err.name === "PathologicalReasoningRepetitionError",
			);
			assert.equal(err.code, "PATHOLOGICAL_REASONING_REPETITION");
			assert.equal(err.isRetryable, true);
			assert.equal(err.period, 5);
			assert.equal(err.repeatedText, "loop ");
			assert.ok(err.repeats >= 8);
			return true;
		},
	);

	// Both attempts were streaming; NO non-streaming fallback occurred
	assert.equal(attemptCount, 2);
	assert.equal(provider.requests.length, 2);
	assert.equal(provider.requests[0].stream, true);
	assert.equal(provider.requests[1].stream, true);

	// Statistics collector recorded the repetition error
	const summary = stats.getSummary();
	assert.equal(summary.api.repetitionErrors, 1);
});

test("silent reasoning mode (showReasoningTokens: false) still aborts on pathological repetition", async (t) => {
	let attemptCount = 0;
	const provider = await startMockProvider((body, response) => {
		attemptCount++;
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});

		const base = {
			id: `gen-${attemptCount}`,
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: "test-model",
		};

		if (attemptCount === 1) {
			for (let i = 0; i < 25; i++) {
				response.write(
					`data: ${JSON.stringify({
						...base,
						choices: [
							{
								index: 0,
								delta: { thinking: "word" },
								finish_reason: null,
							},
						],
					})}\n\n`,
				);
			}
			response.end();
		} else {
			response.write(
				`data: ${JSON.stringify({
					...base,
					choices: [
						{
							index: 0,
							delta: { content: "Silent mode recovered." },
							finish_reason: null,
						},
					],
				})}\n\n`,
			);
			response.end("data: [DONE]\n\n");
		}
	});
	t.after(() => provider.close());

	const service = createTestService("openrouter", provider.baseUrl);
	const response = await service.call(
		makeRequest("openrouter", {
			showReasoningTokens: false,
			showResponseStream: true,
		}),
		{ maxRepetitionRetries: 1 },
	);

	assert.equal(response.content, "Silent mode recovered.");
	assert.equal(attemptCount, 2);
});

test("disableRepetitionDetection allows repeating stream without aborting", async (t) => {
	let attemptCount = 0;
	const provider = await startMockProvider((body, response) => {
		attemptCount++;
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});

		const base = {
			id: `gen-${attemptCount}`,
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: "test-model",
		};

		// Send 25 repeats of "lock"
		for (let i = 0; i < 25; i++) {
			response.write(
				`data: ${JSON.stringify({
					...base,
					choices: [
						{
							index: 0,
							delta: { reasoning_content: "lock" },
							finish_reason: null,
						},
					],
				})}\n\n`,
			);
		}
		response.write(
			`data: ${JSON.stringify({
				...base,
				choices: [
					{
						index: 0,
						delta: { content: "Stream finished." },
						finish_reason: null,
					},
				],
			})}\n\n`,
		);
		response.end("data: [DONE]\n\n");
	});
	t.after(() => provider.close());

	const service = createTestService("openrouter", provider.baseUrl);
	const response = await service.call(makeRequest("openrouter"), {
		disableRepetitionDetection: true,
	});

	assert.equal(response.content, "Stream finished.");
	// Completed on first attempt without aborting
	assert.equal(attemptCount, 1);
});

test("ordinary streaming errors still fall back to non-streaming", async (t) => {
	const provider = await startMockProvider((body, response, count) => {
		if (body.stream) {
			// Ordinary stream failure (e.g. 400 error indicating stream unsupported)
			response.writeHead(400, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					error: {
						message: "Stream unsupported",
						type: "invalid_request_error",
					},
				}),
			);
			return;
		}
		// Non-streaming fallback response
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				id: "chatcmpl-nonstream",
				object: "chat.completion",
				created: Math.floor(Date.now() / 1000),
				model: "test-model",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "Fallback content." },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
			}),
		);
	});
	t.after(() => provider.close());

	const service = createTestService("openrouter", provider.baseUrl);
	const response = await service.call(makeRequest("openrouter"));

	assert.equal(response.content, "Fallback content.");
	// Request 1 was stream, Request 2 was non-streaming fallback
	assert.equal(provider.requests.length, 2);
	assert.equal(provider.requests[0].stream, true);
	assert.equal(provider.requests[1].stream, undefined);
});

test("POE provider also aborts on pathological repetition and retries successfully", async (t) => {
	let attemptCount = 0;
	const provider = await startMockProvider((body, response) => {
		attemptCount++;
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});

		const base = {
			id: `poe-${attemptCount}`,
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: "test-model",
		};

		if (attemptCount === 1) {
			for (let i = 0; i < 25; i++) {
				response.write(
					`data: ${JSON.stringify({
						...base,
						choices: [
							{
								index: 0,
								delta: { reasoning: "step " },
								finish_reason: null,
							},
						],
					})}\n\n`,
				);
			}
			response.end();
		} else {
			response.write(
				`data: ${JSON.stringify({
					...base,
					choices: [
						{
							index: 0,
							delta: { content: "POE success." },
							finish_reason: null,
						},
					],
				})}\n\n`,
			);
			response.end("data: [DONE]\n\n");
		}
	});
	t.after(() => provider.close());

	const service = createTestService("poe", provider.baseUrl);
	const response = await service.call(makeRequest("poe"), {
		maxRepetitionRetries: 1,
	});

	assert.equal(response.content, "POE success.");
	assert.equal(attemptCount, 2);
});
