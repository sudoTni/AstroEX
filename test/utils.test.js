const assert = require("node:assert/strict");
const test = require("node:test");

const utils = require("../dist/utils");
const delayUtils = require("../dist/utils/delayUtils");

test("AppError carries code, statusCode, message, and context", () => {
	const err = new utils.AppError("TEST_CODE", 404, "Not found", {
		detail: "abc",
	});
	assert.equal(err.name, "AppError");
	assert.equal(err.code, "TEST_CODE");
	assert.equal(err.statusCode, 404);
	assert.equal(err.message, "Not found");
	assert.deepEqual(err.context, { detail: "abc" });
});

test("formatDate formats dates correctly", () => {
	const d = new Date("2026-03-15T10:30:45Z");
	const formatted = utils.formatDate(d);
	assert.match(formatted, /^\d{4}-\d{2}-\d{2}$/);

	const customFormatted = utils.formatDate(d, "yyyyMMdd_HHmmss");
	assert.match(customFormatted, /^\d{8}_\d{6}$/);
});

test("formatDuration formats intervals accurately", () => {
	assert.equal(utils.formatDuration(500), "500ms");
	assert.equal(utils.formatDuration(1500), "1s");
	assert.equal(utils.formatDuration(65000), "1m 5s");
	assert.equal(utils.formatDuration(3665000), "61m 5s");
	assert.equal(utils.formatDuration(0), "");
});

test("safeAsyncOperation returns result on success and null on failure", async () => {
	const successResult = await utils.safeAsyncOperation(
		async () => "ok",
		"test-prefix",
	);
	assert.equal(successResult, "ok");

	const failResult = await utils.safeAsyncOperation(async () => {
		throw new Error("expected test failure");
	}, "test-prefix");
	assert.equal(failResult, null);
});

test("utils.retryWithBackoff succeeds on retry or returns null when exhausted", async () => {
	let attempts = 0;
	const result = await utils.retryWithBackoff(
		async () => {
			attempts++;
			if (attempts < 2) throw new Error("transient");
			return "success";
		},
		3,
		5,
		"test-retry",
	);
	assert.equal(result, "success");
	assert.equal(attempts, 2);

	const exhausted = await utils.retryWithBackoff(
		async () => {
			throw new Error("permanent");
		},
		2,
		5,
		"test-retry-exhaust",
	);
	assert.equal(exhausted, null);
});

test("delayUtils.getRandomJitterDelay returns value within bounds and validates input", () => {
	const delay = delayUtils.getRandomJitterDelay(1, 2);
	assert.ok(
		delay >= 1000 && delay <= 2000,
		`Expected delay between 1000 and 2000 ms, got ${delay}`,
	);

	assert.throws(
		() => delayUtils.getRandomJitterDelay(-1, 2),
		/Delay values must be positive/,
	);
	assert.throws(
		() => delayUtils.getRandomJitterDelay(5, 2),
		/minDelay cannot be greater than maxDelay/,
	);
});

test("delayUtils.isRetryableError identifies HTTP status codes", () => {
	assert.equal(delayUtils.isRetryableError(500), true);
	assert.equal(delayUtils.isRetryableError(503), true);
	assert.equal(delayUtils.isRetryableError(429), true);
	assert.equal(delayUtils.isRetryableError(408), true);
	assert.equal(delayUtils.isRetryableError(200), false);
	assert.equal(delayUtils.isRetryableError(404), false);
});

test("delayUtils.isNetworkError identifies network-related errors", () => {
	assert.equal(delayUtils.isNetworkError(new Error("socket timeout")), true);
	assert.equal(
		delayUtils.isNetworkError(new Error("ECONNRESET: connection reset")),
		true,
	);
	assert.equal(delayUtils.isNetworkError(new Error("validation error")), false);
});

test("delayUtils.retryWithBackoff retries and propagates error on exhaustion", async () => {
	let attempts = 0;
	const result = await delayUtils.retryWithBackoff(
		async () => {
			attempts++;
			if (attempts < 2) throw new Error("retryable issue");
			return 42;
		},
		{ maxRetries: 2, baseDelay: 5, maxDelay: 50, jitter: false },
	);
	assert.equal(result, 42);
	assert.equal(attempts, 2);

	await assert.rejects(
		() =>
			delayUtils.retryWithBackoff(
				async () => {
					throw new Error("fatal error");
				},
				{ maxRetries: 1, baseDelay: 5, maxDelay: 50, jitter: false },
			),
		/fatal error/,
	);
});
