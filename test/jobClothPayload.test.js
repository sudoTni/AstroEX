const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runJobCloth } = require("../dist/commands/jobCloth");
const { JobRepository } = require("../dist/jobRepository");
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

test("jobCloth supplies its payload-log stage to every LLM call", async () => {
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
	let suppliedPayload;
	let suppliedOptions;

	llmService.call = async (request, options) => {
		suppliedPayload = JSON.parse(JSON.stringify(request));
		suppliedOptions = options;
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
			baseUrl: "https://api.example.com/v1",
			modelId: "test-model",
			batch: 10,
		});

		assert.deepEqual(suppliedOptions, { payloadLogStage: "jobCloth" });
		const savedSystemPrompt = suppliedPayload.messages.find(
			(message) => message.role === "system",
		)?.content;
		const savedUserPrompt = suppliedPayload.messages.find(
			(message) => message.role === "user",
		)?.content;
		assert.ok(
			savedSystemPrompt?.length > 0,
			"Saved payload must include system prompt",
		);
		assert.ok(
			savedUserPrompt.trim().endsWith(resumeContent),
			"Saved user prompt must end with complete my_resume.txt without truncation",
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
	const repository = new JobRepository({
		dbFilePath: path.join(tempDir, "jobDB.sqlite"),
		defaultExpirationMs: 30 * 24 * 60 * 60 * 1000,
		enableJobDB: true,
	});
	await repository.initialize();

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
			baseUrl: "https://api.example.com/v1",
			modelId: "z-ai/glm-5.3-flash",
			batch: 10,
			jobRepository: repository,
		});

		assert.equal(results.length, 1, "Only the aligned job should pass");
		assert.equal(results[0].id, "job-1");
		assert.equal(results[0].title, "Security Operations Analyst");
		assert.equal(results[0].isWorthInvestigating, undefined);
		assert.equal(results[0].isVeryHighlyAligned, undefined);
		assert.equal(results[0].confidence, undefined);
		assert.equal(results[0].rationale, undefined);

		const writtenOutput = JSON.parse(await fs.readFile(outputFile, "utf-8"));
		assert.equal(writtenOutput.length, 1);
		assert.equal(writtenOutput[0].id, "job-1");
		assert.equal(writtenOutput[0].isWorthInvestigating, undefined);
		assert.equal(writtenOutput[0].isVeryHighlyAligned, undefined);
		assert.equal(writtenOutput[0].confidence, undefined);
		assert.equal(writtenOutput[0].rationale, undefined);
		assert.equal(
			repository.getRecentJobClothProcessingKeys(
				sampleJobs,
				30 * 24 * 60 * 60 * 1000,
			).size,
			2,
			"both the accepted and rejected job must be recorded",
		);
	} finally {
		llmService.call = originalCall;
		await repository.close();
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
			baseUrl: "https://api.example.com/v1",
			modelId: "z-ai/glm-5.3-flash",
			batch: 10,
		});

		assert.equal(results.length, 1);
		assert.equal(results[0].id, "job-3");
		assert.equal(results[0].title, "Endpoint Security Engineer");
		assert.equal(results[0].isWorthInvestigating, undefined);
		assert.equal(results[0].isVeryHighlyAligned, undefined);
		assert.equal(results[0].confidence, undefined);
		assert.equal(results[0].rationale, undefined);
	} finally {
		llmService.call = originalCall;
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("jobCloth handles jobTtitle typo from LLM response in batch mode", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "jobcloth-typo-test-"),
	);
	const inputFile = path.join(tempDir, "test_jobs.json");
	const outputFile = path.join(tempDir, "test_clothed.json");

	const sampleJobs = [
		{
			id: "job-1",
			title: "IT SYSTEM ENGINEER 2 – CLOUD SPECIALIST",
			url: "https://indeed.com/viewjob?jk=1",
			source: "indeed",
		},
		{
			id: "job-2",
			title: "Network Engineer",
			url: "https://indeed.com/viewjob?jk=2",
			source: "indeed",
		},
	];
	await fs.writeFile(inputFile, JSON.stringify(sampleJobs, null, 2), "utf-8");

	const originalCall = llmService.call;
	llmService.call = async () => {
		return {
			content: [
				{
					jobTitle: "IT SYSTEM ENGINEER 2 – CLOUD SPECIALIST",
					isWorthInvestigating: true,
					rationale: "Matches enterprise support profile.",
					confidence: 0.8,
				},
				{
					jobTtitle: "Network Engineer",
					isWorthInvestigating: false,
					rationale: "Network engineer core is out of scope.",
					confidence: 0.8,
				},
			],
			rawResponse: {},
			usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
		};
	};

	try {
		const results = await runJobCloth(inputFile, outputFile, {
			apiKey: "test-key",
			baseUrl: "https://api.example.com/v1",
			modelId: "z-ai/glm-5.3-flash",
			batch: 10,
		});

		assert.equal(results.length, 1);
		assert.equal(results[0].id, "job-1");
		assert.equal(results[0].title, "IT SYSTEM ENGINEER 2 – CLOUD SPECIALIST");
	} finally {
		llmService.call = originalCall;
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("jobCloth allows individual retries to execute even if batch attempt failed", async () => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "jobcloth-cb-recovery-test-"),
	);
	const inputFile = path.join(tempDir, "test_jobs.json");
	const outputFile = path.join(tempDir, "test_clothed.json");

	const sampleJobs = [
		{
			id: "job-rec-1",
			title: "Security Operations Analyst",
			url: "https://indeed.com/viewjob?jk=rec1",
			source: "indeed",
		},
	];
	await fs.writeFile(inputFile, JSON.stringify(sampleJobs, null, 2), "utf-8");

	const originalCall = llmService.call;
	let callCount = 0;
	llmService.call = async () => {
		callCount++;
		if (callCount === 1) {
			// Batch call fails
			throw new Error("Simulated batch failure");
		}
		// Individual retry call succeeds
		return {
			content: [
				{
					jobTitle: "Security Operations Analyst",
					isWorthInvestigating: true,
					rationale: "Recovered via individual retry.",
					confidence: 0.9,
				},
			],
			rawResponse: {},
			usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
		};
	};

	try {
		// Note: we do NOT set circuitThreshold: 1.1 here! Default threshold (0.5) applies.
		await assert.rejects(
			() =>
				runJobCloth(inputFile, outputFile, {
					apiKey: "test-key",
					baseUrl: "https://api.example.com/v1",
					modelId: "test-model",
					batch: 1,
					batchRetryAttempts: 1,
					jobTitleRetryAttempts: 1,
				}),
			/Batch 1 failed/,
		);

		assert.equal(
			callCount,
			2,
			"Both batch and individual retry calls must have executed",
		);
	} finally {
		llmService.call = originalCall;
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("jobJudge outbound prompt does not receive jobCloth evaluation results in targJD", async (t) => {
	const { runJobJudge } = require("../dist/commands/jobJudge");
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "jobjudge-prompt-test-"),
	);
	t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

	const dataDir = path.join(tempDir, "data");
	await fs.mkdir(dataDir, { recursive: true });
	const inputFile = path.join(dataDir, "clothed_jobs.json");

	// Clothed job input that has stray jobCloth evaluation fields
	const sampleJobs = [
		{
			id: "job-10",
			title: "Senior Security Engineer",
			company: "CyberSecure",
			url: "https://www.indeed.com/viewjob?jk=job10",
			source: "indeed",
			descriptionText: "Detailed security engineering description.",
			confidence: 0.95,
			rationale: "Matched security profile in jobCloth.",
			isWorthInvestigating: true,
			isVeryHighlyAligned: true,
		},
	];
	await fs.writeFile(inputFile, JSON.stringify(sampleJobs, null, 2), "utf-8");

	const originalCall = llmService.call;
	const capturedRequests = [];
	llmService.call = async (request) => {
		capturedRequests.push(request);
		return {
			content: [
				{
					jobTitle: "Senior Security Engineer",
					isVeryHighlyAligned: true,
					rationale: "Passes all criteria.",
					confidence: 0.9,
				},
			],
			rawResponse: {},
			usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
		};
	};

	try {
		await runJobJudge({
			preset: "jep_ds-v4-f-0423",
			"api-key": "mock-api-key",
			"base-url": "https://api.example.com",
			"model-id": "mock-model",
			"input-file": inputFile,
			"output-file": path.join(dataDir, "astroapply_eval_"),
			"use-jobdb": false,
			sleep: 0,
		});

		assert.equal(capturedRequests.length, 1);
		const userMessage = capturedRequests[0].messages.find(
			(m) => m.role === "user",
		)?.content;
		assert.ok(userMessage, "User message must be present");
		// Extract targJD block from user prompt
		const targJdContent =
			userMessage.match(/``` Job Description - targJD\s*([\s\S]*?)```/)?.[1] ??
			"";
		assert.ok(
			targJdContent.length > 0,
			"targJD block must be present in prompt",
		);
		// Ensure jobCloth evaluation metadata is NOT in the targJD block sent to the LLM
		assert.equal(
			targJdContent.includes("Matched security profile in jobCloth."),
			false,
		);
		assert.equal(targJdContent.includes("confidence"), false);
		assert.equal(targJdContent.includes("rationale"), false);
		assert.equal(targJdContent.includes("isWorthInvestigating"), false);
		assert.equal(targJdContent.includes("isVeryHighlyAligned"), false);
		// Ensure job description text IS present in the targJD block
		assert.ok(
			targJdContent.includes("Detailed security engineering description."),
		);
	} finally {
		llmService.call = originalCall;
	}
});
