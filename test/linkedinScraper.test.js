const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");

const {
	jobTypeCode,
	isLinkedInRemote,
	extractJobIdFromUrl,
	parseSalaryInfo,
} = require("../dist/acquisition/jobspy/linkedinUtil");
const { acquireLinkedInJobs } = require("../dist/acquisition/jobspy/linkedin");
const { IndeedProvider } = require("../dist/acquisition/jobspyProvider");

test("linkedinUtil.jobTypeCode maps known job types to LinkedIn codes", () => {
	assert.equal(jobTypeCode("fulltime"), "F");
	assert.equal(jobTypeCode("full-time"), "F");
	assert.equal(jobTypeCode("parttime"), "P");
	assert.equal(jobTypeCode("contract"), "C");
	assert.equal(jobTypeCode("internship"), "I");
	assert.equal(jobTypeCode("temporary"), "T");
	assert.equal(jobTypeCode("unknown"), "");
	assert.equal(jobTypeCode(undefined), "");
});

test("linkedinUtil.isLinkedInRemote detects remote keywords across fields", () => {
	assert.equal(
		isLinkedInRemote("Software Engineer (Remote)", null, "New York, NY"),
		true,
	);
	assert.equal(
		isLinkedInRemote(
			"DevOps Engineer",
			"This is a 100% work from home role",
			"Austin, TX",
		),
		true,
	);
	assert.equal(isLinkedInRemote("Security Analyst", null, "Remote, US"), true);
	assert.equal(
		isLinkedInRemote("Platform Engineer", "wfh flexible", "Chicago, IL"),
		true,
	);
	assert.equal(
		isLinkedInRemote(
			"Onsite Database Admin",
			"Must be in office 5 days a week",
			"Boston, MA",
		),
		false,
	);
});

test("linkedinUtil.extractJobIdFromUrl parses various LinkedIn job URLs", () => {
	assert.equal(
		extractJobIdFromUrl(
			"https://www.linkedin.com/jobs/view/senior-engineer-4123456789",
		),
		"4123456789",
	);
	assert.equal(
		extractJobIdFromUrl("https://www.linkedin.com/jobs/view/4123456789/"),
		"4123456789",
	);
	assert.equal(
		extractJobIdFromUrl(
			"https://www.linkedin.com/jobs/search/?currentJobId=4123456789&keywords=devops",
		),
		"4123456789",
	);
	assert.equal(extractJobIdFromUrl("invalid-url"), undefined);
});

test("linkedinUtil.parseSalaryInfo extracts compensation amounts and intervals", () => {
	const annual = parseSalaryInfo("$120,000 - $160,000 / yr");
	assert.equal(annual?.minAmount, 120000);
	assert.equal(annual?.maxAmount, 160000);
	assert.equal(annual?.currency, "USD");
	assert.equal(annual?.interval, "yearly");

	const hourly = parseSalaryInfo("€45 - €65 / hr");
	assert.equal(hourly?.minAmount, 45);
	assert.equal(hourly?.maxAmount, 65);
	assert.equal(hourly?.currency, "EUR");
	assert.equal(hourly?.interval, "hourly");

	assert.equal(parseSalaryInfo(""), undefined);
});

test("acquireLinkedInJobs parses guest search cards into canonical jobs", async (t) => {
	const sampleHtml = `
		<div class="base-search-card">
			<a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/staff-security-engineer-4198765432?position=1"></a>
			<span class="sr-only">Staff Security Engineer</span>
			<h4 class="base-search-card__subtitle">
				<a href="https://www.linkedin.com/company/guard-corp?trk=public_jobs">Guard Corp</a>
			</h4>
			<span class="job-search-card__location">Remote, United States</span>
			<time class="job-search-card__listdate" datetime="2026-09-08">2 days ago</time>
			<span class="job-search-card__salary-info">$180,000 - $220,000 / yr</span>
		</div>
		<div class="base-search-card">
			<a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/onsite-analyst-4198765433"></a>
			<h3 class="base-search-card__title">Onsite Analyst</h3>
			<h4 class="base-search-card__subtitle">Local Bank</h4>
			<span class="job-search-card__location">Dallas, TX</span>
		</div>
	`;

	const server = http.createServer((req, res) => {
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(sampleHtml);
	});

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	t.after(() => server.close());

	// Override the endpoint temporarily via proxy-style or directly
	const axios = require("axios");
	const originalGet = axios.Axios.prototype.get;
	const searchParams = [];
	axios.Axios.prototype.get = async function (url, config) {
		if (typeof url === "string" && url.includes("seeMoreJobPostings/search")) {
			searchParams.push({ ...config.params });
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

	const progressReports = [];
	const jobs = await acquireLinkedInJobs({
		searchTerm: "security",
		resultsWanted: 10,
		isRemote: true,
		pageDelayMs: 0,
		onProgress: (p) => {
			progressReports.push(p);
		},
	});

	// Only the remote job should be retained when isRemote: true
	assert.equal(jobs.length, 1);
	assert.equal(jobs[0].id, "linkedin:4198765432");
	assert.equal(jobs[0].source, "linkedin");
	assert.equal(jobs[0].title, "Staff Security Engineer");
	assert.equal(jobs[0].company, "Guard Corp");
	assert.equal(
		jobs[0].companyUrl,
		"https://www.linkedin.com/company/guard-corp",
	);
	assert.equal(jobs[0].isRemote, true);
	assert.equal(jobs[0].compensation?.minAmount, 180000);
	assert.equal(jobs[0].compensation?.maxAmount, 220000);
	assert.equal(jobs[0].description, undefined); // Phase 1 does not fetch description
	assert.equal(jobs[0].descriptionRepresentation, "unknown");
	assert.equal(progressReports.length, 2);
	assert.equal(progressReports[0].page, 1);
	assert.equal(progressReports[0].fetched, 1);
	assert.equal(progressReports[1].page, 2);
	assert.equal(progressReports[1].fetched, 0);
	assert.equal(searchParams.length, 2);
	assert.ok(searchParams.every((params) => params.f_WT === 2));
	assert.equal(searchParams[0].start, 0);
	assert.equal(searchParams[1].start, 2);
});

test("acquireLinkedInJobs omits f_WT when remote search is disabled", async (t) => {
	const axios = require("axios");
	const originalGet = axios.Axios.prototype.get;
	let capturedParams;
	axios.Axios.prototype.get = async (_url, config) => {
		capturedParams = config.params;
		return { status: 200, data: "", headers: {} };
	};
	t.after(() => {
		axios.Axios.prototype.get = originalGet;
	});

	await acquireLinkedInJobs({
		searchTerm: "security",
		resultsWanted: 1,
		isRemote: false,
		pageDelayMs: 0,
	});

	assert.ok(capturedParams);
	assert.equal(Object.hasOwn(capturedParams, "f_WT"), false);
});

test("provider maps remoteOnly to LinkedIn f_WT=2", async (t) => {
	const axios = require("axios");
	const originalGet = axios.Axios.prototype.get;
	let capturedParams;
	axios.Axios.prototype.get = async (_url, config) => {
		capturedParams = config.params;
		return { status: 200, data: "", headers: {} };
	};
	t.after(() => {
		axios.Axios.prototype.get = originalGet;
	});

	const result = await new IndeedProvider().acquire({
		sources: ["linkedin"],
		searchTerm: "security",
		resultsWanted: 1,
		remoteOnly: true,
	});

	assert.deepEqual(result.failures, []);
	assert.equal(capturedParams.f_WT, 2);
});
