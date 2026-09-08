const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runJobCloth } = require("../dist/commands/jobCloth");
const { runJobJudge } = require("../dist/commands/jobJudge");
const { runResumeOptimizationMode } = require("../dist/commands/makeMaterials");
const { llmService } = require("../dist/llmService");
const { formatLLMRequest } = require("../dist/logging/llmFormatter");
const { buildPipelineConfig } = require("../dist/pipelineConfig");
const { getPreset, loadPresets } = require("../dist/presets");

// Helper to set up a clean temporary environment
async function setupTestEnvironment() {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-reasoning-test-"),
	);
	const dataDir = path.join(root, "data");
	const logDir = path.join(root, "logs");
	const materialsDir = path.join(root, "materials");
	const profileDir = path.join(root, "profile");

	await Promise.all([
		fs.mkdir(dataDir, { recursive: true }),
		fs.mkdir(logDir, { recursive: true }),
		fs.mkdir(materialsDir, { recursive: true }),
		fs.mkdir(profileDir, { recursive: true }),
	]);

	// Write required profile files
	await fs.writeFile(
		path.join(profileDir, "my_resume.txt"),
		"Sample Resume Content for Testing",
		"utf-8",
	);
	await fs.writeFile(
		path.join(profileDir, "my_testimonials.txt"),
		"Great engineer and colleague.",
		"utf-8",
	);
	await fs.writeFile(
		path.join(profileDir, "my_professional_title.txt"),
		"Security Engineer",
		"utf-8",
	);
	await fs.writeFile(
		path.join(profileDir, "my_professional_summary.txt"),
		"Experienced cloud security engineer.",
		"utf-8",
	);
	await fs.writeFile(
		path.join(profileDir, "my_key_skills.txt"),
		"- Cloud Security\n- TypeScript",
		"utf-8",
	);

	// Write sample jobs input file
	const sampleJobs = [
		{
			id: "indeed:job-1",
			title: "Senior Security Analyst",
			company: "CyberCorp",
			descriptionText: "Security analyst responsibilities and requirements.",
			source: "indeed",
			url: "https://example.com/job/1",
		},
	];
	const sampleJobsFile = path.join(dataDir, "test_jobs.json");
	await fs.writeFile(
		sampleJobsFile,
		JSON.stringify(sampleJobs, null, 2),
		"utf-8",
	);

	return {
		root,
		dataDir,
		logDir,
		materialsDir,
		profileDir,
		sampleJobsFile,
	};
}

function createMockLlmCall(capturedRequests) {
	return async (request) => {
		capturedRequests.push(request);
		const userMsg =
			request.messages?.find((m) => m.role === "user")?.content || "";
		if (userMsg.includes("Job Titles") || userMsg.includes("job title")) {
			return {
				content: [
					{
						jobTitle: "Senior Security Analyst",
						isVeryHighlyAligned: true,
						rationale: "Relevant experience",
						confidence: 0.95,
					},
				],
				usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
			};
		}
		if (
			userMsg.includes("Resume Optimization") ||
			userMsg.includes("cover_length") ||
			request.messages?.some(
				(m) => m.role === "system" && m.content.includes("Veritas"),
			)
		) {
			return {
				content: `# Resume Filename
resume_test.txt

# Cover Letter Filename
cover_test.txt

# Optimized & Tailored Professional Title
Senior Security Analyst

# Optimized & Tailored Professional Summary
Expert security analyst.

# Optimized & Tailored Key Skills
- Cloud Security

# Optimized & Tailored Cover Letter
Dear Hiring Team,\n\nI am applying for Senior Security Analyst.`,
				usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
			};
		}
		return {
			content: [
				{
					jobTitle: "Senior Security Analyst",
					isVeryHighlyAligned: true,
					rationale: "Relevant experience",
					confidence: 0.95,
				},
			],
			usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
		};
	};
}

test("buildPipelineConfig correctly maps phase-specific reasoning effort options", () => {
	// Baseline: no reasoning effort options provided
	const baseConfig = buildPipelineConfig({});
	assert.equal(baseConfig.reasoningEffort.jobCloth, undefined);
	assert.equal(baseConfig.reasoningEffort.jobJudge, undefined);
	assert.equal(baseConfig.reasoningEffort.makeMaterials, undefined);

	// Supplied with phase-specific options
	const configured = buildPipelineConfig({
		reasoningEffort: {
			jobCloth: "low",
			jobJudge: "high",
			makeMaterials: "max",
		},
	});
	assert.equal(configured.reasoningEffort.jobCloth, "low");
	assert.equal(configured.reasoningEffort.jobJudge, "high");
	assert.equal(configured.reasoningEffort.makeMaterials, "max");

	// Preserves arbitrary opaque string values
	const custom = buildPipelineConfig({
		reasoningEffort: {
			jobCloth: "custom-reasoning-1",
			jobJudge: "o3-mini-high",
			makeMaterials: "extreme",
		},
	});
	assert.equal(custom.reasoningEffort.jobCloth, "custom-reasoning-1");
	assert.equal(custom.reasoningEffort.jobJudge, "o3-mini-high");
	assert.equal(custom.reasoningEffort.makeMaterials, "extreme");
});

test("formatLLMRequest includes reasoning_effort only when present and non-empty", () => {
	// When reasoning_effort is provided
	const formattedHigh = formatLLMRequest({
		provider: "openai",
		model: "o3-mini",
		temperature: 0.7,
		reasoning_effort: "high",
	});
	assert.ok(
		formattedHigh.includes("reasoning_effort=high"),
		`Formatted request should contain reasoning_effort=high, got: ${formattedHigh}`,
	);

	const formattedMax = formatLLMRequest({
		provider: "openai",
		model: "o3-mini",
		reasoning_effort: "max",
	});
	assert.ok(
		formattedMax.includes("reasoning_effort=max"),
		`Formatted request should contain reasoning_effort=max, got: ${formattedMax}`,
	);

	// When reasoning_effort is omitted/undefined
	const formattedOmitted = formatLLMRequest({
		provider: "openai",
		model: "gpt-4o",
		temperature: 0.7,
	});
	assert.ok(
		!formattedOmitted.includes("reasoning_effort"),
		`Formatted request must NOT mention reasoning_effort when omitted, got: ${formattedOmitted}`,
	);

	// When reasoning_effort is empty string
	const formattedEmpty = formatLLMRequest({
		provider: "openai",
		model: "gpt-4o",
		reasoning_effort: "",
	});
	assert.ok(
		!formattedEmpty.includes("reasoning_effort"),
		`Formatted request must NOT mention reasoning_effort when empty string, got: ${formattedEmpty}`,
	);
});

test("Baseline: all phases omit reasoning_effort when CLI options are not provided", async (t) => {
	const env = await setupTestEnvironment();
	const priorEnv = {
		ASTROEX_DATA_DIR: process.env.ASTROEX_DATA_DIR,
		ASTROEX_LOG_DIR: process.env.ASTROEX_LOG_DIR,
		ASTROEX_MATERIALS_DIR: process.env.ASTROEX_MATERIALS_DIR,
		ASTROEX_PROFILE_DIR: process.env.ASTROEX_PROFILE_DIR,
	};
	process.env.ASTROEX_DATA_DIR = env.dataDir;
	process.env.ASTROEX_LOG_DIR = env.logDir;
	process.env.ASTROEX_MATERIALS_DIR = env.materialsDir;
	process.env.ASTROEX_PROFILE_DIR = env.profileDir;

	const originalCall = llmService.call;
	const capturedRequests = [];
	llmService.call = createMockLlmCall(capturedRequests);

	t.after(async () => {
		llmService.call = originalCall;
		for (const [k, v] of Object.entries(priorEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		await fs.rm(env.root, { recursive: true, force: true });
	});

	// 1. jobCloth without reasoning_effort
	const clothedFile = path.join(env.dataDir, "clothed_jobs.json");
	await runJobCloth(env.sampleJobsFile, clothedFile, {
		apiKey: "mock-key",
		baseUrl: "https://api.example.com",
		modelId: "mock-model",
		batch: 10,
	});

	assert.equal(capturedRequests.length, 1);
	assert.equal(
		"reasoning_effort" in capturedRequests[0],
		false,
		"jobCloth request must omit reasoning_effort property",
	);
	assert.equal(capturedRequests[0].reasoning_effort, undefined);

	// 2. jobJudge without reasoning_effort
	const judgeOutputFile = path.join(env.dataDir, "astroapply_eval_");
	await runJobJudge({
		preset: "jep_glm-5.3-flash",
		"api-key": "mock-key",
		"base-url": "https://api.example.com",
		"model-id": "mock-model",
		"input-file": clothedFile,
		"output-file": judgeOutputFile,
		"use-jobdb": false,
		"strict-parsing": false,
		sleep: 0,
		"eval-mode": 1,
		logDir: env.logDir,
	});

	assert.equal(capturedRequests.length, 2);
	assert.equal(
		"reasoning_effort" in capturedRequests[1],
		false,
		"jobJudge request must omit reasoning_effort property",
	);
	assert.equal(capturedRequests[1].reasoning_effort, undefined);

	// 3. makeMaterials without reasoning_effort
	const presets = await loadPresets();
	const matPreset = getPreset("makeMaterials", "rop_g5.6-luna_or", presets);
	assert.ok(matPreset);

	await runResumeOptimizationMode(matPreset, {
		preset: "rop_g5.6-luna_or",
		apiKey: "mock-key",
		targJD: "Job Description for Senior Security Analyst",
		sleep: 0,
		logDir: env.logDir,
	});

	assert.equal(capturedRequests.length, 3);
	assert.equal(
		"reasoning_effort" in capturedRequests[2],
		false,
		"makeMaterials request must omit reasoning_effort property",
	);
	assert.equal(capturedRequests[2].reasoning_effort, undefined);
});

test("Phase isolation: --jc-reasoning-effort sets reasoning_effort only on jobCloth", async (t) => {
	const env = await setupTestEnvironment();
	const priorEnv = {
		ASTROEX_DATA_DIR: process.env.ASTROEX_DATA_DIR,
		ASTROEX_LOG_DIR: process.env.ASTROEX_LOG_DIR,
		ASTROEX_MATERIALS_DIR: process.env.ASTROEX_MATERIALS_DIR,
		ASTROEX_PROFILE_DIR: process.env.ASTROEX_PROFILE_DIR,
	};
	process.env.ASTROEX_DATA_DIR = env.dataDir;
	process.env.ASTROEX_LOG_DIR = env.logDir;
	process.env.ASTROEX_MATERIALS_DIR = env.materialsDir;
	process.env.ASTROEX_PROFILE_DIR = env.profileDir;

	const originalCall = llmService.call;
	const capturedRequests = [];
	llmService.call = createMockLlmCall(capturedRequests);

	t.after(async () => {
		llmService.call = originalCall;
		for (const [k, v] of Object.entries(priorEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		await fs.rm(env.root, { recursive: true, force: true });
	});

	// jobCloth with --jc-reasoning-effort "high"
	const clothedFile = path.join(env.dataDir, "clothed_jobs.json");
	await runJobCloth(env.sampleJobsFile, clothedFile, {
		apiKey: "mock-key",
		baseUrl: "https://api.example.com",
		modelId: "mock-model",
		batch: 10,
		"jc-reasoning-effort": "high",
	});

	assert.equal(capturedRequests.length, 1);
	assert.equal(capturedRequests[0].reasoning_effort, "high");

	// jobJudge without flag
	const judgeOutputFile = path.join(env.dataDir, "astroapply_eval_");
	await runJobJudge({
		preset: "jep_glm-5.3-flash",
		"api-key": "mock-key",
		"base-url": "https://api.example.com",
		"model-id": "mock-model",
		"input-file": clothedFile,
		"output-file": judgeOutputFile,
		"use-jobdb": false,
		"strict-parsing": false,
		sleep: 0,
		"eval-mode": 1,
		logDir: env.logDir,
	});

	assert.equal(capturedRequests.length, 2);
	assert.equal(
		"reasoning_effort" in capturedRequests[1],
		false,
		"jobJudge request must omit reasoning_effort",
	);

	// makeMaterials without flag
	const presets = await loadPresets();
	const matPreset = getPreset("makeMaterials", "rop_g5.6-luna_or", presets);
	await runResumeOptimizationMode(matPreset, {
		preset: "rop_g5.6-luna_or",
		apiKey: "mock-key",
		targJD: "Job Description for Senior Security Analyst",
		sleep: 0,
		logDir: env.logDir,
	});

	assert.equal(capturedRequests.length, 3);
	assert.equal(
		"reasoning_effort" in capturedRequests[2],
		false,
		"makeMaterials request must omit reasoning_effort",
	);
});

test("Phase isolation: --jj-reasoning-effort sets reasoning_effort only on jobJudge", async (t) => {
	const env = await setupTestEnvironment();
	const priorEnv = {
		ASTROEX_DATA_DIR: process.env.ASTROEX_DATA_DIR,
		ASTROEX_LOG_DIR: process.env.ASTROEX_LOG_DIR,
		ASTROEX_MATERIALS_DIR: process.env.ASTROEX_MATERIALS_DIR,
		ASTROEX_PROFILE_DIR: process.env.ASTROEX_PROFILE_DIR,
	};
	process.env.ASTROEX_DATA_DIR = env.dataDir;
	process.env.ASTROEX_LOG_DIR = env.logDir;
	process.env.ASTROEX_MATERIALS_DIR = env.materialsDir;
	process.env.ASTROEX_PROFILE_DIR = env.profileDir;

	const originalCall = llmService.call;
	const capturedRequests = [];
	llmService.call = createMockLlmCall(capturedRequests);

	t.after(async () => {
		llmService.call = originalCall;
		for (const [k, v] of Object.entries(priorEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		await fs.rm(env.root, { recursive: true, force: true });
	});

	// jobCloth without flag
	const clothedFile = path.join(env.dataDir, "clothed_jobs.json");
	await runJobCloth(env.sampleJobsFile, clothedFile, {
		apiKey: "mock-key",
		baseUrl: "https://api.example.com",
		modelId: "mock-model",
		batch: 10,
	});

	assert.equal(capturedRequests.length, 1);
	assert.equal(
		"reasoning_effort" in capturedRequests[0],
		false,
		"jobCloth request must omit reasoning_effort",
	);

	// jobJudge with --jj-reasoning-effort "max"
	const judgeOutputFile = path.join(env.dataDir, "astroapply_eval_");
	await runJobJudge({
		preset: "jep_glm-5.3-flash",
		"api-key": "mock-key",
		"base-url": "https://api.example.com",
		"model-id": "mock-model",
		"input-file": clothedFile,
		"output-file": judgeOutputFile,
		"use-jobdb": false,
		"strict-parsing": false,
		"jj-reasoning-effort": "max",
		sleep: 0,
		"eval-mode": 1,
		logDir: env.logDir,
	});

	assert.equal(capturedRequests.length, 2);
	assert.equal(capturedRequests[1].reasoning_effort, "max");

	// makeMaterials without flag
	const presets = await loadPresets();
	const matPreset = getPreset("makeMaterials", "rop_g5.6-luna_or", presets);
	await runResumeOptimizationMode(matPreset, {
		preset: "rop_g5.6-luna_or",
		apiKey: "mock-key",
		targJD: "Job Description for Senior Security Analyst",
		sleep: 0,
		logDir: env.logDir,
	});

	assert.equal(capturedRequests.length, 3);
	assert.equal(
		"reasoning_effort" in capturedRequests[2],
		false,
		"makeMaterials request must omit reasoning_effort",
	);
});

test("Phase isolation: --mm-reasoning-effort sets reasoning_effort only on makeMaterials", async (t) => {
	const env = await setupTestEnvironment();
	const priorEnv = {
		ASTROEX_DATA_DIR: process.env.ASTROEX_DATA_DIR,
		ASTROEX_LOG_DIR: process.env.ASTROEX_LOG_DIR,
		ASTROEX_MATERIALS_DIR: process.env.ASTROEX_MATERIALS_DIR,
		ASTROEX_PROFILE_DIR: process.env.ASTROEX_PROFILE_DIR,
	};
	process.env.ASTROEX_DATA_DIR = env.dataDir;
	process.env.ASTROEX_LOG_DIR = env.logDir;
	process.env.ASTROEX_MATERIALS_DIR = env.materialsDir;
	process.env.ASTROEX_PROFILE_DIR = env.profileDir;

	const originalCall = llmService.call;
	const capturedRequests = [];
	llmService.call = createMockLlmCall(capturedRequests);

	t.after(async () => {
		llmService.call = originalCall;
		for (const [k, v] of Object.entries(priorEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		await fs.rm(env.root, { recursive: true, force: true });
	});

	// jobCloth without flag
	const clothedFile = path.join(env.dataDir, "clothed_jobs.json");
	await runJobCloth(env.sampleJobsFile, clothedFile, {
		apiKey: "mock-key",
		baseUrl: "https://api.example.com",
		modelId: "mock-model",
		batch: 10,
	});

	assert.equal(capturedRequests.length, 1);
	assert.equal(
		"reasoning_effort" in capturedRequests[0],
		false,
		"jobCloth request must omit reasoning_effort",
	);

	// jobJudge without flag
	const judgeOutputFile = path.join(env.dataDir, "astroapply_eval_");
	await runJobJudge({
		preset: "jep_glm-5.3-flash",
		"api-key": "mock-key",
		"base-url": "https://api.example.com",
		"model-id": "mock-model",
		"input-file": clothedFile,
		"output-file": judgeOutputFile,
		"use-jobdb": false,
		"strict-parsing": false,
		sleep: 0,
		"eval-mode": 1,
		logDir: env.logDir,
	});

	assert.equal(capturedRequests.length, 2);
	assert.equal(
		"reasoning_effort" in capturedRequests[1],
		false,
		"jobJudge request must omit reasoning_effort",
	);

	// makeMaterials with --mm-reasoning-effort "o3-ultra"
	const presets = await loadPresets();
	const matPreset = getPreset("makeMaterials", "rop_g5.6-luna_or", presets);
	await runResumeOptimizationMode(matPreset, {
		preset: "rop_g5.6-luna_or",
		apiKey: "mock-key",
		targJD: "Job Description for Senior Security Analyst",
		"mm-reasoning-effort": "o3-ultra",
		sleep: 0,
		logDir: env.logDir,
	});

	assert.equal(capturedRequests.length, 3);
	assert.equal(capturedRequests[2].reasoning_effort, "o3-ultra");
});

test("Simultaneous configuration: multiple flags apply independently to respective phases", async (t) => {
	const env = await setupTestEnvironment();
	const priorEnv = {
		ASTROEX_DATA_DIR: process.env.ASTROEX_DATA_DIR,
		ASTROEX_LOG_DIR: process.env.ASTROEX_LOG_DIR,
		ASTROEX_MATERIALS_DIR: process.env.ASTROEX_MATERIALS_DIR,
		ASTROEX_PROFILE_DIR: process.env.ASTROEX_PROFILE_DIR,
	};
	process.env.ASTROEX_DATA_DIR = env.dataDir;
	process.env.ASTROEX_LOG_DIR = env.logDir;
	process.env.ASTROEX_MATERIALS_DIR = env.materialsDir;
	process.env.ASTROEX_PROFILE_DIR = env.profileDir;

	const originalCall = llmService.call;
	const capturedRequests = [];
	llmService.call = createMockLlmCall(capturedRequests);

	t.after(async () => {
		llmService.call = originalCall;
		for (const [k, v] of Object.entries(priorEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		await fs.rm(env.root, { recursive: true, force: true });
	});

	// jobCloth with "low"
	const clothedFile = path.join(env.dataDir, "clothed_jobs.json");
	await runJobCloth(env.sampleJobsFile, clothedFile, {
		apiKey: "mock-key",
		baseUrl: "https://api.example.com",
		modelId: "mock-model",
		batch: 10,
		"jc-reasoning-effort": "low",
	});

	// jobJudge with "medium"
	const judgeOutputFile = path.join(env.dataDir, "astroapply_eval_");
	await runJobJudge({
		preset: "jep_glm-5.3-flash",
		"api-key": "mock-key",
		"base-url": "https://api.example.com",
		"model-id": "mock-model",
		"input-file": clothedFile,
		"output-file": judgeOutputFile,
		"use-jobdb": false,
		"strict-parsing": false,
		"jj-reasoning-effort": "medium",
		sleep: 0,
		"eval-mode": 1,
		logDir: env.logDir,
	});

	// makeMaterials with "max"
	const presets = await loadPresets();
	const matPreset = getPreset("makeMaterials", "rop_g5.6-luna_or", presets);
	await runResumeOptimizationMode(matPreset, {
		preset: "rop_g5.6-luna_or",
		apiKey: "mock-key",
		targJD: "Job Description for Senior Security Analyst",
		"mm-reasoning-effort": "max",
		sleep: 0,
		logDir: env.logDir,
	});

	assert.equal(capturedRequests.length, 3);
	assert.equal(capturedRequests[0].reasoning_effort, "low");
	assert.equal(capturedRequests[1].reasoning_effort, "medium");
	assert.equal(capturedRequests[2].reasoning_effort, "max");
});

test("Payload file dumps reflect reasoning_effort when present and omit when absent", async (t) => {
	const env = await setupTestEnvironment();
	const priorEnv = {
		ASTROEX_DATA_DIR: process.env.ASTROEX_DATA_DIR,
		ASTROEX_LOG_DIR: process.env.ASTROEX_LOG_DIR,
		ASTROEX_MATERIALS_DIR: process.env.ASTROEX_MATERIALS_DIR,
		ASTROEX_PROFILE_DIR: process.env.ASTROEX_PROFILE_DIR,
	};
	process.env.ASTROEX_DATA_DIR = env.dataDir;
	process.env.ASTROEX_LOG_DIR = env.logDir;
	process.env.ASTROEX_MATERIALS_DIR = env.materialsDir;
	process.env.ASTROEX_PROFILE_DIR = env.profileDir;

	const originalCall = llmService.call;
	const capturedRequests = [];
	llmService.call = createMockLlmCall(capturedRequests);

	t.after(async () => {
		llmService.call = originalCall;
		for (const [k, v] of Object.entries(priorEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		await fs.rm(env.root, { recursive: true, force: true });
	});

	// Case A: With reasoning effort configured and logPayload: true
	const clothedFileWithReasoning = path.join(
		env.dataDir,
		"clothed_with_reasoning.json",
	);
	await runJobCloth(env.sampleJobsFile, clothedFileWithReasoning, {
		apiKey: "mock-key",
		baseUrl: "https://api.example.com",
		modelId: "mock-model",
		batch: 10,
		logPayload: true,
		logDir: env.logDir,
		"jc-reasoning-effort": "high",
	});

	// Find cloth payload dump file
	const logFilesA = await fs.readdir(env.logDir);
	const clothDumpA = logFilesA.find(
		(f) => f.includes("payload") && f.endsWith(".json"),
	);
	assert.ok(clothDumpA, "jobCloth payload file should exist");
	const clothDumpContentA = JSON.parse(
		await fs.readFile(path.join(env.logDir, clothDumpA), "utf-8"),
	);
	assert.equal(clothDumpContentA.reasoning_effort, "high");

	// Clean up logs directory for next check
	await fs.rm(path.join(env.logDir, clothDumpA), { force: true });

	// Case B: Without reasoning effort and logPayload: true
	const clothedFileNoReasoning = path.join(
		env.dataDir,
		"clothed_no_reasoning.json",
	);
	await runJobCloth(env.sampleJobsFile, clothedFileNoReasoning, {
		apiKey: "mock-key",
		baseUrl: "https://api.example.com",
		modelId: "mock-model",
		batch: 10,
		logPayload: true,
		logDir: env.logDir,
	});

	const logFilesB = await fs.readdir(env.logDir);
	const clothDumpB = logFilesB.find(
		(f) => f.includes("payload") && f.endsWith(".json"),
	);
	assert.ok(clothDumpB, "jobCloth payload file should exist");
	const clothDumpContentB = JSON.parse(
		await fs.readFile(path.join(env.logDir, clothDumpB), "utf-8"),
	);
	assert.equal(
		"reasoning_effort" in clothDumpContentB,
		false,
		"jobCloth payload dump must not have reasoning_effort property when omitted",
	);
	assert.equal(clothDumpContentB.reasoning_effort, undefined);

	// Case C: makeMaterials payload dump with reasoning effort
	const presets = await loadPresets();
	const matPreset = getPreset("makeMaterials", "rop_g5.6-luna_or", presets);
	await runResumeOptimizationMode(matPreset, {
		preset: "rop_g5.6-luna_or",
		apiKey: "mock-key",
		targJD: "Job Description for Senior Security Analyst",
		"mm-reasoning-effort": "deep",
		logPayload: true,
		logDir: env.logDir,
		sleep: 0,
	});

	const logFilesC = await fs.readdir(env.logDir);
	const matDump = logFilesC.find(
		(f) =>
			f.startsWith("makematerials_") &&
			f.includes("payload") &&
			f.endsWith(".json"),
	);
	assert.ok(matDump, "makeMaterials payload file should exist");
	const matDumpContent = JSON.parse(
		await fs.readFile(path.join(env.logDir, matDump), "utf-8"),
	);
	assert.equal(matDumpContent.reasoning_effort, "deep");
});

test("Standalone commands support both phase prefix and generic --reasoning-effort alias", async (t) => {
	const env = await setupTestEnvironment();
	const priorEnv = {
		ASTROEX_DATA_DIR: process.env.ASTROEX_DATA_DIR,
		ASTROEX_LOG_DIR: process.env.ASTROEX_LOG_DIR,
		ASTROEX_MATERIALS_DIR: process.env.ASTROEX_MATERIALS_DIR,
		ASTROEX_PROFILE_DIR: process.env.ASTROEX_PROFILE_DIR,
	};
	process.env.ASTROEX_DATA_DIR = env.dataDir;
	process.env.ASTROEX_LOG_DIR = env.logDir;
	process.env.ASTROEX_MATERIALS_DIR = env.materialsDir;
	process.env.ASTROEX_PROFILE_DIR = env.profileDir;

	const originalCall = llmService.call;
	const capturedRequests = [];
	llmService.call = createMockLlmCall(capturedRequests);

	t.after(async () => {
		llmService.call = originalCall;
		for (const [k, v] of Object.entries(priorEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		await fs.rm(env.root, { recursive: true, force: true });
	});

	// jobCloth with generic alias
	const clothedFile = path.join(env.dataDir, "clothed_jobs.json");
	await runJobCloth(env.sampleJobsFile, clothedFile, {
		apiKey: "mock-key",
		baseUrl: "https://api.example.com",
		modelId: "mock-model",
		batch: 10,
		"reasoning-effort": "alias-effort-cloth",
	});
	assert.equal(capturedRequests[0].reasoning_effort, "alias-effort-cloth");

	// jobJudge with generic alias
	const judgeOutputFile = path.join(env.dataDir, "astroapply_eval_");
	await runJobJudge({
		preset: "jep_glm-5.3-flash",
		"api-key": "mock-key",
		"base-url": "https://api.example.com",
		"model-id": "mock-model",
		"input-file": clothedFile,
		"output-file": judgeOutputFile,
		"use-jobdb": false,
		"strict-parsing": false,
		"reasoning-effort": "alias-effort-judge",
		sleep: 0,
		"eval-mode": 1,
		logDir: env.logDir,
	});
	assert.equal(capturedRequests[1].reasoning_effort, "alias-effort-judge");

	// makeMaterials with generic alias
	const presets = await loadPresets();
	const matPreset = getPreset("makeMaterials", "rop_g5.6-luna_or", presets);
	await runResumeOptimizationMode(matPreset, {
		preset: "rop_g5.6-luna_or",
		apiKey: "mock-key",
		targJD: "Job Description for Senior Security Analyst",
		"reasoning-effort": "alias-effort-materials",
		sleep: 0,
		logDir: env.logDir,
	});
	assert.equal(capturedRequests[2].reasoning_effort, "alias-effort-materials");
});

test("Console output reflects effective reasoning_effort for each LLM phase and omits when unset", async (t) => {
	const env = await setupTestEnvironment();
	const priorEnv = {
		ASTROEX_DATA_DIR: process.env.ASTROEX_DATA_DIR,
		ASTROEX_LOG_DIR: process.env.ASTROEX_LOG_DIR,
		ASTROEX_MATERIALS_DIR: process.env.ASTROEX_MATERIALS_DIR,
		ASTROEX_PROFILE_DIR: process.env.ASTROEX_PROFILE_DIR,
	};
	process.env.ASTROEX_DATA_DIR = env.dataDir;
	process.env.ASTROEX_LOG_DIR = env.logDir;
	process.env.ASTROEX_MATERIALS_DIR = env.materialsDir;
	process.env.ASTROEX_PROFILE_DIR = env.profileDir;

	const originalCall = llmService.call;
	const capturedRequests = [];
	llmService.call = createMockLlmCall(capturedRequests);

	t.after(async () => {
		llmService.call = originalCall;
		for (const [k, v] of Object.entries(priorEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		await fs.rm(env.root, { recursive: true, force: true });
	});

	async function captureConsole(fn) {
		const originalWrite = process.stdout.write;
		let output = "";
		process.stdout.write = (chunk, encoding, callback) => {
			output += typeof chunk === "string" ? chunk : chunk.toString(encoding);
			if (typeof callback === "function") callback();
			return true;
		};
		try {
			await fn();
		} finally {
			process.stdout.write = originalWrite;
		}
		return output;
	}

	// 1. jobCloth with reasoning effort -> console output has reasoning_effort=high
	const clothFile1 = path.join(env.dataDir, "clothed_console_1.json");
	const clothLogWithEffort = await captureConsole(async () => {
		await runJobCloth(env.sampleJobsFile, clothFile1, {
			apiKey: "mock-key",
			baseUrl: "https://api.example.com",
			modelId: "mock-model",
			batch: 10,
			"jc-reasoning-effort": "high",
		});
	});
	assert.ok(
		clothLogWithEffort.includes("reasoning_effort=high"),
		`JobCloth console output must include reasoning_effort=high, got: ${clothLogWithEffort}`,
	);

	// 2. jobCloth without reasoning effort -> console output does NOT mention reasoning_effort
	const clothFile2 = path.join(env.dataDir, "clothed_console_2.json");
	const clothLogWithoutEffort = await captureConsole(async () => {
		await runJobCloth(env.sampleJobsFile, clothFile2, {
			apiKey: "mock-key",
			baseUrl: "https://api.example.com",
			modelId: "mock-model",
			batch: 10,
		});
	});
	assert.ok(
		!clothLogWithoutEffort.includes("reasoning_effort"),
		`JobCloth console output must NOT include reasoning_effort when unset, got: ${clothLogWithoutEffort}`,
	);

	// 3. jobCloth with whitespace-only effort -> treated as unset, omitted from console output
	const clothFile3 = path.join(env.dataDir, "clothed_console_3.json");
	const clothLogWhitespace = await captureConsole(async () => {
		await runJobCloth(env.sampleJobsFile, clothFile3, {
			apiKey: "mock-key",
			baseUrl: "https://api.example.com",
			modelId: "mock-model",
			batch: 10,
			"jc-reasoning-effort": "   ",
		});
	});
	assert.ok(
		!clothLogWhitespace.includes("reasoning_effort"),
		`JobCloth console output must NOT include reasoning_effort for whitespace-only input, got: ${clothLogWhitespace}`,
	);

	// 4. jobJudge with reasoning effort -> console output has reasoning_effort=max
	const judgeOutputFile1 = path.join(env.dataDir, "judge_console_1_");
	const judgeLogWithEffort = await captureConsole(async () => {
		await runJobJudge({
			preset: "jep_glm-5.3-flash",
			"api-key": "mock-key",
			"base-url": "https://api.example.com",
			"model-id": "mock-model",
			"input-file": clothFile1,
			"output-file": judgeOutputFile1,
			"use-jobdb": false,
			"strict-parsing": false,
			"jj-reasoning-effort": "max",
			sleep: 0,
			"eval-mode": 1,
			logDir: env.logDir,
		});
	});
	assert.ok(
		judgeLogWithEffort.includes("reasoning_effort=max"),
		`JobJudge console output must include reasoning_effort=max, got: ${judgeLogWithEffort}`,
	);

	// 5. jobJudge without reasoning effort -> console output does NOT mention reasoning_effort
	const judgeOutputFile2 = path.join(env.dataDir, "judge_console_2_");
	const judgeLogWithoutEffort = await captureConsole(async () => {
		await runJobJudge({
			preset: "jep_glm-5.3-flash",
			"api-key": "mock-key",
			"base-url": "https://api.example.com",
			"model-id": "mock-model",
			"input-file": clothFile1,
			"output-file": judgeOutputFile2,
			"use-jobdb": false,
			"strict-parsing": false,
			sleep: 0,
			"eval-mode": 1,
			logDir: env.logDir,
		});
	});
	assert.ok(
		!judgeLogWithoutEffort.includes("reasoning_effort"),
		`JobJudge console output must NOT include reasoning_effort when unset, got: ${judgeLogWithoutEffort}`,
	);

	// 6. makeMaterials with reasoning effort -> console output has reasoning_effort=deep
	const presets = await loadPresets();
	const matPreset = getPreset("makeMaterials", "rop_g5.6-luna_or", presets);
	const matLogWithEffort = await captureConsole(async () => {
		await runResumeOptimizationMode(matPreset, {
			preset: "rop_g5.6-luna_or",
			apiKey: "mock-key",
			targJD: "Job Description for Senior Security Analyst",
			"mm-reasoning-effort": "deep",
			sleep: 0,
			logDir: env.logDir,
		});
	});
	assert.ok(
		matLogWithEffort.includes("reasoning_effort=deep"),
		`MakeMaterials console output must include reasoning_effort=deep, got: ${matLogWithEffort}`,
	);

	// 7. makeMaterials without reasoning effort -> console output does NOT mention reasoning_effort
	const matLogWithoutEffort = await captureConsole(async () => {
		await runResumeOptimizationMode(matPreset, {
			preset: "rop_g5.6-luna_or",
			apiKey: "mock-key",
			targJD: "Job Description for Senior Security Analyst",
			sleep: 0,
			logDir: env.logDir,
		});
	});
	assert.ok(
		!matLogWithoutEffort.includes("reasoning_effort"),
		`MakeMaterials console output must NOT include reasoning_effort when unset, got: ${matLogWithoutEffort}`,
	);
});
