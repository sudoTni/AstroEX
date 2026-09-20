const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { toLegacyJob } = require("../dist/acquisition/normalize");
const { IndeedProvider } = require("../dist/acquisition/jobspyProvider");
const {
	getProviderCooldownMs,
	isJobRepositoryCapacityError,
	loadAcquisitionCheckpoint,
	runAcquireJobs,
	shouldDisableAcquisitionSource,
} = require("../dist/commands/acquireJobs");

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

test("canonical jobs retain provider identity through the legacy compatibility projection", () => {
	const job = {
		id: "indeed:abc123",
		source: "indeed",
		sourceJobId: "abc123",
		canonicalUrl: "https://www.indeed.com/viewjob?jk=abc123",
		title: "Security Engineer",
		company: "Example Corp",
		location: "Austin, TX, USA",
		description: "Job description",
		descriptionRepresentation: "markdown",
		acquiredAt: "2026-08-11T00:00:00.000Z",
	};
	const legacy = toLegacyJob(job);
	assert.equal(legacy.source, "indeed");
	assert.equal(legacy.sourceJobId, "abc123");
	assert.equal(legacy.url, job.canonicalUrl);
	assert.equal(legacy.descriptionText, "Job description");
});

test("unrecoverable provider rejections disable the source for the active run", () => {
	assert.equal(
		shouldDisableAcquisitionSource({
			source: "indeed",
			message: "Request failed with status code 403",
			retryable: false,
		}),
		true,
	);
	assert.equal(
		shouldDisableAcquisitionSource({
			source: "indeed",
			message: "network timeout",
			retryable: true,
		}),
		false,
	);
});

test("retryable provider failures use bounded exponential cooldowns", () => {
	assert.equal(
		getProviderCooldownMs(
			{
				source: "indeed",
				message: "Request failed with status code 429",
				retryable: true,
			},
			1,
		),
		60_000,
	);
	assert.equal(
		getProviderCooldownMs(
			{
				source: "indeed",
				message: "Request failed with status code 429",
				retryable: true,
			},
			4,
		),
		5 * 60_000,
	);
	assert.equal(
		getProviderCooldownMs(
			{ source: "indeed", message: "network timeout", retryable: true },
			3,
		),
		60_000,
	);
});

test("repository capacity errors are recognized as non-fatal acquisition bookkeeping failures", () => {
	assert.equal(
		isJobRepositoryCapacityError(
			new Error("Database size limit (10000) reached"),
		),
		true,
	);
	assert.equal(
		isJobRepositoryCapacityError(
			new Error(
				"Database size limit (3) reached; all retained entries are JD or judgment checkpoints",
			),
		),
		true,
	);
	assert.equal(
		isJobRepositoryCapacityError(new Error("database is unavailable")),
		false,
	);
});

test("acquisition checkpoint ignores retired or malformed records", async (t) => {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-checkpoint-"),
	);
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const checkpoint = path.join(directory, "acquired_jobs.json");
	await fs.writeFile(
		checkpoint,
		JSON.stringify([
			{
				id: "indeed:valid",
				source: "indeed",
				canonicalUrl: "https://www.indeed.com/viewjob?jk=valid",
				title: "Security Engineer",
				company: "Example Corp",
				descriptionRepresentation: "unknown",
				acquiredAt: "2026-09-07T00:00:00.000Z",
			},
			{
				id: "retired",
				source: "ziprecruiter",
				canonicalUrl: "https://www.ziprecruiter.com/jobs/view/retired",
				title: "Retired Job",
				company: "Example Corp",
				acquiredAt: "2026-09-07T00:00:00.000Z",
			},
			{ id: "incomplete" },
		]),
	);
	const jobs = await loadAcquisitionCheckpoint(checkpoint);
	assert.deepEqual(
		jobs.map((job) => job.id),
		["indeed:valid"],
	);
});

test("acquisition checkpoint loads both indeed and linkedin records", async (t) => {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-checkpoint-multi-"),
	);
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const checkpoint = path.join(directory, "acquired_jobs.json");
	await fs.writeFile(
		checkpoint,
		JSON.stringify([
			{
				id: "indeed:valid",
				source: "indeed",
				canonicalUrl: "https://www.indeed.com/viewjob?jk=valid",
				title: "Security Engineer",
				company: "Example Corp",
				descriptionRepresentation: "unknown",
				acquiredAt: "2026-09-07T00:00:00.000Z",
			},
			{
				id: "linkedin:4123456789",
				source: "linkedin",
				sourceJobId: "4123456789",
				canonicalUrl: "https://www.linkedin.com/jobs/view/4123456789",
				title: "Cloud Architect",
				company: "Cloud Corp",
				descriptionRepresentation: "unknown",
				acquiredAt: "2026-09-07T00:00:00.000Z",
			},
		]),
	);
	const jobs = await loadAcquisitionCheckpoint(checkpoint);
	assert.deepEqual(
		jobs.map((job) => job.id),
		["indeed:valid", "linkedin:4123456789"],
	);
});

test("runAcquireJobs reports every query completion for 1, 2, 3, and throttling-range query counts", async (t) => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-acq-progress-"),
	);
	t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

	const originalAcquire = IndeedProvider.prototype.acquire;
	let providerCalls = 0;
	IndeedProvider.prototype.acquire = async () => {
		providerCalls++;
		return { jobs: [], failures: [] };
	};
	t.after(() => {
		IndeedProvider.prototype.acquire = originalAcquire;
	});

	for (const queryCount of [1, 2, 3, 13]) {
		providerCalls = 0;
		const terms = Array.from(
			{ length: queryCount },
			(_, index) => `query-${index + 1}`,
		);
		const outputFile = path.join(tempDir, `progress-${queryCount}.json`);
		const { output } = await captureConsole(() =>
			runAcquireJobs({
				sites: "indeed",
				"search-terms": terms.join(","),
				"search-terms-file": path.join(tempDir, "unused.txt"),
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
				"output-file": outputFile,
				"use-jobdb": false,
			}),
		);

		assert.equal(providerCalls, queryCount);
		let previousPosition = -1;
		for (let completed = 1; completed <= queryCount; completed++) {
			const marker = `query ${completed}/${queryCount} complete (`;
			const position = output.indexOf(marker);
			assert.ok(position > previousPosition, `${marker} must appear in order`);
			assert.equal(
				output.split(marker).length - 1,
				1,
				`${marker} must appear exactly once`,
			);
			previousPosition = position;
		}
		assert.doesNotMatch(output, new RegExp(`query ${queryCount + 1}/`));
	}
});

test("runAcquireJobs suppresses only recently analyzed jobs and preserves the analysis clock", async (t) => {
	const { DatabaseSync } = require("node:sqlite");
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-acq-30day-test-"),
	);
	const originalDataDir = process.env.ASTROEX_DATA_DIR;
	process.env.ASTROEX_DATA_DIR = tempDir;

	t.after(async () => {
		if (originalDataDir === undefined) {
			Reflect.deleteProperty(process.env, "ASTROEX_DATA_DIR");
		} else {
			process.env.ASTROEX_DATA_DIR = originalDataDir;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	const termsFile = path.join(tempDir, "search_terms.txt");
	await fs.writeFile(termsFile, "engineer\n", "utf-8");

	const outputFile = path.join(tempDir, "acquired_jobs_indeed.json");
	const dbFile = path.join(tempDir, "jobDB.sqlite");

	const mockJob = {
		id: "indeed:acq-30day-1",
		source: "indeed",
		sourceJobId: "acq-30day-1",
		canonicalUrl: "https://www.indeed.com/viewjob?jk=acq-30day-1",
		title: "Security Engineer",
		company: "Acme Cyber",
		location: "Remote",
		description: "Security role description",
		descriptionRepresentation: "markdown",
		acquiredAt: new Date().toISOString(),
		isRemote: true,
	};

	const originalAcquire = IndeedProvider.prototype.acquire;
	t.after(() => {
		IndeedProvider.prototype.acquire = originalAcquire;
	});

	IndeedProvider.prototype.acquire = async () => ({
		jobs: [mockJob],
		failures: [],
	});
	const acquire = () =>
		runAcquireJobs({
			sites: "indeed",
			"search-terms": "engineer",
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
			"output-file": outputFile,
			"use-jobdb": true,
		});

	// --- 1. First Encounter: eligible and recorded ---
	const { result: result1, output: firstRunOutput } =
		await captureConsole(acquire);

	assert.equal(result1.jobs, 1, "First encounter must acquire 1 job");
	assert.match(
		firstRunOutput,
		/Stage 1\/8: AcquireJobs progress initialized — tracking 1 planned query\./,
	);
	assert.match(firstRunOutput, /query 1\/1 complete \(100%\)/);
	const written1 = JSON.parse(await fs.readFile(outputFile, "utf-8"));
	assert.equal(written1.length, 1);
	assert.equal(written1[0].id, "indeed:acq-30day-1");

	// Inspect SQLite record
	const db = new DatabaseSync(dbFile);
	const initialRow = db
		.prepare(
			"SELECT admit_time, last_processed, search_only FROM jobs WHERE identity_key = ?",
		)
		.get("id:indeed:acq-30day-1");
	assert.ok(initialRow, "Job must be recorded in jobDB.sqlite");
	const initialAdmitTime = Number(initialRow.admit_time);
	assert.ok(initialAdmitTime > 0, "admit_time must be positive timestamp");
	assert.equal(
		initialRow.last_processed,
		null,
		"Discovery alone must not start analysis suppression",
	);
	db.close();

	// --- 2. Discovery-only records remain eligible on a later run. ---
	await fs.unlink(outputFile);
	const result2 = await acquire();
	assert.equal(result2.jobs, 1, "Unanalyzed rediscovery must remain eligible");
	const written2 = JSON.parse(await fs.readFile(outputFile, "utf-8"));
	assert.equal(written2.length, 1);

	// Simulate a successful JobJudge analysis, then remove the artifact so only
	// repository suppression determines the next acquisition result.
	const db2 = new DatabaseSync(dbFile);
	const analysisTime = Date.now();
	db2
		.prepare(
			"UPDATE jobs SET last_processed = ?, search_only = 0 WHERE identity_key = ?",
		)
		.run(analysisTime, "id:indeed:acq-30day-1");
	await fs.unlink(outputFile);

	// --- 3. A recently analyzed job is excluded. ---
	const result3 = await acquire();
	assert.equal(result3.jobs, 0, "Recent analysis must suppress acquisition");
	assert.deepEqual(JSON.parse(await fs.readFile(outputFile, "utf-8")), []);
	const rowAfterSuppression = db2
		.prepare("SELECT last_processed FROM jobs WHERE identity_key = ?")
		.get("id:indeed:acq-30day-1");
	assert.equal(
		Number(rowAfterSuppression.last_processed),
		analysisTime,
		"Rediscovery during suppression must not refresh last_processed",
	);

	// --- 4. Age only the analysis timestamp past 30 days. ---
	const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;
	const expiredAnalysisTime = Date.now() - THIRTY_ONE_DAYS_MS;
	db2
		.prepare("UPDATE jobs SET last_processed = ? WHERE identity_key = ?")
		.run(expiredAnalysisTime, "id:indeed:acq-30day-1");
	db2.close();

	// --- 5. The job is eligible once the prior analysis is older than 30 days. ---
	const result4 = await acquire();
	assert.equal(result4.jobs, 1, "Expired analysis must be eligible again");
	const written4 = JSON.parse(await fs.readFile(outputFile, "utf-8"));
	assert.equal(written4.length, 1);
	assert.equal(written4[0].id, "indeed:acq-30day-1");
});
