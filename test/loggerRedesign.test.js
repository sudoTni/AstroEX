const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
	LogLevel,
	LoggingManager,
	createLogger,
	defaultLoggingManager,
	formatDuration,
	formatJson,
	formatTerminal,
	isLogLevelEnabled,
	normalizeLogLevel,
	sanitizeContext,
	sanitizeError,
	sanitizeString,
} = require("../dist/logging");

test("LogLevel normalization and severity checks", () => {
	assert.equal(normalizeLogLevel("trace"), "trace");
	assert.equal(normalizeLogLevel("debug"), "debug");
	assert.equal(normalizeLogLevel("info"), "info");
	assert.equal(normalizeLogLevel("success"), "success");
	assert.equal(normalizeLogLevel("warn"), "warn");
	assert.equal(normalizeLogLevel("error"), "error");
	assert.equal(normalizeLogLevel("fatal"), "fatal");
	assert.equal(normalizeLogLevel("log"), "debug");
	assert.equal(normalizeLogLevel("UNKNOWN"), "info");

	assert.equal(isLogLevelEnabled("debug", "info"), false);
	assert.equal(isLogLevelEnabled("info", "info"), true);
	assert.equal(isLogLevelEnabled("success", "info"), true);
	assert.equal(isLogLevelEnabled("warn", "info"), true);
	assert.equal(isLogLevelEnabled("error", "warn"), true);
	assert.equal(isLogLevelEnabled("fatal", "error"), true);
	assert.equal(isLogLevelEnabled("trace", "debug"), false);
});

test("Sensitive data redaction for keys, tokens, and credentials", () => {
	// 1. Key-based redaction
	const inputContext = {
		apiKey: "secret-12345",
		nested: {
			authToken: "token-abc",
			password: "my-password",
			safeValue: "safe",
		},
		items: [{ token: "item-token" }, { normal: "value" }],
	};
	const sanitized = sanitizeContext(inputContext);
	assert.deepEqual(sanitized, {
		apiKey: "[redacted]",
		nested: {
			authToken: "[redacted]",
			password: "[redacted]",
			safeValue: "safe",
		},
		items: [{ token: "[redacted]" }, { normal: "value" }],
	});

	// 2. String-level secret redaction
	assert.equal(
		sanitizeString("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz"),
		"Bearer [redacted]",
	);
	assert.equal(
		sanitizeString(`Key is sk-${"1234567890abcdef".repeat(2)} in config`),
		"Key is sk-[redacted] in config",
	);
	assert.equal(
		sanitizeString(`OpenRouter key: sk-or-v1-${"0123456789abcdef".repeat(4)}`),
		"OpenRouter key: sk-or-v1-[redacted]",
	);
	assert.equal(
		sanitizeString(
			[
				"Connected to https://admin:",
				"superSecret123",
				"@proxy.example.com:8080/path",
			].join(""),
		),
		"Connected to https://admin:[redacted]@proxy.example.com:8080/path",
	);

	// 3. Circular reference protection
	const circular = { name: "test" };
	circular.self = circular;
	const sanitizedCircular = sanitizeContext(circular);
	assert.equal(sanitizedCircular.name, "test");
	assert.equal(sanitizedCircular.self, "[circular]");
});

test("Error sanitization preserves rich metadata and redacts secrets in messages", () => {
	const innerError = new Error(
		`Failed to connect with sk-${"1234567890abcdef".repeat(2)}`,
	);
	const error = new Error("Provider request failed: 401 Unauthorized", {
		cause: innerError,
	});
	error.code = "AUTH_FAILED";
	error.statusCode = 401;
	error.context = {
		provider: "openrouter",
		apiKey: ["sk-or-v1-", "0123456789abcdef".repeat(4)].join(""),
	};

	const sanitized = sanitizeError(error);
	assert.equal(sanitized.name, "Error");
	assert.equal(sanitized.message, "Provider request failed: 401 Unauthorized");
	assert.equal(sanitized.code, "AUTH_FAILED");
	assert.equal(sanitized.statusCode, 401);
	assert.equal(sanitized.context.apiKey, "[redacted]");
	assert.equal(sanitized.cause.message, "Failed to connect with sk-[redacted]");
});

test("Formatters produce accurate terminal and JSON representations", () => {
	const record = {
		timestamp: "2026-09-07T15:00:00.000Z",
		level: "info",
		component: "TestComponent",
		message: "Operation completed",
		context: { count: 42, durationMs: 1500 },
	};

	// Terminal formatting without color
	const terminalOutput = formatTerminal(record, false);
	assert.match(terminalOutput, /\[TestComponent\]/);
	assert.match(terminalOutput, /\[INFO \]/);
	assert.match(terminalOutput, /Operation completed/);
	assert.match(terminalOutput, /\(1s\)/);
	assert.match(terminalOutput, /count=42/);

	// JSON formatting
	const jsonOutput = formatJson(record);
	const parsed = JSON.parse(jsonOutput);
	assert.equal(parsed.component, "TestComponent");
	assert.equal(parsed.level, "info");
	assert.equal(parsed.message, "Operation completed");
	assert.deepEqual(parsed.context, { count: 42, durationMs: 1500 });
});

test("formatDuration formats various time units accurately", () => {
	assert.equal(formatDuration(0), "");
	assert.equal(formatDuration(500), "500ms");
	assert.equal(formatDuration(1500), "1s");
	assert.equal(formatDuration(65000), "1m 5s");
	assert.equal(formatDuration(125000), "2m 5s");
});

test("Scoped logger, timers, and child loggers work seamlessly", async () => {
	const records = [];
	const manager = new LoggingManager();
	manager.configure({
		minLevel: "trace",
		enableConsole: false,
		enableFile: false,
	});

	// Hook dispatch for testing
	const origDispatch = manager.dispatch.bind(manager);
	manager.dispatch = (record, opts) => {
		records.push(record);
		origDispatch(record, opts);
	};

	const logger = manager.createLogger("ServiceA", { serviceVersion: "1.0" });
	logger.info("Service initialized", { port: 8080 });

	const timer = logger.startTimer("Task execution");
	await new Promise((resolve) => setTimeout(resolve, 10));
	timer.done("Task completed", "success", { items: 5 });

	// Child logger
	const childLogger = logger.child("Worker", { workerId: "w-1" });
	childLogger.debug("Processing job", { jobId: "j-100" });

	assert.equal(records.length, 3);

	// Record 1: Info with merged default context
	assert.equal(records[0].component, "ServiceA");
	assert.equal(records[0].level, "info");
	assert.equal(records[0].context.serviceVersion, "1.0");
	assert.equal(records[0].context.port, 8080);

	// Record 2: Success with timer
	assert.equal(records[1].component, "ServiceA");
	assert.equal(records[1].level, "success");
	assert.equal(records[1].context.items, 5);
	assert.ok(records[1].context.durationMs >= 5);

	// Record 3: Child logger
	assert.equal(records[2].component, "ServiceA:Worker");
	assert.equal(records[2].level, "debug");
	assert.equal(records[2].context.serviceVersion, "1.0");
	assert.equal(records[2].context.workerId, "w-1");
	assert.equal(records[2].context.jobId, "j-100");
});

test("time and timeSync wrappers measure latency and log errors without swallowing", async () => {
	const records = [];
	const manager = new LoggingManager();
	manager.configure({
		minLevel: "trace",
		enableConsole: false,
		enableFile: false,
	});
	manager.dispatch = (record) => records.push(record);

	const logger = manager.createLogger("PerformanceTest");

	// Successful async time wrapper
	const result = await logger.time(
		"asyncOp",
		async () => {
			await new Promise((r) => setTimeout(r, 5));
			return "op-success";
		},
		{ extra: "data" },
	);

	assert.equal(result, "op-success");
	assert.equal(records[0].level, "debug");
	assert.match(records[0].message, /asyncOp succeeded/);
	assert.ok(records[0].context.durationMs >= 4);

	// Failing async time wrapper re-throws
	await assert.rejects(
		async () => {
			await logger.time("failingOp", async () => {
				throw new Error("Deliberate failure");
			});
		},
		{ message: "Deliberate failure" },
	);

	assert.equal(records[1].level, "error");
	assert.match(records[1].message, /failingOp failed/);
	assert.equal(records[1].context.error.message, "Deliberate failure");
});

test("Correlation context is propagated and isolated with withContext", () => {
	const records = [];
	const manager = new LoggingManager();
	manager.configure({
		minLevel: "trace",
		enableConsole: false,
		enableFile: false,
	});
	manager.dispatch = (record) => records.push(record);

	const logger = manager.createLogger("ContextTest");

	logger.info("Outside context");
	assert.equal(records[0].context, undefined);

	manager.withContext({ correlationId: "corr-123", tenantId: "acme" }, () => {
		logger.info("Inside context");
		assert.equal(records[1].context.correlationId, "corr-123");
		assert.equal(records[1].context.tenantId, "acme");
	});

	logger.info("After context reset");
	assert.equal(records[2].context, undefined);
});
