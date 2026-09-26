const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const { executePipeline } = require("../dist/commands/runPipeline");
const { runJobCloth } = require("../dist/commands/jobCloth");
const { runJobJudge } = require("../dist/commands/jobJudge");
const { runResumeOptimizationMode } = require("../dist/commands/makeMaterials");
const { llmService } = require("../dist/llmService");
const { formatLLMRequest } = require("../dist/logging/llmFormatter");
const {
	buildPipelineConfig,
	parseOpenRouterProviderRouting,
} = require("../dist/pipelineConfig");
const { getPreset, loadPresets } = require("../dist/presets");
const { ExecutionLog } = require("../dist/utils");

const execFileAsync = promisify(execFile);

async function setupTestEnvironment() {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-provider-routing-test-"),
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
		fs.writeFile(
			path.join(profileDir, "my_testimonials.txt"),
			"Strong security engineer",
		),
		fs.writeFile(
			path.join(profileDir, "my_professional_title.txt"),
			"Security Engineer",
		),
		fs.writeFile(
			path.join(profileDir, "my_professional_summary.txt"),
			"Cloud security specialist",
		),
		fs.writeFile(
			path.join(profileDir, "my_key_skills.txt"),
			"Cloud Security, Incident Response",
		),
	]);
	const inputFile = path.join(dataDir, "processed_jobs.json");
	await fs.writeFile(
		inputFile,
		JSON.stringify([
			{
				id: `indeed:${path.basename(root)}`,
				source: "indeed",
				sourceJobId: path.basename(root),
				title: "Senior Security Engineer",
				company: "Example Corp",
				url: "https://example.com/job",
				descriptionText: "Secure cloud systems and respond to incidents.",
			},
		]),
		"utf8",
	);
	return { root, dataDir, logDir, materialsDir, profileDir, inputFile };
}

function installEnvironment(env) {
	const prior = {};
	for (const [key, value] of Object.entries({
		ASTROEX_DATA_DIR: env.dataDir,
		ASTROEX_LOG_DIR: env.logDir,
		ASTROEX_MATERIALS_DIR: env.materialsDir,
		ASTROEX_PROFILE_DIR: env.profileDir,
	})) {
		prior[key] = process.env[key];
		process.env[key] = value;
	}
	return () => {
		for (const [key, value] of Object.entries(prior)) {
			if (value === undefined) Reflect.deleteProperty(process.env, key);
			else process.env[key] = value;
		}
	};
}

function mockLlmCall(captured) {
	return async (request, options) => {
		const stage = options?.payloadLogStage;
		captured[stage].push(JSON.parse(JSON.stringify(request)));
		if (stage === "makeMaterials") {
			return {
				content: `# Resume Filename
resume_test.txt

# Cover Letter Filename
cover_test.txt

# Optimized & Tailored Professional Title
Senior Security Engineer

# Optimized & Tailored Professional Summary
Cloud security specialist

# Optimized & Tailored Key Skills
Cloud Security

# Optimized & Tailored Cover Letter
Dear Hiring Team, I am applying for the security role.`,
				usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
			};
		}
		return {
			content: [
				{
					jobTitle: "Senior Security Engineer",
					isVeryHighlyAligned: true,
					rationale: "Strong security alignment",
					confidence: 0.95,
				},
			],
			usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
		};
	};
}

async function runAllLlmStages(env, providerRouting = {}) {
	const captured = { jobCloth: [], jobJudge: [], makeMaterials: [] };
	const originalCall = llmService.call;
	llmService.call = mockLlmCall(captured);
	try {
		const presets = await loadPresets();
		const clothPreset = getPreset("jobCloth", "jc_glm-5.3-flash", presets);
		const materialsPreset = getPreset(
			"makeMaterials",
			"rop_g5.6-luna_or",
			presets,
		);
		assert.ok(clothPreset);
		assert.ok(materialsPreset);

		const clothedFile = path.join(env.dataDir, "clothed_jobs.json");
		await runJobCloth(env.inputFile, clothedFile, {
			apiKey: "mock-key",
			baseUrl: clothPreset.base_url,
			modelId: clothPreset.modelId,
			preset: clothPreset.name,
			batch: 10,
			sleep: 0,
			...(providerRouting.jobCloth
				? { providerRouting: providerRouting.jobCloth }
				: {}),
		});

		await runJobJudge({
			"api-key": "mock-key",
			"base-url": "",
			"model-id": "",
			"input-file": clothedFile,
			"output-file": path.join(env.dataDir, "astroapply_eval_"),
			preset: "jep_glm-5.3-flash",
			"use-jobdb": false,
			"strict-parsing": false,
			sleep: 0,
			"eval-mode": 1,
			...(providerRouting.jobJudge
				? { providerRouting: providerRouting.jobJudge }
				: {}),
		});

		const materialsResult = await runResumeOptimizationMode(materialsPreset, {
			preset: materialsPreset.name,
			apiKey: "mock-key",
			targJD: `Unique target ${env.root}`,
			sleep: 0,
			...(providerRouting.makeMaterials
				? { providerRouting: providerRouting.makeMaterials }
				: {}),
		});
		assert.equal(materialsResult.error, undefined);
		return captured;
	} finally {
		llmService.call = originalCall;
	}
}

test("provider routing parser trims entries, preserves order, and omits empty input", () => {
	assert.equal(parseOpenRouterProviderRouting(undefined), undefined);
	assert.equal(parseOpenRouterProviderRouting(""), undefined);
	assert.equal(parseOpenRouterProviderRouting("   "), undefined);
	assert.deepEqual(parseOpenRouterProviderRouting("anthropic"), {
		only: ["anthropic"],
		order: ["anthropic"],
		allow_fallbacks: false,
	});
	assert.deepEqual(
		parseOpenRouterProviderRouting(
			" anthropic, amazon-bedrock,,google-vertex ",
		),
		{
			only: ["anthropic", "amazon-bedrock", "google-vertex"],
			order: ["anthropic", "amazon-bedrock", "google-vertex"],
			allow_fallbacks: false,
		},
	);
	assert.deepEqual(
		parseOpenRouterProviderRouting("Custom-Provider,custom-two"),
		{
			only: ["Custom-Provider", "custom-two"],
			order: ["Custom-Provider", "custom-two"],
			allow_fallbacks: false,
		},
	);
});

test("pipeline config keeps stage provider routes independent and rejects empty lists", () => {
	const baseline = buildPipelineConfig({});
	assert.equal(baseline.providerRouting.jobCloth, undefined);
	assert.equal(baseline.providerRouting.remoteEval, undefined);
	assert.equal(baseline.providerRouting.jobJudge, undefined);
	assert.equal(baseline.providerRouting.makeMaterials, undefined);

	const configured = buildPipelineConfig({
		providerRouting: {
			jobCloth: {
				only: ["anthropic"],
				order: ["anthropic"],
				allow_fallbacks: false,
			},
			remoteEval: {
				only: ["openai"],
				order: ["openai"],
				allow_fallbacks: false,
			},
			jobJudge: {
				only: ["google-vertex"],
				order: ["google-vertex"],
				allow_fallbacks: false,
			},
			makeMaterials: {
				only: ["amazon-bedrock", "anthropic"],
				order: ["amazon-bedrock", "anthropic"],
				allow_fallbacks: false,
			},
		},
	});
	assert.deepEqual(configured.providerRouting, {
		jobCloth: {
			only: ["anthropic"],
			order: ["anthropic"],
			allow_fallbacks: false,
		},
		remoteEval: { only: ["openai"], order: ["openai"], allow_fallbacks: false },
		jobJudge: {
			only: ["google-vertex"],
			order: ["google-vertex"],
			allow_fallbacks: false,
		},
		makeMaterials: {
			only: ["amazon-bedrock", "anthropic"],
			order: ["amazon-bedrock", "anthropic"],
			allow_fallbacks: false,
		},
	});
	assert.throws(
		() =>
			buildPipelineConfig({
				// Deliberately invalid: an empty slug list must stay rejected.
				providerRouting: { jobCloth: { only: [] } },
			}),
		/too_small|at least 1|Array must contain/i,
	);
});

test("each pipeline provider option preserves the auto-provider sentinel as a sole route", () => {
	const auto = parseOpenRouterProviderRouting("astro_auto_provider");
	assert.deepEqual(auto, {
		only: ["astro_auto_provider"],
		order: ["astro_auto_provider"],
		allow_fallbacks: false,
	});
	const configured = buildPipelineConfig({
		providerRouting: {
			jobCloth: auto,
			remoteEval: auto,
			jobJudge: auto,
			makeMaterials: auto,
		},
	});
	for (const routing of Object.values(configured.providerRouting)) {
		assert.deepEqual(routing, {
			only: ["astro_auto_provider"],
			order: ["astro_auto_provider"],
			allow_fallbacks: false,
		});
	}
});

test("all three LLM stages omit provider routing by default", async (t) => {
	const env = await setupTestEnvironment();
	const restoreEnvironment = installEnvironment(env);
	t.after(async () => {
		restoreEnvironment();
		await fs.rm(env.root, { recursive: true, force: true });
	});

	const captured = await runAllLlmStages(env);
	for (const stage of Object.keys(captured)) {
		assert.ok(captured[stage].length > 0);
		assert.ok(
			captured[stage].every((request) => !("providerRouting" in request)),
		);
	}
});

test("provider routing reaches only its configured stage", async (t) => {
	const env = await setupTestEnvironment();
	const restoreEnvironment = installEnvironment(env);
	t.after(async () => {
		restoreEnvironment();
		await fs.rm(env.root, { recursive: true, force: true });
	});

	const captured = await runAllLlmStages(env, {
		jobCloth: {
			only: ["anthropic", "amazon-bedrock"],
			order: ["anthropic", "amazon-bedrock"],
			allow_fallbacks: false,
		},
	});
	assert.ok(
		captured.jobCloth.every((request) => {
			assert.deepEqual(request.providerRouting, {
				only: ["anthropic", "amazon-bedrock"],
				order: ["anthropic", "amazon-bedrock"],
				allow_fallbacks: false,
			});
			return true;
		}),
	);
	assert.ok(
		captured.jobJudge.every((request) => !("providerRouting" in request)),
	);
	assert.ok(
		captured.makeMaterials.every((request) => !("providerRouting" in request)),
	);
});

test("each stage preserves its own provider order in requests and logs", async (t) => {
	const env = await setupTestEnvironment();
	const restoreEnvironment = installEnvironment(env);
	const originalStdoutWrite = process.stdout.write;
	let stdout = "";
	process.stdout.write = (chunk) => {
		stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
		return true;
	};
	const executionLog = new ExecutionLog();
	const executionLogPath = executionLog.initialize(env.logDir, [
		"run-pipeline",
	]);

	t.after(async () => {
		executionLog.close();
		process.stdout.write = originalStdoutWrite;
		restoreEnvironment();
		await fs.rm(env.root, { recursive: true, force: true });
	});

	const routes = {
		jobCloth: {
			only: ["anthropic", "amazon-bedrock"],
			order: ["anthropic", "amazon-bedrock"],
			allow_fallbacks: false,
		},
		jobJudge: {
			only: ["google-vertex"],
			order: ["google-vertex"],
			allow_fallbacks: false,
		},
		makeMaterials: {
			only: ["amazon-bedrock", "anthropic"],
			order: ["amazon-bedrock", "anthropic"],
			allow_fallbacks: false,
		},
	};
	const captured = await runAllLlmStages(env, routes);
	for (const stage of Object.keys(routes)) {
		assert.ok(captured[stage].length > 0);
		assert.ok(
			captured[stage].every((request) => {
				assert.deepEqual(request.providerRouting, routes[stage]);
				return true;
			}),
		);
	}

	executionLog.close();
	const executionOutput = await fs.readFile(executionLogPath, "utf8");
	for (const expected of [
		"jc-provider=anthropic,amazon-bedrock",
		"jj-provider=google-vertex",
		"mm-provider=amazon-bedrock,anthropic",
	]) {
		assert.ok(
			stdout.includes(expected),
			`console output must include ${expected}`,
		);
		assert.ok(
			executionOutput.includes(expected),
			`execution log must include ${expected}`,
		);
	}
});

test("global provider-ignore propagates to all stages", () => {
	const config = buildPipelineConfig({
		providerIgnore: ["deepinfra", "together"],
		providerRouting: {
			jobCloth: {
				only: ["anthropic"],
				order: ["anthropic"],
				allow_fallbacks: false,
			},
		},
	});
	assert.deepEqual(config.providerIgnore, ["deepinfra", "together"]);
	assert.deepEqual(config.providerRouting.jobCloth, {
		only: ["anthropic"],
		order: ["anthropic"],
		allow_fallbacks: false,
		ignore: ["deepinfra", "together"],
	});
	assert.deepEqual(config.providerRouting.remoteEval, {
		ignore: ["deepinfra", "together"],
	});
	assert.deepEqual(config.providerRouting.jobJudge, {
		ignore: ["deepinfra", "together"],
	});
	assert.deepEqual(config.providerRouting.makeMaterials, {
		ignore: ["deepinfra", "together"],
	});
});

test("stage quantization options remain strictly isolated to their stage", () => {
	const config = buildPipelineConfig({
		"jc-provider-quant": "int8, fp8",
		"jj-provider-quant": "int4",
	});
	assert.deepEqual(config.providerRouting.jobCloth, {
		quantizations: ["int8", "fp8"],
	});
	assert.equal(config.providerRouting.remoteEval, undefined);
	assert.deepEqual(config.providerRouting.jobJudge, {
		quantizations: ["int4"],
	});
	assert.equal(config.providerRouting.makeMaterials, undefined);
});

test("stage routing supports full coexistence of only, ignore, and quantizations", async (t) => {
	const env = await setupTestEnvironment();
	const restoreEnvironment = installEnvironment(env);
	t.after(async () => {
		restoreEnvironment();
		await fs.rm(env.root, { recursive: true, force: true });
	});

	const routes = {
		jobCloth: {
			only: ["anthropic"],
			order: ["anthropic"],
			allow_fallbacks: false,
			ignore: ["deepinfra"],
			quantizations: ["int8", "fp8"],
		},
		jobJudge: {
			only: ["google-vertex"],
			order: ["google-vertex"],
			allow_fallbacks: false,
			ignore: ["deepinfra"],
		},
		makeMaterials: {
			ignore: ["deepinfra"],
			quantizations: ["bf16"],
		},
	};
	const captured = await runAllLlmStages(env, routes);
	assert.ok(
		captured.jobCloth.every((req) => {
			assert.deepEqual(req.providerRouting, routes.jobCloth);
			return true;
		}),
	);
	assert.ok(
		captured.jobJudge.every((req) => {
			assert.deepEqual(req.providerRouting, routes.jobJudge);
			return true;
		}),
	);
	assert.ok(
		captured.makeMaterials.every((req) => {
			assert.deepEqual(req.providerRouting, routes.makeMaterials);
			return true;
		}),
	);
});

test("detailed LLM request formatting shows provider routing parameters when configured", () => {
	const configured = formatLLMRequest({
		provider: "openrouter",
		model: "test-model",
		reasoning_effort: "high",
		providerRouting: {
			only: ["anthropic"],
			order: ["anthropic"],
			allow_fallbacks: false,
			ignore: ["deepinfra", "together"],
			quantizations: ["int8", "fp8"],
		},
	});
	assert.ok(configured.includes("reasoning_effort=high"));
	assert.ok(configured.includes("provider.only=anthropic"));
	assert.ok(configured.includes("provider.order=anthropic"));
	assert.ok(configured.includes("allow_fallbacks=false"));
	assert.ok(configured.includes("provider.ignore=deepinfra,together"));
	assert.ok(configured.includes("provider.quantizations=int8,fp8"));

	const omitted = formatLLMRequest({
		provider: "openrouter",
		model: "test-model",
	});
	assert.equal(omitted.includes("provider.only"), false);
	assert.equal(omitted.includes("provider.order"), false);
	assert.equal(omitted.includes("allow_fallbacks"), false);
	assert.equal(omitted.includes("provider.ignore"), false);
	assert.equal(omitted.includes("provider.quantizations"), false);
});

test("run-pipeline logs provider-ignore and stage quantizations in console output", async (t) => {
	const env = await setupTestEnvironment();
	const restoreEnvironment = installEnvironment(env);
	const originalStdoutWrite = process.stdout.write;
	let stdout = "";
	process.stdout.write = (chunk) => {
		stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
		return true;
	};
	const originalCall = llmService.call;
	llmService.call = async () => ({
		content: [
			{
				jobTitle: "Senior Security Engineer",
				isPreFiltered: true,
				rationale: "Matches",
			},
		],
		usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
	});

	t.after(() => {
		llmService.call = originalCall;
		process.stdout.write = originalStdoutWrite;
		restoreEnvironment();
		return fs.rm(env.root, { recursive: true, force: true });
	});

	const config = buildPipelineConfig({
		paths: {
			dataDir: env.dataDir,
			profileDir: env.profileDir,
			materialsDir: env.materialsDir,
			processedJobsFile: env.inputFile,
		},
		providers: { apiKey: "test-key" },
		deployment: { enabled: false },
		options: { clean: false, sleep: 0, useCheckpoints: false },
		providerIgnore: ["deepinfra", "together"],
		"jc-provider-quant": "int8,fp8",
		providerRouting: {
			jobCloth: {
				only: ["anthropic"],
				order: ["anthropic"],
				allow_fallbacks: false,
			},
		},
	});

	await executePipeline(config, {
		resume: "jobCloth",
		skipMaterials: true,
	});

	assert.ok(
		stdout.includes("provider-ignore=deepinfra,together"),
		"console output must include provider-ignore=deepinfra,together",
	);
	assert.ok(
		stdout.includes("jc-provider-quant=int8,fp8"),
		"console output must include jc-provider-quant=int8,fp8",
	);
});

test("run-pipeline help exposes provider routing, ignore, and quantization options", async (t) => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-routing-help-"),
	);
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const { stdout } = await execFileAsync(
		process.execPath,
		[
			path.join(__dirname, "../dist/index.js"),
			"--no-banner",
			"run-pipeline",
			"--help",
		],
		{
			env: {
				...process.env,
				ASTROEX_DATA_DIR: path.join(root, "data"),
				ASTROEX_LOG_DIR: path.join(root, "logs"),
				ASTROEX_MATERIALS_DIR: path.join(root, "materials"),
				ASTROEX_PROFILE_DIR: path.join(root, "profile"),
			},
		},
	);
	for (const option of [
		"--jc-provider",
		"--re-provider",
		"--jj-provider",
		"--mm-provider",
		"--provider-ignore",
		"--jc-provider-quant",
		"--re-provider-quant",
		"--jj-provider-quant",
		"--mm-provider-quant",
		"--astro_auto_provider-top",
	]) {
		assert.ok(stdout.includes(option), `help must include ${option}`);
	}
	assert.match(stdout, /comma-separated list/);
	assert.match(stdout, /astro_auto_provider/);
});

test("buildPipelineConfig validates and configures astro_auto_provider-top", () => {
	const defaultCfg = buildPipelineConfig({});
	assert.equal(defaultCfg.options.astroAutoProviderTop, 3);

	const customCfg = buildPipelineConfig({ "astro_auto_provider-top": 4 });
	assert.equal(customCfg.options.astroAutoProviderTop, 4);

	const strCfg = buildPipelineConfig({ "astro_auto_provider-top": "5" });
	assert.equal(strCfg.options.astroAutoProviderTop, 5);

	const camelCfg = buildPipelineConfig({ astroAutoProviderTop: 6 });
	assert.equal(camelCfg.options.astroAutoProviderTop, 6);

	const optCfg = buildPipelineConfig({ options: { astroAutoProviderTop: 7 } });
	assert.equal(optCfg.options.astroAutoProviderTop, 7);

	const prevEnv = process.env.ASTROEX_ASTRO_AUTO_PROVIDER_TOP;
	try {
		process.env.ASTROEX_ASTRO_AUTO_PROVIDER_TOP = "8";
		const envCfg = buildPipelineConfig({});
		assert.equal(envCfg.options.astroAutoProviderTop, 8);
	} finally {
		if (prevEnv === undefined)
			Reflect.deleteProperty(process.env, "ASTROEX_ASTRO_AUTO_PROVIDER_TOP");
		else process.env.ASTROEX_ASTRO_AUTO_PROVIDER_TOP = prevEnv;
	}

	assert.throws(() => buildPipelineConfig({ "astro_auto_provider-top": 0 }));
	assert.throws(() => buildPipelineConfig({ "astro_auto_provider-top": -1 }));
	assert.throws(() => buildPipelineConfig({ "astro_auto_provider-top": 2.5 }));
	assert.throws(() =>
		buildPipelineConfig({ "astro_auto_provider-top": "abc" }),
	);
});

test("run-pipeline rejects invalid --astro_auto_provider-top values", async (t) => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-top-validation-"),
	);
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	for (const invalidValue of ["0", "-1", "2.5"]) {
		await assert.rejects(
			async () => {
				await execFileAsync(
					process.execPath,
					[
						path.join(__dirname, "../dist/index.js"),
						"--no-banner",
						"run-pipeline",
						"--astro_auto_provider-top",
						invalidValue,
					],
					{
						env: {
							...process.env,
							ASTROEX_DATA_DIR: path.join(root, "data"),
							ASTROEX_LOG_DIR: path.join(root, "logs"),
							ASTROEX_MATERIALS_DIR: path.join(root, "materials"),
							ASTROEX_PROFILE_DIR: path.join(root, "profile"),
						},
					},
				);
			},
			(err) => {
				assert.match(
					err.stderr || err.stdout || err.message,
					/--astro_auto_provider-top must be an integer of at least 1/,
				);
				return true;
			},
		);
	}
});
