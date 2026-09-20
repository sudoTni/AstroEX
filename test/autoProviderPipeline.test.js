const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { executePipeline } = require("../dist/commands/runPipeline");
const { buildPipelineConfig } = require("../dist/pipelineConfig");
const { llmService } = require("../dist/llmService");

async function setup(t) {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-auto-provider-"),
	);
	const dataDir = path.join(root, "data");
	const logDir = path.join(root, "logs");
	const materialsDir = path.join(root, "materials");
	const profileDir = path.join(root, "profile");
	await Promise.all(
		[dataDir, logDir, materialsDir, profileDir].map((directory) =>
			fs.mkdir(directory, { recursive: true }),
		),
	);
	await Promise.all([
		fs.writeFile(
			path.join(profileDir, "search_terms.txt"),
			"Security Engineer\n",
		),
		fs.writeFile(path.join(profileDir, "my_resume.txt"), "Security resume"),
		fs.writeFile(path.join(profileDir, "my_testimonials.txt"), "Excellent"),
		fs.writeFile(
			path.join(profileDir, "my_professional_title.txt"),
			"Security Engineer",
		),
		fs.writeFile(
			path.join(profileDir, "my_professional_summary.txt"),
			"Cloud security specialist",
		),
		fs.writeFile(path.join(profileDir, "my_key_skills.txt"), "Cloud Security"),
	]);
	const processedFile = path.join(dataDir, "processed.json");
	await fs.writeFile(
		processedFile,
		JSON.stringify([
			{
				id: "indeed:auto-provider",
				source: "indeed",
				sourceJobId: "auto-provider",
				title: "Senior Security Engineer",
				company: "Example Corp",
				url: "https://example.com/job",
				descriptionText: "Cloud security and incident response.",
			},
		]),
		"utf8",
	);
	const prior = {
		ASTROEX_DATA_DIR: process.env.ASTROEX_DATA_DIR,
		ASTROEX_LOG_DIR: process.env.ASTROEX_LOG_DIR,
		ASTROEX_MATERIALS_DIR: process.env.ASTROEX_MATERIALS_DIR,
		ASTROEX_PROFILE_DIR: process.env.ASTROEX_PROFILE_DIR,
	};
	process.env.ASTROEX_DATA_DIR = dataDir;
	process.env.ASTROEX_LOG_DIR = logDir;
	process.env.ASTROEX_MATERIALS_DIR = materialsDir;
	process.env.ASTROEX_PROFILE_DIR = profileDir;
	t.after(async () => {
		for (const [key, value] of Object.entries(prior)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await fs.rm(root, { recursive: true, force: true });
	});
	return { dataDir, materialsDir, profileDir, processedFile };
}

async function captureConsole(run) {
	const original = process.stdout.write;
	let output = "";
	process.stdout.write = (chunk) => {
		output += String(chunk);
		return true;
	};
	try {
		return { result: await run(), output };
	} finally {
		process.stdout.write = original;
	}
}

function selectorResponseFor(url) {
	if (url.includes("/models/deepseek/deepseek-v4-flash/endpoints")) {
		return "deepseek-provider";
	}
	if (url.includes("/models/z-ai/glm-5.3-flash/endpoints")) {
		return "glm-provider";
	}
	if (url.includes("/models/openai/gpt-5.6-luna/endpoints")) {
		return "openai-provider";
	}
	throw new Error(`Unexpected selector URL: ${url}`);
}

function selectionEndpoint(tag) {
	return {
		provider_name: tag,
		tag,
		quantization: "fp8",
		pricing: {
			prompt: "0.000001",
			completion: "0.000001",
			input_cache_read: "0.000001",
		},
		throughput_last_30m: { p50: 80 },
		uptime_last_1d: 99,
		latency_last_30m: { p50: 0.2 },
	};
}

function mockLlmResponse(stage) {
	if (stage === "makeMaterials") {
		return {
			content: `# Resume Filename
resume_auto.txt

# Cover Letter Filename
cover_auto.txt

# Optimized & Tailored Professional Title
Senior Security Engineer

# Optimized & Tailored Professional Summary
Cloud security specialist

# Optimized & Tailored Key Skills
Cloud Security

# Optimized & Tailored Cover Letter
Dear Hiring Team,\n\nI am applying for the role.`,
			usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
		};
	}
	if (stage === "remoteEval") {
		return {
			content: [
				{
					jobTitle: "Senior Security Engineer",
					isConfirmedRemote: true,
					rationale: "Remote",
					confidence: 0.9,
				},
			],
			usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
		};
	}
	return {
		content: [
			{
				jobTitle: "Senior Security Engineer",
				isVeryHighlyAligned: true,
				rationale: "Aligned",
				confidence: 0.9,
			},
		],
		usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
	};
}

test("pipeline resolves each auto-provider stage immediately before its own LLM work", async (t) => {
	const env = await setup(t);
	const events = [];
	const originalFetch = global.fetch;
	const originalCall = llmService.call;
	global.fetch = async (url) => {
		const modelProvider = selectorResponseFor(String(url));
		events.push({ kind: "selector", provider: modelProvider });
		return {
			ok: true,
			json: async () => ({
				data: { endpoints: [selectionEndpoint(modelProvider)] },
			}),
		};
	};
	llmService.call = async (request, options) => {
		events.push({
			kind: "llm",
			stage: options.payloadLogStage,
			routing: request.providerRouting,
		});
		return mockLlmResponse(options.payloadLogStage);
	};
	t.after(() => {
		global.fetch = originalFetch;
		llmService.call = originalCall;
	});

	const config = buildPipelineConfig({
		search: { sites: ["indeed"], remoteOnly: true },
		paths: {
			dataDir: env.dataDir,
			profileDir: env.profileDir,
			materialsDir: env.materialsDir,
			processedJobsFile: env.processedFile,
		},
		providers: { apiKey: "test-key" },
		deployment: { enabled: false },
		options: { clean: false, sleep: 0, useCheckpoints: false },
		presets: {
			jobCloth: "jc_ds-v4-f-0423",
			remoteEval: "re_glm-5.3-flash",
			jobJudge: "jep_ds-v4-f-0423",
			makeMaterials: "rop_g5.6-luna_or",
		},
		providerRouting: {
			jobCloth: { only: ["astro_auto_provider"] },
			remoteEval: { only: ["astro_auto_provider"] },
			jobJudge: { only: ["astro_auto_provider"] },
			makeMaterials: { only: ["astro_auto_provider"] },
		},
	});
	const { output } = await captureConsole(() =>
		executePipeline(config, { resume: "jobCloth" }),
	);

	const stageRouting = new Map();
	for (const event of events.filter((event) => event.kind === "llm")) {
		if (!stageRouting.has(event.stage))
			stageRouting.set(event.stage, event.routing);
	}
	assert.deepEqual(stageRouting.get("jobCloth"), {
		only: ["deepseek-provider"],
	});
	assert.deepEqual(stageRouting.get("remoteEval"), { only: ["glm-provider"] });
	assert.deepEqual(stageRouting.get("jobJudge"), {
		only: ["deepseek-provider"],
	});
	assert.deepEqual(stageRouting.get("makeMaterials"), {
		only: ["openai-provider"],
	});
	assert.equal(events.filter((event) => event.kind === "selector").length, 4);
	const expectedSelectors = [
		["jobCloth", "deepseek-provider"],
		["remoteEval", "glm-provider"],
		["jobJudge", "deepseek-provider"],
		["makeMaterials", "openai-provider"],
	];
	assert.deepEqual(
		events
			.filter((event) => event.kind === "selector")
			.map((event) => event.provider),
		expectedSelectors.map(([, provider]) => provider),
	);
	for (const [selectorOffset, [stage]] of expectedSelectors.entries()) {
		const selectorIndex = events
			.map((event, index) => ({ event, index }))
			.filter(({ event }) => event.kind === "selector")[selectorOffset].index;
		const llmIndex = events.findIndex(
			(event) => event.kind === "llm" && event.stage === stage,
		);
		assert.ok(
			selectorIndex >= 0 && selectorIndex < llmIndex,
			`${stage} must select before LLM execution`,
		);
	}
	assert.equal(output.match(/Provider slugs:/g)?.length, 4);
	assert.equal(output.includes("only=astro_auto_provider"), false);
});

test("explicit routes bypass selection while mixed sentinel routes fail before LLM execution", async (t) => {
	const env = await setup(t);
	let selectorCalls = 0;
	let llmCalls = 0;
	const routes = [];
	const originalFetch = global.fetch;
	const originalCall = llmService.call;
	global.fetch = async () => {
		selectorCalls += 1;
		return {
			ok: true,
			json: async () => ({
				data: { endpoints: [selectionEndpoint("selected")] },
			}),
		};
	};
	llmService.call = async (request) => {
		llmCalls += 1;
		routes.push(request.providerRouting);
		return mockLlmResponse("jobCloth");
	};
	t.after(() => {
		global.fetch = originalFetch;
		llmService.call = originalCall;
	});

	const explicitConfig = buildPipelineConfig({
		paths: {
			dataDir: env.dataDir,
			profileDir: env.profileDir,
			materialsDir: env.materialsDir,
			processedJobsFile: env.processedFile,
		},
		providers: { apiKey: "test-key" },
		deployment: { enabled: false },
		options: { clean: false, sleep: 0, useCheckpoints: false },
		providerRouting: { jobCloth: { only: ["anthropic"] } },
	});
	await executePipeline(explicitConfig, {
		resume: "jobCloth",
		skipMaterials: true,
	});
	assert.equal(selectorCalls, 0);
	assert.ok(routes.some((route) => route?.only?.[0] === "anthropic"));

	llmCalls = 0;
	routes.length = 0;
	const mixedConfig = buildPipelineConfig({
		paths: {
			dataDir: env.dataDir,
			profileDir: env.profileDir,
			materialsDir: env.materialsDir,
			processedJobsFile: env.processedFile,
		},
		providers: { apiKey: "test-key" },
		deployment: { enabled: false },
		options: { clean: false, sleep: 0, useCheckpoints: false },
		providerRouting: {
			jobCloth: { only: ["astro_auto_provider", "anthropic"] },
		},
	});
	await assert.rejects(
		() =>
			executePipeline(mixedConfig, { resume: "jobCloth", skipMaterials: true }),
		/must be used alone/,
	);
	assert.equal(selectorCalls, 0);
	assert.equal(llmCalls, 0);
});

test("pipeline passes stage quantization constraints to astro_auto_provider and preserves routing", async (t) => {
	const env = await setup(t);
	const routes = [];
	const originalFetch = global.fetch;
	const originalCall = llmService.call;
	global.fetch = async () => {
		return {
			ok: true,
			json: async () => ({
				data: {
					endpoints: [
						{
							provider_name: "int8-provider",
							tag: "int8-provider",
							quantization: "int8",
							pricing: {
								prompt: "0.000001",
								completion: "0.000001",
								input_cache_read: "0.000001",
							},
							throughput_last_30m: { p50: 80 },
							uptime_last_1d: 99,
							latency_last_30m: { p50: 0.2 },
						},
					],
				},
			}),
		};
	};
	llmService.call = async (request, options) => {
		routes.push(request.providerRouting);
		return mockLlmResponse(options.payloadLogStage);
	};
	t.after(() => {
		global.fetch = originalFetch;
		llmService.call = originalCall;
	});

	const config = buildPipelineConfig({
		paths: {
			dataDir: env.dataDir,
			profileDir: env.profileDir,
			materialsDir: env.materialsDir,
			processedJobsFile: env.processedFile,
		},
		providers: { apiKey: "test-key" },
		deployment: { enabled: false },
		options: { clean: false, sleep: 0, useCheckpoints: false },
		providerIgnore: ["deepinfra"],
		"jc-provider-quant": "int8",
		providerRouting: {
			jobCloth: { only: ["astro_auto_provider"] },
		},
	});

	await executePipeline(config, {
		resume: "jobCloth",
		skipMaterials: true,
	});

	assert.ok(routes.length > 0);
	assert.deepEqual(routes[0], {
		only: ["int8-provider"],
		ignore: ["deepinfra"],
		quantizations: ["int8"],
	});
});

test("pipeline respects --astro_auto_provider-top when selecting provider endpoints and logs orchestration", async (t) => {
	const env = await setup(t);
	const routes = [];
	const originalFetch = global.fetch;
	const originalCall = llmService.call;

	const mockEndpoints = [
		{
			provider_name: "prov-1",
			tag: "prov-1",
			quantization: "fp8",
			pricing: {
				prompt: "0.000001",
				completion: "0.000001",
				input_cache_read: "0.000001",
			},
			throughput_last_30m: { p50: 90 },
			uptime_last_1d: 99,
			latency_last_30m: { p50: 0.1 },
		},
		{
			provider_name: "prov-2",
			tag: "prov-2",
			quantization: "fp8",
			pricing: {
				prompt: "0.000001",
				completion: "0.000001",
				input_cache_read: "0.000001",
			},
			throughput_last_30m: { p50: 85 },
			uptime_last_1d: 99,
			latency_last_30m: { p50: 0.2 },
		},
		{
			provider_name: "prov-3",
			tag: "prov-3",
			quantization: "fp8",
			pricing: {
				prompt: "0.000001",
				completion: "0.000001",
				input_cache_read: "0.000001",
			},
			throughput_last_30m: { p50: 80 },
			uptime_last_1d: 99,
			latency_last_30m: { p50: 0.3 },
		},
		{
			provider_name: "prov-4",
			tag: "prov-4",
			quantization: "fp8",
			pricing: {
				prompt: "0.000001",
				completion: "0.000001",
				input_cache_read: "0.000001",
			},
			throughput_last_30m: { p50: 75 },
			uptime_last_1d: 99,
			latency_last_30m: { p50: 0.4 },
		},
		{
			provider_name: "prov-5",
			tag: "prov-5",
			quantization: "fp8",
			pricing: {
				prompt: "0.000001",
				completion: "0.000001",
				input_cache_read: "0.000001",
			},
			throughput_last_30m: { p50: 70 },
			uptime_last_1d: 99,
			latency_last_30m: { p50: 0.5 },
		},
		{
			provider_name: "prov-6",
			tag: "prov-6",
			quantization: "fp8",
			pricing: {
				prompt: "0.000001",
				completion: "0.000001",
				input_cache_read: "0.000001",
			},
			throughput_last_30m: { p50: 65 },
			uptime_last_1d: 99,
			latency_last_30m: { p50: 0.6 },
		},
	];

	global.fetch = async () => {
		return {
			ok: true,
			json: async () => ({
				data: { endpoints: mockEndpoints },
			}),
		};
	};

	llmService.call = async (request, options) => {
		routes.push(request.providerRouting);
		return mockLlmResponse(options.payloadLogStage);
	};

	t.after(() => {
		global.fetch = originalFetch;
		llmService.call = originalCall;
	});

	const config = buildPipelineConfig({
		paths: {
			dataDir: env.dataDir,
			profileDir: env.profileDir,
			materialsDir: env.materialsDir,
			processedJobsFile: env.processedFile,
		},
		providers: { apiKey: "test-key" },
		deployment: { enabled: false },
		options: { clean: false, sleep: 0, useCheckpoints: false },
		"astro_auto_provider-top": 4,
		providerRouting: {
			jobCloth: { only: ["astro_auto_provider"] },
		},
	});

	const { output } = await captureConsole(() =>
		executePipeline(config, {
			resume: "jobCloth",
			skipMaterials: true,
			"astro_auto_provider-top": 4,
		}),
	);

	assert.ok(routes.length > 0);
	assert.equal(routes[0].only.length, 4);
	assert.deepEqual(routes[0].only, ["prov-1", "prov-2", "prov-3", "prov-4"]);
	assert.ok(
		output.includes("astro_auto_provider-top=4"),
		"console output must include astro_auto_provider-top=4",
	);
});
