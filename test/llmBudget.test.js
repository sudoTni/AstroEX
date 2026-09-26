const assert = require("node:assert/strict");
const test = require("node:test");
const { LLMService } = require("../dist/llmService");

test("LLM request budget prevents calls before provider activity", async () => {
	const previous = process.env.ASTROEX_MAX_LLM_REQUESTS;
	process.env.ASTROEX_MAX_LLM_REQUESTS = "1";
	try {
		const service = new LLMService();
		await assert.rejects(() => service.call({}));
		await assert.rejects(() => service.call({}), /budget exhausted/);
	} finally {
		if (previous === undefined)
			Reflect.deleteProperty(process.env, "ASTROEX_MAX_LLM_REQUESTS");
		else process.env.ASTROEX_MAX_LLM_REQUESTS = previous;
	}
});

test("LLM output-token and deadline limits stop calls before provider activity", async () => {
	const outputPrevious = process.env.ASTROEX_MAX_LLM_OUTPUT_TOKENS;
	const deadlinePrevious = process.env.ASTROEX_LLM_DEADLINE_MS;
	try {
		process.env.ASTROEX_MAX_LLM_OUTPUT_TOKENS = "10";
		Reflect.deleteProperty(process.env, "ASTROEX_LLM_DEADLINE_MS");
		const outputLimited = new LLMService();
		await assert.rejects(
			() =>
				outputLimited.call({
					provider: "openai",
					model: "unused",
					messages: [],
					maxTokens: 11,
				}),
			/output-token budget exceeded/,
		);
		Reflect.deleteProperty(process.env, "ASTROEX_MAX_LLM_OUTPUT_TOKENS");
		process.env.ASTROEX_LLM_DEADLINE_MS = "1";
		const deadlineLimited = new LLMService();
		await new Promise((resolve) => setTimeout(resolve, 5));
		await assert.rejects(
			() => deadlineLimited.call({}),
			/run deadline exceeded/,
		);
	} finally {
		if (outputPrevious === undefined)
			Reflect.deleteProperty(process.env, "ASTROEX_MAX_LLM_OUTPUT_TOKENS");
		else process.env.ASTROEX_MAX_LLM_OUTPUT_TOKENS = outputPrevious;
		if (deadlinePrevious === undefined)
			Reflect.deleteProperty(process.env, "ASTROEX_LLM_DEADLINE_MS");
		else process.env.ASTROEX_LLM_DEADLINE_MS = deadlinePrevious;
	}
});

test("cumulative output-token reservations stop a run before provider activity", async () => {
	const previous = process.env.ASTROEX_MAX_TOTAL_LLM_OUTPUT_TOKENS;
	process.env.ASTROEX_MAX_TOTAL_LLM_OUTPUT_TOKENS = "10";
	try {
		const service = new LLMService();
		await assert.rejects(
			() =>
				service.call({
					provider: "openai",
					model: "unused",
					messages: [],
					maxTokens: 11,
				}),
			/Total LLM output-token budget exceeded/,
		);
	} finally {
		if (previous === undefined)
			Reflect.deleteProperty(
				process.env,
				"ASTROEX_MAX_TOTAL_LLM_OUTPUT_TOKENS",
			);
		else process.env.ASTROEX_MAX_TOTAL_LLM_OUTPUT_TOKENS = previous;
	}
});
