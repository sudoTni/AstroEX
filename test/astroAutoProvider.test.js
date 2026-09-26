const assert = require("node:assert/strict");
const test = require("node:test");

const {
	ASTRO_AUTO_PROVIDER,
	astro_auto_provider,
} = require("../dist/astroAutoProvider");

function endpoint({
	tag,
	quantization = "fp8",
	prompt = 0.000001,
	completion = 0.000001,
	cache = 0.000001,
	throughput = 50,
	uptime = 99,
	latency = 0.5,
}) {
	return {
		provider_name: tag,
		tag,
		quantization,
		pricing: {
			prompt: String(prompt),
			completion: String(completion),
			input_cache_read: String(cache),
		},
		throughput_last_30m: { p50: throughput },
		uptime_last_1d: uptime,
		latency_last_30m: { p50: latency },
	};
}

function successfulFetch(endpoints, calls) {
	return async (url, init) => {
		calls.push({ url, init });
		return {
			ok: true,
			json: async () => ({ data: { endpoints } }),
		};
	};
}

test("astro_auto_provider selects and formats ranked FP8 OpenRouter providers", async () => {
	const calls = [];
	const result = await astro_auto_provider({
		modelId: "author/model",
		apiKey: "test-key",
		fetchImpl: successfulFetch(
			[
				endpoint({ tag: "fast", throughput: 90 }),
				endpoint({ tag: "steady", throughput: 60 }),
				endpoint({
					tag: "outlier",
					prompt: 0.000005,
					completion: 0.000005,
					cache: 0.000005,
					throughput: 999,
				}),
				endpoint({ tag: "not-fp8", quantization: "bf16", throughput: 999 }),
				endpoint({ tag: "fast", throughput: 80 }),
			],
			calls,
		),
		now: () => new Date("2026-09-18T12:34:56"),
	});

	assert.equal(ASTRO_AUTO_PROVIDER, "astro_auto_provider");
	assert.equal(calls.length, 1);
	assert.equal(
		calls[0].url,
		"https://openrouter.ai/api/v1/models/author/model/endpoints",
	);
	assert.equal(calls[0].init.headers.Authorization, "Bearer test-key");
	assert.equal(calls[0].init.headers.Accept, "application/json");
	assert.equal(
		calls[0].init.headers["HTTP-Referer"],
		"https://github.com/sudoTni/AstroEX",
	);
	assert.equal(calls[0].init.headers["X-Title"], "AstroEX");
	assert.deepEqual(result.providerSlugs, ["fast", "steady"]);
	assert.equal(result.excludedCount, 1);
	assert.match(
		result.noDetailsOutput,
		/^Model: author\/model\nDate & time: 2026-09-18 12:34:56/m,
	);
	assert.match(result.noDetailsOutput, /Provider slugs:\nfast,steady$/);
});

test("astro_auto_provider reports an empty structured selection without inventing a provider", async () => {
	const result = await astro_auto_provider({
		modelId: "author/model",
		apiKey: "test-key",
		fetchImpl: successfulFetch(
			[endpoint({ tag: "bf16", quantization: "bf16" })],
			[],
		),
	});
	assert.deepEqual(result.providerSlugs, []);
	assert.match(
		result.noDetailsOutput,
		/No eligible FP8 providers remained after filtering\.$/,
	);
});

test("astro_auto_provider preserves selector errors for invalid input and OpenRouter failures", async () => {
	await assert.rejects(
		() => astro_auto_provider({ modelId: "invalid", apiKey: "test-key" }),
		/MODEL_ID must look like "author\/model"/,
	);
	await assert.rejects(
		() => astro_auto_provider({ modelId: "author/model", apiKey: "" }),
		/AEX_OR_API_KEY is not set/,
	);
	await assert.rejects(
		() =>
			astro_auto_provider({
				modelId: "author/model",
				apiKey: "test-key",
				fetchImpl: async () => ({
					ok: false,
					status: 429,
					text: async () => "rate limited",
				}),
			}),
		/OpenRouter returned HTTP 429\nrate limited/,
	);
});

test("astro_auto_provider defaults to selecting 3 provider slugs", async () => {
	const result = await astro_auto_provider({
		modelId: "author/model",
		apiKey: "test-key",
		fetchImpl: successfulFetch(
			[
				endpoint({ tag: "p1", throughput: 100 }),
				endpoint({ tag: "p2", throughput: 90 }),
				endpoint({ tag: "p3", throughput: 80 }),
				endpoint({ tag: "p4", throughput: 70 }),
				endpoint({ tag: "p5", throughput: 60 }),
				endpoint({ tag: "p6", throughput: 50 }),
			],
			[],
		),
	});
	assert.equal(result.providerSlugs.length, 3);
	assert.deepEqual(result.providerSlugs, ["p1", "p2", "p3"]);
});

test("astro_auto_provider respects explicit top override (e.g. top: 5)", async () => {
	const result = await astro_auto_provider({
		modelId: "author/model",
		apiKey: "test-key",
		top: 5,
		fetchImpl: successfulFetch(
			[
				endpoint({ tag: "p1", throughput: 100 }),
				endpoint({ tag: "p2", throughput: 90 }),
				endpoint({ tag: "p3", throughput: 80 }),
				endpoint({ tag: "p4", throughput: 70 }),
				endpoint({ tag: "p5", throughput: 60 }),
				endpoint({ tag: "p6", throughput: 50 }),
			],
			[],
		),
	});
	assert.equal(result.providerSlugs.length, 5);
	assert.deepEqual(result.providerSlugs, ["p1", "p2", "p3", "p4", "p5"]);
});

test("astro_auto_provider filters endpoints by configured quantizations", async () => {
	const result = await astro_auto_provider({
		modelId: "author/model",
		apiKey: "test-key",
		quantizations: ["int8"],
		fetchImpl: successfulFetch(
			[
				endpoint({ tag: "int8-fast", quantization: "int8", throughput: 90 }),
				endpoint({ tag: "fp8-fast", quantization: "fp8", throughput: 100 }),
				endpoint({ tag: "int8-steady", quantization: "int8", throughput: 70 }),
				endpoint({ tag: "bf16-fast", quantization: "bf16", throughput: 120 }),
			],
			[],
		),
	});
	assert.deepEqual(result.providerSlugs, ["int8-fast", "int8-steady"]);
	assert.match(
		result.noDetailsOutput,
		/Provider slugs:\nint8-fast,int8-steady$/,
	);
});

test("astro_auto_provider formats empty selection message for custom quantization", async () => {
	const result = await astro_auto_provider({
		modelId: "author/model",
		apiKey: "test-key",
		quantizations: ["int4"],
		fetchImpl: successfulFetch(
			[endpoint({ tag: "fp8", quantization: "fp8" })],
			[],
		),
	});
	assert.deepEqual(result.providerSlugs, []);
	assert.match(
		result.noDetailsOutput,
		/No eligible INT4 providers remained after filtering\.$/,
	);
});
