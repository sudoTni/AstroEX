const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { verifyArtifactManifest } = require("../dist/artifactManifest");
const { runJobCloth } = require("../dist/commands/jobCloth");
const { runJobJudge } = require("../dist/commands/jobJudge");
const { runResumeOptimizationMode } = require("../dist/commands/makeMaterials");
const { processAcquiredJobs } = require("../dist/commands/processData");
const { JobRepository } = require("../dist/jobRepository");
const { llmService } = require("../dist/llmService");
const { getPreset, loadPresets } = require("../dist/presets");

function makeJob(id, title, company, overrides = {}) {
	return {
		id: `indeed:${id}`,
		source: "indeed",
		sourceJobId: id,
		canonicalUrl: `https://www.indeed.com/viewjob?jk=${id}`,
		title,
		company,
		location: "New York, NY, USA",
		description: `Full job description for ${title} at ${company}. Requires security experience.`,
		descriptionText: `Full job description for ${title} at ${company}. Requires security experience.`,
		descriptionRepresentation: "markdown",
		acquiredAt: new Date().toISOString(),
		...overrides,
	};
}

test("offline pipeline integration: acquisition -> processing -> clothing -> judging -> materials with checkpoints & manifests", async (t) => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-pipeline-offline-"),
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

	const originalEnv = {
		ASTROEX_DATA_DIR: process.env.ASTROEX_DATA_DIR,
		ASTROEX_LOG_DIR: process.env.ASTROEX_LOG_DIR,
		ASTROEX_MATERIALS_DIR: process.env.ASTROEX_MATERIALS_DIR,
		ASTROEX_PROFILE_DIR: process.env.ASTROEX_PROFILE_DIR,
	};

	t.after(async () => {
		for (const [key, val] of Object.entries(originalEnv)) {
			if (val === undefined) delete process.env[key];
			else process.env[key] = val;
		}
		await fs.rm(root, { recursive: true, force: true });
	});

	process.env.ASTROEX_DATA_DIR = dataDir;
	process.env.ASTROEX_LOG_DIR = logDir;
	process.env.ASTROEX_MATERIALS_DIR = materialsDir;
	process.env.ASTROEX_PROFILE_DIR = profileDir;

	// Setup profile files
	await fs.writeFile(
		path.join(profileDir, "search_terms.txt"),
		"Security Engineer\nCloud Engineer\n",
		"utf8",
	);
	await fs.writeFile(
		path.join(profileDir, "my_resume.txt"),
		"the candidate - Experienced Cloud Security Engineer with DevSecOps expertise.\n",
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
		"Cloud Security Engineer\n",
		"utf8",
	);
	await fs.writeFile(
		path.join(profileDir, "my_professional_summary.txt"),
		"Expert in cloud security and zero trust architectures.\n",
		"utf8",
	);
	await fs.writeFile(
		path.join(profileDir, "my_key_skills.txt"),
		"Cloud Security, DevSecOps, Kubernetes, IAM\n",
		"utf8",
	);
	await fs.writeFile(
		path.join(profileDir, "my_testimonials.txt"),
		"the candidate is a top-tier security professional.\n",
		"utf8",
	);

	// Deterministic fixture jobs
	const fixtureJobs = [
		makeJob("job-pass-1", "Cloud Security Engineer", "Acme Security"),
		makeJob("job-fail-1", "Sales Associate", "Retail Co"),
		makeJob("job-filter-company", "Security Engineer", "BlocklistCorp"),
		makeJob("job-filter-title", "Security Intern", "Good Corp"),
		makeJob("job-pass-1", "Cloud Security Engineer", "Acme Security"), // exact dupe
	];

	const acquiredJobsFile = path.join(dataDir, "acquired_jobs_indeed.json");
	await fs.writeFile(acquiredJobsFile, JSON.stringify(fixtureJobs, null, 2), {
		encoding: "utf8",
		mode: 0o600,
	});

	// Mock LLM service
	let llmCalls = 0;
	const originalLlmCall = llmService.call;
	t.after(() => {
		llmService.call = originalLlmCall;
	});

	llmService.call = async (req) => {
		llmCalls++;
		const contentStr = JSON.stringify(req.messages);

		// JobCloth mock response
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
					{
						jobTitle: "Sales Associate",
						isVeryHighlyAligned: false,
						rationale: "Not aligned.",
						confidence: 0.1,
					},
				],
				usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
			};
		}

		// MakeMaterials mock response
		if (
			contentStr.includes("ROP") ||
			contentStr.includes("Resume Optimization") ||
			contentStr.includes("cover_length")
		) {
			return {
				content: `# Resume Filename
Candidate_Materials_Cloud_Security_Engineer

# Cover Letter Filename
Candidate_Cover_Letter_Acme_Security.txt

# Optimized & Tailored Professional Title
Lead Cloud Security Engineer

# Optimized & Tailored Professional Summary
High-impact Security Engineer specialized in cloud infrastructure and DevSecOps.

# Optimized & Tailored Key Skills
- Cloud Security Architecture
- DevSecOps & CI/CD Security
- IAM & Zero Trust

# Optimized & Tailored Cover Letter
Dear Hiring Team at Acme Security,\n\nI am thrilled to apply for the Cloud Security Engineer role...`,
				usage: { promptTokens: 150, completionTokens: 100, totalTokens: 250 },
			};
		}

		// JobJudge mock response
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

	// === STAGE 1: Process Data ===
	const processedFile = path.join(dataDir, "processed_jobs_indeed.json");
	const processResult = await processAcquiredJobs({
		inputDirectory: dataDir,
		outputFile: processedFile,
	});

	// Verify duplicate and filtered entries
	assert.equal(processResult.filesProcessed, 1);
	assert.equal(processResult.duplicatesRemoved, 1); // 1 exact dupe removed
	assert.equal(processResult.filteredEntries, 2); // BlocklistCorp + Intern
	assert.equal(processResult.outputRecordCount, 2); // Cloud Security Engineer + Sales Associate

	// Verify processData manifest and private permissions (0600)
	const processStat = await fs.stat(processedFile);
	assert.equal(
		processStat.mode & 0o777,
		0o600,
		"Processed jobs file must have 0600 permissions",
	);
	const processManifest = await verifyArtifactManifest(processedFile);
	assert.equal(
		processManifest.ok,
		true,
		"Processed jobs manifest must be valid",
	);

	// === STAGE 2: JobCloth (Prefiltering) ===
	const clothedFile = path.join(dataDir, "clothed_jobs_indeed.json");
	const presets = await loadPresets();
	const clothPreset = getPreset("jobCloth", "jc_glm-5.3-flash", presets);
	assert.ok(clothPreset);

	const clothJobs = await runJobCloth(processedFile, clothedFile, {
		apiKey: "mock-api-key",
		baseUrl: clothPreset.base_url,
		modelId: clothPreset.modelId,
		preset: "jc_glm-5.3-flash",
		batch: 10,
	});

	assert.equal(
		clothJobs.length,
		1,
		"Only Cloud Security Engineer should pass clothing",
	);
	assert.equal(clothJobs[0].title, "Cloud Security Engineer");

	// Verify cloth manifest and file mode
	const clothStat = await fs.stat(clothedFile);
	assert.equal(
		clothStat.mode & 0o777,
		0o600,
		"Clothed jobs file must have 0600 permissions",
	);
	const clothManifest = await verifyArtifactManifest(clothedFile);
	assert.equal(clothManifest.ok, true, "Clothed jobs manifest must be valid");

	const clothCallsAfterFirstRun = llmCalls;
	assert.ok(
		clothCallsAfterFirstRun > 0,
		"LLM calls should have been made in jobCloth",
	);

	// === STAGE 3: JobJudge (Alignment Evaluation) ===
	const judgePreset = getPreset("jobJudge", "jep_glm-5.3-flash", presets);
	assert.ok(judgePreset);

	const judgeResult = await runJobJudge({
		"api-key": "mock-api-key",
		"base-url": judgePreset.base_url,
		"model-id": judgePreset.modelId,
		"input-file": clothedFile,
		"output-file": path.join(dataDir, "astroapply_eval_"),
		preset: "jep_glm-5.3-flash",
		"use-jobdb": true,
		"strict-parsing": false,
		"log-payload": false,
		sleep: 0,
		"eval-mode": 1,
		"show-reasoning": false,
		"show-stream": false,
		verbose: false,
		logDir,
	});

	assert.equal(judgeResult.jobs, 1);
	assert.equal(judgeResult.passed, 1);

	// Verify pass artifact in astroapply_eval_pass
	const passDir = path.join(dataDir, "astroapply_eval_pass");
	const passFiles = await fs.readdir(passDir);
	const passJsonFiles = passFiles.filter(
		(f) => f.endsWith(".json") && !f.endsWith(".manifest.json"),
	);
	assert.equal(passJsonFiles.length, 1);
	const passFilePath = path.join(passDir, passJsonFiles[0]);

	const passStat = await fs.stat(passFilePath);
	assert.equal(
		passStat.mode & 0o777,
		0o600,
		"Eval pass file must have 0600 permissions",
	);
	const passManifest = await verifyArtifactManifest(passFilePath);
	assert.equal(passManifest.ok, true, "Eval pass manifest must be valid");

	// Verify SQLite database has recorded the judged job
	const repository = new JobRepository({
		dbFilePath: path.join(dataDir, "jobDB.sqlite"),
		defaultExpirationMs: 30 * 24 * 60 * 60 * 1000,
		enableJobDB: true,
	});
	await repository.initialize();
	const isMatchedInDb = repository.isJobMatched({
		id: "indeed:job-pass-1",
		title: "Cloud Security Engineer",
		company: "Acme Security",
		source: "indeed",
	});
	assert.equal(isMatchedInDb, true, "JobRepository must record judged job");
	await repository.close();

	// === STAGE 4: MakeMaterials ===
	const materialsPreset = getPreset(
		"makeMaterials",
		"rop_g5.6-luna_or",
		presets,
	);
	assert.ok(materialsPreset);

	const materialsResult = await runResumeOptimizationMode(materialsPreset, {
		preset: "rop_g5.6-luna_or",
		apiKey: "mock-api-key",
		verbose: false,
		sleep: 0,
		jitter: false,
		logDir,
	});

	assert.equal(
		materialsResult.content.length,
		1,
		"Should generate 1 materials result",
	);

	// Verify materials output files and manifests
	const matSubDirs = await fs.readdir(materialsDir);
	assert.ok(
		matSubDirs.length > 0,
		"Materials output directory should be created",
	);
	const matOutputDir = path.join(materialsDir, matSubDirs[0]);
	const matFiles = await fs.readdir(matOutputDir);
	const txtFile = matFiles.find((f) => f.endsWith(".txt"));
	assert.ok(txtFile, "Materials txt file must exist");
	const txtFilePath = path.join(matOutputDir, txtFile);
	const txtStat = await fs.stat(txtFilePath);
	assert.equal(
		txtStat.mode & 0o777,
		0o600,
		"Materials txt file must have 0600 permissions",
	);
	const txtManifest = await verifyArtifactManifest(txtFilePath);
	assert.equal(txtManifest.ok, true, "Materials manifest must be valid");

	// === STAGE 5: Duplicate Protection & Checkpoint Resumption ===
	const callsBeforeRerun = llmCalls;

	// Re-run jobCloth with identical input: Checkpoint should detect matching output and skip LLM calls
	const clothRerun = await runJobCloth(processedFile, clothedFile, {
		apiKey: "mock-api-key",
		baseUrl: clothPreset.base_url,
		modelId: clothPreset.modelId,
		preset: "jc_glm-5.3-flash",
		batch: 10,
	});
	assert.equal(clothRerun.length, 1);
	assert.equal(
		llmCalls,
		callsBeforeRerun,
		"jobCloth rerun must not call LLM due to durable checkpoint",
	);

	// Re-run jobJudge: Checkpoint should detect matching work and skip LLM calls
	await runJobJudge({
		"api-key": "mock-api-key",
		"base-url": judgePreset.base_url,
		"model-id": judgePreset.modelId,
		"input-file": clothedFile,
		"output-file": path.join(dataDir, "astroapply_eval_"),
		preset: "jep_glm-5.3-flash",
		"use-jobdb": true,
		"strict-parsing": false,
		"log-payload": false,
		sleep: 0,
		"eval-mode": 1,
		"show-reasoning": false,
		"show-stream": false,
		verbose: false,
		logDir,
	});
	assert.equal(
		llmCalls,
		callsBeforeRerun,
		"jobJudge rerun must not call LLM due to durable checkpoint",
	);

	// Re-run makeMaterials: Checkpoint should detect matching work and skip LLM calls
	await runResumeOptimizationMode(materialsPreset, {
		preset: "rop_g5.6-luna_or",
		apiKey: "mock-api-key",
		verbose: false,
		sleep: 0,
		jitter: false,
		logDir,
	});
	assert.equal(
		llmCalls,
		callsBeforeRerun,
		"makeMaterials rerun must not call LLM due to durable checkpoint",
	);
});
