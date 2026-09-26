const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const axios = require("axios");

const {
	fetchLinkedInJobDetails,
} = require("../dist/acquisition/jobspy/linkedinEnrichment");
const { runEnrichLinkedInJobs } = require("../dist/commands/enrichJobs");
const { JobRepository } = require("../dist/jobRepository");

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

async function createTempDir(t) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "astroex-enrich-test-"));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}

test("fetchLinkedInJobDetails parses description, directUrl, and job criteria", async (t) => {
	const sampleHtml = `
		<div class="show-more-less-html__markup">
			<h2>About the Role</h2>
			<p>We are seeking a senior security engineer to secure our cloud infrastructure.</p>
			<ul>
				<li>5+ years Kubernetes experience</li>
				<li>Terraform knowledge</li>
			</ul>
		</div>
		<code id="applyUrl"><!--https://careers.acme.com/apply?url=https%3A%2F%2Fboards.greenhouse.io%2Facme%2Fjobs%2F987654--></code>
		<ul>
			<li class="description__job-criteria-item">
				<h3 class="description__job-criteria-subheader">Seniority level</h3>
				<span class="description__job-criteria-text">Mid-Senior level</span>
			</li>
			<li class="description__job-criteria-item">
				<h3 class="description__job-criteria-subheader">Employment type</h3>
				<span class="description__job-criteria-text">Full-time</span>
			</li>
			<li class="description__job-criteria-item">
				<h3 class="description__job-criteria-subheader">Job function</h3>
				<span class="description__job-criteria-text">Engineering</span>
			</li>
			<li class="description__job-criteria-item">
				<h3 class="description__job-criteria-subheader">Industries</h3>
				<span class="description__job-criteria-text">Software Development</span>
			</li>
		</ul>
	`;

	const originalGet = axios.Axios.prototype.get;
	axios.Axios.prototype.get = async function (url, config) {
		if (typeof url === "string" && url.includes("/jobs/view/12345678")) {
			return {
				status: 200,
				data: sampleHtml,
				headers: {},
			};
		}
		return originalGet.call(this, url, config);
	};
	t.after(() => {
		axios.Axios.prototype.get = originalGet;
	});

	const details = await fetchLinkedInJobDetails({
		jobId: "12345678",
		descriptionFormat: "markdown",
	});

	assert.ok(details.description);
	assert.ok(details.description.includes("About the Role"));
	assert.ok(details.description.includes("Kubernetes"));
	assert.equal(
		details.directUrl,
		"https://boards.greenhouse.io/acme/jobs/987654",
	);
	assert.equal(details.jobLevel, "Mid-Senior level");
	assert.equal(details.jobType, "Full-time");
	assert.equal(details.jobFunction, "Engineering");
	assert.equal(details.companyIndustry, "Software Development");
});

test("fetchLinkedInJobDetails handles login/signup redirect safely", async (t) => {
	const originalGet = axios.Axios.prototype.get;
	axios.Axios.prototype.get = async (url, config) => ({
		status: 200,
		data: "<html>Login to LinkedIn</html>",
		headers: {},
		request: {
			res: {
				responseUrl: "https://www.linkedin.com/signup/cold-join",
			},
		},
	});
	t.after(() => {
		axios.Axios.prototype.get = originalGet;
	});

	const details = await fetchLinkedInJobDetails({
		jobId: "blocked-id",
	});

	assert.equal(details.description, undefined);
});

test("runEnrichLinkedInJobs enriches surviving LinkedIn jobs and leaves Indeed intact", async (t) => {
	const dir = await createTempDir(t);
	const inputFile = path.join(dir, "clothed_jobs.json");
	const outputFile = path.join(dir, "clothed_jobs_enriched.json");
	const dbFile = path.join(dir, "jobDB.sqlite");

	const repository = new JobRepository({
		dbFilePath: dbFile,
		enableJobDB: true,
	});
	await repository.initialize();
	await repository.load();
	t.after(() => repository.close());

	// Add search discovery for the LinkedIn job
	await repository.addSearchedJobs([
		{
			id: "linkedin:888999",
			source: "linkedin",
			sourceJobId: "888999",
			url: "https://www.linkedin.com/jobs/view/888999",
			title: "Security Architect",
			company: "CyberSec Ltd",
		},
	]);

	const inputJobs = [
		{
			id: "indeed:111",
			source: "indeed",
			sourceJobId: "111",
			url: "https://www.indeed.com/viewjob?jk=111",
			title: "Backend Engineer",
			company: "Indeed Corp",
			descriptionText:
				"Pre-existing Indeed description that should not be changed.",
		},
		{
			id: "linkedin:888999",
			source: "linkedin",
			sourceJobId: "888999",
			url: "https://www.linkedin.com/jobs/view/888999",
			title: "Security Architect",
			company: "CyberSec Ltd",
			// No descriptionText yet!
		},
	];

	await fs.writeFile(inputFile, JSON.stringify(inputJobs, null, 2), "utf8");

	const sampleDetailHtml = `
		<div class="show-more-less-html__markup">
			<p>Enriched description for Security Architect at CyberSec Ltd.</p>
		</div>
		<code id="applyUrl"><!--https://careers.cybersec.com/apply?url=https%3A%2F%2Flever.co%2Fcybersec%2F123--></code>
	`;

	const originalGet = axios.Axios.prototype.get;
	axios.Axios.prototype.get = async function (url, config) {
		if (typeof url === "string" && url.includes("/jobs/view/888999")) {
			return {
				status: 200,
				data: sampleDetailHtml,
				headers: {},
			};
		}
		return originalGet.call(this, url, config);
	};
	t.after(() => {
		axios.Axios.prototype.get = originalGet;
	});

	const { result, output: consoleOutput } = await captureConsole(() =>
		runEnrichLinkedInJobs({
			inputFile,
			outputFile,
			delayMs: 0,
			jobRepository: repository,
		}),
	);

	assert.equal(result.totalJobs, 2);
	assert.equal(result.enrichedCount, 1);
	assert.match(
		consoleOutput,
		/\[enrich\]\[linkedin\] 0\/1 Starting description enrichment/,
	);
	assert.match(consoleOutput, /\[enrich\]\[linkedin\] 1\/1 Enriched/);

	const enrichedData = JSON.parse(await fs.readFile(outputFile, "utf8"));
	assert.equal(enrichedData.length, 2);

	// Indeed job is untouched
	assert.equal(enrichedData[0].id, "indeed:111");
	assert.equal(
		enrichedData[0].descriptionText,
		"Pre-existing Indeed description that should not be changed.",
	);

	// LinkedIn job is enriched
	assert.equal(enrichedData[1].id, "linkedin:888999");
	assert.ok(
		enrichedData[1].descriptionText.includes(
			"Enriched description for Security Architect",
		),
	);
	assert.equal(enrichedData[1].directUrl, "https://lever.co/cybersec/123");

	// Manifest is created
	const manifest = JSON.parse(
		await fs.readFile(`${outputFile}.manifest.json`, "utf8"),
	);
	assert.equal(manifest.command, "enrichJobs");
	assert.equal(manifest.enrichedCount, 1);

	// Repository was updated with description scraped checkpoint
	const entry = repository.findEntry(enrichedData[1]);
	assert.notEqual(entry, undefined);
	assert.notEqual(entry.descriptionScrapedAt, null);
});

test("runEnrichLinkedInJobs waits exactly one second between consecutive scrapes by default", async (t) => {
	const dir = await createTempDir(t);
	const inputFile = path.join(dir, "clothed_jobs.json");
	const outputFile = path.join(dir, "clothed_jobs_enriched.json");
	const jobs = ["111111", "222222"].map((jobId, index) => ({
		id: `linkedin:${jobId}`,
		source: "linkedin",
		sourceJobId: jobId,
		url: `https://www.linkedin.com/jobs/view/${jobId}`,
		title: `Security Engineer ${index + 1}`,
		company: "CyberSec Ltd",
	}));
	await fs.writeFile(inputFile, JSON.stringify(jobs), "utf8");

	const originalGet = axios.Axios.prototype.get;
	axios.Axios.prototype.get = async () => ({
		status: 200,
		data: '<div class="show-more-less-html__markup"><p>Job description.</p></div>',
		headers: {},
	});
	t.after(() => {
		axios.Axios.prototype.get = originalGet;
	});

	const originalSetTimeout = global.setTimeout;
	const delays = [];
	global.setTimeout = (callback, delay) => {
		delays.push(delay);
		callback();
		return 0;
	};
	t.after(() => {
		global.setTimeout = originalSetTimeout;
	});

	const result = await runEnrichLinkedInJobs({ inputFile, outputFile });

	assert.equal(result.enrichedCount, 2);
	assert.deepEqual(delays, [1000]);
});
