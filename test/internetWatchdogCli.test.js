const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
	executePipeline,
	resolveInternetWatchdogOption,
} = require("../dist/commands/runPipeline");
const { InternetConnectivityLostError } = require("../dist/internetWatchdog");
const { buildPipelineConfig } = require("../dist/pipelineConfig");

test("internet watchdog is disabled when the option is omitted", () => {
	assert.deepEqual(resolveInternetWatchdogOption(undefined), {
		enabled: false,
	});
	assert.deepEqual(buildPipelineConfig().internetWatchdog, { enabled: false });
});

test("bare internet watchdog option uses the default target", () => {
	assert.deepEqual(resolveInternetWatchdogOption(""), {
		enabled: true,
		target: "8.8.8.8",
	});
	assert.deepEqual(resolveInternetWatchdogOption(true), {
		enabled: true,
		target: "8.8.8.8",
	});
});

test("installed yargs semantics distinguish omitted, bare, and valued string options", () => {
	const yargs = require("yargs/yargs");
	const parse = (args) =>
		yargs(args)
			.exitProcess(false)
			.option("internet-watchdog", {
				type: "string",
				requiresArg: false,
			})
			.parse();
	assert.equal(parse([])["internet-watchdog"], undefined);
	assert.equal(parse(["--internet-watchdog"])["internet-watchdog"], "");
	assert.equal(
		parse(["--internet-watchdog", "example.com"])["internet-watchdog"],
		"example.com",
	);
});

test("internet watchdog accepts and normalizes a custom target", () => {
	const resolved = resolveInternetWatchdogOption("Example.COM");
	assert.deepEqual(resolved, { enabled: true, target: "example.com" });
	assert.deepEqual(
		buildPipelineConfig({ internetWatchdog: resolved }).internetWatchdog,
		resolved,
	);
});

test("internet watchdog rejects malformed custom targets", () => {
	assert.throws(
		() => resolveInternetWatchdogOption("https://example.com"),
		/hostname or IP address|IP address or hostname/i,
	);
});

test("a normally completed pipeline stops its run-scoped watchdog", async (t) => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-watchdog-run-"),
	);
	const dataDir = path.join(root, "data");
	const profileDir = path.join(root, "profile");
	const materialsDir = path.join(root, "materials");
	await Promise.all([
		fs.mkdir(dataDir, { recursive: true }),
		fs.mkdir(profileDir, { recursive: true }),
		fs.mkdir(materialsDir, { recursive: true }),
	]);
	await Promise.all([
		fs.writeFile(path.join(profileDir, "search_terms.txt"), "engineer\n"),
		fs.writeFile(path.join(profileDir, "my_resume.txt"), "Resume\n"),
	]);
	t.after(() => fs.rm(root, { recursive: true, force: true }));

	const events = [];
	const fakeWatchdog = {
		async validateStartup() {
			events.push("validate");
		},
		start() {
			events.push("start");
		},
		async stop() {
			events.push("stop");
		},
	};
	const config = buildPipelineConfig({
		paths: { dataDir, profileDir, materialsDir },
		internetWatchdog: { enabled: true, target: "8.8.8.8" },
		deployment: { enabled: false },
		options: { clean: false, resume: "deployment" },
	});
	const result = await executePipeline(config, {
		resume: "deployment",
		watchdogFactory: () => fakeWatchdog,
	});
	assert.equal(result.success, true);
	assert.deepEqual(events, ["validate", "start", "stop"]);
});

test("watchdog cancellation is surfaced and the watchdog is still stopped", async () => {
	const events = [];
	const config = buildPipelineConfig({
		internetWatchdog: { enabled: true, target: "8.8.8.8" },
		deployment: { enabled: false },
		options: { clean: false, resume: "deployment" },
	});
	await assert.rejects(
		executePipeline(config, {
			resume: "deployment",
			watchdogFactory: (options) => ({
				async validateStartup() {
					events.push("validate");
				},
				start() {
					events.push("start");
					options.onConnectivityLost(
						new InternetConnectivityLostError("8.8.8.8", 3, 15_000),
					);
				},
				async stop() {
					events.push("stop");
				},
			}),
		}),
		(error) =>
			error instanceof InternetConnectivityLostError &&
			error.code === "INTERNET_WATCHDOG_CONNECTIVITY_LOST",
	);
	assert.deepEqual(events, ["validate", "start", "stop"]);
});
