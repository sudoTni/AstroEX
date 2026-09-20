const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runJobCloth } = require("../dist/commands/jobCloth");
const { llmService } = require("../dist/llmService");

async function withFixture(jobTitles, run) {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-cloth-progress-"),
	);
	const inputFile = path.join(directory, "jobs.json");
	const outputFile = path.join(directory, "clothed.json");
	await fs.writeFile(
		inputFile,
		JSON.stringify(
			jobTitles.map((title, index) => ({
				id: String(index),
				title,
				url: `https://example.test/jobs/${index}`,
			})),
		),
	);
	try {
		return await run({ inputFile, outputFile });
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}

async function captureStdout(run) {
	const originalWrite = process.stdout.write;
	let output = "";
	process.stdout.write = (chunk) => {
		output += String(chunk);
		return true;
	};
	try {
		await run();
		return output;
	} finally {
		process.stdout.write = originalWrite;
	}
}

function successfulResponse(jobTitle) {
	return {
		content: [
			{
				jobTitle,
				isHighlyAligned: true,
				rationale: "Relevant experience.",
				confidence: 0.9,
			},
		],
		rawResponse: {},
		usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
	};
}

test("jobCloth reports every completed LLM batch beyond the normal progress throttle", async () => {
	const titles = Array.from({ length: 15 }, (_, index) => `Title ${index + 1}`);
	const originalCall = llmService.call;
	let callNumber = 0;
	llmService.call = async () => successfulResponse(titles[callNumber++]);

	try {
		const output = await captureStdout(() =>
			withFixture(titles, ({ inputFile, outputFile }) =>
				runJobCloth(inputFile, outputFile, {
					apiKey: "test-key",
					baseUrl: "https://api.example.test/v1",
					modelId: "test-model",
					batch: 1,
					sleep: 0,
				}),
			),
		);

		assert.equal(callNumber, titles.length);
		assert.match(output, /15 planned LLM calls/);
		const updates = Array.from(
			output.matchAll(/LLM call (\d+)\/15 complete \((\d+)%\)/g),
			(match) => ({ completed: Number(match[1]), percent: Number(match[2]) }),
		);
		assert.deepEqual(
			updates,
			Array.from({ length: titles.length }, (_, index) => ({
				completed: index + 1,
				percent: Math.round(((index + 1) / titles.length) * 100),
			})),
		);
	} finally {
		llmService.call = originalCall;
	}
});

test("jobCloth retries do not inflate completed-call progress", async () => {
	const originalCall = llmService.call;
	let callNumber = 0;
	llmService.call = async () => {
		callNumber++;
		if (callNumber === 1) throw new Error("temporary failure");
		return successfulResponse("Alpha");
	};

	try {
		const output = await captureStdout(() =>
			withFixture(["Alpha"], ({ inputFile, outputFile }) =>
				runJobCloth(inputFile, outputFile, {
					apiKey: "test-key",
					baseUrl: "https://api.example.test/v1",
					modelId: "test-model",
					batch: 1,
					sleep: 0,
					batchRetryAttempts: 2,
					batchRetryDelay: 0,
					circuitThreshold: 1.1,
				}),
			),
		);

		assert.equal(callNumber, 2);
		assert.equal(
			(output.match(/LLM call 1\/1 complete \(100%\)/g) ?? []).length,
			1,
		);
	} finally {
		llmService.call = originalCall;
	}
});
