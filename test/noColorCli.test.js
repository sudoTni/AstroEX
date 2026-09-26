const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const { isColorSupported } = require("../dist/logging/fader");
const { formatTerminal } = require("../dist/logging");
const { printBanner } = require("../dist/utils");

const execFileAsync = promisify(execFile);
const CLI_PATH = path.join(__dirname, "../dist/index.js");
const ESCAPE = String.fromCharCode(27);
const ANSI_REGEX = new RegExp(`${ESCAPE}\\[[0-9;]*[a-zA-Z]`, "g");

async function setupPreflightEnvironment() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "astroex-nocolor-cli-"));
	const profileDirectory = path.join(root, "profile");
	await fs.mkdir(profileDirectory, { recursive: true });
	await Promise.all([
		fs.writeFile(path.join(profileDirectory, "search_terms.txt"), "engineer\n"),
		fs.writeFile(path.join(profileDirectory, "my_resume.txt"), "Resume\n"),
	]);

	return {
		root,
		env: {
			...process.env,
			ASTROEX_DATA_DIR: path.join(root, "data"),
			ASTROEX_LOG_DIR: path.join(root, "logs"),
			ASTROEX_MATERIALS_DIR: path.join(root, "materials"),
			ASTROEX_PROFILE_DIR: profileDirectory,
		},
		cleanup: () => fs.rm(root, { recursive: true, force: true }),
	};
}

test("CLI --help displays --color option cleanly without broken flags", async () => {
	const { stdout } = await execFileAsync(process.execPath, [
		CLI_PATH,
		"--help",
	]);
	assert.match(stdout, /--color/);
	assert.match(
		stdout,
		/Enable or disable ANSI colors and gradient formatting\s+\(negate with --no-color\)/,
	);
	assert.doesNotMatch(stdout, /----no-color/);
});

test("CLI --help --no-color emits 0 ANSI escape sequences", async () => {
	const { stdout, stderr } = await execFileAsync(process.execPath, [
		CLI_PATH,
		"--help",
		"--no-color",
	]);
	const combined = stdout + stderr;
	assert.doesNotMatch(combined, ANSI_REGEX);
	assert.match(stdout, /Commands:/);
});

test("CLI preflight --color emits ANSI escape sequences", async () => {
	const envFixture = await setupPreflightEnvironment();
	try {
		const { stdout, stderr } = await execFileAsync(
			process.execPath,
			[CLI_PATH, "preflight", "--color"],
			{ env: envFixture.env },
		);
		const combined = stdout + stderr;
		assert.match(combined, ANSI_REGEX);
	} finally {
		await envFixture.cleanup();
	}
});

test("CLI preflight --no-color completely suppresses all ANSI escapes", async () => {
	const envFixture = await setupPreflightEnvironment();
	try {
		const { stdout, stderr } = await execFileAsync(
			process.execPath,
			[CLI_PATH, "preflight", "--no-color"],
			{
				env: {
					...envFixture.env,
					FORCE_COLOR: "1", // Ensure CLI flag overrides FORCE_COLOR=1
				},
			},
		);
		const combined = stdout + stderr;
		assert.doesNotMatch(combined, ANSI_REGEX);
		assert.match(combined, /"valid": true/);
	} finally {
		await envFixture.cleanup();
	}
});

test("CLI preflight --color=false suppresses all ANSI escapes", async () => {
	const envFixture = await setupPreflightEnvironment();
	try {
		const { stdout, stderr } = await execFileAsync(
			process.execPath,
			[CLI_PATH, "preflight", "--color=false"],
			{ env: envFixture.env },
		);
		const combined = stdout + stderr;
		assert.doesNotMatch(combined, ANSI_REGEX);
		assert.match(combined, /"valid": true/);
	} finally {
		await envFixture.cleanup();
	}
});

test("CLI preflight --color=0 suppresses all ANSI escapes", async () => {
	const envFixture = await setupPreflightEnvironment();
	try {
		const { stdout, stderr } = await execFileAsync(
			process.execPath,
			[CLI_PATH, "preflight", "--color=0"],
			{ env: envFixture.env },
		);
		const combined = stdout + stderr;
		assert.doesNotMatch(combined, ANSI_REGEX);
		assert.match(combined, /"valid": true/);
	} finally {
		await envFixture.cleanup();
	}
});

test("CLI preflight --no-colors alias suppresses all ANSI escapes", async () => {
	const envFixture = await setupPreflightEnvironment();
	try {
		const { stdout, stderr } = await execFileAsync(
			process.execPath,
			[CLI_PATH, "preflight", "--no-colors"],
			{ env: envFixture.env },
		);
		const combined = stdout + stderr;
		assert.doesNotMatch(combined, ANSI_REGEX);
		assert.match(combined, /"valid": true/);
	} finally {
		await envFixture.cleanup();
	}
});

test("CLI preflight respects NO_COLOR=1 environment variable", async () => {
	const envFixture = await setupPreflightEnvironment();
	try {
		const { stdout, stderr } = await execFileAsync(
			process.execPath,
			[CLI_PATH, "preflight"],
			{
				env: {
					...envFixture.env,
					NO_COLOR: "1",
					FORCE_COLOR: "1",
				},
			},
		);
		const combined = stdout + stderr;
		assert.doesNotMatch(combined, ANSI_REGEX);
		assert.match(combined, /"valid": true/);
	} finally {
		await envFixture.cleanup();
	}
});

test("CLI preflight respects ASTROEX_NO_COLOR=true environment variable", async () => {
	const envFixture = await setupPreflightEnvironment();
	try {
		const { stdout, stderr } = await execFileAsync(
			process.execPath,
			[CLI_PATH, "preflight"],
			{
				env: {
					...envFixture.env,
					ASTROEX_NO_COLOR: "true",
					FORCE_COLOR: "1",
				},
			},
		);
		const combined = stdout + stderr;
		assert.doesNotMatch(combined, ANSI_REGEX);
		assert.match(combined, /"valid": true/);
	} finally {
		await envFixture.cleanup();
	}
});

test("CLI preflight respects FORCE_COLOR=0 environment variable", async () => {
	const envFixture = await setupPreflightEnvironment();
	try {
		const { stdout, stderr } = await execFileAsync(
			process.execPath,
			[CLI_PATH, "preflight"],
			{
				env: {
					...envFixture.env,
					FORCE_COLOR: "0",
				},
			},
		);
		const combined = stdout + stderr;
		assert.doesNotMatch(combined, ANSI_REGEX);
		assert.match(combined, /"valid": true/);
	} finally {
		await envFixture.cleanup();
	}
});

test("isColorSupported correctly resolves flag and environment precedence", () => {
	const originalArgv = process.argv;
	const originalEnv = { ...process.env };

	try {
		// CLI flag precedence over env vars
		process.argv = ["node", "astroex", "--no-color"];
		process.env.FORCE_COLOR = "1";
		assert.equal(isColorSupported(), false);

		process.argv = ["node", "astroex", "--color"];
		process.env.NO_COLOR = "1";
		assert.equal(isColorSupported(), true);

		// --color=false
		process.argv = ["node", "astroex", "--color=false"];
		assert.equal(isColorSupported(), false);

		// --color=0
		process.argv = ["node", "astroex", "--color=0"];
		assert.equal(isColorSupported(), false);

		// --no-colors alias
		process.argv = ["node", "astroex", "--no-colors"];
		assert.equal(isColorSupported(), false);

		// No CLI flags, test NO_COLOR
		process.argv = ["node", "astroex"];
		// biome-ignore lint/performance/noDelete: Node process.env properties must be deleted with delete operator
		delete process.env.FORCE_COLOR;
		process.env.NO_COLOR = "1";
		assert.equal(isColorSupported(), false);

		// ASTROEX_NO_COLOR
		// biome-ignore lint/performance/noDelete: Node process.env properties must be deleted with delete operator
		delete process.env.NO_COLOR;
		process.env.ASTROEX_NO_COLOR = "yes";
		assert.equal(isColorSupported(), false);

		process.env.ASTROEX_NO_COLOR = "false";
		process.env.FORCE_COLOR = "1";
		assert.equal(isColorSupported(), true);

		// FORCE_COLOR=0
		// biome-ignore lint/performance/noDelete: Node process.env properties must be deleted with delete operator
		delete process.env.ASTROEX_NO_COLOR;
		process.env.FORCE_COLOR = "0";
		assert.equal(isColorSupported(), false);
	} finally {
		process.argv = originalArgv;
		process.env = originalEnv;
	}
});

test("formatTerminal and printBanner emit no ANSI escapes when useColor is false", () => {
	const record = {
		timestamp: "2026-09-14T12:00:00.000Z",
		level: "info",
		component: "TestComp",
		message: "Running task",
		context: { key: "value", num: 100 },
	};
	const formatted = formatTerminal(record, false);
	assert.doesNotMatch(formatted, ANSI_REGEX);
	assert.match(formatted, /Running task/);
	assert.match(formatted, /key=value/);

	// Test printBanner
	const originalWrite = process.stdout.write;
	const bannerLogs = [];
	try {
		process.stdout.write = (msg) => {
			bannerLogs.push(String(msg));
			return true;
		};
		printBanner(false);
		assert.ok(bannerLogs.length > 0);
		for (const line of bannerLogs) {
			assert.doesNotMatch(line, ANSI_REGEX);
		}
	} finally {
		process.stdout.write = originalWrite;
	}
});
