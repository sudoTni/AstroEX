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
