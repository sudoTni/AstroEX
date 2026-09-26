const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const {
	PIPELINE_PHASES,
	buildPipelineConfig,
	executePipeline,
	shouldExecutePhase,
	validateResumePhase,
} = require("../dist/commands/runPipeline");
const { llmService } = require("../dist/llmService");
const { defaultLoggingManager } = require("../dist/logging");
const { JobRepository } = require("../dist/jobRepository");

function makeJob(id, title, company, overrides = {}) {
	const url = `https://www.indeed.com/viewjob?jk=${id}`;
	return {
		id: `indeed:${id}`,
		source: "indeed",
		sourceJobId: id,
		canonicalUrl: url,
		url,
		title,
		company,
		location: "New York, NY, USA",
		description: `Full job description for ${title} at ${company}. Requires cloud security experience.`,
		descriptionText: `Full job description for ${title} at ${company}. Requires cloud security experience.`,
		descriptionRepresentation: "markdown",
		acquiredAt: new Date().toISOString(),
		...overrides,
	};
}

async function setupTestEnvironment(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "astroex-resume-test-"));
	const dataDir = path.join(root, "data");
	const logDir = path.join(root, "logs");
	const materialsDir = path.join(root, "materials");
	const deployedMaterialsDir = path.join(root, "materials-deployed");
	const profileDir = path.join(root, "profile");
	const destDir = path.join(root, "dest");

	await Promise.all([
		fs.mkdir(dataDir, { recursive: true }),
		fs.mkdir(logDir, { recursive: true }),
		fs.mkdir(materialsDir, { recursive: true }),
		fs.mkdir(deployedMaterialsDir, { recursive: true }),
		fs.mkdir(profileDir, { recursive: true }),
		fs.mkdir(destDir, { recursive: true }),
	]);

	const originalEnv = {
		ASTROEX_DATA_DIR: process.env.ASTROEX_DATA_DIR,
		ASTROEX_LOG_DIR: process.env.ASTROEX_LOG_DIR,
		ASTROEX_MATERIALS_DIR: process.env.ASTROEX_MATERIALS_DIR,
		ASTROEX_PROFILE_DIR: process.env.ASTROEX_PROFILE_DIR,
		AEX_DEPLOY: process.env.AEX_DEPLOY,
		AEX_DEPLOY_DESTINATION: process.env.AEX_DEPLOY_DESTINATION,
	};

	if (t) {
		t.after(async () => {
			for (const [key, val] of Object.entries(originalEnv)) {
				if (val === undefined) delete process.env[key];
				else process.env[key] = val;
			}
			await fs.rm(root, { recursive: true, force: true });
		});
	}

	process.env.ASTROEX_DATA_DIR = dataDir;
	process.env.ASTROEX_LOG_DIR = logDir;
	process.env.ASTROEX_MATERIALS_DIR = materialsDir;
	process.env.ASTROEX_PROFILE_DIR = profileDir;
	process.env.AEX_DEPLOY = "0";

	// Profile files
	await fs.writeFile(
		path.join(profileDir, "search_terms.txt"),
		"Security Engineer\n",
		"utf8",
	);
	await fs.writeFile(
		path.join(profileDir, "my_resume.txt"),
		"Experienced Cloud Security Architect.\n",
		"utf8",
	);
	await fs.writeFile(
		path.join(profileDir, "company_filters.txt"),
		"BlocklistCorp\n",
		"utf8",
	);
	await fs.writeFile(
		path.join(profileDir, "title_filters.txt"),
		"Intern\n",
		"utf8",
	);
	await fs.writeFile(
		path.join(profileDir, "my_professional_title.txt"),
		"Cloud Security Architect\n",
		"utf8",
	);
	await fs.writeFile(
		path.join(profileDir, "my_professional_summary.txt"),
		"Expert in cloud security and containers.\n",
		"utf8",
	);
	await fs.writeFile(
		path.join(profileDir, "my_key_skills.txt"),
		"Cloud Security, Kubernetes, AWS\n",
		"utf8",
	);
	await fs.writeFile(
		path.join(profileDir, "my_testimonials.txt"),
		"Top security professional.\n",
		"utf8",
	);

	return {
		root,
		dataDir,
		logDir,
		materialsDir,
		deployedMaterialsDir,
		profileDir,
		destDir,
	};
}

function mockLlmCalls(t) {
	const originalLlmCall = llmService.call;
	t.after(() => {
		llmService.call = originalLlmCall;
	});

	llmService.call = async (req) => {
		const contentStr = JSON.stringify(req.messages);

		if (
			contentStr.includes("classification engine") ||
			contentStr.includes("JOB-TITLE-LEVEL") ||
			contentStr.includes("job-title")
		) {
			return {
				content: [
					{
						jobTitle: "Cloud Security Engineer",
						isVeryHighlyAligned: true,
						rationale: "Strong alignment with security profile.",
						confidence: 0.95,
					},
				],
				usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
			};
		}

		if (
			contentStr.includes("ROP") ||
			contentStr.includes("Resume Optimization") ||
			contentStr.includes("cover_length")
		) {
			return {
				content: `# Resume Filename
Alex_Morgan_Materials_Cloud_Security_Engineer

# Cover Letter Filename
Alex_Morgan_Cover_Letter_Acme_Security.txt

# Optimized & Tailored Professional Title
Lead Cloud Security Engineer

# Optimized & Tailored Professional Summary
High-impact Security Engineer.

# Optimized & Tailored Key Skills
- Cloud Security Architecture

# Optimized & Tailored Cover Letter
Dear Hiring Team at Acme Security,\n\nI am thrilled to apply...`,
				usage: { promptTokens: 150, completionTokens: 100, totalTokens: 250 },
			};
		}

		return {
			content: [
				{
					jobTitle: "Cloud Security Engineer",
					isVeryHighlyAligned: true,
					rationale: "Candidate has deep cloud security experience.",
					confidence: 0.96,
				},
			],
			usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
		};
	};
}

async function captureLogRecords(operation) {
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

// 1. Phase definitions and validation helpers
test("PIPELINE_PHASES exports exactly the 8 phases in execution order", () => {
	assert.deepEqual(PIPELINE_PHASES, [
		"acquireJobs",
		"processData",
		"jobCloth",
		"enrichJobs",
		"remoteEval",
		"jobJudge",
		"makeMaterials",
		"deployment",
	]);
});

test("validateResumePhase accepts all valid phases and throws on invalid inputs", () => {
	for (const phase of PIPELINE_PHASES) {
		assert.equal(validateResumePhase(phase), phase);
	}

	const expectedError =
		'Invalid --resume phase "invalidPhase".\nValid phases: acquireJobs, processData, jobCloth, enrichJobs, remoteEval, jobJudge, makeMaterials, deployment';

	assert.throws(
		() => validateResumePhase("invalidPhase"),
		(err) => err instanceof Error && err.message === expectedError,
	);
	assert.throws(
		() => validateResumePhase("jobcloth"), // case sensitivity check
		(err) =>
			err instanceof Error &&
			err.message.includes('Invalid --resume phase "jobcloth".'),
	);
	assert.throws(
		() => validateResumePhase(""),
		(err) =>
			err instanceof Error &&
			err.message.includes('Invalid --resume phase "".'),
	);
	assert.throws(
		() => validateResumePhase(undefined),
		(err) =>
			err instanceof Error &&
			err.message.includes('Invalid --resume phase "undefined".'),
	);
});

test("shouldExecutePhase calculates phase inclusion correctly", () => {
	// Unset resume -> all phases execute
	for (const phase of PIPELINE_PHASES) {
		assert.equal(shouldExecutePhase(phase, undefined), true);
	}

	// Resume from acquireJobs -> all phases execute
	for (const phase of PIPELINE_PHASES) {
		assert.equal(shouldExecutePhase(phase, "acquireJobs"), true);
	}

	// Resume from jobCloth -> acquireJobs and processData skipped; jobCloth through deployment execute
	assert.equal(shouldExecutePhase("acquireJobs", "jobCloth"), false);
	assert.equal(shouldExecutePhase("processData", "jobCloth"), false);
	assert.equal(shouldExecutePhase("jobCloth", "jobCloth"), true);
	assert.equal(shouldExecutePhase("enrichJobs", "jobCloth"), true);
	assert.equal(shouldExecutePhase("jobJudge", "jobCloth"), true);
	assert.equal(shouldExecutePhase("makeMaterials", "jobCloth"), true);
	assert.equal(shouldExecutePhase("deployment", "jobCloth"), true);

	// Resume from jobJudge -> phases 1-4 skipped; jobJudge through deployment execute
	assert.equal(shouldExecutePhase("acquireJobs", "jobJudge"), false);
	assert.equal(shouldExecutePhase("processData", "jobJudge"), false);
	assert.equal(shouldExecutePhase("jobCloth", "jobJudge"), false);
	assert.equal(shouldExecutePhase("enrichJobs", "jobJudge"), false);
	assert.equal(shouldExecutePhase("jobJudge", "jobJudge"), true);
	assert.equal(shouldExecutePhase("makeMaterials", "jobJudge"), true);
	assert.equal(shouldExecutePhase("deployment", "jobJudge"), true);

	// Resume from deployment -> phases 1-6 skipped; deployment executes
	for (let i = 0; i < 6; i++) {
		assert.equal(shouldExecutePhase(PIPELINE_PHASES[i], "deployment"), false);
	}
	assert.equal(shouldExecutePhase("deployment", "deployment"), true);
});

test("buildPipelineConfig preserves resume option and schema enforces valid enum", () => {
	const configDefault = buildPipelineConfig({
		deployment: { enabled: false },
	});
	assert.equal(configDefault.options.resume, undefined);

	const configResume = buildPipelineConfig({
		options: { resume: "jobJudge" },
		deployment: { enabled: false },
	});
	assert.equal(configResume.options.resume, "jobJudge");

	assert.throws(() => {
		buildPipelineConfig({
			options: { resume: "notAPhase" },
		});
	});
});

test("CLI: invalid --resume phase fails with exact error message and non-zero exit", async () => {
	let failed = false;
	try {
		await execFileAsync(
			process.execPath,
			[
				path.join(__dirname, "../dist/index.js"),
				"run-pipeline",
				"--resume",
				"unknownPhase",
			],
			{
				env: {
					...process.env,
					NO_COLOR: "1",
					ASTROEX_NO_COLOR: "1",
				},
			},
		);
	} catch (error) {
		failed = true;
		assert.equal(error.code, 1);
		const combinedOutput = `${error.stdout || ""} ${error.stderr || ""}`;
		assert.ok(
			combinedOutput.includes('Invalid --resume phase "unknownPhase".'),
			`Expected invalid phase message, got:\n${combinedOutput}`,
		);
		assert.ok(
			combinedOutput.includes(
				"Valid phases: acquireJobs, processData, jobCloth, enrichJobs, remoteEval, jobJudge, makeMaterials, deployment",
			),
			`Expected valid phases list, got:\n${combinedOutput}`,
		);
	}
	assert.ok(failed, "CLI should exit non-zero for invalid resume phase");
});

test("pipeline cost tracking emits a zero-safe final summary and remains silent when disabled", async (t) => {
	const env = await setupTestEnvironment(t);
	const baseOverrides = {
		paths: {
			dataDir: env.dataDir,
			materialsDir: env.materialsDir,
			deployedMaterialsDir: env.deployedMaterialsDir,
			profileDir: env.profileDir,
		},
		deployment: { enabled: false },
		options: { resume: "deployment" },
	};

	const disabledRecords = await captureLogRecords(() =>
		executePipeline(buildPipelineConfig(baseOverrides), {
			resume: "deployment",
		}),
	);
	assert.equal(
		disabledRecords.filter(
			(record) => record.context?.event === "openrouter.usage.pipeline_summary",
		).length,
		0,
	);

	let trackedResult;
	const enabledRecords = await captureLogRecords(async () => {
		trackedResult = await executePipeline(
			buildPipelineConfig({
				...baseOverrides,
				options: {
					resume: "deployment",
					trackOpenRouterCosts: true,
				},
			}),
			{ resume: "deployment" },
		);
	});
	assert.equal(trackedResult.success, true);
	const summaries = enabledRecords.filter(
		(record) => record.context?.event === "openrouter.usage.pipeline_summary",
	);
	assert.equal(summaries.length, 1);
	assert.deepEqual(summaries[0].context, {
		event: "openrouter.usage.pipeline_summary",
		status: "success",
		accountedCalls: 0,
		unavailableUsageCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		totalCostUsd: 0,
	});
	assert.doesNotMatch(summaries[0].message, /average=/);
	assert.equal(
		Object.hasOwn(summaries[0].context, "averageCostPerTokenUsd"),
		false,
	);
});

test("pipeline failure after a billed call still emits the incurred-usage summary", async (t) => {
	if (process.platform === "win32") {
		t.skip("test uses a temporary POSIX rclone shim");
		return;
	}

	const env = await setupTestEnvironment(t);
	const clothedFile = path.join(env.dataDir, "clothed_jobs_indeed.json");
	await fs.writeFile(
		clothedFile,
		JSON.stringify([
			makeJob("cost-failure", "Cloud Security Engineer", "Acme Security"),
		]),
		"utf8",
	);
	await fs.writeFile(
		path.join(env.materialsDir, "material.txt"),
		"material",
		"utf8",
	);

	const binDir = path.join(env.root, "bin");
	await fs.mkdir(binDir);
	const rclonePath = path.join(binDir, "rclone");
	await fs.writeFile(
		rclonePath,
		'#!/bin/sh\nif [ "$1" = "version" ]; then exit 0; fi\nexit 17\n',
		"utf8",
	);
	await fs.chmod(rclonePath, 0o755);
	const originalPath = process.env.PATH;
	process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

	const originalCallOpenAI = llmService.callOpenAI;
	llmService.callOpenAI = async (_provider, request) => ({
		content: [
			{
				jobTitle: "Cloud Security Engineer",
				isVeryHighlyAligned: true,
				isWorthInvestigating: true,
				rationale: "Strong alignment.",
				confidence: 0.95,
			},
		],
		provider: "openrouter",
		model: request.model,
		usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
		billingUsage: {
			requestId: "gen-before-pipeline-failure",
			timestamp: new Date().toISOString(),
			model: request.model,
			stage: "jobJudge",
			inputTokens: 100,
			outputTokens: 30,
			totalTokens: 130,
			costUsd: 0.0075,
		},
		duration: 0,
		timestamp: new Date().toISOString(),
		requestId: "gen-before-pipeline-failure",
	});
	t.after(() => {
		llmService.callOpenAI = originalCallOpenAI;
		if (originalPath === undefined) Reflect.deleteProperty(process.env, "PATH");
		else process.env.PATH = originalPath;
	});

	const config = buildPipelineConfig({
		paths: {
			dataDir: env.dataDir,
			materialsDir: env.materialsDir,
			deployedMaterialsDir: env.deployedMaterialsDir,
			profileDir: env.profileDir,
			clothedJobsFile: clothedFile,
		},
		providers: { apiKey: "mock-key" },
		deployment: {
			enabled: true,
			destination: "TestRemote:/destination",
		},
		options: {
			clean: false,
			resume: "jobJudge",
			sleep: 0,
			trackOpenRouterCosts: true,
		},
	});

	let pipelineError;
	const records = await captureLogRecords(async () => {
		try {
			await executePipeline(config, {
				resume: "jobJudge",
				skipMaterials: true,
			});
		} catch (error) {
			pipelineError = error;
		}
	});
	assert.ok(pipelineError);
	const summaries = records.filter(
		(record) => record.context?.event === "openrouter.usage.pipeline_summary",
	);
	assert.equal(summaries.length, 1);
	assert.equal(summaries[0].context.status, "failed");
	assert.equal(
		summaries[0].context.accountedCalls,
		1,
		`pipeline error: ${pipelineError instanceof Error ? pipelineError.message : String(pipelineError)}`,
	);
	assert.equal(summaries[0].context.totalTokens, 130);
	assert.equal(summaries[0].context.totalCostUsd, 0.0075);
});

test("executePipeline without resume: all stages eligible to run in order", async (t) => {
	const env = await setupTestEnvironment(t);
	mockLlmCalls(t);

	const fixtureJobs = [
		makeJob("job-001", "Cloud Security Engineer", "Acme Security"),
	];
	await fs.writeFile(
		path.join(env.dataDir, "acquired_jobs_indeed.json"),
		JSON.stringify(fixtureJobs, null, 2),
		"utf8",
	);

	const config = buildPipelineConfig({
		paths: {
			dataDir: env.dataDir,
			materialsDir: env.materialsDir,
			deployedMaterialsDir: env.deployedMaterialsDir,
			profileDir: env.profileDir,
			acquiredJobsIndeedFile: path.join(
				env.dataDir,
				"acquired_jobs_indeed.json",
			),
			acquiredJobsFile: path.join(env.dataDir, "acquired_jobs_indeed.json"),
		},
		search: {
			sites: ["indeed"],
			searchTermsFile: "search_terms.txt",
		},
		deployment: {
			enabled: false,
		},
		providers: {
			apiKey: "mock-key",
		},
		options: {
			clean: false,
			sleep: 0,
		},
	});

	// skipAcquisition simulates pre-seeded acquisition file
	const result = await executePipeline(config, {
		skipAcquisition: true,
	});

	assert.equal(result.success, true);
	assert.equal(result.stages.acquireJobs.skipped, true);
	assert.ok(result.stages.processData && !result.stages.processData.skipped);
	assert.ok(result.stages.jobCloth && !result.stages.jobCloth.skipped);
	assert.ok(result.stages.jobJudge && !result.stages.jobJudge.skipped);
	assert.ok(
		result.stages.makeMaterials && !result.stages.makeMaterials.skipped,
	);
	assert.equal(result.stages.deployment.skipped, true); // deployment disabled
});

test("executePipeline --resume jobCloth: skips acquireJobs and processData, executes jobCloth through end", async (t) => {
	const env = await setupTestEnvironment(t);
	mockLlmCalls(t);

	// Pre-create processed_jobs.json artifact required by jobCloth
	const processedJobs = [
		makeJob("job-002", "Cloud Security Engineer", "Acme Security"),
	];
	await fs.writeFile(
		path.join(env.dataDir, "processed_jobs.json"),
		JSON.stringify(processedJobs, null, 2),
		"utf8",
	);

	const config = buildPipelineConfig({
		paths: {
			dataDir: env.dataDir,
			materialsDir: env.materialsDir,
			deployedMaterialsDir: env.deployedMaterialsDir,
			profileDir: env.profileDir,
			processedJobsFile: path.join(env.dataDir, "processed_jobs.json"),
			clothedJobsFile: path.join(env.dataDir, "clothed_jobs_indeed.json"),
		},
		search: {
			sites: ["indeed"],
			searchTermsFile: "search_terms.txt",
		},
		deployment: {
			enabled: false,
		},
		providers: {
			apiKey: "mock-key",
		},
		options: {
			clean: false,
			sleep: 0,
			resume: "jobCloth",
		},
	});

	const result = await executePipeline(config, { resume: "jobCloth" });

	assert.equal(result.success, true);
	assert.deepEqual(result.stages.acquireJobs, { skipped: true });
	assert.deepEqual(result.stages.processData, { skipped: true });
	assert.ok(result.stages.jobCloth && !result.stages.jobCloth.skipped);
	assert.ok(result.stages.jobJudge && !result.stages.jobJudge.skipped);
	assert.ok(
		result.stages.makeMaterials && !result.stages.makeMaterials.skipped,
	);
	assert.equal(result.stages.deployment.skipped, true);
});

test("executePipeline --resume jobJudge: skips phases 1-4, executes jobJudge and downstream phases", async (t) => {
	const env = await setupTestEnvironment(t);
	mockLlmCalls(t);

	// Pre-create clothed_jobs_indeed.json artifact required by jobJudge
	const clothedJobs = [
		makeJob("job-003", "Cloud Security Engineer", "Acme Security"),
	];
	const clothedFile = path.join(env.dataDir, "clothed_jobs_indeed.json");
	await fs.writeFile(clothedFile, JSON.stringify(clothedJobs, null, 2), "utf8");

	const config = buildPipelineConfig({
		paths: {
			dataDir: env.dataDir,
			materialsDir: env.materialsDir,
			deployedMaterialsDir: env.deployedMaterialsDir,
			profileDir: env.profileDir,
			clothedJobsFile: clothedFile,
		},
		search: {
			sites: ["indeed"],
			searchTermsFile: "search_terms.txt",
		},
		deployment: {
			enabled: false,
		},
		providers: {
			apiKey: "mock-key",
		},
		options: {
			clean: false,
			sleep: 0,
			resume: "jobJudge",
		},
	});

	const result = await executePipeline(config, { resume: "jobJudge" });

	assert.equal(result.success, true);
	assert.deepEqual(result.stages.acquireJobs, { skipped: true });
	assert.deepEqual(result.stages.processData, { skipped: true });
	assert.deepEqual(result.stages.jobCloth, { skipped: true });
	assert.deepEqual(result.stages.enrichJobs, { skipped: true });
	assert.ok(result.stages.jobJudge && !result.stages.jobJudge.skipped);
	assert.ok(
		result.stages.makeMaterials && !result.stages.makeMaterials.skipped,
	);
	assert.equal(result.stages.deployment.skipped, true);
});

test("executePipeline --resume deployment: skips phases 1-6, runs deployment without requiring LLM apiKey", async (t) => {
	const env = await setupTestEnvironment(t);

	// Pre-create material file to deploy
	const sampleMaterial = path.join(
		env.materialsDir,
		"Alex_Morgan_Materials_Security.txt",
	);
	await fs.writeFile(sampleMaterial, "Sample resume content", "utf8");

	const config = buildPipelineConfig({
		paths: {
			dataDir: env.dataDir,
			materialsDir: env.materialsDir,
			deployedMaterialsDir: env.deployedMaterialsDir,
			profileDir: env.profileDir,
		},
		deployment: {
			enabled: true,
			destination: env.destDir,
		},
		providers: {
			// Deliberately empty apiKey to verify deployment doesn't fail preflight for LLM
			apiKey: undefined,
		},
		options: {
			clean: false,
			sleep: 0,
			resume: "deployment",
		},
	});

	const result = await executePipeline(config, { resume: "deployment" });

	assert.equal(result.success, true);
	assert.deepEqual(result.stages.acquireJobs, { skipped: true });
	assert.deepEqual(result.stages.processData, { skipped: true });
	assert.deepEqual(result.stages.jobCloth, { skipped: true });
	assert.deepEqual(result.stages.enrichJobs, { skipped: true });
	assert.deepEqual(result.stages.jobJudge, { skipped: true });
	assert.deepEqual(result.stages.makeMaterials, { skipped: true });
	assert.ok(result.stages.deployment && !result.stages.deployment.skipped);
	assert.equal(result.stages.deployment.deployed, 1);

	// Verify destination received deployed material
	const deployed = await fs.readdir(env.destDir);
	assert.deepEqual(deployed, ["Alex_Morgan_Materials_Security.txt"]);
});

test("executePipeline preserves downstream flags: --skip-materials and disabled deployment remain skipped", async (t) => {
	const env = await setupTestEnvironment(t);
	mockLlmCalls(t);

	const clothedJobs = [
		makeJob("job-004", "Cloud Security Engineer", "Acme Security"),
	];
	const clothedFile = path.join(env.dataDir, "clothed_jobs_indeed.json");
	await fs.writeFile(clothedFile, JSON.stringify(clothedJobs, null, 2), "utf8");

	const config = buildPipelineConfig({
		paths: {
			dataDir: env.dataDir,
			materialsDir: env.materialsDir,
			deployedMaterialsDir: env.deployedMaterialsDir,
			profileDir: env.profileDir,
			clothedJobsFile: clothedFile,
		},
		deployment: {
			enabled: false, // deployment disabled
		},
		providers: {
			apiKey: "mock-key",
		},
		options: {
			clean: false,
			sleep: 0,
			resume: "jobJudge",
		},
	});

	const result = await executePipeline(config, {
		resume: "jobJudge",
		skipMaterials: true, // downstream flag
	});

	assert.equal(result.success, true);
	assert.deepEqual(result.stages.acquireJobs, { skipped: true });
	assert.deepEqual(result.stages.processData, { skipped: true });
	assert.deepEqual(result.stages.jobCloth, { skipped: true });
	assert.deepEqual(result.stages.enrichJobs, { skipped: true });
	assert.ok(result.stages.jobJudge && !result.stages.jobJudge.skipped);
	assert.deepEqual(result.stages.makeMaterials, { skipped: true });
	assert.deepEqual(result.stages.deployment, { skipped: true });
});

test("executePipeline --resume fails naturally when required upstream artifact is missing", async (t) => {
	const env = await setupTestEnvironment(t);
	mockLlmCalls(t);

	// Resuming from jobCloth without creating processed_jobs.json
	const config = buildPipelineConfig({
		paths: {
			dataDir: env.dataDir,
			materialsDir: env.materialsDir,
			deployedMaterialsDir: env.deployedMaterialsDir,
			profileDir: env.profileDir,
			processedJobsFile: path.join(env.dataDir, "non_existent_processed.json"),
		},
		deployment: {
			enabled: false,
		},
		providers: {
			apiKey: "mock-key",
		},
		options: {
			clean: false,
			sleep: 0,
			resume: "jobCloth",
		},
	});

	await assert.rejects(
		async () => {
			await executePipeline(config, { resume: "jobCloth" });
		},
		(err) => {
			assert.ok(err instanceof Error);
			assert.ok(
				err.message.includes("ENOENT") ||
					err.message.includes("non_existent_processed.json"),
			);
			return true;
		},
	);
});

test("executePipeline propagates opt-in cool-off reporting to processData", async (t) => {
	const env = await setupTestEnvironment(t);
	mockLlmCalls(t);

	const suppressedJob = makeJob(
		"cool-off-suppressed",
		"Suppressed Security Engineer",
		"Suppressed Company",
	);
	const eligibleJob = makeJob(
		"cool-off-eligible",
		"Cloud Security Engineer",
		"Eligible Company",
	);
	await fs.writeFile(
		path.join(env.dataDir, "acquired_jobs_indeed.json"),
		JSON.stringify([suppressedJob, eligibleJob], null, 2),
		"utf8",
	);

	const repository = new JobRepository({
		dbFilePath: path.join(env.dataDir, "jobDB.sqlite"),
		legacyJsonPath: path.join(env.dataDir, "jobDB.json"),
		defaultExpirationMs: 30 * 24 * 60 * 60 * 1000,
		enableJobDB: true,
	});
	await repository.initialize();
	await repository.recordJobClothProcessed([suppressedJob]);
	await repository.close();

	const config = buildPipelineConfig({
		paths: {
			dataDir: env.dataDir,
			materialsDir: env.materialsDir,
			deployedMaterialsDir: env.deployedMaterialsDir,
			profileDir: env.profileDir,
		},
		search: {
			sites: ["indeed"],
			searchTermsFile: "search_terms.txt",
		},
		deployment: { enabled: false },
		providers: { apiKey: "mock-key" },
		options: {
			clean: false,
			sleep: 0,
			logCoolOffs: true,
		},
	});

	const result = await executePipeline(config, {
		skipAcquisition: true,
		skipMaterials: true,
	});

	assert.equal(result.success, true);
	assert.equal(result.stages.processData.jobDbCoolOffSkippedEntries, 1);
	assert.ok(result.stages.processData.coolOffLogFile);
	assert.equal(
		path.dirname(result.stages.processData.coolOffLogFile),
		env.logDir,
	);
	const report = JSON.parse(
		await fs.readFile(result.stages.processData.coolOffLogFile, "utf8"),
	);
	assert.equal(report.count, 1);
	assert.deepEqual(report.jobs, [
		{
			id: suppressedJob.id,
			company: suppressedJob.company,
			title: suppressedJob.title,
		},
	]);
});
