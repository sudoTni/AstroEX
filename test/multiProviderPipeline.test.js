const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseAcquisitionSources } = require("../dist/commands/acquireJobs");
const { buildPipelineConfig } = require("../dist/pipelineConfig");
const { executePipeline } = require("../dist/commands/runPipeline");

test("parseAcquisitionSources parses valid single and multi-source inputs", () => {
	assert.deepEqual(parseAcquisitionSources("indeed"), ["indeed"]);
	assert.deepEqual(parseAcquisitionSources("linkedin"), ["linkedin"]);
	assert.deepEqual(parseAcquisitionSources("indeed, linkedin"), [
		"indeed",
		"linkedin",
	]);
	assert.deepEqual(parseAcquisitionSources("linkedin,indeed"), [
		"linkedin",
		"indeed",
	]);
	assert.deepEqual(parseAcquisitionSources("  LINKEDIN , INDEED  "), [
		"linkedin",
		"indeed",
	]);

	assert.throws(
		() => parseAcquisitionSources(""),
		/must include at least one supported source/i,
	);
	assert.throws(
		() => parseAcquisitionSources("monster"),
		/Unsupported acquisition site\(s\): monster/i,
	);
	assert.throws(
		() => parseAcquisitionSources("indeed,dice"),
		/Unsupported acquisition site\(s\): dice/i,
	);
});

test("buildPipelineConfig honors ASTROEX_JOB_PROVIDER and sets enriched file path", () => {
	const originalEnv = process.env.ASTROEX_JOB_PROVIDER;
	try {
		process.env.ASTROEX_JOB_PROVIDER = "linkedin,indeed";
		const config = buildPipelineConfig();
		assert.deepEqual(config.search.sites, ["linkedin", "indeed"]);
		assert.ok(
			config.paths.clothedJobsEnrichedFile.endsWith(
				"clothed_jobs_enriched.json",
			),
		);
	} finally {
		if (originalEnv !== undefined) {
			process.env.ASTROEX_JOB_PROVIDER = originalEnv;
		} else {
			Reflect.deleteProperty(process.env, "ASTROEX_JOB_PROVIDER");
		}
	}
});

test("buildPipelineConfig defaults and validates the jobCloth cool-off", () => {
	assert.equal(buildPipelineConfig().options.jobClothCoolOffDays, 30);
	assert.equal(
		buildPipelineConfig({ options: { jobClothCoolOffDays: 45 } }).options
			.jobClothCoolOffDays,
		45,
	);
	for (const value of [0, -1, 1.5, Number.NaN]) {
		assert.throws(() =>
			buildPipelineConfig({ options: { jobClothCoolOffDays: value } }),
		);
	}
});

test("buildPipelineConfig keeps OpenRouter cost tracking opt-in", () => {
	assert.equal(buildPipelineConfig().options.trackOpenRouterCosts, false);
	assert.equal(
		buildPipelineConfig({ options: { trackOpenRouterCosts: true } }).options
			.trackOpenRouterCosts,
		true,
	);
});

test("buildPipelineConfig keeps cool-off reporting opt-in", () => {
	assert.equal(buildPipelineConfig().options.logCoolOffs, false);
	assert.equal(
		buildPipelineConfig({ options: { logCoolOffs: true } }).options.logCoolOffs,
		true,
	);
});

test("pipeline transient cleanup preserves *.sqlite* and *.bak* while cleaning transient files", async (t) => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "astroex-clean-test-"));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));

	const sqliteDb = path.join(dir, "jobDB.sqlite");
	const sqliteWal = path.join(dir, "jobDB.sqlite-wal");
	const sqliteShm = path.join(dir, "jobDB.sqlite-shm");
	const backupFile = path.join(dir, "jobDB.sqlite.bak");
	const backupArchive = path.join(dir, "data_backup.bak");

	const acquiredJson = path.join(dir, "acquired_jobs_indeed.json");
	const acquiredManifest = path.join(
		dir,
		"acquired_jobs_indeed.json.manifest.json",
	);
	const acquiredLinkedInJson = path.join(dir, "acquired_jobs_linkedin.json");
	const acquiredLinkedInManifest = path.join(
		dir,
		"acquired_jobs_linkedin.json.manifest.json",
	);
	const processedJson = path.join(dir, "processed_jobs_indeed.json");
	const processedManifest = path.join(
		dir,
		"processed_jobs_indeed.json.manifest.json",
	);
	const clothedJson = path.join(dir, "clothed_jobs_indeed.json");
	const clothedEnrichedJson = path.join(dir, "clothed_jobs_enriched.json");
	const evalPassDir = path.join(dir, "astroapply_eval_pass");
	const evalFailDir = path.join(dir, "astroapply_eval_fail");
	const evalDupeDir = path.join(dir, "astroapply_eval_dupe");

	// Create all files and directories
	await fs.writeFile(sqliteDb, "SQLITE-DATA", "utf8");
	await fs.writeFile(sqliteWal, "SQLITE-WAL", "utf8");
	await fs.writeFile(sqliteShm, "SQLITE-SHM", "utf8");
	await fs.writeFile(backupFile, "BACKUP-DATA", "utf8");
	await fs.writeFile(backupArchive, "BACKUP-ARCHIVE", "utf8");

	await fs.writeFile(acquiredJson, "[]", "utf8");
	await fs.writeFile(acquiredManifest, "{}", "utf8");
	await fs.writeFile(acquiredLinkedInJson, "[]", "utf8");
	await fs.writeFile(acquiredLinkedInManifest, "{}", "utf8");
	await fs.writeFile(processedJson, "[]", "utf8");
	await fs.writeFile(processedManifest, "{}", "utf8");
	await fs.writeFile(clothedJson, "[]", "utf8");
	await fs.writeFile(clothedEnrichedJson, "[]", "utf8");
	await fs.mkdir(evalPassDir, { recursive: true });
	await fs.mkdir(evalFailDir, { recursive: true });
	await fs.mkdir(evalDupeDir, { recursive: true });
	await fs.writeFile(path.join(evalPassDir, "job1.json"), "{}", "utf8");

	const config = buildPipelineConfig({
		paths: {
			dataDir: dir,
			acquiredJobsFile: acquiredJson,
			acquiredJobsIndeedFile: acquiredJson,
			acquiredJobsLinkedInFile: acquiredLinkedInJson,
			processedJobsFile: processedJson,
			clothedJobsFile: clothedJson,
			clothedJobsEnrichedFile: clothedEnrichedJson,
		},
		providers: {
			apiKey: "mock-api-key",
		},
		options: {
			clean: true,
		},
	});

	// Run pipeline with skipAcquisition and skipMaterials (and empty inputs, will stop cleanly)
	try {
		await executePipeline(config, {
			skipAcquisition: true,
			skipMaterials: true,
		});
	} catch {
		// Expected to stop since input files were cleaned
	}

	// Verify SQLite and backup files strictly preserved
	assert.equal(await fs.readFile(sqliteDb, "utf8"), "SQLITE-DATA");
	assert.equal(await fs.readFile(sqliteWal, "utf8"), "SQLITE-WAL");
	assert.equal(await fs.readFile(sqliteShm, "utf8"), "SQLITE-SHM");
	assert.equal(await fs.readFile(backupFile, "utf8"), "BACKUP-DATA");
	assert.equal(await fs.readFile(backupArchive, "utf8"), "BACKUP-ARCHIVE");

	// Verify transient json and manifest files were cleaned
	await assert.rejects(() => fs.access(acquiredJson));
	await assert.rejects(() => fs.access(acquiredManifest));
	await assert.rejects(() => fs.access(acquiredLinkedInJson));
	await assert.rejects(() => fs.access(acquiredLinkedInManifest));
	await assert.rejects(() => fs.access(clothedJson));
	await assert.rejects(() => fs.access(clothedEnrichedJson));
	await assert.rejects(() => fs.access(evalPassDir));
	await assert.rejects(() => fs.access(evalFailDir));
	await assert.rejects(() => fs.access(evalDupeDir));
});

test("multi-provider acquisition stores Indeed in acquired_jobs_indeed.json and LinkedIn in acquired_jobs_linkedin.json, and processData processes both", async (t) => {
	const dir = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-acq-split-test-"),
	);
	t.after(() => fs.rm(dir, { recursive: true, force: true }));

	const termsFile = path.join(dir, "search_terms.txt");
	await fs.writeFile(termsFile, "Security Engineer\n", "utf8");

	const indeedFile = path.join(dir, "acquired_jobs_indeed.json");
	const linkedinFile = path.join(dir, "acquired_jobs_linkedin.json");
	const processedFile = path.join(dir, "processed_jobs.json");

	const mockIndeedJob = {
		id: "indeed:ind-test-1",
		source: "indeed",
		sourceJobId: "ind-test-1",
		canonicalUrl: "https://www.indeed.com/viewjob?jk=ind-test-1",
		title: "Security Engineer Indeed",
		company: "Indeed Company",
		location: "Remote",
		description: "Indeed full job description text.",
		descriptionText: "Indeed full job description text.",
		descriptionRepresentation: "markdown",
		isRemote: true,
		acquiredAt: new Date().toISOString(),
	};

	const mockLinkedInJob = {
		id: "linkedin:li-test-2",
		source: "linkedin",
		sourceJobId: "li-test-2",
		canonicalUrl: "https://www.linkedin.com/jobs/view/li-test-2",
		title: "Security Engineer LinkedIn",
		company: "LinkedIn Company",
		location: "Remote",
		descriptionRepresentation: "unknown",
		isRemote: true,
		acquiredAt: new Date().toISOString(),
	};

	const { IndeedProvider } = require("../dist/acquisition/jobspyProvider");
	const { runAcquireJobs } = require("../dist/commands/acquireJobs");
	const { processAcquiredJobs } = require("../dist/commands/processData");

	const originalAcquire = IndeedProvider.prototype.acquire;
	t.after(() => {
		IndeedProvider.prototype.acquire = originalAcquire;
	});

	IndeedProvider.prototype.acquire = async (query) => {
		const jobs = [];
		if (query.sources.includes("indeed")) {
			jobs.push(mockIndeedJob);
		}
		if (query.sources.includes("linkedin")) {
			jobs.push(mockLinkedInJob);
		}
		return { jobs, failures: [] };
	};

	// Execute multi-provider acquisition
	const acqResult = await runAcquireJobs({
		sites: "indeed,linkedin",
		"search-terms": "Security Engineer",
		"search-terms-file": termsFile,
		locations: "",
		"results-wanted": 10,
		distance: 25,
		"hours-old": 24,
		remote: false,
		"remote-only": false,
		"easy-apply": false,
		"indeed-country": "USA",
		"description-mode": "available",
		"description-format": "markdown",
		proxies: "",
		"output-file": indeedFile,
		"output-file-indeed": indeedFile,
		"output-file-linkedin": linkedinFile,
		outputFilesBySource: {
			indeed: indeedFile,
			linkedin: linkedinFile,
		},
		"use-jobdb": false,
	});

	assert.equal(acqResult.jobs, 2);

	// Verify acquired_jobs_indeed.json contains ONLY Indeed jobs
	const indeedContent = JSON.parse(await fs.readFile(indeedFile, "utf8"));
	assert.equal(indeedContent.length, 1);
	assert.equal(indeedContent[0].id, "indeed:ind-test-1");
	assert.equal(indeedContent[0].source, "indeed");

	// Verify acquired_jobs_linkedin.json contains ONLY LinkedIn jobs
	const linkedInContent = JSON.parse(await fs.readFile(linkedinFile, "utf8"));
	assert.equal(linkedInContent.length, 1);
	assert.equal(linkedInContent[0].id, "linkedin:li-test-2");
	assert.equal(linkedInContent[0].source, "linkedin");

	// Now run processData on the directory containing both files
	const procResult = await processAcquiredJobs({
		inputDirectory: dir,
		outputFile: processedFile,
		companyFilters: [],
		titleFilters: [],
	});

	assert.equal(procResult.filesProcessed, 2);
	assert.equal(procResult.outputRecordCount, 2);

	const processedJobs = JSON.parse(await fs.readFile(processedFile, "utf8"));
	assert.equal(processedJobs.length, 2);
	const processedSources = processedJobs.map((j) => j.source).sort();
	assert.deepEqual(processedSources, ["indeed", "linkedin"]);
});
