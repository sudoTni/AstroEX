const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const { processAcquiredJobs } = require("../dist/commands/processData");
const { JobRepository } = require("../dist/jobRepository");

const execFileAsync = promisify(execFile);

async function captureConsole(run) {
	const originalStdoutWrite = process.stdout.write;
	const originalStderrWrite = process.stderr.write;
	let output = "";
	process.stdout.write = (chunk) => {
		output += String(chunk);
		return true;
	};
	process.stderr.write = (chunk) => {
		output += String(chunk);
		return true;
	};
	try {
		return { result: await run(), output };
	} finally {
		process.stdout.write = originalStdoutWrite;
		process.stderr.write = originalStderrWrite;
	}
}

async function createFixtureDirectory(t) {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-process-data-"),
	);
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	return directory;
}

function canonicalIndeedJob(id, overrides = {}) {
	return {
		id,
		source: "indeed",
		sourceJobId: id,
		canonicalUrl: `https://www.indeed.com/viewjob?jk=${id}`,
		title: "Security Engineer",
		company: "Example Corp",
		descriptionRepresentation: "markdown",
		acquiredAt: "2026-09-07T00:00:00.000Z",
		...overrides,
	};
}

async function createJobRepository(directory, now) {
	const repository = new JobRepository({
		dbFilePath: path.join(directory, "jobDB.sqlite"),
		legacyJsonPath: path.join(directory, "jobDB.json"),
		defaultExpirationMs: 30 * 24 * 60 * 60 * 1000,
		enableJobDB: true,
		now,
	});
	await repository.initialize();
	return repository;
}

test("processData skips only normalized title/company matches inside the jobCloth cool-off", async (t) => {
	const DAY_MS = 24 * 60 * 60 * 1000;
	const now = 50_000_000_000;
	const directory = await createFixtureDirectory(t);
	const input = path.join(directory, "acquired_jobs_cooloff.json");
	const output = path.join(directory, "processed_jobs.json");
	const repository = await createJobRepository(directory, () => now);
	t.after(() => repository.close());

	await repository.recordJobClothProcessed(
		[{ title: " Security   Engineer ", company: " EXAMPLE CORP " }],
		now - 5 * DAY_MS,
	);
	await repository.recordJobClothProcessed(
		[{ title: "Boundary Role", company: "Boundary Corp" }],
		now - 30 * DAY_MS,
	);
	await repository.recordJobClothProcessed(
		[{ title: "Old Role", company: "Old Corp" }],
		now - 31 * DAY_MS,
	);
	await fs.writeFile(
		input,
		JSON.stringify([
			canonicalIndeedJob("recent", {
				title: "security engineer",
				company: "example   corp",
			}),
			canonicalIndeedJob("other-company", {
				title: "Security Engineer",
				company: "Other Corp",
			}),
			canonicalIndeedJob("other-title", {
				title: "Security Analyst",
				company: "Example Corp",
			}),
			canonicalIndeedJob("boundary", {
				title: "Boundary Role",
				company: "Boundary Corp",
			}),
			canonicalIndeedJob("old", {
				title: "Old Role",
				company: "Old Corp",
			}),
		]),
	);

	const { result, output: consoleOutput } = await captureConsole(() =>
		processAcquiredJobs({
			inputFiles: [input],
			outputFile: output,
			jobClothCoolOffDays: 30,
			jobRepository: repository,
		}),
	);
	const jobs = JSON.parse(await fs.readFile(output, "utf8"));
	assert.equal(result.jobDbCoolOffSkippedEntries, 1);
	assert.equal(result.filteredEntries, 1);
	assert.equal(result.outputRecordCount, 4);
	assert.deepEqual(
		jobs.map((job) => job.id),
		["other-company", "other-title", "boundary", "old"],
	);
	assert.match(consoleOutput, /Applied jobCloth JobDB cool-off filter/);
	assert.match(consoleOutput, /jobDbCoolOffSkippedEntries=1/);

	const extendedOutput = path.join(directory, "processed_jobs_45_days.json");
	const extendedResult = await processAcquiredJobs({
		inputFiles: [input],
		outputFile: extendedOutput,
		jobClothCoolOffDays: 45,
		jobRepository: repository,
	});
	assert.equal(extendedResult.jobDbCoolOffSkippedEntries, 3);
	assert.deepEqual(
		JSON.parse(await fs.readFile(extendedOutput, "utf8")).map((job) => job.id),
		["other-company", "other-title"],
	);
});

test("processData logs only jobs excluded by the jobCloth cool-off", async (t) => {
	const DAY_MS = 24 * 60 * 60 * 1000;
	const now = 60_000_000_000;
	const directory = await createFixtureDirectory(t);
	const input = path.join(directory, "acquired_jobs_cooloff_logging.json");
	const output = path.join(directory, "processed_jobs.json");
	const logDirectory = path.join(directory, "nested", "logs");
	const repository = await createJobRepository(directory, () => now);
	t.after(() => repository.close());

	await repository.recordJobClothProcessed(
		[
			{ title: "Cool Role", company: "Cool Company" },
			{ title: "Onsite Role", company: "Onsite Company" },
			{ title: "Filtered Role", company: "Blocked Company" },
		],
		now - 5 * DAY_MS,
	);
	await fs.writeFile(
		input,
		JSON.stringify([
			canonicalIndeedJob("cool", {
				title: "Cool Role",
				company: "Cool Company",
				isRemote: true,
			}),
			canonicalIndeedJob("onsite", {
				title: "Onsite Role",
				company: "Onsite Company",
				isRemote: false,
			}),
			canonicalIndeedJob("profile-filtered", {
				title: "Filtered Role",
				company: "Blocked Company",
				isRemote: true,
			}),
			canonicalIndeedJob("duplicate-first", {
				title: "Duplicate Role",
				company: "Duplicate Company",
				isRemote: true,
			}),
			canonicalIndeedJob("duplicate-second", {
				title: "Duplicate Role",
				company: "Duplicate Company",
				isRemote: true,
			}),
			canonicalIndeedJob("eligible", {
				title: "Eligible Role",
				company: "Eligible Company",
				isRemote: true,
			}),
			{ id: "invalid", title: "Invalid", company: "Invalid" },
		]),
	);

	const { result, output: consoleOutput } = await captureConsole(() =>
		processAcquiredJobs({
			inputFiles: [input],
			outputFile: output,
			companyFilters: ["Blocked Company"],
			remoteOnly: true,
			jobClothCoolOffDays: 30,
			logCoolOffs: true,
			coolOffLogDirectory: logDirectory,
			jobRepository: repository,
		}),
	);

	assert.equal(result.jobDbCoolOffSkippedEntries, 1);
	assert.equal(result.remoteFilteredEntries, 1);
	assert.equal(result.duplicatesRemoved, 1);
	assert.ok(result.coolOffLogFile);
	assert.equal(path.dirname(result.coolOffLogFile), logDirectory);
	assert.match(
		path.basename(result.coolOffLogFile),
		/^processData_cool_off_suppressions_\d{8}T\d{9}Z_p\d+_[0-9a-f-]+\.json$/,
	);
	const report = JSON.parse(await fs.readFile(result.coolOffLogFile, "utf8"));
	assert.ok(!Number.isNaN(Date.parse(report.generatedAt)));
	assert.deepEqual(report, {
		generatedAt: report.generatedAt,
		coolOffDays: 30,
		count: 1,
		jobs: [{ id: "cool", company: "Cool Company", title: "Cool Role" }],
	});
	assert.match(consoleOutput, /Wrote 1 cool-off suppression record to/);
	assert.ok(consoleOutput.includes(result.coolOffLogFile));
	assert.deepEqual(
		JSON.parse(await fs.readFile(output, "utf8")).map((job) => job.id),
		["duplicate-first", "eligible"],
	);
	if (process.platform !== "win32") {
		const mode = (await fs.stat(result.coolOffLogFile)).mode & 0o777;
		assert.equal(mode, 0o600);
	}
});

test("processData cool-off logging is opt-in", async (t) => {
	const DAY_MS = 24 * 60 * 60 * 1000;
	const now = 70_000_000_000;
	const directory = await createFixtureDirectory(t);
	const input = path.join(directory, "acquired_jobs_opt_in.json");
	const output = path.join(directory, "processed_jobs.json");
	const logDirectory = path.join(directory, "logs");
	const repository = await createJobRepository(directory, () => now);
	t.after(() => repository.close());
	await repository.recordJobClothProcessed(
		[{ title: "Security Engineer", company: "Example Corp" }],
		now - DAY_MS,
	);
	await fs.writeFile(input, JSON.stringify([canonicalIndeedJob("suppressed")]));

	const { result, output: consoleOutput } = await captureConsole(() =>
		processAcquiredJobs({
			inputFiles: [input],
			outputFile: output,
			coolOffLogDirectory: logDirectory,
			jobRepository: repository,
		}),
	);
	assert.equal(result.jobDbCoolOffSkippedEntries, 1);
	assert.equal(result.coolOffLogFile, undefined);
	await assert.rejects(fs.access(logDirectory));
	assert.doesNotMatch(consoleOutput, /cool-off suppression record/);
});

test("processData writes empty, unique cool-off reports when enabled", async (t) => {
	const directory = await createFixtureDirectory(t);
	const input = path.join(directory, "acquired_jobs_empty.json");
	const logDirectory = path.join(directory, "logs");
	await fs.writeFile(input, "[]");

	const first = await processAcquiredJobs({
		inputFiles: [input],
		outputFile: path.join(directory, "processed_jobs_first.json"),
		logCoolOffs: true,
		coolOffLogDirectory: logDirectory,
	});
	const second = await processAcquiredJobs({
		inputFiles: [input],
		outputFile: path.join(directory, "processed_jobs_second.json"),
		logCoolOffs: true,
		coolOffLogDirectory: logDirectory,
	});

	assert.ok(first.coolOffLogFile);
	assert.ok(second.coolOffLogFile);
	assert.notEqual(first.coolOffLogFile, second.coolOffLogFile);
	for (const file of [first.coolOffLogFile, second.coolOffLogFile]) {
		const report = JSON.parse(await fs.readFile(file, "utf8"));
		assert.equal(report.coolOffDays, 30);
		assert.equal(report.count, 0);
		assert.deepEqual(report.jobs, []);
		assert.ok(!Number.isNaN(Date.parse(report.generatedAt)));
	}
	assert.equal((await fs.readdir(logDirectory)).length, 2);
});

test("processData fails when an enabled cool-off report cannot be written", async (t) => {
	const directory = await createFixtureDirectory(t);
	const input = path.join(directory, "acquired_jobs_empty.json");
	const invalidLogDirectory = path.join(directory, "not-a-directory");
	await fs.writeFile(input, "[]");
	await fs.writeFile(invalidLogDirectory, "file");

	await assert.rejects(
		processAcquiredJobs({
			inputFiles: [input],
			outputFile: path.join(directory, "processed_jobs.json"),
			logCoolOffs: true,
			coolOffLogDirectory: invalidLogDirectory,
		}),
	);
});

test("run-pipeline help exposes --log-cool-offs", async (t) => {
	const directory = await createFixtureDirectory(t);
	const { stdout, stderr } = await execFileAsync(
		process.execPath,
		[
			path.join(__dirname, "../dist/index.js"),
			"run-pipeline",
			"--help",
			"--no-banner",
			"--no-color",
		],
		{
			env: {
				...process.env,
				ASTROEX_DATA_DIR: path.join(directory, "data"),
				ASTROEX_LOG_DIR: path.join(directory, "logs"),
				ASTROEX_MATERIALS_DIR: path.join(directory, "materials"),
				ASTROEX_PROFILE_DIR: path.join(directory, "profile"),
			},
		},
	);
	assert.equal(stderr, "");
	assert.match(stdout, /--log-cool-offs/);
	assert.match(stdout, /cool-off\s+window/);
});

test("processData validates programmatic jobCloth cool-off values", async (t) => {
	const directory = await createFixtureDirectory(t);
	const output = path.join(directory, "processed_jobs.json");
	for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		await assert.rejects(
			processAcquiredJobs({
				inputFiles: [],
				outputFile: output,
				jobClothCoolOffDays: value,
			}),
			/positive safe integer/,
		);
	}
});

test("processData accepts Indeed artifacts and excludes retired-source records", async (t) => {
	const directory = await createFixtureDirectory(t);
	const input = path.join(directory, "acquired_jobs_fixture.json");
	const output = path.join(directory, "processed_jobs.json");
	await fs.writeFile(
		input,
		JSON.stringify([
			canonicalIndeedJob("canonical"),
			canonicalIndeedJob("duplicate", { title: "Security Engineer" }),
			{
				id: "legacy-indeed",
				title: "Platform Engineer",
				company: "Example Corp",
				url: "https://www.indeed.com/viewjob?jk=legacy-indeed",
			},
			{
				id: "retired-source",
				title: "Retired Job",
				company: "Example Corp",
				url: "https://www.monster.com/jobs/view/retired-source",
			},
		]),
	);

	const { result, output: consoleOutput } = await captureConsole(() =>
		processAcquiredJobs({
			inputDirectory: directory,
			outputFile: output,
			companyFilters: [],
			titleFilters: [],
		}),
	);
	const jobs = JSON.parse(await fs.readFile(output, "utf8"));
	assert.equal(result.filesProcessed, 1);
	assert.equal(result.outputRecordCount, 2);
	assert.equal(result.duplicatesRemoved, 1);
	assert.equal(result.retiredOrInvalidEntries, 1);
	assert.deepEqual(
		jobs.map((job) => job.id),
		["canonical", "legacy-indeed"],
	);
	assert.equal(
		jobs.every((job) => job.source === "indeed"),
		true,
	);
	const manifest = JSON.parse(
		await fs.readFile(`${output}.manifest.json`, "utf8"),
	);
	assert.equal(manifest.schemaVersion, 1);
	assert.equal(manifest.command, "processData");
	assert.equal(manifest.result.outputRecordCount, 2);
	assert.match(
		consoleOutput,
		/Stage 2\/8: ProcessData progress for acquired_jobs_fixture\.json initialized — tracking 4 planned records\./,
	);
	assert.match(consoleOutput, /record 4\/4 complete \(100%\)/);
	assert.equal(
		manifest.sha256,
		crypto
			.createHash("sha256")
			.update(await fs.readFile(output))
			.digest("hex"),
	);
});

test("processData preserves an existing output when setup fails", async (t) => {
	const directory = await createFixtureDirectory(t);
	const output = path.join(directory, "processed_jobs.json");
	await fs.writeFile(output, '[{"id":"existing"}]');
	await assert.rejects(
		processAcquiredJobs({
			inputDirectory: path.join(directory, "missing"),
			outputFile: output,
		}),
	);
	assert.equal(await fs.readFile(output, "utf8"), '[{"id":"existing"}]');
});

test("processData accepts LinkedIn artifacts and normalizes them correctly", async (t) => {
	const directory = await createFixtureDirectory(t);
	const input = path.join(directory, "acquired_jobs_linkedin.json");
	const output = path.join(directory, "processed_jobs.json");
	await fs.writeFile(
		input,
		JSON.stringify([
			{
				id: "linkedin:4123456789",
				source: "linkedin",
				sourceJobId: "4123456789",
				canonicalUrl: "https://www.linkedin.com/jobs/view/4123456789",
				title: "Cloud Architect",
				company: "CloudWorks",
				location: "Austin, TX",
				descriptionRepresentation: "unknown",
				acquiredAt: "2026-09-07T00:00:00.000Z",
				isRemote: true,
			},
		]),
	);

	const result = await processAcquiredJobs({
		inputDirectory: directory,
		outputFile: output,
		companyFilters: [],
		titleFilters: [],
	});

	assert.equal(result.filesProcessed, 1);
	assert.equal(result.outputRecordCount, 1);
	const jobs = JSON.parse(await fs.readFile(output, "utf8"));
	assert.equal(jobs[0].source, "linkedin");
	assert.equal(jobs[0].id, "linkedin:4123456789");
	assert.equal(jobs[0].remoteOk, true);
});

test("processData performs cross-provider deduplication preserving Indeed description over LinkedIn", async (t) => {
	const directory = await createFixtureDirectory(t);
	const input1 = path.join(directory, "acquired_jobs_01_linkedin.json");
	const input2 = path.join(directory, "acquired_jobs_02_indeed.json");
	const output = path.join(directory, "processed_jobs.json");

	// Input 1 has LinkedIn job with NO description
	await fs.writeFile(
		input1,
		JSON.stringify([
			{
				id: "linkedin:111",
				source: "linkedin",
				sourceJobId: "111",
				canonicalUrl: "https://www.linkedin.com/jobs/view/111",
				title: "Site Reliability Engineer",
				company: "Acme Corp",
				location: "Remote",
				descriptionRepresentation: "unknown",
				acquiredAt: "2026-09-07T00:00:00.000Z",
				isRemote: true,
			},
		]),
	);

	// Input 2 has Indeed job for SAME title and company with FULL description
	await fs.writeFile(
		input2,
		JSON.stringify([
			canonicalIndeedJob("indeed:222", {
				title: "Site Reliability Engineer",
				company: "Acme Corp",
				description: "Full Indeed Markdown Description with requirements",
			}),
		]),
	);

	const result = await processAcquiredJobs({
		inputDirectory: directory,
		outputFile: output,
		companyFilters: [],
		titleFilters: [],
	});

	assert.equal(result.filesProcessed, 2);
	assert.equal(result.outputRecordCount, 1);
	assert.equal(result.duplicatesRemoved, 1);
	const jobs = JSON.parse(await fs.readFile(output, "utf8"));
	assert.equal(jobs.length, 1);
	// Indeed description is preserved!
	assert.equal(
		jobs[0].descriptionText,
		"Full Indeed Markdown Description with requirements",
	);
	assert.equal(jobs[0].source, "indeed");
});

test("processData processes explicit inputFiles list containing both indeed and linkedin artifacts", async (t) => {
	const directory = await createFixtureDirectory(t);
	const indeedFile = path.join(directory, "custom_indeed.json");
	const linkedinFile = path.join(directory, "custom_linkedin.json");
	const output = path.join(directory, "processed_jobs.json");

	await fs.writeFile(
		indeedFile,
		JSON.stringify([canonicalIndeedJob("canonical-indeed")]),
	);
	await fs.writeFile(
		linkedinFile,
		JSON.stringify([
			{
				id: "linkedin:li-999",
				source: "linkedin",
				sourceJobId: "li-999",
				canonicalUrl: "https://www.linkedin.com/jobs/view/li-999",
				title: "Cloud Security Architect",
				company: "Cloud Security Co",
				location: "Remote",
				descriptionRepresentation: "unknown",
				acquiredAt: "2026-09-07T00:00:00.000Z",
				isRemote: true,
			},
		]),
	);

	const result = await processAcquiredJobs({
		inputFiles: [indeedFile, linkedinFile],
		outputFile: output,
	});

	assert.equal(result.filesProcessed, 2);
	assert.equal(result.outputRecordCount, 2);
	const jobs = JSON.parse(await fs.readFile(output, "utf8"));
	assert.equal(jobs.length, 2);
	const sources = jobs.map((j) => j.source).sort();
	assert.deepEqual(sources, ["indeed", "linkedin"]);
});
