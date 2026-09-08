const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { processAcquiredJobs } = require("../dist/commands/processData");

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
				url: "https://www.linkedin.com/jobs/view/retired-source",
			},
		]),
	);

	const result = await processAcquiredJobs({
		inputDirectory: directory,
		outputFile: output,
		companyFilters: [],
		titleFilters: [],
	});
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
