const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { toLegacyJob } = require("../dist/acquisition/normalize");
const {
	getProviderCooldownMs,
	isJobDbCapacityError,
	shouldDisableAcquisitionSource,
} = require("../dist/commands/acquireJobs");
const { JobDB } = require("../dist/jobDB");

test("canonical jobs retain provider identity through the legacy compatibility projection", () => {
	const job = {
		id: "indeed:abc123",
		source: "indeed",
		sourceJobId: "abc123",
		canonicalUrl: "https://www.indeed.com/viewjob?jk=abc123",
		title: "Security Engineer",
		company: "Example Corp",
		location: "Example City, NY, USA",
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

test("JobDB keeps source IDs separate", async () => {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-acquisition-"),
	);
	const db = new JobDB({
		dbFilePath: path.join(directory, "jobDB.json"),
		defaultExpirationMs: 60_000,
		enableJobDB: true,
		backupEnabled: false,
	});
	try {
		await db.initialize();
		await db.load();
		const added = await db.addSearchedJobs([
			{
				id: "linkedin:123",
				source: "linkedin",
				sourceJobId: "123",
				title: "Security Engineer",
				company: "Example Corp",
				url: "https://www.linkedin.com/jobs/view/123",
			},
			{
				id: "indeed:123",
				source: "indeed",
				sourceJobId: "123",
				title: "Security Engineer",
				company: "Example Corp",
				url: "https://www.indeed.com/viewjob?jk=123",
			},
		]);
		assert.equal(added, 2);
		assert.equal(db.size(), 2);
		assert.equal(
			db.isJobSeen({
				id: "linkedin:123",
				source: "linkedin",
				title: "Security Engineer",
				company: "Example Corp",
			}),
			true,
		);
		assert.equal(
			db.isJobSeen({
				id: "indeed:123",
				source: "indeed",
				title: "Security Engineer",
				company: "Example Corp",
			}),
			true,
		);
	} finally {
		await db.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
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
				source: "linkedin",
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
				source: "linkedin",
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

test("JobDB capacity errors are recognized as non-fatal acquisition bookkeeping failures", () => {
	assert.equal(
		isJobDbCapacityError(new Error("Database size limit (10000) reached")),
		true,
	);
	assert.equal(
		isJobDbCapacityError(
			new Error(
				"Database size limit (3) reached; all retained entries are JD or judgment checkpoints",
			),
		),
		true,
	);
	assert.equal(
		isJobDbCapacityError(new Error("database is unavailable")),
		false,
	);
});
