const assert = require("node:assert/strict");
const test = require("node:test");

const {
	buildIndeedFilters,
	isIndeedRemoteJob,
} = require("../dist/acquisition/jobspy/indeed");

test("Indeed keeps the fresh-posting filter when remote acquisition is enabled", () => {
	const filters = buildIndeedFilters({ hoursOld: 24, isRemote: true });
	assert.match(filters, /dateOnIndeed/);
	assert.match(filters, /24h/);
});

test("Indeed remote predicate retains remote records and rejects on-site records", () => {
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
			location: { formatted: { long: "Example City, NY" } },
		}),
		false,
	);
});
