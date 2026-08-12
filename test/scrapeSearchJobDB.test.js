const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { JOB_DB_RETENTION_MS } = require("../dist/constants");
const { JobDB } = require("../dist/jobDB");
const {
	filterJobsNeedingDescriptions,
	filterLinkedInScrapeTargets,
	isLinkedInJobUrl,
} = require("../dist/commands/scrapeJobs");
const { getScrapedJobIdentity } = require("../dist/commands/scrapeJob");
const {
	buildLinkedInSearchUrl,
	filterUnseenSearchJobs,
	filterCompanySearchJobs,
} = require("../dist/commands/scrapeSearch");

function createSearchJob(id, overrides = {}) {
	return {
		id,
		title: "Security Engineer",
		company: "Example Corp",
		url: `https://www.linkedin.com/jobs/view/security-engineer-${id}?position=1`,
		...overrides,
	};
}

async function createJobDB(
	t,
	expirationMs = JOB_DB_RETENTION_MS,
	overrides = {},
) {
	const testRoot = await fs.promises.mkdtemp(
		path.join(os.tmpdir(), "astroex-search-jobdb-"),
	);
	const dbFilePath = path.join(testRoot, "jobDB.json");
	const jobDB = new JobDB({
		dbFilePath,
		defaultExpirationMs: expirationMs,
		enableJobDB: true,
		backupEnabled: false,
		...overrides,
	});
	await jobDB.initialize();
	await jobDB.load();
	t.after(async () => {
		await jobDB.close();
		await fs.promises.rm(testRoot, { recursive: true, force: true });
	});
	return { jobDB, dbFilePath };
}

test("scrape-search remembers a job without making jobJudge skip it", async (t) => {
	const { jobDB } = await createJobDB(t);
	const job = createSearchJob("4432878808");

	assert.equal(await jobDB.addSearchedJobs([job]), 1);
	assert.equal(jobDB.isJobSeen(job), true);
	assert.equal(jobDB.isJobMatched(job), false);
	assert.equal(jobDB.getAllEntries()[0].searchOnly, true);
});

test("search duplicates are ignored and judging promotes the existing entry", async (t) => {
	const { jobDB } = await createJobDB(t);
	const job = createSearchJob("4432878808");

	assert.equal(await jobDB.addSearchedJobs([job, job]), 1);
	assert.equal(await jobDB.addSearchedJobs([job]), 0);
	assert.equal(jobDB.size(), 1);

	await jobDB.addJob(job, job.id);

	assert.equal(jobDB.size(), 1);
	assert.equal(jobDB.isJobMatched(job), true);
	assert.equal(jobDB.getAllEntries()[0].searchOnly, undefined);
});

test("different LinkedIn IDs remain distinct even with the same company and title", async (t) => {
	const { jobDB } = await createJobDB(t);
	const firstJob = createSearchJob("4432878808");
	const secondJob = createSearchJob("4430628819");

	assert.equal(await jobDB.addSearchedJobs([firstJob, secondJob]), 2);
	assert.equal(jobDB.size(), 2);
});

test("a stable ID keeps JD and judge checkpoints distinct from same-label jobs", async (t) => {
	const { jobDB } = await createJobDB(t);
	const firstJob = createSearchJob("4432878808");
	const secondJob = createSearchJob("4430628819");

	await jobDB.markJobDescriptionScraped(firstJob, firstJob.id);
	await jobDB.addJob(firstJob, firstJob.id);

	assert.equal(jobDB.isJobDescriptionScraped(secondJob), false);
	assert.equal(jobDB.isJobMatched(secondJob), false);
	assert.equal(await jobDB.addSearchedJobs([secondJob]), 1);
});

test("a canonical provider URL is a deterministic fallback identity", async (t) => {
	const { jobDB } = await createJobDB(t);
	const original = {
		id: "",
		source: "indeed",
		title: "Security Engineer",
		company: "Example Corp",
		url: "https://www.indeed.com/viewjob?jk=abc123&utm_source=first",
	};
	const repeated = {
		...original,
		url: "https://www.indeed.com/viewjob?jk=abc123&utm_source=second",
	};

	assert.equal(await jobDB.addSearchedJobs([original]), 1);
	assert.equal(jobDB.isJobSeen(repeated), true);
	await jobDB.markJobDescriptionScraped(repeated);
	assert.equal(jobDB.isJobDescriptionScraped(original), true);
	await jobDB.addJob(original);
	assert.equal(jobDB.isJobMatched(repeated), true);
});

test("capacity evicts discovery-only records before any JD or judge checkpoint", async (t) => {
	const { jobDB } = await createJobDB(t, JOB_DB_RETENTION_MS, {
		maxDbSize: 3,
	});
	const described = createSearchJob("4432878808");
	const judged = createSearchJob("4430628819");
	const disposable = createSearchJob("4430900001");
	const replacement = createSearchJob("4430900002");

	await jobDB.markJobDescriptionScraped(described, described.id);
	await jobDB.addJob(judged, judged.id);
	assert.equal(await jobDB.addSearchedJobs([disposable]), 1);
	assert.equal(await jobDB.addSearchedJobs([replacement]), 1);

	assert.equal(jobDB.size(), 3);
	assert.equal(jobDB.isJobDescriptionScraped(described), true);
	assert.equal(jobDB.isJobMatched(judged), true);
	assert.equal(jobDB.isJobSeen(disposable), false);
	assert.equal(jobDB.isJobSeen(replacement), true);
	const stats = jobDB.getStats();
	assert.equal(stats.totalEntries, 3);
	assert.equal(stats.discoveryOnlyEntries, 1);
	assert.equal(stats.descriptionCheckpointEntries, 1);
	assert.equal(stats.judgedEntries, 1);
	assert.equal(stats.capacity, 3);
});

test("discovery capacity does not fail a workflow when every retained record is protected", async (t) => {
	const { jobDB } = await createJobDB(t, JOB_DB_RETENTION_MS, {
		maxDbSize: 2,
	});
	const described = createSearchJob("4432878808");
	const judged = createSearchJob("4430628819");
	const unrecordedDiscovery = createSearchJob("4430900001");

	await jobDB.markJobDescriptionScraped(described, described.id);
	await jobDB.addJob(judged, judged.id);

	assert.equal(await jobDB.addSearchedJobs([unrecordedDiscovery]), 0);
	assert.equal(jobDB.size(), 2);
	assert.equal(jobDB.isJobDescriptionScraped(described), true);
	assert.equal(jobDB.isJobMatched(judged), true);
});

test("jobJudge matches an already-judged LinkedIn ID even if its labels change", async (t) => {
	const { jobDB } = await createJobDB(t);
	const originalJob = createSearchJob("4432878808");
	await jobDB.addJob(originalJob, originalJob.id);

	const relabeledJob = createSearchJob("4432878808", {
		title: "Senior Security Engineer",
		company: "Example Corp, Inc.",
	});
	assert.equal(jobDB.isJobMatched(relabeledJob), true);
});

test("scrape-search filters prior and same-run duplicates before output", async (t) => {
	const { jobDB } = await createJobDB(t);
	const priorJob = createSearchJob("4432878808");
	const newJob = createSearchJob("4430628819");
	await jobDB.addSearchedJobs([priorJob]);

	const filtered = filterUnseenSearchJobs(
		[priorJob, newJob, { ...newJob }],
		new Set(),
		jobDB,
	);

	assert.deepEqual(
		filtered.map((job) => job.id),
		["4430628819"],
	);
});

test("scrape-search advances by the number of cards returned instead of skipping results", () => {
	const url = buildLinkedInSearchUrl(
		"Senior Cybersecurity Engineer",
		"Torrance, CA",
		10,
	);
	assert.match(url, /keywords=Senior%20Cybersecurity%20Engineer/);
	assert.match(url, /start=10/);
	assert.match(url, /location=Torrance%2C%20CA/);
});

test("expired search entries become eligible again", async (t) => {
	const expirationMs = 1000;
	const { jobDB, dbFilePath } = await createJobDB(t, expirationMs);
	const job = createSearchJob("4432878808");
	await jobDB.addSearchedJobs([job]);

	const entries = jobDB.getAllEntries();
	entries[0].admitTime = Date.now() - expirationMs - 1;
	await fs.promises.writeFile(dbFilePath, JSON.stringify(entries), "utf-8");
	await jobDB.load();

	assert.equal(await jobDB.cleanupExpired(), 1);
	assert.equal(jobDB.isJobSeen(job), false);
	assert.equal(await jobDB.addSearchedJobs([job]), 1);
});

test("a job advances from search to JD download to judge exactly once", async (t) => {
	const { jobDB } = await createJobDB(t);
	const job = createSearchJob("4432878808");

	// scrape-search emits and records a previously unseen LinkedIn post.
	assert.deepEqual(filterUnseenSearchJobs([job], new Set(), jobDB), [job]);
	assert.equal(await jobDB.addSearchedJobs([job]), 1);
	assert.deepEqual(filterUnseenSearchJobs([job], new Set(), jobDB), []);

	// A search checkpoint must still allow one detailed JD download.
	assert.equal(jobDB.isJobDescriptionScraped(job), false);
	assert.deepEqual(
		filterJobsNeedingDescriptions([job, { ...job }], new Set(), jobDB),
		[job],
	);
	await jobDB.markJobDescriptionScraped(job, job.id);
	assert.equal(jobDB.isJobDescriptionScraped(job), true);
	assert.deepEqual(filterJobsNeedingDescriptions([job], new Set(), jobDB), []);

	// Downloading a JD must not suppress its first judge evaluation.
	assert.equal(jobDB.isJobMatched(job), false);
	await jobDB.addJob(job, job.id);
	assert.equal(jobDB.isJobMatched(job), true);
	assert.equal(jobDB.size(), 1);
	assert.equal(jobDB.getAllEntries()[0].searchOnly, undefined);
});

test("scrape-jobs only sends LinkedIn positions to the page-description scraper", () => {
	const linkedin = createSearchJob("4432878808");
	const indeed = {
		id: "indeed:abc123",
		title: "Security Engineer",
		company: "Example Corp",
		url: "https://www.indeed.com/viewjob?jk=abc123",
	};

	assert.equal(isLinkedInJobUrl(linkedin.url), true);
	assert.equal(isLinkedInJobUrl(indeed.url), false);
	assert.deepEqual(filterLinkedInScrapeTargets([linkedin, indeed]), [linkedin]);
});

test("a direct JD scrape is checkpointed even without scrape-search", async (t) => {
	const { jobDB } = await createJobDB(t);
	const job = createSearchJob("4430628819");

	assert.equal(jobDB.isJobSeen(job), false);
	await jobDB.markJobDescriptionScraped(job, job.id);

	const [entry] = jobDB.getAllEntries();
	assert.equal(entry.linkedInJobId, job.id);
	assert.equal(entry.searchOnly, true);
	assert.equal(typeof entry.descriptionScrapedAt, "number");
	assert.equal(jobDB.isJobMatched(job), false);
});

test("a direct scraper can skip an existing JD using only its canonical URL", async (t) => {
	const { jobDB } = await createJobDB(t);
	const job = createSearchJob("4430628819");

	assert.equal(jobDB.isJobDescriptionUrlScraped(job.url), false);
	await jobDB.markJobDescriptionScraped(job, job.id);
	assert.equal(
		jobDB.isJobDescriptionUrlScraped(
			"https://www.linkedin.com/jobs/view/security-engineer-4430628819?trk=retry",
		),
		true,
	);
});

test("single-job scrape checkpoints only complete job metadata", () => {
	const url = "https://www.linkedin.com/jobs/view/security-engineer-4430628819";
	assert.deepEqual(
		getScrapedJobIdentity(
			{ url, title: "Security Engineer", company: "Example Corp" },
			url,
		),
		{
			id: "4430628819",
			title: "Security Engineer",
			company: "Example Corp",
			url,
		},
	);
	assert.equal(
		getScrapedJobIdentity({ url, title: "", company: "Example Corp" }, url),
		undefined,
	);
});

test("the JD checkpoint expires with the shared retention policy", async (t) => {
	const expirationMs = 1000;
	const { jobDB, dbFilePath } = await createJobDB(t, expirationMs);
	const job = createSearchJob("4430628819");
	await jobDB.markJobDescriptionScraped(job, job.id);

	const entries = jobDB.getAllEntries();
	entries[0].admitTime = Date.now() - expirationMs - 1;
	await fs.promises.writeFile(dbFilePath, JSON.stringify(entries), "utf-8");
	await jobDB.load();

	assert.equal(await jobDB.cleanupExpired(), 1);
	assert.equal(jobDB.isJobDescriptionScraped(job), false);
	assert.deepEqual(filterJobsNeedingDescriptions([job], new Set(), jobDB), [
		job,
	]);
});

test("scrape-search company filter retains matching companies and excludes others", () => {
	const googleJob = createSearchJob("1", { company: "Google LLC" });
	const metaJob = createSearchJob("2", { company: "Meta Platforms" });
	const amazonJob = createSearchJob("3", { company: "Amazon Web Services" });

	const jobs = [googleJob, metaJob, amazonJob];

	// Filter for Google only
	assert.deepEqual(filterCompanySearchJobs(jobs, ["Google"]), [googleJob]);

	// Filter case-insensitively and partial match for google and amazon
	assert.deepEqual(filterCompanySearchJobs(jobs, ["google", "amazon"]), [
		googleJob,
		amazonJob,
	]);

	// When no filter specified, returns all jobs
	assert.deepEqual(filterCompanySearchJobs(jobs, []), jobs);
	assert.deepEqual(filterCompanySearchJobs(jobs, undefined), jobs);
});
