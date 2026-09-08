const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runJobCloth } = require("../dist/commands/jobCloth");
const { llmService } = require("../dist/llmService");

test("jobCloth includes resume at the bottom of LLM payloads in batch mode", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jobcloth-test-"));
	const inputFile = path.join(tempDir, "test_jobs.json");
	const outputFile = path.join(tempDir, "test_clothed.json");

	const sampleJobs = [
		{
			id: "1",
			title: "Security Operations Analyst",
			url: "https://example.com/job/1",
		},
		{
			id: "2",
			title: "IT Support Specialist",
			url: "https://example.com/job/2",
		},
	];
	await fs.writeFile(inputFile, JSON.stringify(sampleJobs, null, 2), "utf-8");

	const resumeContent = (
		await fs.readFile(
			path.resolve(__dirname, "../profile.example/my_resume.txt"),
			"utf-8",
		)
	).trim();

	const originalCall = llmService.call;
	const capturedRequests = [];

	llmService.call = async (request) => {
		capturedRequests.push(request);
		const titles = ["Security Operations Analyst", "IT Support Specialist"];
		return {
			content: titles.map((title) => ({
				jobTitle: title,
				isVeryHighlyAligned: true,
				rationale: "Relevant experience.",
				confidence: 0.9,
			})),
			rawResponse: {},
			usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
		};
	};

	try {
		await runJobCloth(inputFile, outputFile, {
			apiKey: "test-key",
			resumeFile: path.resolve(__dirname, "../profile.example/my_resume.txt"),
			baseUrl: "https://api.example.com/v1",
			modelId: "test-model",
			batch: 10,
		});

		assert.equal(capturedRequests.length, 1);
		const userMessage = capturedRequests[0].messages.find(
			(m) => m.role === "user",
		);
		assert.ok(userMessage, "User message should exist in payload");

		const content = userMessage.content;
		const jobTitlesIndex = content.indexOf("--- Job Titles ---");
		const resumeIndex = content.indexOf("--- Resume ---");

		assert.ok(
			jobTitlesIndex !== -1,
			"Payload must contain '--- Job Titles ---'",
		);
		assert.ok(resumeIndex !== -1, "Payload must contain '--- Resume ---'");
		assert.ok(
			jobTitlesIndex < resumeIndex,
			"'--- Job Titles ---' must precede '--- Resume ---'",
		);
		assert.ok(
			content.trim().endsWith(resumeContent),
			"Payload must end with my_resume.txt content",
		);
	} finally {
		llmService.call = originalCall;
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("jobCloth includes resume at the bottom of LLM payloads in batch 0 mode", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jobcloth-test-"));
	const inputFile = path.join(tempDir, "test_jobs.json");
	const outputFile = path.join(tempDir, "test_clothed.json");

	const sampleJobs = [
		{
			id: "1",
			title: "Security Operations Analyst",
			url: "https://example.com/job/1",
		},
	];
	await fs.writeFile(inputFile, JSON.stringify(sampleJobs, null, 2), "utf-8");

	const resumeContent = (
		await fs.readFile(
			path.resolve(__dirname, "../profile.example/my_resume.txt"),
			"utf-8",
		)
	).trim();

	const originalCall = llmService.call;
	const capturedRequests = [];

	llmService.call = async (request) => {
		capturedRequests.push(request);
		return {
			content: [
				{
					jobTitle: "Security Operations Analyst",
					isVeryHighlyAligned: true,
					rationale: "Relevant experience.",
					confidence: 0.9,
				},
			],
			rawResponse: {},
			usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
		};
	};

	try {
		await runJobCloth(inputFile, outputFile, {
			apiKey: "test-key",
			resumeFile: path.resolve(__dirname, "../profile.example/my_resume.txt"),
			baseUrl: "https://api.example.com/v1",
			modelId: "test-model",
			batch: 0,
		});

		assert.equal(capturedRequests.length, 1);
		const userMessage = capturedRequests[0].messages.find(
			(m) => m.role === "user",
		);
		assert.ok(userMessage, "User message should exist in payload");

		const content = userMessage.content;
		const jobTitlesIndex = content.indexOf("--- Job Titles ---");
		const resumeIndex = content.indexOf("--- Resume ---");

		assert.ok(
			jobTitlesIndex !== -1,
			"Payload must contain '--- Job Titles ---'",
		);
		assert.ok(resumeIndex !== -1, "Payload must contain '--- Resume ---'");
		assert.ok(
			jobTitlesIndex < resumeIndex,
			"'--- Job Titles ---' must precede '--- Resume ---'",
		);
		assert.ok(
			content.trim().endsWith(resumeContent),
			"Payload must end with my_resume.txt content",
		);
	} finally {
		llmService.call = originalCall;
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("jobCloth includes resume at the bottom of LLM payloads in individual retry mode", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jobcloth-test-"));
	const inputFile = path.join(tempDir, "test_jobs.json");
	const outputFile = path.join(tempDir, "test_clothed.json");

	const sampleJobs = [
		{
			id: "1",
			title: "Security Operations Analyst",
			url: "https://example.com/job/1",
		},
	];
	await fs.writeFile(inputFile, JSON.stringify(sampleJobs, null, 2), "utf-8");

	const resumeContent = (
		await fs.readFile(
			path.resolve(__dirname, "../profile.example/my_resume.txt"),
			"utf-8",
		)
	).trim();

	const originalCall = llmService.call;
	const capturedRequests = [];
	let callCount = 0;

	llmService.call = async (request) => {
		capturedRequests.push(request);
		callCount++;
		// Fail the batch attempts so it falls back to retryFailedJobTitles
		if (callCount <= 1) {
			throw new Error("Simulated batch failure");
		}
		return {
			content: [
				{
					jobTitle: "Security Operations Analyst",
					isVeryHighlyAligned: true,
					rationale: "Relevant experience.",
					confidence: 0.9,
				},
			],
			rawResponse: {},
			usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
		};
	};

	try {
		await assert.rejects(
			() =>
				runJobCloth(inputFile, outputFile, {
					apiKey: "test-key",
					resumeFile: path.resolve(
						__dirname,
						"../profile.example/my_resume.txt",
					),
					baseUrl: "https://api.example.com/v1",
					modelId: "test-model",
					batch: 1,
					batchRetryAttempts: 1,
					jobTitleRetryAttempts: 1,
					circuitThreshold: 1.1,
				}),
			/Batch 1 failed/,
		);

		// First call was batch (failed), second call was individual retry
		assert.equal(capturedRequests.length, 2);
		const retryUserMessage = capturedRequests[1].messages.find(
			(m) => m.role === "user",
		);
		assert.ok(retryUserMessage, "User message should exist in retry payload");

		const content = retryUserMessage.content;
		const jobTitleIndex = content.indexOf("--- Job Title ---");
		const resumeIndex = content.indexOf("--- Resume ---");

		assert.ok(jobTitleIndex !== -1, "Payload must contain '--- Job Title ---'");
		assert.ok(resumeIndex !== -1, "Payload must contain '--- Resume ---'");
		assert.ok(
			jobTitleIndex < resumeIndex,
			"'--- Job Title ---' must precede '--- Resume ---'",
		);
		assert.ok(
			content.trim().endsWith(resumeContent),
			"Payload must end with my_resume.txt content",
		);
	} finally {
		llmService.call = originalCall;
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("jobCloth saves complete payload to disk when logPayload is enabled", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jobcloth-test-"));
	const inputFile = path.join(tempDir, "test_jobs.json");
	const outputFile = path.join(tempDir, "test_clothed.json");
	const logDir = path.join(tempDir, "logs");

	const sampleJobs = [
		{
			id: "1",
			title: "Security Operations Analyst",
			url: "https://example.com/job/1",
		},
	];
	await fs.writeFile(inputFile, JSON.stringify(sampleJobs, null, 2), "utf-8");

	const resumeContent = (
		await fs.readFile(
			path.resolve(__dirname, "../profile.example/my_resume.txt"),
			"utf-8",
		)
	).trim();

	const originalCall = llmService.call;

	llmService.call = async () => {
		return {
			content: [
				{
					jobTitle: "Security Operations Analyst",
					isVeryHighlyAligned: true,
					rationale: "Relevant experience.",
					confidence: 0.9,
				},
			],
			rawResponse: {},
			usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
		};
	};

	try {
		await runJobCloth(inputFile, outputFile, {
			apiKey: "test-key",
			resumeFile: path.resolve(__dirname, "../profile.example/my_resume.txt"),
			baseUrl: "https://api.example.com/v1",
			modelId: "test-model",
			batch: 10,
			logPayload: true,
			logDir,
		});

		const files = await fs.readdir(logDir);
		const payloadFile = files.find(
			(f) => f.startsWith("jobcloth_") && f.endsWith(".json"),
		);
		assert.ok(payloadFile, "A jobcloth_*_payload_*.json file must be saved");

		const payloadRaw = await fs.readFile(
			path.join(logDir, payloadFile),
			"utf-8",
		);
		const payloadData = JSON.parse(payloadRaw);

		const userMessage = payloadData.messages.find((m) => m.role === "user");
		assert.ok(userMessage, "Saved payload must have user message");
		assert.ok(
			userMessage.content.trim().endsWith(resumeContent),
			"Saved payload file must end with complete my_resume.txt without truncation",
		);
	} finally {
		llmService.call = originalCall;
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("jobCloth accepts isWorthInvestigating: true from LLM response and passes jobs through", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jobcloth-test-"));
	const inputFile = path.join(tempDir, "test_jobs.json");
	const outputFile = path.join(tempDir, "test_clothed.json");

	const sampleJobs = [
		{
			id: "job-1",
			title: "Security Operations Analyst",
			company: "CyberCorp",
			location: "Remote",
			url: "https://indeed.com/viewjob?jk=1",
			source: "indeed",
		},
		{
			id: "job-2",
			title: "Pet Groomer",
			company: "PetCare",
			location: "Remote",
			url: "https://indeed.com/viewjob?jk=2",
			source: "indeed",
		},
	];
	await fs.writeFile(inputFile, JSON.stringify(sampleJobs, null, 2), "utf-8");

	const originalCall = llmService.call;

	// Mock LLM returning "isWorthInvestigating" as used by jc_prompt.txt
	llmService.call = async () => {
		return {
			content: [
				{
					jobTitle: "Security Operations Analyst",
					isWorthInvestigating: true,
					rationale: "Direct match for SecOps background.",
					confidence: 0.95,
				},
				{
					jobTitle: "Pet Groomer",
					isWorthInvestigating: false,
					rationale: "Completely outside technical track.",
					confidence: 0.99,
				},
			],
			rawResponse: {},
			usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
		};
	};

	try {
		const results = await runJobCloth(inputFile, outputFile, {
			apiKey: "test-key",
			resumeFile: path.resolve(__dirname, "../profile.example/my_resume.txt"),
			baseUrl: "https://api.example.com/v1",
			modelId: "z-ai/glm-5.3-flash",
			batch: 10,
		});

		assert.equal(results.length, 1, "Only the aligned job should pass");
		assert.equal(results[0].id, "job-1");
		assert.equal(results[0].title, "Security Operations Analyst");
		assert.equal(results[0].isWorthInvestigating, true);
		assert.equal(results[0].isVeryHighlyAligned, true);
		assert.equal(results[0].confidence, 0.95);
		assert.equal(results[0].rationale, "Direct match for SecOps background.");

		const writtenOutput = JSON.parse(await fs.readFile(outputFile, "utf-8"));
		assert.equal(writtenOutput.length, 1);
		assert.equal(writtenOutput[0].id, "job-1");
		assert.equal(writtenOutput[0].isWorthInvestigating, true);
		assert.equal(writtenOutput[0].isVeryHighlyAligned, true);
	} finally {
		llmService.call = originalCall;
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("jobCloth handles string-coerced booleans and object-wrapped responses", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jobcloth-test-"));
	const inputFile = path.join(tempDir, "test_jobs.json");
	const outputFile = path.join(tempDir, "test_clothed.json");

	const sampleJobs = [
		{
			id: "job-3",
			title: "Endpoint Security Engineer",
			url: "https://indeed.com/viewjob?jk=3",
			source: "indeed",
		},
	];
	await fs.writeFile(inputFile, JSON.stringify(sampleJobs, null, 2), "utf-8");

	const originalCall = llmService.call;

	// Mock LLM returning wrapped object with string booleans and percentage confidence
	llmService.call = async () => {
		return {
			content: {
				jobs: [
					{
						jobTitle: "Endpoint Security Engineer",
						isWorthInvestigating: "true",
						rationale: "Strong endpoint alignment.",
						confidence: "95",
					},
				],
			},
			rawResponse: {},
			usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
		};
	};

	try {
		const results = await runJobCloth(inputFile, outputFile, {
			apiKey: "test-key",
			resumeFile: path.resolve(__dirname, "../profile.example/my_resume.txt"),
			baseUrl: "https://api.example.com/v1",
			modelId: "z-ai/glm-5.3-flash",
			batch: 10,
		});

		assert.equal(results.length, 1);
		assert.equal(results[0].isWorthInvestigating, true);
		assert.equal(results[0].isVeryHighlyAligned, true);
		assert.equal(results[0].confidence, 0.95);
	} finally {
		llmService.call = originalCall;
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
