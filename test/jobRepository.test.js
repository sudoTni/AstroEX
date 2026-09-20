const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { JobRepository } = require("../dist/jobRepository");

async function createRepository(t, options = {}) {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-job-repository-"),
	);
	t.after(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});
	const repository = new JobRepository({
		dbFilePath: path.join(directory, "jobDB.sqlite"),
		legacyJsonPath: path.join(directory, "jobDB.json"),
		defaultExpirationMs: 30 * 24 * 60 * 60 * 1000,
		enableJobDB: true,
		...options,
	});
	await repository.initialize();
	await repository.load();
	return { directory, repository };
}

function indeedJob(id, overrides = {}) {
	return {
		id,
		source: "indeed",
		sourceJobId: id,
		title: "Security Engineer",
		company: "Example Corp",
		url: `https://www.indeed.com/viewjob?jk=${id}`,
		...overrides,
	};
}

test("imports only Indeed records from the retired JSON JobDB exactly once", async (t) => {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-job-repository-migration-"),
	);
	t.after(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});
	const legacyJsonPath = path.join(directory, "jobDB.json");
	await fs.writeFile(
		legacyJsonPath,
		JSON.stringify([
			{
				source: "indeed",
				sourceJobId: "indeed-1",
				title: "Platform Engineer",
				company: "Example Corp",
				admitTime: 1_700_000_000_000,
				lastProcessed: 1_700_000_001_000,
			},
			{
				source: "linkedin",
				sourceJobId: "retired-1",
				title: "Retired Source Job",
				company: "Example Corp",
				admitTime: 1_700_000_000_000,
			},
		]),
	);

	const configuration = {
		dbFilePath: path.join(directory, "jobDB.sqlite"),
		legacyJsonPath,
		defaultExpirationMs: 30 * 24 * 60 * 60 * 1000,
		enableJobDB: true,
	};
	const first = new JobRepository(configuration);
	await first.initialize();
	assert.equal(first.size(), 1);
	assert.equal(
		first.isJobMatched(indeedJob("indeed-1", { title: "Platform Engineer" })),
		false,
	);
	await first.close();

	const second = new JobRepository(configuration);
	await second.initialize();
	assert.equal(second.size(), 1);
	assert.equal((await fs.stat(legacyJsonPath)).isFile(), true);
	await second.close();
});

test("persists discovery, description, and judgment checkpoints across reopen", async (t) => {
	const { repository } = await createRepository(t);
	const job = indeedJob("lifecycle-1");
	assert.equal(await repository.addSearchedJobs([job, job]), 1);
	assert.equal(repository.isJobSeen(job), true);
	assert.equal(repository.isJobDescriptionScraped(job), false);
	assert.equal(repository.isJobMatched(job), false);

	await repository.markJobDescriptionScraped(job);
	assert.equal(repository.isJobDescriptionScraped(job), true);
	await repository.addJob(job);
	assert.equal(repository.isJobMatched(job), true);
	await repository.close();

	await repository.initialize();
	assert.equal(repository.size(), 1);
	assert.equal(repository.isJobMatched(job), true);
	await repository.close();
});

test("uses the Indeed URL job key when an explicit ID is unavailable", async (t) => {
	const { repository } = await createRepository(t);
	const first = indeedJob("", {
		id: undefined,
		sourceJobId: undefined,
		url: "https://www.indeed.com/viewjob?jk=canonical-1&utm_source=test",
	});
	const equivalent = {
		...first,
		url: "https://www.indeed.com/viewjob?jk=canonical-1",
	};
	assert.equal(await repository.addSearchedJobs([first]), 1);
	assert.equal(repository.isJobSeen(equivalent), true);
	await repository.close();
});

test("evicts discovery-only records but preserves completed checkpoints at capacity", async (t) => {
	const { repository } = await createRepository(t, { maxRecords: 3 });
	const described = indeedJob("described");
	const judged = indeedJob("judged");
	const disposable = indeedJob("disposable");
	const replacement = indeedJob("replacement");
	await repository.markJobDescriptionScraped(described);
	await repository.addJob(judged);
	assert.equal(await repository.addSearchedJobs([disposable]), 1);
	assert.equal(await repository.addSearchedJobs([replacement]), 1);
	assert.equal(repository.size(), 3);
	assert.equal(repository.isJobDescriptionScraped(described), true);
	assert.equal(repository.isJobMatched(judged), true);
	assert.equal(repository.isJobSeen(disposable), false);
	assert.equal(repository.isJobSeen(replacement), true);
	await repository.close();
});

test("disabled repositories are inert", async () => {
	const repository = new JobRepository({
		dbFilePath: path.join(os.tmpdir(), "unused-astroex-jobDB.sqlite"),
		defaultExpirationMs: 1,
		enableJobDB: false,
	});
	await repository.initialize();
	assert.equal(await repository.addSearchedJobs([indeedJob("disabled")]), 0);
	assert.equal(repository.size(), 0);
	assert.equal(repository.isJobSeen(indeedJob("disabled")), false);
});

test("default repository capacity supports high-volume job history", async (t) => {
	const { repository } = await createRepository(t);
	assert.equal(repository.getStats().capacity, 250_000);
	await repository.close();
});

test("reports the schema version and SQLite integrity", async (t) => {
	const { repository } = await createRepository(t);
	assert.deepEqual(repository.verifyIntegrity(), {
		schemaVersion: "3",
		integrity: "ok",
		details: "ok",
	});
	await repository.close();
});

test("jobCloth history matches normalized title and company within an exact cool-off window", async (t) => {
	const DAY_MS = 24 * 60 * 60 * 1000;
	const t0 = 10_000_000_000;
	let currentTime = t0;
	const { repository } = await createRepository(t, {
		now: () => currentTime,
	});
	const original = {
		title: "  Security   Engineer ",
		company: " Example   Corp ",
	};

	assert.equal(await repository.recordJobClothProcessed([original]), 1);
	const normalized = { title: "security engineer", company: "example corp" };
	const differentCompany = {
		title: "security engineer",
		company: "Other Corp",
	};
	const differentTitle = {
		title: "Security Analyst",
		company: "example corp",
	};

	currentTime = t0 + 30 * DAY_MS - 1;
	assert.equal(
		repository.getRecentJobClothProcessingKeys([normalized], 30 * DAY_MS).size,
		1,
	);
	assert.equal(
		repository.getRecentJobClothProcessingKeys(
			[differentCompany, differentTitle],
			30 * DAY_MS,
		).size,
		0,
	);

	currentTime = t0 + 30 * DAY_MS;
	assert.equal(
		repository.getRecentJobClothProcessingKeys([normalized], 30 * DAY_MS).size,
		0,
		"exactly at the boundary the job is eligible",
	);
	await repository.close();
});

test("jobCloth history retains the newest processing event and rejects malformed inputs", async (t) => {
	const DAY_MS = 24 * 60 * 60 * 1000;
	const t0 = 20_000_000_000;
	const currentTime = t0 + 40 * DAY_MS;
	const { repository } = await createRepository(t, {
		now: () => currentTime,
	});
	const job = { title: "Platform Engineer", company: "Acme" };

	await repository.recordJobClothProcessed([job], t0 + 20 * DAY_MS);
	await repository.recordJobClothProcessed([job], t0 + 10 * DAY_MS);
	assert.equal(
		repository.getRecentJobClothProcessingKeys([job], 30 * DAY_MS).size,
		1,
		"an older replay must not replace the newest processing time",
	);
	assert.equal(
		await repository.recordJobClothProcessed([
			{ title: "", company: "Acme" },
			{ title: "Platform Engineer", company: "   " },
		]),
		0,
	);
	await assert.rejects(
		repository.recordJobClothProcessed([job], Number.NaN),
		/non-negative integer/,
	);
	assert.throws(
		() => repository.getRecentJobClothProcessingKeys([job], 0),
		/positive integer/,
	);
	await repository.close();
});

test("30-day window is measured from the last successful analysis", async (t) => {
	const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
	let currentTime = 1_000_000_000;
	const clock = () => currentTime;

	const { repository } = await createRepository(t, { now: clock });
	const job = indeedJob("window-test-1");

	// 1. First encounter -> eligible for normal consideration
	assert.equal(
		repository.isJobSeen(job),
		false,
		"Job should not be seen before first encounter",
	);
	assert.equal(
		repository.isJobMatched(job),
		false,
		"Job should not be matched before first encounter",
	);
	assert.equal(
		await repository.addSearchedJobs([job]),
		1,
		"First encounter should be admitted",
	);
	assert.equal(
		repository.isJobSeen(job),
		true,
		"Job should be seen after discovery",
	);
	assert.equal(
		repository.isJobMatched(job),
		false,
		"Job should not be matched before judgment",
	);

	// Simulate job being evaluated by jobJudge
	currentTime += 3600 * 1000; // 1 hour later
	await repository.addJob(job);
	const firstAnalysisTime = currentTime;
	assert.equal(
		repository.isJobMatched(job),
		true,
		"Job should be matched after judgment",
	);

	// Verify admitTime is still the first encounter timestamp (1_000_000_000), NOT the judgment timestamp
	const entries = repository.getAllEntries();
	assert.equal(entries.length, 1);
	assert.equal(
		entries[0].admitTime,
		1_000_000_000,
		"admitTime must remain first encounter timestamp",
	);

	// 2. Duplicate shortly after first encounter (5 days) -> suppressed
	currentTime = 1_000_000_000 + 5 * 24 * 60 * 60 * 1000;
	assert.equal(
		repository.isJobSeen(job),
		true,
		"Duplicate after 5 days must be seen (suppressed)",
	);
	assert.equal(
		repository.isJobMatched(job),
		true,
		"Duplicate after 5 days must be matched (suppressed)",
	);
	assert.equal(
		await repository.addSearchedJobs([job]),
		0,
		"Duplicate after 5 days must not be re-admitted",
	);

	// 3. Duplicate just before 30 days (30 days - 1 ms) -> suppressed
	currentTime = 1_000_000_000 + THIRTY_DAYS_MS - 1;
	assert.equal(
		repository.isJobSeen(job),
		true,
		"Duplicate just before 30 days must be seen (suppressed)",
	);
	assert.equal(
		repository.isJobMatched(job),
		true,
		"Duplicate just before 30 days must be matched (suppressed)",
	);
	assert.equal(
		await repository.addSearchedJobs([job]),
		0,
		"Duplicate just before 30 days must not be re-admitted",
	);

	// The discovery clock reaching 30 days does not expire a later analysis.
	currentTime = 1_000_000_000 + THIRTY_DAYS_MS;
	assert.equal(
		repository.isJobSeen(job),
		false,
		"The independent discovery checkpoint expires after 30 days",
	);
	assert.equal(
		repository.isJobMatched(job),
		true,
		"Analysis remains active until 30 days after analysis",
	);

	// 4. Boundary behavior at exactly 30 days after analysis -> eligible again
	currentTime = firstAnalysisTime + THIRTY_DAYS_MS;
	assert.equal(
		repository.isJobMatched(job),
		false,
		"At exactly 30 days after analysis, job must become eligible",
	);

	// 5. Duplicate after 30 days (35 days) -> eligible again, starts new 30-day cycle
	currentTime = 1_000_000_000 + 35 * 24 * 60 * 60 * 1000;
	assert.equal(
		repository.isJobSeen(job),
		false,
		"After 35 days, job must be eligible",
	);
	assert.equal(
		repository.isJobMatched(job),
		false,
		"After 35 days, job must not be matched",
	);
	assert.equal(
		await repository.addSearchedJobs([job]),
		1,
		"Re-encounter after 35 days must be admitted",
	);

	// Rediscovery may refresh admission, but it must preserve analysis history.
	assert.equal(repository.isJobSeen(job), true, "Seen in new cycle");
	assert.equal(
		repository.isJobMatched(job),
		false,
		"Not matched in new cycle (stale evaluation cleared)",
	);
	const newEntries = repository.getAllEntries();
	assert.equal(newEntries.length, 1);
	assert.equal(
		newEntries[0].admitTime,
		currentTime,
		"New cycle must record new encounter admitTime",
	);
	assert.equal(
		newEntries[0].lastProcessed,
		firstAnalysisTime,
		"Rediscovery must preserve the previous lastProcessed",
	);

	await repository.close();
});

test("duplicate encounters do not reset or extend the analysis window", async (t) => {
	const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
	const t0 = 2_000_000_000;
	let currentTime = t0;
	const clock = () => currentTime;

	const { repository } = await createRepository(t, { now: clock });
	const job = indeedJob("no-extension-test");

	// Initial discovery at T0
	assert.equal(await repository.addSearchedJobs([job]), 1);

	// Evaluation at T0 + 2 days
	currentTime = t0 + 2 * 24 * 60 * 60 * 1000;
	await repository.addJob(job);
	const firstAnalysisTime = currentTime;

	// Duplicate encounter at T0 + 10 days
	currentTime = t0 + 10 * 24 * 60 * 60 * 1000;
	assert.equal(await repository.addSearchedJobs([job]), 0);

	// Duplicate encounter at T0 + 20 days
	currentTime = t0 + 20 * 24 * 60 * 60 * 1000;
	assert.equal(await repository.addSearchedJobs([job]), 0);

	// Duplicate encounter at T0 + 29 days
	currentTime = t0 + 29 * 24 * 60 * 60 * 1000;
	assert.equal(await repository.addSearchedJobs([job]), 0);

	// Verify admitTime remained T0 through all duplicate encounters
	const entries = repository.getAllEntries();
	assert.equal(
		entries[0].admitTime,
		t0,
		"admitTime must NOT have been moved forward by duplicates",
	);
	assert.equal(
		entries[0].lastProcessed,
		firstAnalysisTime,
		"Rediscovery must not refresh lastProcessed",
	);

	// The window expires 30 days after analysis, despite later rediscoveries.
	currentTime = firstAnalysisTime + THIRTY_DAYS_MS;
	assert.equal(
		repository.isJobSeen(job),
		false,
		"Discovery checkpoint may expire independently",
	);
	assert.equal(
		repository.isJobMatched(job),
		false,
		"Must become eligible exactly 30 days after analysis",
	);

	await repository.close();
});

test("analysis eligibility handles 7 days, the final second, exact expiry, and successful re-analysis", async (t) => {
	const DAY_MS = 24 * 60 * 60 * 1000;
	const THIRTY_DAYS_MS = 30 * DAY_MS;
	const firstAnalysisTime = 2_500_000_000;
	let currentTime = firstAnalysisTime;
	const { repository } = await createRepository(t, {
		now: () => currentTime,
	});
	const job = indeedJob("precise-analysis-window");

	await repository.addSearchedJobs([job]);
	await repository.addJob(job);

	currentTime = firstAnalysisTime + 7 * DAY_MS;
	assert.equal(repository.isJobMatched(job), true);
	await repository.markJobDescriptionScraped(job);
	assert.equal(
		repository.getAllEntries()[0].lastProcessed,
		firstAnalysisTime,
		"A description refresh must not extend analysis suppression",
	);

	currentTime = firstAnalysisTime + THIRTY_DAYS_MS - 1_000;
	assert.equal(repository.isJobMatched(job), true);

	currentTime = firstAnalysisTime + THIRTY_DAYS_MS;
	assert.equal(repository.isJobMatched(job), false);
	assert.equal(await repository.addSearchedJobs([job]), 1);
	assert.equal(
		repository.getAllEntries()[0].lastProcessed,
		firstAnalysisTime,
		"Rediscovery at expiry preserves the prior analysis time",
	);

	currentTime += 1;
	assert.equal(repository.isJobMatched(job), false);
	await repository.addJob(job);
	assert.equal(repository.getAllEntries()[0].lastProcessed, currentTime);
	assert.equal(repository.isJobMatched(job), true);

	await repository.close();
});

test("persistence and reload preserves the 30-day last-analysis invariant", async (t) => {
	const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
	const t0 = 3_000_000_000;
	let currentTime = t0;
	const clock = () => currentTime;

	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-persist-window-"),
	);
	t.after(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});

	const dbFilePath = path.join(directory, "jobDB.sqlite");
	const repoConfig = {
		dbFilePath,
		defaultExpirationMs: THIRTY_DAYS_MS,
		enableJobDB: true,
		now: clock,
	};

	// Session 1: Add job and evaluate
	const repo1 = new JobRepository(repoConfig);
	await repo1.initialize();
	const job = indeedJob("persist-test-job");
	assert.equal(await repo1.addSearchedJobs([job]), 1);

	// Move forward 1 day and evaluate
	currentTime = t0 + 1 * 24 * 60 * 60 * 1000;
	await repo1.addJob(job);
	assert.equal(repo1.isJobMatched(job), true);
	await repo1.close();

	// Session 2: Reload on Day 15
	currentTime = t0 + 15 * 24 * 60 * 60 * 1000;
	const repo2 = new JobRepository(repoConfig);
	await repo2.initialize();
	assert.equal(repo2.isJobSeen(job), true, "Must still be seen on Day 15");
	assert.equal(
		repo2.isJobMatched(job),
		true,
		"Must still be matched on Day 15",
	);
	assert.equal(
		await repo2.addSearchedJobs([job]),
		0,
		"Must not re-admit duplicate on Day 15",
	);
	await repo2.close();

	// Session 3: Reload on Day 31 (past 30 days from T0)
	currentTime = t0 + 31 * 24 * 60 * 60 * 1000;
	const repo3 = new JobRepository(repoConfig);
	await repo3.initialize();
	assert.equal(
		repo3.isJobSeen(job),
		false,
		"Must be eligible again on Day 31 after reload",
	);
	assert.equal(
		repo3.isJobMatched(job),
		false,
		"Must not be matched on Day 31 after reload",
	);
	assert.equal(
		await repo3.addSearchedJobs([job]),
		1,
		"Must be re-admitted for new cycle on Day 31",
	);
	await repo3.close();
});

test("cleanupExpired retains rows until all persisted checkpoints are at least 30 days old", async (t) => {
	const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
	const t0 = 4_000_000_000;
	let currentTime = t0;
	const clock = () => currentTime;

	const { repository } = await createRepository(t, { now: clock });
	const job = indeedJob("cleanup-test-job");
	assert.equal(await repository.addSearchedJobs([job]), 1);

	// Duplicate encounter at Day 25
	currentTime = t0 + 25 * 24 * 60 * 60 * 1000;
	await repository.addJob(job);

	// At Day 29: cleanup should not remove it
	currentTime = t0 + 29 * 24 * 60 * 60 * 1000;
	assert.equal(
		await repository.cleanupExpired(),
		0,
		"Must not clean up active entry on Day 29",
	);
	assert.equal(repository.size(), 1);

	// At Day 30, the discovery is old but the Day 25 analysis is still active.
	currentTime = t0 + THIRTY_DAYS_MS;
	assert.equal(repository.getStats().expiredEntries, 0);
	assert.equal(
		await repository.cleanupExpired(),
		0,
		"Must retain an active analysis checkpoint",
	);
	assert.equal(repository.size(), 1);

	// At exactly 30 days after the latest checkpoint, the row can be removed.
	currentTime = t0 + 55 * 24 * 60 * 60 * 1000;
	assert.equal(repository.getStats().expiredEntries, 1);
	assert.equal(await repository.cleanupExpired(), 1);
	assert.equal(repository.size(), 0);

	await repository.close();
});

test("persists and queries LinkedIn jobs in JobRepository", async (t) => {
	const { repository } = await createRepository(t);
	const liJob = {
		id: "linkedin:4123456789",
		source: "linkedin",
		sourceJobId: "4123456789",
		title: "Cybersecurity Analyst",
		company: "Acme Cyber",
		url: "https://www.linkedin.com/jobs/view/4123456789",
	};

	assert.equal(await repository.addSearchedJobs([liJob]), 1);
	assert.equal(repository.isJobSeen(liJob), true);
	assert.equal(repository.isJobDescriptionScraped(liJob), false);
	assert.equal(repository.isJobMatched(liJob), false);

	await repository.markJobDescriptionScraped(liJob);
	assert.equal(repository.isJobDescriptionScraped(liJob), true);

	await repository.addJob(liJob);
	assert.equal(repository.isJobMatched(liJob), true);

	const entries = repository.getAllEntries();
	assert.equal(entries.length, 1);
	assert.equal(entries[0].source, "linkedin");
	assert.equal(entries[0].sourceJobId, "4123456789");
	assert.equal(entries[0].title, "Cybersecurity Analyst");

	await repository.close();
});

test("migrates SQLite repository from schema version 1 to version 3 seamlessly", async (t) => {
	const { DatabaseSync } = require("node:sqlite");
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-job-repo-migration-v2-"),
	);
	t.after(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});
	const dbFilePath = path.join(directory, "jobDB.sqlite");

	// Step 1: Create a schema v1 database with strict indeed check
	const db = new DatabaseSync(dbFilePath);
	db.exec(`
		CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
		INSERT INTO metadata (key, value) VALUES ('schema_version', '1');
		CREATE TABLE jobs (
			identity_key TEXT PRIMARY KEY,
			source TEXT NOT NULL CHECK(source = 'indeed'),
			source_job_id TEXT,
			company TEXT NOT NULL,
			title TEXT NOT NULL,
			admit_time INTEGER NOT NULL,
			description_scraped_at INTEGER,
			last_processed INTEGER,
			search_only INTEGER NOT NULL DEFAULT 1 CHECK(search_only IN (0, 1))
		) STRICT;
		INSERT INTO jobs (identity_key, source, source_job_id, company, title, admit_time)
		VALUES ('id:indeed:existing-1', 'indeed', 'existing-1', 'Legacy Corp', 'SecOps', ${Date.now()});
	`);
	db.close();

	// Step 2: Initialize JobRepository on this v1 database
	const repository = new JobRepository({
		dbFilePath,
		defaultExpirationMs: 30 * 24 * 60 * 60 * 1000,
		enableJobDB: true,
	});
	await repository.initialize();

	// Step 3: Verify migration succeeded
	assert.equal(repository.verifyIntegrity().schemaVersion, "3");
	assert.equal(repository.size(), 1);

	// Existing indeed job must still exist and be seen
	const existingJob = {
		id: "indeed:existing-1",
		source: "indeed",
		sourceJobId: "existing-1",
		title: "SecOps",
		company: "Legacy Corp",
	};
	assert.equal(repository.isJobSeen(existingJob), true);

	// Step 4: Verify we can now insert LinkedIn jobs without CHECK constraint failure
	const liJob = {
		id: "linkedin:998877",
		source: "linkedin",
		sourceJobId: "998877",
		title: "Cloud Security Architect",
		company: "Cloud Systems",
		url: "https://www.linkedin.com/jobs/view/998877",
	};
	assert.equal(await repository.addSearchedJobs([liJob]), 1);
	assert.equal(repository.isJobSeen(liJob), true);
	assert.equal(repository.size(), 2);

	await repository.close();
});

test("migrates version 2 last_processed rows into normalized jobCloth history", async (t) => {
	const { DatabaseSync } = require("node:sqlite");
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-job-repo-migration-v3-"),
	);
	t.after(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});
	const dbFilePath = path.join(directory, "jobDB.sqlite");
	const processedAt = 30_000_000_000;
	const db = new DatabaseSync(dbFilePath);
	db.exec(`
		CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
		INSERT INTO metadata (key, value) VALUES ('schema_version', '2');
		CREATE TABLE jobs (
			identity_key TEXT PRIMARY KEY,
			source TEXT NOT NULL CHECK(source IN ('indeed', 'linkedin')),
			source_job_id TEXT,
			company TEXT NOT NULL,
			title TEXT NOT NULL,
			admit_time INTEGER NOT NULL,
			description_scraped_at INTEGER,
			last_processed INTEGER,
			search_only INTEGER NOT NULL DEFAULT 1 CHECK(search_only IN (0, 1))
		) STRICT;
		INSERT INTO jobs (
			identity_key, source, source_job_id, company, title, admit_time,
			last_processed, search_only
		) VALUES (
			'id:indeed:history-1', 'indeed', 'history-1', ' Example   Corp ',
			' Security Engineer ', ${processedAt - 1}, ${processedAt}, 0
		);
	`);
	db.close();

	const repository = new JobRepository({
		dbFilePath,
		defaultExpirationMs: 30 * 24 * 60 * 60 * 1000,
		enableJobDB: true,
		now: () => processedAt + 1,
	});
	await repository.initialize();
	assert.equal(repository.verifyIntegrity().schemaVersion, "3");
	assert.equal(
		repository.getRecentJobClothProcessingKeys(
			[{ title: "security engineer", company: "example corp" }],
			30 * 24 * 60 * 60 * 1000,
		).size,
		1,
	);
	await repository.close();
});
