const assert = require("node:assert/strict");
const test = require("node:test");

const {
	LOG_GRADIENTS,
	formatTerminal,
	hsvToRgb,
	rgbToAnsi,
	stripAnsi,
} = require("../dist/logging");

const RESET = "\x1b[0m";

function ansiFor(profile) {
	const [r, g, b] = hsvToRgb(
		LOG_GRADIENTS[profile].startHue,
		LOG_GRADIENTS[profile].saturation,
		LOG_GRADIENTS[profile].value,
	);
	return rgbToAnsi(r, g, b);
}

test("terminal formatter applies the semantic colour hierarchy without changing text", () => {
	const record = {
		timestamp: "2026-09-10T12:00:00.000Z",
		level: "info",
		component: "Pipeline",
		message: "Stage 2/7: Normalizing jobs",
		context: {
			inputFile: "/tmp/acquired_jobs_indeed.json",
			jobId: "indeed:123",
			recordsProcessed: 42,
			durationMs: 1500,
		},
	};

	const formatted = formatTerminal(record, true);
	const plain = stripAnsi(formatted);

	assert.match(plain, /Stage 2\/7: Normalizing jobs/);
	assert.match(plain, /inputFile=\/tmp\/acquired_jobs_indeed\.json/);
	assert.match(plain, /jobId=indeed:123/);
	assert.match(plain, /recordsProcessed=42/);
	assert.match(plain, /\(1s\)/);
	assert.match(
		formatted,
		new RegExp(ansiFor("section").replace(/[\\[\]]/g, "\\$&")),
	);
	assert.ok(formatted.includes(ansiFor("path")));
	assert.ok(formatted.includes(ansiFor("identifier")));
	assert.ok(formatted.includes(ansiFor("metric")));
	assert.ok(formatted.includes(ansiFor("duration")));
	assert.ok(formatted.endsWith(RESET));
});

test("warnings and errors remain stable single-hue states across multiline output", () => {
	for (const level of ["warn", "error", "fatal"]) {
		const formatted = formatTerminal(
			{
				timestamp: "2026-09-10T12:00:00.000Z",
				level,
				component: "Pipeline",
				message: "Operation needs attention\nSee diagnostics",
			},
			true,
		);
		assert.equal(
			stripAnsi(formatted).includes(
				"Operation needs attention\nSee diagnostics",
			),
			true,
		);
		assert.ok(formatted.includes(ansiFor(level)));
		assert.ok(formatted.endsWith(RESET));
	}
});

test("no-color output remains a plain, machine-safe representation", () => {
	const formatted = formatTerminal(
		{
			timestamp: "2026-09-10T12:00:00.000Z",
			level: "success",
			component: "Pipeline",
			message: "Completed",
			context: { outputFile: "/tmp/result.json", count: 1 },
		},
		false,
	);
	assert.equal(formatted.includes("\x1b["), false);
	assert.match(formatted, /outputFile=\/tmp\/result\.json count=1/);
});
