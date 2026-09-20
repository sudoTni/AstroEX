const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const { IndeedProvider } = require("../dist/acquisition/jobspyProvider");
const {
	filterRemoteOnlyJobs,
	resolveRemoteOnlyOption,
	runAcquireJobs,
} = require("../dist/commands/acquireJobs");
const { processAcquiredJobs } = require("../dist/commands/processData");
const { buildPipelineConfig } = require("../dist/pipelineConfig");
const {
	resolvePipelineAcquisitionInputFiles,
} = require("../dist/commands/runPipeline");

function createMockJob(id, isRemoteVal, overrides = {}) {
	const job = {
		id: `indeed:${id}`,
		source: "indeed",
		sourceJobId: id,
		canonicalUrl: `https://www.indeed.com/viewjob?jk=${id}`,
		title: `Software Engineer ${id}`,
		company: "Tech Corp",
		location: "Remote, USA",
		description: "Great remote or hybrid software role",
		descriptionRepresentation: "markdown",
		acquiredAt: new Date().toISOString(),
		...overrides,
	};
	if (isRemoteVal !== "OMIT") {
		job.isRemote = isRemoteVal;
	}
	return job;
}

test("filterRemoteOnlyJobs strictly retains only isRemote === true jobs", () => {
	const jobs = [
		createMockJob("1", true),
		createMockJob("2", false),
		createMockJob("3", undefined),
		createMockJob("4", null),
		createMockJob("5", "OMIT"),
		createMockJob("6", "true"),
		createMockJob("7", 1),
		createMockJob("8", true),
	];

	const filtered = filterRemoteOnlyJobs(jobs);

	assert.equal(filtered.length, 2);
	assert.equal(filtered[0].id, "indeed:1");
	assert.equal(filtered[0].isRemote, true);
	assert.equal(filtered[1].id, "indeed:8");
	assert.equal(filtered[1].isRemote, true);
});

test("buildPipelineConfig resolves remoteOnly with default, explicit override, and env variable", () => {
	// 1. Default when omitted is false
	const defaultConfig = buildPipelineConfig();
	assert.strictEqual(defaultConfig.search.remoteOnly, false);

	// 2. Explicit override to true
	const trueConfig = buildPipelineConfig({
		search: { remoteOnly: true },
	});
	assert.strictEqual(trueConfig.search.remoteOnly, true);

	// 3. Explicit override to false
	const falseConfig = buildPipelineConfig({
		search: { remoteOnly: false },
	});
	assert.strictEqual(falseConfig.search.remoteOnly, false);

	// 4. Environment variable ASTROEX_REMOTE_ONLY=1
	const prevEnv = process.env.ASTROEX_REMOTE_ONLY;
	try {
		process.env.ASTROEX_REMOTE_ONLY = "1";
		const envConfig = buildPipelineConfig();
		assert.strictEqual(envConfig.search.remoteOnly, true);

		// Explicit override false wins over env var
		const explicitWins = buildPipelineConfig({
			search: { remoteOnly: false },
		});
		assert.strictEqual(explicitWins.search.remoteOnly, false);
	} finally {
		if (prevEnv === undefined) {
			Reflect.deleteProperty(process.env, "ASTROEX_REMOTE_ONLY");
		} else {
			process.env.ASTROEX_REMOTE_ONLY = prevEnv;
		}
	}
});

test("hoursOld remains absent unless explicitly configured", () => {
	const omitted = buildPipelineConfig();
	assert.strictEqual(omitted.search.hoursOld, undefined);

	const configured = buildPipelineConfig({ search: { hoursOld: 48 } });
	assert.strictEqual(configured.search.hoursOld, 48);

	assert.throws(
		() => buildPipelineConfig({ search: { hoursOld: 0 } }),
		/greater than 0/,
	);
});

test("explicit remote-only CLI values take precedence over the environment", () => {
	assert.equal(resolveRemoteOnlyOption(undefined, undefined, undefined), false);
	assert.equal(resolveRemoteOnlyOption(undefined, undefined, "1"), true);
	assert.equal(resolveRemoteOnlyOption(false, false, "1"), false);
	assert.equal(resolveRemoteOnlyOption(true, true, undefined), true);
});

test("CLI option declarations and help text for remote-only", async () => {
	const cliPath = path.join(__dirname, "../dist/index.js");

	// 1. acquire-jobs help output
	const { stdout: acquireHelp } = await execFileAsync(process.execPath, [
		cliPath,
		"acquire-jobs",
		"--help",
	]);
	assert.match(acquireHelp, /--remote-only/);
	assert.match(acquireHelp, /Retain only acquired jobs/);

	// 2. run-pipeline help output
	const { stdout: pipelineHelp } = await execFileAsync(process.execPath, [
		cliPath,
		"run-pipeline",
		"--help",
	]);
	assert.match(pipelineHelp, /--remote-only/);
	assert.match(
		pipelineHelp,
		/confirm\s+remote status with remoteEval before jobJudge/,
	);
	assert.match(pipelineHelp, /--remoteeval-preset/);
	assert.match(pipelineHelp, /--re-provider/);
	assert.match(pipelineHelp, /--re-reasoning-level/);
	assert.doesNotMatch(acquireHelp, /default: 168/);
	assert.doesNotMatch(pipelineHelp, /default: 24/);
});

test("pipeline normalization selects only configured source artifacts", () => {
	const config = buildPipelineConfig({
		search: { sites: ["indeed"] },
		paths: {
			acquiredJobsFile: "/data/acquired_jobs_indeed.json",
			acquiredJobsIndeedFile: "/data/acquired_jobs_indeed.json",
			acquiredJobsLinkedInFile: "/data/acquired_jobs_linkedin.json",
		},
	});
	assert.deepEqual(resolvePipelineAcquisitionInputFiles(config), [
		"/data/acquired_jobs_indeed.json",
	]);

	const multiSource = buildPipelineConfig({
		search: { sites: ["indeed", "linkedin"] },
		paths: {
			acquiredJobsFile: "/data/acquired_jobs_indeed.json",
			acquiredJobsIndeedFile: "/data/acquired_jobs_indeed.json",
			acquiredJobsLinkedInFile: "/data/acquired_jobs_linkedin.json",
		},
	});
	assert.deepEqual(resolvePipelineAcquisitionInputFiles(multiSource), [
		"/data/acquired_jobs_indeed.json",
		"/data/acquired_jobs_linkedin.json",
	]);
});

test("processData defensively filters canonical and legacy reused artifacts", async (t) => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-remote-process-"),
	);
	t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

	const selectedFile = path.join(tempDir, "selected_jobs.json");
	const staleFile = path.join(tempDir, "acquired_jobs_stale.json");
	const outputFile = path.join(tempDir, "processed_jobs.json");
	await fs.writeFile(
		selectedFile,
		JSON.stringify([
			createMockJob("canonical-remote", true),
			createMockJob("canonical-onsite", false),
			{
				id: "linkedin:legacy-remote",
				title: "Legacy Remote Engineer",
				company: "Legacy Corp",
				url: "https://www.linkedin.com/jobs/view/1234567890",
				remoteOk: true,
			},
			{
				id: "linkedin:legacy-onsite",
				title: "Legacy Onsite Engineer",
				company: "Legacy Corp",
				url: "https://www.linkedin.com/jobs/view/1234567891",
				remoteOk: false,
			},
		]),
		"utf8",
	);
	await fs.writeFile(
		staleFile,
		JSON.stringify([createMockJob("stale-onsite", false)]),
		"utf8",
	);

	const result = await processAcquiredJobs({
		inputFiles: [selectedFile],
		outputFile,
		companyFilters: [],
		titleFilters: [],
		remoteOnly: true,
	});
	const jobs = JSON.parse(await fs.readFile(outputFile, "utf8"));

	assert.equal(result.filesProcessed, 1);
	assert.equal(result.remoteFilteredEntries, 2);
	assert.deepEqual(
		jobs.map((job) => job.id),
		["indeed:canonical-remote", "linkedin:legacy-remote"],
	);
	assert.ok(jobs.every((job) => job.remoteOk === true));
});

test("runAcquireJobs with remote-only disabled preserves both remote and non-remote jobs", async (t) => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-remote-disabled-"),
	);
	t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

	const termsFile = path.join(tempDir, "search_terms.txt");
	await fs.writeFile(termsFile, "engineer\n", "utf-8");

	const outputFile = path.join(tempDir, "acquired_jobs_indeed.json");

	const mockJobs = [
		createMockJob("rem-1", true),
		createMockJob("nonrem-2", false),
		createMockJob("undef-3", undefined),
	];

	const originalAcquire = IndeedProvider.prototype.acquire;
	t.after(() => {
		IndeedProvider.prototype.acquire = originalAcquire;
	});

	let capturedQuery = null;
	IndeedProvider.prototype.acquire = async (query) => {
		capturedQuery = query;
		return {
			jobs: mockJobs,
			failures: [],
		};
	};

	const result = await runAcquireJobs({
		sites: "indeed",
		"search-terms": "engineer",
		"search-terms-file": termsFile,
		locations: "",
		"results-wanted": 10,
		distance: 25,
		remote: false,
		"remote-only": false,
		"easy-apply": false,
		"indeed-country": "USA",
		"description-mode": "available",
		"description-format": "markdown",
		proxies: "",
		"output-file": outputFile,
		"use-jobdb": false,
	});

	assert.equal(result.jobs, 3);
	assert.strictEqual(capturedQuery.hoursOld, undefined);
	assert.strictEqual(capturedQuery.isRemote, undefined);
	assert.strictEqual(capturedQuery.remoteOnly, undefined);

	const savedContent = JSON.parse(await fs.readFile(outputFile, "utf-8"));
	assert.equal(savedContent.length, 3);
	assert.deepEqual(
		savedContent.map((j) => j.id),
		["indeed:rem-1", "indeed:nonrem-2", "indeed:undef-3"],
	);
});

test("runAcquireJobs with remote-only enabled retains only isRemote === true and excludes all other values", async (t) => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-remote-enabled-"),
	);
	t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

	const termsFile = path.join(tempDir, "search_terms.txt");
	await fs.writeFile(termsFile, "engineer\n", "utf-8");

	const outputFile = path.join(tempDir, "acquired_jobs_indeed.json");

	const mockJobs = [
		createMockJob("rem-1", true),
		createMockJob("nonrem-2", false),
		createMockJob("undef-3", undefined),
		createMockJob("null-4", null),
		createMockJob("missing-5", "OMIT"),
		createMockJob("rem-6", true),
	];

	const originalAcquire = IndeedProvider.prototype.acquire;
	t.after(() => {
		IndeedProvider.prototype.acquire = originalAcquire;
	});

	let capturedQuery = null;
	IndeedProvider.prototype.acquire = async (query) => {
		capturedQuery = query;
		return {
			jobs: mockJobs,
			failures: [],
		};
	};

	const result = await runAcquireJobs({
		sites: "indeed",
		"search-terms": "engineer",
		"search-terms-file": termsFile,
		locations: "",
		"results-wanted": 10,
		distance: 25,
		remote: false,
		"remote-only": true,
		"easy-apply": false,
		"indeed-country": "USA",
		"description-mode": "available",
		"description-format": "markdown",
		proxies: "",
		"output-file": outputFile,
		"use-jobdb": false,
	});

	assert.strictEqual(capturedQuery.isRemote, true);
	assert.strictEqual(capturedQuery.remoteOnly, true);
	assert.strictEqual(capturedQuery.hoursOld, undefined);
	assert.equal(result.jobs, 2);

	const savedContent = JSON.parse(await fs.readFile(outputFile, "utf-8"));
	assert.equal(savedContent.length, 2);
	assert.deepEqual(
		savedContent.map((j) => j.id),
		["indeed:rem-1", "indeed:rem-6"],
	);
	assert.ok(savedContent.every((j) => j.isRemote === true));

	// Verify downstream processing only sees the filtered remote jobs
	const processedOutputFile = path.join(tempDir, "processed_jobs.json");
	const processResult = await processAcquiredJobs({
		inputDirectory: tempDir,
		outputFile: processedOutputFile,
	});
	assert.equal(processResult.outputRecordCount, 2);
	const processedJobs = JSON.parse(
		await fs.readFile(processedOutputFile, "utf-8"),
	);
	assert.equal(processedJobs.length, 2);
	assert.ok(processedJobs.every((j) => j.remoteOk === true));
});

test("runAcquireJobs with remote-only filters non-remote jobs from resumed checkpoint", async (t) => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-remote-checkpoint-"),
	);
	t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

	const termsFile = path.join(tempDir, "search_terms.txt");
	await fs.writeFile(termsFile, "engineer\n", "utf-8");

	const outputFile = path.join(tempDir, "acquired_jobs_indeed.json");

	// Pre-populate checkpoint with existing mixed jobs
	const existingJobs = [
		createMockJob("existing-remote", true),
		createMockJob("existing-onsite", false),
		createMockJob("existing-unknown", undefined),
	];
	await fs.writeFile(
		outputFile,
		JSON.stringify(existingJobs, null, 2),
		"utf-8",
	);

	const originalAcquire = IndeedProvider.prototype.acquire;
	t.after(() => {
		IndeedProvider.prototype.acquire = originalAcquire;
	});

	IndeedProvider.prototype.acquire = async () => ({
		jobs: [],
		failures: [],
	});

	const result = await runAcquireJobs({
		sites: "indeed",
		"search-terms": "engineer",
		"search-terms-file": termsFile,
		locations: "",
		"results-wanted": 10,
		distance: 25,
		"hours-old": 24,
		remote: false,
		"remote-only": true,
		"easy-apply": false,
		"indeed-country": "USA",
		"description-mode": "available",
		"description-format": "markdown",
		proxies: "",
		"output-file": outputFile,
		"use-jobdb": false,
	});

	// Only existing-remote remains
	assert.equal(result.jobs, 1);
	const savedContent = JSON.parse(await fs.readFile(outputFile, "utf-8"));
	assert.equal(savedContent.length, 1);
	assert.equal(savedContent[0].id, "indeed:existing-remote");
});
