const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { toLegacyJob } = require("../dist/acquisition/normalize");
const {
	getProviderCooldownMs,
	isJobRepositoryCapacityError,
	loadAcquisitionCheckpoint,
	shouldDisableAcquisitionSource,
} = require("../dist/commands/acquireJobs");

test("canonical jobs retain provider identity through the legacy compatibility projection", () => {
	const job = {
		id: "indeed:abc123",
		source: "indeed",
		sourceJobId: "abc123",
		canonicalUrl: "https://www.indeed.com/viewjob?jk=abc123",
		title: "Security Engineer",
		company: "Example Corp",
		location: "Example City, ST, USA",
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
				source: "linkedin",
				canonicalUrl: "https://www.linkedin.com/jobs/view/retired",
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
