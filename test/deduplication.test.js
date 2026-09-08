const assert = require("node:assert/strict");
const test = require("node:test");

const {
	LoggingManager,
	clearOnceKeys,
	formatLLMResponse,
	logOnce,
} = require("../dist/logging");
const {
	clearPresetsCache,
	loadAndReplacePromptTemplate,
	loadPresets,
	loadVeritasSystemPrompt,
} = require("../dist/presets");
const { LLMService } = require("../dist/llmService");

test("logOnce and ScopedLogger infoOnce/debugOnce deduplicate identical keys", () => {
	clearOnceKeys();
	const manager = new LoggingManager();
	manager.configure({
		minLevel: "debug",
		enableConsole: false,
		enableFile: false,
	});

	const records = [];
	manager.dispatch = (record) => records.push(record);

	const logger = manager.createLogger("TestDedupe");

	// Test logger.infoOnce
	logger.infoOnce("first-key", "Message one");
	logger.infoOnce("first-key", "Message one again");
	logger.infoOnce("second-key", "Message two");

	assert.equal(records.length, 2);
	assert.equal(records[0].message, "Message one");
	assert.equal(records[1].message, "Message two");

	// Test logger.debugOnce
	logger.debugOnce("debug-key", "Debug message");
	logger.debugOnce("debug-key", "Debug message again");

	assert.equal(records.length, 3);
	assert.equal(records[2].message, "Debug message");
});

test("presets and templates are cached in memory across multiple calls", async () => {
	clearPresetsCache();

	// Load presets first time (cache miss)
	const presets1 = await loadPresets();
	assert.ok(presets1.jobCloth);

	// Load presets second time (cache hit)
	const presets2 = await loadPresets();
	assert.strictEqual(
		presets1,
		presets2,
		"Cached presets instance should be identical",
	);

	// Load Veritas system prompt twice
	const prompt1 = await loadVeritasSystemPrompt();
	const prompt2 = await loadVeritasSystemPrompt();
	assert.equal(typeof prompt1, "string");
	assert.strictEqual(
		prompt1,
		prompt2,
		"Cached prompt string should be identical",
	);

	// Load prompt template twice
	const res1 = await loadAndReplacePromptTemplate(
		"./prompts/jep_prompt01.txt",
		{
			targJD: "Software Engineer",
			myResume: "Experienced Dev",
		},
	);
	const res2 = await loadAndReplacePromptTemplate(
		"./prompts/jep_prompt01.txt",
		{
			targJD: "Software Engineer",
			myResume: "Experienced Dev",
		},
	);
	assert.equal(res1, res2);
	assert.ok(res1.includes("Software Engineer"));
});

test("formatLLMResponse omits duplicate content body when contentStreamed is true", () => {
	const dummyData = {
		provider: "openrouter",
		model: "z-ai/glm-5.3-flash",
		duration: 1200,
		usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
		content: [{ jobTitle: "Engineer", isVeryHighlyAligned: true }],
	};

	// Without contentStreamed: full content is rendered
	const formattedDefault = formatLLMResponse(dummyData, { useColor: false });
	assert.ok(formattedDefault.includes("├─ Content"));
	assert.ok(formattedDefault.includes("Engineer"));

	// With contentStreamed: content body is replaced with stream notice
	const formattedStreamed = formatLLMResponse(
		{ ...dummyData, contentStreamed: true },
		{ useColor: false },
	);
	assert.ok(formattedStreamed.includes("[Streamed live above]"));
	assert.ok(!formattedStreamed.includes("├─ Content"));
});

test("LLMService initializes providers at info on first call, debug on identical re-init", () => {
	const service = new LLMService();
	const records = [];
	const manager = require("../dist/logging").defaultLoggingManager;
	const origDispatch = manager.dispatch.bind(manager);

	manager.dispatch = (record, opts) => {
		if (record.component === "LLMService") {
			records.push(record);
		}
		origDispatch(record, opts);
	};

	try {
		const config = [
			{
				name: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				apiKey: "test-key-12345",
				model: "glm-5.3-flash",
			},
		];

		// First initialization -> should be info
		service.initialize(config, "openrouter");
		const firstInitLevels = records.map((r) => r.level);
		assert.ok(firstInitLevels.includes("info"));
		assert.ok(!firstInitLevels.includes("debug"));

		records.length = 0;

		// Re-initialization with identical config -> should be debug
		service.initialize(config, "openrouter");
		const secondInitLevels = records.map((r) => r.level);
		assert.ok(secondInitLevels.includes("debug"));
		assert.ok(!secondInitLevels.includes("info"));
	} finally {
		manager.dispatch = origDispatch;
	}
});

test("sanitizeContext preserves token metrics (maxTokens, promptTokens, tokensUsed) while redacting secrets", () => {
	const { sanitizeContext } = require("../dist/logging");
	const input = {
		provider: "openrouter",
		model: "z-ai/glm-5.3-flash",
		temperature: 1.0,
		topP: 0.95,
		maxTokens: 64000,
		promptTokens: 1200,
		completionTokens: 350,
		totalTokens: 1550,
		tokensUsed: 1550,
		apiKey: ["sk-or-v1-", "0123456789abcdef".repeat(4)].join(""),
		authToken: "secret-token",
		token: "sensitive-session",
	};

	const sanitized = sanitizeContext(input);

	assert.equal(sanitized.temperature, 1.0);
	assert.equal(sanitized.topP, 0.95);
	assert.equal(sanitized.maxTokens, 64000);
	assert.equal(sanitized.promptTokens, 1200);
	assert.equal(sanitized.completionTokens, 350);
	assert.equal(sanitized.totalTokens, 1550);
	assert.equal(sanitized.tokensUsed, 1550);
	assert.equal(sanitized.apiKey, "[redacted]");
	assert.equal(sanitized.authToken, "[redacted]");
	assert.equal(sanitized.token, "[redacted]");
});

test("runJobCloth respects preset sampling parameters (temperature: 1.0, maxTokens: 64000)", async () => {
	const fs = require("node:fs/promises");
	const os = require("node:os");
	const path = require("node:path");
	const { runJobCloth } = require("../dist/commands/jobCloth");
	const { llmService } = require("../dist/llmService");

	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "preset-params-test-"),
	);
	const inputFile = path.join(tempDir, "test_jobs.json");
	const outputFile = path.join(tempDir, "test_clothed.json");

	const sampleJobs = [
		{
			id: "1",
			title: "Security Analyst",
			url: "https://example.com/job/1",
		},
	];
	await fs.writeFile(inputFile, JSON.stringify(sampleJobs, null, 2), "utf-8");

	const capturedRequests = [];
	const originalCall = llmService.call;
	llmService.call = async (request) => {
		capturedRequests.push(request);
		return {
			content: [
				{
					jobTitle: "Security Analyst",
					isVeryHighlyAligned: true,
					rationale: "Aligned role",
					confidence: 0.9,
				},
			],
			rawResponse: {},
			usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
		};
	};

	try {
		await runJobCloth(inputFile, outputFile, {
			apiKey: "test-api-key",
			resumeFile: path.resolve(__dirname, "../profile.example/my_resume.txt"),
			preset: "jc_glm-5.3-flash",
			batch: 10,
		});

		assert.equal(capturedRequests.length, 1);
		const req = capturedRequests[0];
		assert.equal(
			req.temperature,
			1.0,
			"Preset temperature (1.0) must be respected",
		);
		assert.equal(req.topP, 0.95, "Preset topP (0.95) must be respected");
		assert.equal(
			req.maxTokens,
			64000,
			"Preset maxTokens (64000) must be respected",
		);
	} finally {
		llmService.call = originalCall;
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
