const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
	closeFileLogging,
	getLogFilePath,
	initializeFileLogging,
	log,
} = require("../dist/utils");

test("file logging emits redacted JSONL records", async () => {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-logging-"),
	);
	const priorLevel = process.env.ASTROEX_LOG_LEVEL;
	const priorColor = process.env.ASTROEX_NO_COLOR;
	process.env.ASTROEX_LOG_LEVEL = "debug";
	process.env.ASTROEX_NO_COLOR = "1";
	try {
		initializeFileLogging(directory, "events.jsonl", "Test");
		const filePath = getLogFilePath();
		assert.equal(filePath, path.join(directory, "Test_events.jsonl"));
		log("LoggingTest", "Stored credentials safely", "info", {
			apiKey: "should-not-appear",
			nested: { authorization: "Bearer should-not-appear" },
			attempt: 2,
		});
		await closeFileLogging();
		const [line] = (await fs.readFile(filePath, "utf-8")).trim().split("\n");
		const event = JSON.parse(line);
		assert.deepEqual(event, {
			timestamp: event.timestamp,
			level: "info",
			component: "LoggingTest",
			message: "Stored credentials safely",
			context: {
				apiKey: "[redacted]",
				nested: { authorization: "[redacted]" },
				attempt: 2,
			},
		});
		assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);
	} finally {
		if (priorLevel === undefined) process.env.ASTROEX_LOG_LEVEL = undefined;
		else process.env.ASTROEX_LOG_LEVEL = priorLevel;
		if (priorColor === undefined) process.env.ASTROEX_NO_COLOR = undefined;
		else process.env.ASTROEX_NO_COLOR = priorColor;
		await closeFileLogging();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
