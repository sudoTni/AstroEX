const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const axios = require("axios");

const { verifyArtifactManifest } = require("../dist/artifactManifest");
const { runJobCloth } = require("../dist/commands/jobCloth");
const { runEnrichLinkedInJobs } = require("../dist/commands/enrichJobs");
const { runJobJudge } = require("../dist/commands/jobJudge");
const { runResumeOptimizationMode } = require("../dist/commands/makeMaterials");
const { processAcquiredJobs } = require("../dist/commands/processData");
const { JobRepository } = require("../dist/jobRepository");
const { llmService } = require("../dist/llmService");
const { getPreset, loadPresets } = require("../dist/presets");
const { ExecutionLog } = require("../dist/utils");

test("end-to-end multi-provider pipeline integration (Indeed + LinkedIn -> processData -> jobCloth -> enrichJobs -> jobJudge -> makeMaterials)", async (t) => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-multiprovider-pipeline-"),
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
	const executionLog = new ExecutionLog();
	const executionLogPath = executionLog.initialize(logDir, ["run-pipeline"]);
	t.after(() => executionLog.close());

	// Setup profile
	await fs.writeFile(
		path.join(profileDir, "search_terms.txt"),
		"Security Engineer\n",
		"utf8",
	);
	await fs.writeFile(
		path.join(profileDir, "my_resume.txt"),
		"Experienced Security Architect with Kubernetes and Cloud Security background.\n",
		"utf8",
	);
	await fs.writeFile(path.join(profileDir, "company_filters.txt"), "", "utf8");
	await fs.writeFile(path.join(profileDir, "title_filters.txt"), "", "utf8");
	await fs.writeFile(
		path.join(profileDir, "my_professional_title.txt"),
		"Security Architect\n",
		"utf8",
	);
	await fs.writeFile(
		path.join(profileDir, "my_professional_summary.txt"),
		"Cloud security architect specializing in container defense.\n",
		"utf8",
	);
	await fs.writeFile(
		path.join(profileDir, "my_key_skills.txt"),
		"Security, Kubernetes, AWS\n",
		"utf8",
	);
	await fs.writeFile(
		path.join(profileDir, "my_testimonials.txt"),
		"Exemplary technical leadership.\n",
		"utf8",
	);

	// Setup initial SQLite DB
	const dbFile = path.join(dataDir, "jobDB.sqlite");
	const repository = new JobRepository({
		dbFilePath: dbFile,
		enableJobDB: true,
	});
	await repository.initialize();
	await repository.load();
	t.after(() => repository.close());

	// Fixtures: 1 Indeed job (with description), 1 LinkedIn job (without description)
	const indeedJob = {
		id: "indeed:ind-100",
		source: "indeed",
		sourceJobId: "ind-100",
		canonicalUrl: "https://www.indeed.com/viewjob?jk=ind-100",
		title: "Senior Security Engineer",
		company: "IndeedTech",
		location: "Remote, USA",
		description: "Indeed full job description for Senior Security Engineer.",
		descriptionText:
			"Indeed full job description for Senior Security Engineer.",
		descriptionRepresentation: "markdown",
		isRemote: true,
		acquiredAt: new Date().toISOString(),
	};

	const linkedinJob = {
		id: "linkedin:li-200",
		source: "linkedin",
		sourceJobId: "li-200",
		canonicalUrl: "https://www.linkedin.com/jobs/view/li-200",
		title: "Lead Cloud Architect",
		company: "LinkedInTech",
		location: "Remote",
		descriptionRepresentation: "unknown",
		isRemote: true,
		acquiredAt: new Date().toISOString(),
	};

	await fs.writeFile(
		path.join(dataDir, "acquired_jobs_01_indeed.json"),
		JSON.stringify([indeedJob], null, 2),
		"utf8",
	);
	await fs.writeFile(
		path.join(dataDir, "acquired_jobs_02_linkedin.json"),
		JSON.stringify([linkedinJob], null, 2),
		"utf8",
	);

	// Mock axios for LinkedIn detail page
	const originalGet = axios.Axios.prototype.get;
	axios.Axios.prototype.get = async function (url, config) {
		if (typeof url === "string" && url.includes("/jobs/view/li-200")) {
			return {
				status: 200,
				data: `
					<div class="show-more-less-html__markup">
						<p>LinkedIn detailed description for Lead Cloud Architect with deep cloud and security requirements.</p>
					</div>
					<code id="applyUrl"><!--https://company.com/apply?url=https%3A%2F%2Fboards.greenhouse.io%2Fapply%2Fli-200--></code>
				`,
				headers: {},
			};
		}
		return originalGet.call(this, url, config);
	};
	t.after(() => {
		axios.Axios.prototype.get = originalGet;
	});

	// Mock LLM service
	const originalLlmCall = llmService.call;
	const requestsByStage = {
		jobCloth: [],
		jobJudge: [],
		makeMaterials: [],
	};
	const optionsByStage = {
		jobCloth: [],
		jobJudge: [],
		makeMaterials: [],
	};
	t.after(() => {
		llmService.call = originalLlmCall;
	});

	llmService.call = async (req, options) => {
		const contentStr = JSON.stringify(req.messages);

		// JobCloth mock
		if (
			contentStr.includes("classification engine") ||
			contentStr.includes("JOB-TITLE-LEVEL") ||
			contentStr.includes("job-title")
		) {
			requestsByStage.jobCloth.push(JSON.parse(JSON.stringify(req)));
			optionsByStage.jobCloth.push(options);
			return {
				content: [
					{
						jobTitle: "Senior Security Engineer",
						isVeryHighlyAligned: true,
						rationale: "Matches security title.",
						confidence: 0.95,
					},
					{
						jobTitle: "Lead Cloud Architect",
						isVeryHighlyAligned: true,
						rationale: "Matches architecture title.",
						confidence: 0.95,
					},
				],
				usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
			};
		}

		// MakeMaterials mock
		if (
			contentStr.includes("ROP") ||
			contentStr.includes("Resume Optimization") ||
			contentStr.includes("cover_length")
		) {
			requestsByStage.makeMaterials.push(JSON.parse(JSON.stringify(req)));
			optionsByStage.makeMaterials.push(options);
			return {
				content: `# Resume Filename
Alex_Morgan_Materials_Security_Architect

# Cover Letter Filename
Alex_Morgan_Cover_Letter_Target.txt

# Optimized & Tailored Professional Title
Lead Security Architect

# Optimized & Tailored Professional Summary
Architect with deep security experience.

# Optimized & Tailored Key Skills
- Cloud Security
- Kubernetes
- CI/CD

# Optimized & Tailored Cover Letter
Dear Hiring Team,\n\nI am excited to apply for this role.`,
				usage: { promptTokens: 150, completionTokens: 100, totalTokens: 250 },
			};
		}

		// JobJudge mock
		requestsByStage.jobJudge.push(JSON.parse(JSON.stringify(req)));
		optionsByStage.jobJudge.push(options);
		return {
			content: [
				{
					jobTitle: "Job Evaluation",
					isVeryHighlyAligned: true,
					rationale: "Candidate has strong alignment.",
					confidence: 0.95,
				},
			],
			usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
		};
	};

	// 1. Process Data
	const processedFile = path.join(dataDir, "processed_jobs.json");
	const processResult = await processAcquiredJobs({
		inputDirectory: dataDir,
		outputFile: processedFile,
	});
	assert.equal(processResult.filesProcessed, 2);
	assert.equal(processResult.outputRecordCount, 2);

	const processedJobs = JSON.parse(await fs.readFile(processedFile, "utf8"));
	assert.equal(processedJobs[0].source, "indeed");
	assert.equal(processedJobs[1].source, "linkedin");

	// 2. JobCloth
	const clothedFile = path.join(dataDir, "clothed_jobs.json");
	const presets = await loadPresets();
	const clothPreset = getPreset("jobCloth", "jc_glm-5.3-flash", presets);

	const clothJobs = await runJobCloth(processedFile, clothedFile, {
		apiKey: "mock-api-key",
		baseUrl: clothPreset.base_url,
		modelId: clothPreset.modelId,
		preset: "jc_glm-5.3-flash",
		batch: 10,
	});
	assert.equal(clothJobs.length, 2);

	// 3. Enrich Jobs (Stage 3.5)
	const clothedEnrichedFile = path.join(dataDir, "clothed_jobs_enriched.json");
	const enrichResult = await runEnrichLinkedInJobs({
		inputFile: clothedFile,
		outputFile: clothedEnrichedFile,
		delayMs: 0,
		jobRepository: repository,
	});
	assert.equal(enrichResult.totalJobs, 2);
	assert.equal(enrichResult.enrichedCount, 1);

	const enrichedJobs = JSON.parse(
		await fs.readFile(clothedEnrichedFile, "utf8"),
	);
	assert.equal(enrichedJobs[1].source, "linkedin");
	assert.ok(
		enrichedJobs[1].descriptionText.includes(
			"LinkedIn detailed description for Lead Cloud Architect",
		),
	);
	assert.equal(
		enrichedJobs[1].directUrl,
		"https://boards.greenhouse.io/apply/li-200",
	);
	assert.ok(repository.isJobDescriptionScraped(linkedinJob));

	// 4. JobJudge (Stage 4)
	const judgeResult = await runJobJudge({
		"api-key": "mock-api-key",
		"base-url": "",
		"model-id": "",
		"input-file": clothedEnrichedFile,
		"output-file": path.join(dataDir, "astroapply_eval_"),
		preset: "jep_glm-5.3-flash",
		"use-jobdb": true,
		"strict-parsing": false,
		sleep: 0,
		"eval-mode": 1,
	});

	assert.equal(judgeResult.jobs, 2);
	assert.equal(judgeResult.passed, 2);

	// Verify eval pass directory contains evaluated JSON files for both Indeed and LinkedIn jobs
	const passDir = path.join(dataDir, "astroapply_eval_pass");
	const evalFiles = await fs.readdir(passDir);
	const jsonFiles = evalFiles.filter(
		(f) => f.endsWith(".json") && !f.endsWith(".manifest.json"),
	);
	assert.equal(jsonFiles.length, 2);

	// 5. MakeMaterials (Stage 5)
	const materialsPreset = getPreset(
		"makeMaterials",
		"rop_g5.6-luna_or",
		presets,
	);
	const materialsResult = await runResumeOptimizationMode(materialsPreset, {
		preset: "rop_g5.6-luna_or",
		apiKey: "mock-api-key",
		sleep: 0,
	});

	assert.equal(materialsResult.content.length, 2);

	// Verify materials were written to disk
	const { findMaterialTextFiles } = require("../dist/commands/runPipeline");
	const materialFiles = await findMaterialTextFiles(materialsDir);
	assert.ok(materialFiles.length >= 1);

	for (const stage of ["jobCloth", "jobJudge", "makeMaterials"]) {
		assert.equal(optionsByStage[stage].length, requestsByStage[stage].length);
		assert.ok(
			optionsByStage[stage].every(
				(options) => options?.payloadLogStage === stage,
			),
		);
		for (const request of requestsByStage[stage]) {
			assert.ok(request.messages.some((message) => message.role === "system"));
		}
	}

	executionLog.close();
	const executionFiles = (await fs.readdir(logDir)).filter((file) =>
		file.endsWith(".log"),
	);
	assert.deepEqual(executionFiles, [path.basename(executionLogPath)]);
	const executionOutput = await fs.readFile(executionLogPath, "utf8");
	for (const stageOutput of [
		"[ProcessData]",
		"[JobCloth]",
		"[EnrichJobs]",
		"[JobJudge]",
		"[MakeMaterials]",
	]) {
		assert.ok(executionOutput.includes(stageOutput));
	}
	assert.ok(!executionOutput.includes(String.fromCharCode(27)));
});
