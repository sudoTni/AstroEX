const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const { ExecutionLog, log, writeLlmPayloadLog } = require("../dist/utils");

test("one execution log mirrors the whole run without changing console output", async () => {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-logging-"),
	);
	const originalStdoutWrite = process.stdout.write;
	const originalStderrWrite = process.stderr.write;
	let stdout = "";
	let stderr = "";
	const executionLog = new ExecutionLog();

	process.stdout.write = (chunk) => {
		stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
		return true;
	};
	process.stderr.write = (chunk) => {
		stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
		return true;
	};

	try {
		const filePath = executionLog.initialize(directory, ["run-pipeline"]);
		const coloredStageOne = "\u001b[31mstage-one direct output\u001b[0m\n";
		process.stdout.write("\u001b[");
		process.stdout.write("31mstage-one direct output\u001b[0m\n");
		log("StageTwo", "stage-two logger output", "warn");
		executionLog.close();

		assert.equal(stdout, coloredStageOne);
		assert.match(stderr, /stage-two logger output/);
		assert.match(
			path.basename(filePath),
			/^astroex_run-pipeline_\d{8}T\d{9}Z_p\d+_[0-9a-f-]+\.log$/,
		);

		const entries = await fs.readdir(directory, { withFileTypes: true });
		assert.equal(entries.filter((entry) => entry.isFile()).length, 1);
		for (const subdirectory of [
			"jc_payload_logs",
			"re_payload_logs",
			"jj_payload_logs",
			"mm_payload_logs",
		]) {
			assert.ok(
				entries.some(
					(entry) => entry.isDirectory() && entry.name === subdirectory,
				),
			);
		}

		const contents = await fs.readFile(filePath, "utf8");
		assert.match(contents, /stage-one direct output/);
		assert.match(contents, /stage-two logger output/);
		assert.ok(contents.indexOf("stage-one") < contents.indexOf("stage-two"));
		assert.ok(!contents.includes(String.fromCharCode(27)));
		assert.ok(!contents.includes(String.fromCharCode(155)));
		if (process.platform !== "win32") {
			assert.equal((await fs.stat(filePath)).mode & 0o077, 0);
		}
	} finally {
		executionLog.close();
		process.stdout.write = originalStdoutWrite;
		process.stderr.write = originalStderrWrite;
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("rapid execution-log creation cannot overwrite another run", async () => {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-logging-"),
	);
	try {
		const paths = [];
		for (let index = 0; index < 8; index += 1) {
			const executionLog = new ExecutionLog();
			paths.push(executionLog.initialize(directory, ["run-pipeline"]));
			executionLog.close();
		}
		assert.equal(new Set(paths).size, paths.length);
		const files = (await fs.readdir(directory)).filter((name) =>
			name.endsWith(".log"),
		);
		assert.equal(files.length, paths.length);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("concurrent CLI runs create distinct logs and expose no file-logging switches", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "astroex-cli-logging-"));
	const logDirectory = path.join(root, "logs");
	const environment = {
		...process.env,
		ASTROEX_DATA_DIR: path.join(root, "data"),
		ASTROEX_LOG_DIR: logDirectory,
		ASTROEX_MATERIALS_DIR: path.join(root, "materials"),
		ASTROEX_PROFILE_DIR: path.join(root, "profile"),
	};
	const cli = path.resolve(__dirname, "../dist/index.js");

	try {
		const results = await Promise.all([
			execFileAsync(process.execPath, [cli, "--no-banner", "--help"], {
				env: environment,
			}),
			execFileAsync(
				process.execPath,
				[cli, "--no-banner", "--disable-file-logging", "--help"],
				{ env: environment },
			),
		]);

		for (const { stdout, stderr } of results) {
			assert.equal(stderr, "");
			assert.match(stdout, /Commands:/);
		}
		assert.doesNotMatch(
			results[0].stdout,
			/--(?:disable-file-logging|log-payload|log-dir|log-file)/,
		);

		let failedRun;
		try {
			await execFileAsync(process.execPath, [cli, "--no-banner"], {
				env: environment,
			});
		} catch (error) {
			failedRun = error;
		}
		assert.ok(failedRun);
		assert.match(
			`${failedRun.stdout ?? ""}${failedRun.stderr ?? ""}`,
			/You need at least one command/,
		);

		const files = (await fs.readdir(logDirectory)).filter((name) =>
			name.endsWith(".log"),
		);
		assert.equal(files.length, 3);
		assert.equal(new Set(files).size, 3);
		const logContents = [];
		for (const file of files) {
			const contents = await fs.readFile(path.join(logDirectory, file), "utf8");
			logContents.push(contents);
			assert.match(contents, /Commands:/);
			assert.ok(!contents.includes(String.fromCharCode(27)));
			assert.ok(!contents.includes(String.fromCharCode(155)));
		}
		assert.ok(
			logContents.some((contents) =>
				contents.includes("You need at least one command"),
			),
		);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("provider payload logger writes complete, unique JSON without transforming it", async () => {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-payloads-"),
	);
	const priorLogDirectory = process.env.ASTROEX_LOG_DIR;
	process.env.ASTROEX_LOG_DIR = directory;

	try {
		for (const [stage, subdirectory] of [
			["jobCloth", "jc_payload_logs"],
			["remoteEval", "re_payload_logs"],
			["jobJudge", "jj_payload_logs"],
			["makeMaterials", "mm_payload_logs"],
		]) {
			const systemPrompt = `${stage} system prompt\n${"S".repeat(100_000)}\nEND_SYSTEM_PROMPT`;
			const firstRequest = {
				model: "\u001b[36mtest-model\u001b[0m",
				messages: [
					{ role: "system", content: systemPrompt },
					{
						role: "user",
						content: `final ${stage} \u001b[32mprompt\u001b[0m`,
					},
				],
				temperature: 0.7,
				top_p: 0.9,
				max_tokens: 12_345,
				response_format: { type: "json_object" },
				tools: [
					{
						type: "function",
						function: { name: "lookup", parameters: { type: "object" } },
					},
				],
				tool_choice: "auto",
				reasoning_effort: "high",
			};
			const secondRequest = {
				...firstRequest,
				messages: [
					{ role: "system", content: `second ${stage} system prompt` },
					{ role: "user", content: `second ${stage} prompt` },
				],
			};

			const [firstPath, secondPath] = await Promise.all([
				writeLlmPayloadLog(stage, firstRequest),
				writeLlmPayloadLog(stage, secondRequest),
			]);
			assert.notEqual(firstPath, secondPath);
			assert.equal(path.dirname(firstPath), path.join(directory, subdirectory));
			assert.match(path.basename(firstPath), /^[a-z]+_payload_.*\.json$/);
			const firstPayloadText = await fs.readFile(firstPath, "utf8");
			const secondPayloadText = await fs.readFile(secondPath, "utf8");
			assert.deepEqual(JSON.parse(firstPayloadText), firstRequest);
			assert.deepEqual(JSON.parse(secondPayloadText), secondRequest);
			assert.equal(
				JSON.parse(firstPayloadText).messages[0].content,
				systemPrompt,
			);
			assert.ok(firstPayloadText.includes("END_SYSTEM_PROMPT"));
			assert.equal(
				firstRequest.messages.at(-1).content,
				`final ${stage} \u001b[32mprompt\u001b[0m`,
			);
			assert.ok(firstPayloadText.includes("\\u001b"));
			assert.equal(
				(await fs.readdir(path.join(directory, subdirectory))).length,
				2,
			);
			if (process.platform !== "win32") {
				assert.equal((await fs.stat(firstPath)).mode & 0o077, 0);
			}
		}
	} finally {
		if (priorLogDirectory === undefined) {
			Reflect.deleteProperty(process.env, "ASTROEX_LOG_DIR");
		} else process.env.ASTROEX_LOG_DIR = priorLogDirectory;
		await fs.rm(directory, { recursive: true, force: true });
	}
});
