const assert = require("node:assert/strict");
const test = require("node:test");
const { version: packageVersion } = require("../package.json");

const {
	createStatisticsCollector,
} = require("../dist/statistics/StatisticsCollector");

test("completed statistics retain standard and custom metrics", async () => {
	const stats = createStatisticsCollector("statistics-test");
	stats.startCollection();

	const timer = stats.startTimer("work.item");
	await new Promise((resolve) => setTimeout(resolve, 5));
	stats.endTimer(timer);

	stats.incrementCounter("files.read", 2);
	stats.incrementCounter("data.recordsProcessed", 7);
	stats.incrementCounter("jobs.successful", 3);
	stats.setGauge("queue.depth", 4);
	stats.recordHistogram("jobs.perBatch", 2);
	stats.recordHistogram("jobs.perBatch", 6);
	stats.recordSuccess("test.complete");

	const summary = stats.endCollection();

	assert.equal(summary.metadata.version, packageVersion);
	assert.equal(summary.resources.files.read, 2);
	assert.equal(summary.data.recordsProcessed, 7);
	assert.equal(summary.operations.total, 1);
	assert.equal(summary.operations.successful, 1);
	assert.equal(summary.operations.successRate, 100);
	assert.equal(summary.metrics.counters["jobs.successful"], 3);
	assert.equal(summary.metrics.gauges["queue.depth"], 4);
	assert.deepEqual(summary.metrics.histograms["jobs.perBatch"], {
		count: 2,
		total: 8,
		minimum: 2,
		maximum: 6,
		average: 4,
	});
	assert.ok(summary.performance.operationTimes["work.item"] > 0);
	assert.ok(summary.performance.cpuTime >= 0);

	const exported = JSON.parse(stats.export("json"));
	assert.equal(exported.resources.files.read, 2);
	assert.equal(exported.metrics.counters["jobs.successful"], 3);
	assert.match(stats.export("csv"), /Counter - jobs\.successful,3/);
	assert.match(
		stats.export("markdown"),
		/\| Counter \| jobs\.successful \| 3 \|/,
	);

	// Ending in both a success path and a finally block must be harmless and
	// must not erase the completed snapshot.
	assert.deepEqual(stats.endCollection(), summary);
});

test("endCollection closes outstanding timers and calculates API rates", async () => {
	const stats = createStatisticsCollector("statistics-auto-close-test");
	stats.startCollection();
	stats.startTimer("work.unfinished");
	stats.incrementCounter("api.totalCalls", 4);
	stats.incrementCounter("api.successfulCalls", 3);
	stats.incrementCounter("api.failedCalls", 1);
	stats.recordHistogram("api.responseTime", 10);
	stats.recordHistogram("api.responseTime", 30);
	stats.recordError(new Error("network timeout"));
	await new Promise((resolve) => setTimeout(resolve, 2));

	const summary = stats.endCollection();

	assert.ok(summary.performance.operationTimes["work.unfinished"] > 0);
	assert.equal(summary.api.errorRate, 25);
	assert.equal(summary.api.averageResponseTime, 20);
	assert.equal(summary.errors.byCategory.network, 1);
	assert.equal(summary.operations.failed, 1);
});

test("derived rates remain correct for cleanup errors recorded after completion", () => {
	const stats = createStatisticsCollector("statistics-cleanup-test");
	stats.startCollection();
	stats.recordSuccess("command.complete");
	stats.endCollection();

	stats.recordError(new Error("cleanup failed"));
	const summary = stats.endCollection();

	assert.equal(summary.operations.total, 2);
	assert.equal(summary.operations.successful, 1);
	assert.equal(summary.operations.failed, 1);
	assert.equal(summary.operations.successRate, 50);
});
