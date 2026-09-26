const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runPreflight } = require("../dist/commands/preflight");

test("preflight reports missing profile inputs and verifies isolated SQLite", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "astroex-preflight-"));
	const original = Object.fromEntries(
		["DATA", "LOG", "MATERIALS", "PROFILE"].map((name) => [
			name,
			process.env[`ASTROEX_${name}_DIR`],
		]),
	);
	t.after(async () => {
		for (const [name, value] of Object.entries(original)) {
			const key = `ASTROEX_${name}_DIR`;
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await fs.rm(root, { recursive: true, force: true });
	});
	process.env.ASTROEX_DATA_DIR = path.join(root, "data");
	process.env.ASTROEX_LOG_DIR = path.join(root, "logs");
	process.env.ASTROEX_MATERIALS_DIR = path.join(root, "materials");
	process.env.ASTROEX_PROFILE_DIR = path.join(root, "profile");
	await fs.mkdir(process.env.ASTROEX_PROFILE_DIR, { recursive: true });
	const result = await runPreflight();
	assert.deepEqual(result.missingProfileFiles.sort(), [
		"my_resume.txt",
		"search_terms.txt",
	]);
	assert.equal(result.repository.integrity, "ok");
});

test("preflight validates selected presets against their intended stage", async (t) => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-preflight-preset-"),
	);
	const prior = {
		ASTROEX_DATA_DIR: process.env.ASTROEX_DATA_DIR,
		ASTROEX_LOG_DIR: process.env.ASTROEX_LOG_DIR,
		ASTROEX_MATERIALS_DIR: process.env.ASTROEX_MATERIALS_DIR,
		ASTROEX_PROFILE_DIR: process.env.ASTROEX_PROFILE_DIR,
	};
	for (const [key, value] of Object.entries({
		ASTROEX_DATA_DIR: path.join(root, "data"),
		ASTROEX_LOG_DIR: path.join(root, "logs"),
		ASTROEX_MATERIALS_DIR: path.join(root, "materials"),
		ASTROEX_PROFILE_DIR: path.join(root, "profile"),
	})) {
		process.env[key] = value;
	}
	t.after(async () => {
		for (const [key, value] of Object.entries(prior)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await fs.rm(root, { recursive: true, force: true });
	});
	await fs.mkdir(process.env.ASTROEX_PROFILE_DIR, { recursive: true });
	await fs.writeFile(
		path.join(process.env.ASTROEX_PROFILE_DIR, "search_terms.txt"),
		"engineer",
	);
	await fs.writeFile(
		path.join(process.env.ASTROEX_PROFILE_DIR, "my_resume.txt"),
		"resume",
	);

	const valid = await runPreflight({
		selectedPresetCategories: { remoteEval: "re_glm-5.3-flash" },
	});
	assert.equal(valid.selectedPresetsValid, true);
	const wrongCategory = await runPreflight({
		selectedPresetCategories: { jobCloth: "re_glm-5.3-flash" },
	});
	assert.equal(wrongCategory.selectedPresetsValid, false);
	assert.deepEqual(wrongCategory.missingSelectedPresets, [
		"jobCloth:re_glm-5.3-flash",
	]);
});
