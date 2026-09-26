const assert = require("node:assert/strict");
const test = require("node:test");
const axios = require("axios");

const {
	buildIndeedFilters,
	isIndeedRemoteJob,
} = require("../dist/acquisition/jobspy/indeed");
const { IndeedProvider } = require("../dist/acquisition/jobspyProvider");

test("Indeed filter builder implements the complete remote-only/hours-old matrix", () => {
	const neither = buildIndeedFilters({});
	assert.equal(neither, "");

	const hoursOnly = buildIndeedFilters({ hoursOld: 24 });
	assert.match(hoursOnly, /dateOnIndeed/);
	assert.match(hoursOnly, /24h/);
	assert.doesNotMatch(hoursOnly, /DSQF7/);

	const remoteOnly = buildIndeedFilters({
		isRemote: true,
		remoteOnly: true,
	});
	assert.match(remoteOnly, /keys: \["DSQF7"\]/);
	assert.doesNotMatch(remoteOnly, /dateOnIndeed/);

	const hoursPrecedence = buildIndeedFilters({
		hoursOld: 24,
		isRemote: true,
		remoteOnly: true,
		easyApply: true,
		jobType: "fulltime",
	});
	assert.match(hoursPrecedence, /dateOnIndeed/);
	assert.doesNotMatch(hoursPrecedence, /DSQF7|DESKTOP|CF3CP/);
});

test("Indeed rejects ambiguous non-date filter combinations and non-positive hoursOld", () => {
	assert.throws(
		() => buildIndeedFilters({ remoteOnly: true, easyApply: true }),
		/cannot be combined/,
	);
	assert.throws(() => buildIndeedFilters({ hoursOld: 0 }), /greater than zero/);
});

test("Indeed sends the selected filter consistently across cursor pages", async (t) => {
	const requestBodies = [];
	const originalPost = axios.Axios.prototype.post;
	axios.Axios.prototype.post = async (_url, body) => {
		requestBodies.push(body.query);
		if (requestBodies.length === 1) {
			return {
				status: 200,
				data: {
					data: {
						jobSearch: {
							pageInfo: { nextCursor: "cursor-page-2" },
							results: [
								{
									job: {
										key: "remote-1",
										title: "Security Engineer",
										attributes: [{ key: "DSQF7", label: "Remote" }],
									},
								},
							],
						},
					},
				},
			};
		}
		return {
			status: 200,
			data: {
				data: {
					jobSearch: {
						pageInfo: { nextCursor: null },
						results: [],
					},
				},
			},
		};
	};
	t.after(() => {
		axios.Axios.prototype.post = originalPost;
	});

	const result = await new IndeedProvider().acquire({
		sources: ["indeed"],
		searchTerm: "security",
		resultsWanted: 2,
		remoteOnly: true,
	});

	assert.equal(requestBodies.length, 2);
	assert.ok(requestBodies.every((query) => query.includes('keys: ["DSQF7"]')));
	assert.ok(requestBodies.every((query) => !query.includes("dateOnIndeed")));
	assert.match(requestBodies[1], /cursor: "cursor-page-2"/);
	assert.deepEqual(result.failures, []);
	assert.equal(result.jobs.length, 1);
	assert.equal(result.jobs[0].isRemote, true);
});

test("Indeed request construction gives hoursOld precedence over remote-only", async (t) => {
	const requestBodies = [];
	const originalPost = axios.Axios.prototype.post;
	axios.Axios.prototype.post = async (_url, body) => {
		requestBodies.push(body.query);
		return {
			status: 200,
			data: {
				data: {
					jobSearch: {
						pageInfo: { nextCursor: null },
						results: [],
					},
				},
			},
		};
	};
	t.after(() => {
		axios.Axios.prototype.post = originalPost;
	});

	const result = await new IndeedProvider().acquire({
		sources: ["indeed"],
		searchTerm: "security",
		resultsWanted: 2,
		remoteOnly: true,
		hoursOld: 24,
		jobType: "fulltime",
		easyApply: true,
	});

	assert.equal(requestBodies.length, 1);
	assert.match(requestBodies[0], /dateOnIndeed/);
	assert.match(requestBodies[0], /start: "24h"/);
	assert.doesNotMatch(requestBodies[0], /DSQF7|DESKTOP|CF3CP/);
	assert.deepEqual(result.failures, []);
});

test("Indeed remote predicate retains remote records and rejects on-site records", () => {
	assert.equal(
		isIndeedRemoteJob({
			title: "Security Engineer",
			attributes: [{ key: "DSQF7", label: "" }],
		}),
		true,
	);
	assert.equal(
		isIndeedRemoteJob({
			title: "Security Engineer",
			attributes: [{ key: "DSQF7", label: "Remote" }],
		}),
		true,
	);
	assert.equal(
		isIndeedRemoteJob({
			title: "Security Engineer",
			location: { formatted: { long: "Austin, TX" } },
		}),
		false,
	);
});
