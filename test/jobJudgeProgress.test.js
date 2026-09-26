const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runJobJudge } = require("../dist/commands/jobJudge");
const { llmService } = require("../dist/llmService");

async function withFixture(jobTitles, run) {
	const testRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-job-judge-progress-"),
	);
	const dataDirectory = path.join(testRoot, "data");
	const inputFile = path.join(dataDirectory, "clothed_jobs.json");
	await fs.mkdir(dataDirectory);
	await fs.writeFile(
		inputFile,
		JSON.stringify(
			jobTitles.map((title, index) => ({
				id: `judge-${index}`,
				title,
				company: "Example Corp",
				location: "Remote",
				url: `https://www.indeed.com/viewjob?jk=${index}`,
				source: "indeed",
				descriptionText: `${title} description.`,
			})),
		),
	);
	try {
		return await run({ testRoot, dataDirectory, inputFile });
	} finally {
		await fs.rm(testRoot, { recursive: true, force: true });
	}
}

async function captureStdout(run) {
	const originalWrite = process.stdout.write;
	const originalStderrWrite = process.stderr.write;
	let output = "";
	process.stdout.write = (chunk) => {
		output += String(chunk);
		return true;
	};
	process.stderr.write = (chunk) => {
		output += String(chunk);
		return true;
	};
	try {
		await run();
		return output;
	} finally {
		process.stdout.write = originalWrite;
		process.stderr.write = originalStderrWrite;
	}
}

function successfulResponse(jobTitle) {
	return {
		content: [
			{
				jobTitle,
				isVeryHighlyAligned: true,
				isWorthInvestigating: true,
				isHighlyAligned: true,
				rationale: "Relevant experience.",
				confidence: 0.9,
			},
		],
		rawResponse: {},
		usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
	};
}

function judgeArgs({ testRoot, dataDirectory, inputFile }) {
	return {
		"api-key": "test-key",
		"base-url": "https://api.example.test/v1",
		"model-id": "test-model",
		"input-file": inputFile,
		"output-file": path.join(dataDirectory, "astroapply_eval_"),
		preset: "jep_glm-5.3-flash",
		"use-jobdb": false,
		"strict-parsing": false,
		sleep: 0,
		"eval-mode": 1,
		"show-reasoning": false,
		"show-stream": false,
		verbose: false,
	};
}

test("jobJudge reports progress after completed evaluations, including a single call", async () => {
	const titles = ["Alpha", "Beta"];
	const originalCall = llmService.call;
	let callNumber = 0;
	llmService.call = async () => successfulResponse(titles[callNumber++]);

	try {
		const output = await captureStdout(() =>
			withFixture(titles, (fixture) => runJobJudge(judgeArgs(fixture))),
		);

		assert.equal(callNumber, 2);
		assert.match(
			output,
			/Stage 6\/8: JobJudge progress initialized — tracking 2 planned jobs\./,
		);
		const firstUpdate = output.indexOf("job 1/2 complete (50%).");
		const secondUpdate = output.indexOf("job 2/2 complete (100%).");
		assert.ok(firstUpdate >= 0, "the first completed call reports progress");
		assert.ok(secondUpdate > firstUpdate, "the next call advances progress");

		llmService.call = async () => successfulResponse("Alpha");
		const singleCallOutput = await captureStdout(() =>
			withFixture(["Alpha"], (fixture) => runJobJudge(judgeArgs(fixture))),
		);

		assert.equal(
			(singleCallOutput.match(/job 1\/1 complete \(100%\)/g) ?? []).length,
			1,
		);
		assert.doesNotMatch(singleCallOutput, /job 2\//);

		let retryCallNumber = 0;
		const originalSetTimeout = global.setTimeout;
		global.setTimeout = (callback) => {
			callback();
			return 0;
		};
		llmService.call = async () => {
			retryCallNumber++;
			if (retryCallNumber === 1) throw new Error("temporary failure");
			return successfulResponse("Alpha");
		};
		try {
			const retryOutput = await captureStdout(() =>
				withFixture(["Alpha"], (fixture) => runJobJudge(judgeArgs(fixture))),
			);
			assert.equal(retryCallNumber, 2);
			assert.equal(
				(retryOutput.match(/job 1\/1 complete \(100%\)/g) ?? []).length,
				1,
			);
		} finally {
			global.setTimeout = originalSetTimeout;
		}
	} finally {
		llmService.call = originalCall;
	}
});

test("jobJudge advances progress when skipping description-less jobs", async () => {
	const originalCall = llmService.call;
	let callNumber = 0;
	llmService.call = async () => {
		callNumber++;
		return successfulResponse("Valid Job");
	};

	try {
		const testRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "astroex-job-judge-skip-"),
		);
		const dataDirectory = path.join(testRoot, "data");
		const inputFile = path.join(dataDirectory, "clothed_jobs.json");
		await fs.mkdir(dataDirectory);
		await fs.writeFile(
			inputFile,
			JSON.stringify([
				{
					id: "job-1",
					title: "Valid Job",
					company: "Example Corp",
					url: "https://www.indeed.com/viewjob?jk=1",
					source: "indeed",
					descriptionText: "Detailed job description.",
				},
				{
					id: "job-2",
					title: "Blank Description Job",
					company: "Example Corp",
					url: "https://www.indeed.com/viewjob?jk=2",
					source: "indeed",
					descriptionText: "",
				},
			]),
		);

		const output = await captureStdout(async () => {
			await runJobJudge(judgeArgs({ testRoot, dataDirectory, inputFile }));
		});

		assert.equal(callNumber, 1);
		assert.match(output, /tracking 2 planned jobs\./);
		assert.ok(output.includes("job 1/2 complete (50%)."));
		assert.ok(
			output.includes("job 2/2 complete (100%) (no description skipped)."),
		);

		await fs.rm(testRoot, { recursive: true, force: true });
	} finally {
		llmService.call = originalCall;
	}
});

test("jobJudge omits remoteOk only from the outbound LLM job payload", async () => {
	const originalCall = llmService.call;
	let capturedTargJd = "";
	llmService.call = async (req) => {
		const userMsg = req.messages.find((m) => m.role === "user");
		if (userMsg) {
			capturedTargJd = userMsg.content;
		}
		return successfulResponse("Remote Job");
	};

	try {
		const testRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "astroex-job-judge-isremote-"),
		);
		const dataDirectory = path.join(testRoot, "data");
		const inputFile = path.join(dataDirectory, "clothed_jobs.json");
		await fs.mkdir(dataDirectory);
		await fs.writeFile(
			inputFile,
			JSON.stringify([
				{
					id: "job-rem-1",
					title: "Remote Job",
					company: "Example Corp",
					url: "https://www.indeed.com/viewjob?jk=rem1",
					source: "indeed",
					isRemote: true,
					remoteOk: true,
					confidence: 0.95,
					rationale: "Prior jobCloth verdict to be stripped",
					isWorthInvestigating: true,
					isVeryHighlyAligned: true,
					descriptionText: "100% remote security engineer position.",
				},
			]),
		);

		await captureStdout(async () => {
			await runJobJudge(judgeArgs({ testRoot, dataDirectory, inputFile }));
		});

		// Extract targJD block from user prompt
		const targJdContent =
			capturedTargJd.match(
				/``` Job Description - targJD\s*([\s\S]*?)```/,
			)?.[1] ?? "";
		assert.ok(
			targJdContent.length > 0,
			"targJD block must be present in prompt",
		);

		// The LLM-bound copy omits only remoteOk; the remaining expected job
		// metadata is unchanged and prior subjective verdicts remain stripped.
		const parsedTargJd = JSON.parse(targJdContent);
		assert.deepStrictEqual(parsedTargJd, {
			id: "job-rem-1",
			title: "Remote Job",
			company: "Example Corp",
			url: "https://www.indeed.com/viewjob?jk=rem1",
			source: "indeed",
			isRemote: true,
			descriptionText: "100% remote security engineer position.",
		});
		assert.strictEqual("remoteOk" in parsedTargJd, false);
		assert.ok(!targJdContent.includes('"remoteOk"'));

		// Check saved evaluation pass artifact contains isRemote and remoteOk
		const passFile = path.join(
			dataDirectory,
			"astroapply_eval_pass",
			"job-rem-1.json",
		);
		const savedContent = await fs.readFile(passFile, "utf8");
		const parsedSaved = JSON.parse(savedContent);
		assert.strictEqual(parsedSaved.isRemote, true);
		assert.strictEqual("isRemote" in parsedSaved, true);
		assert.strictEqual(savedContent.includes('"isRemote": true'), true);
		assert.strictEqual(parsedSaved.remoteOk, true);
		assert.strictEqual("remoteOk" in parsedSaved, true);
		assert.strictEqual(savedContent.includes('"remoteOk": true'), true);
		assert.strictEqual(parsedSaved.confidence, undefined);
		assert.strictEqual("confidence" in parsedSaved, false);
		assert.strictEqual(parsedSaved.isWorthInvestigating, undefined);
		assert.strictEqual("isWorthInvestigating" in parsedSaved, false);
		assert.strictEqual(parsedSaved.isVeryHighlyAligned, undefined);
		assert.strictEqual("isVeryHighlyAligned" in parsedSaved, false);

		await fs.rm(testRoot, { recursive: true, force: true });
	} finally {
		llmService.call = originalCall;
	}
});
