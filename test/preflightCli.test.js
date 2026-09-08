const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const { promisify } = require("node:util");
const path = require("node:path");
const test = require("node:test");

const execFileAsync = promisify(execFile);

test("preflight --json emits parseable operational output", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-preflight-cli-"),
	);
	try {
		const profileDirectory = path.join(root, "profile");
		await fs.mkdir(profileDirectory, { recursive: true });
		await Promise.all([
			fs.writeFile(
				path.join(profileDirectory, "search_terms.txt"),
				"engineer\n",
			),
			fs.writeFile(path.join(profileDirectory, "my_resume.txt"), "Resume\n"),
		]);
		const { stdout } = await execFileAsync(
			process.execPath,
			[path.join(__dirname, "../dist/index.js"), "preflight", "--json"],
			{
				env: {
					...process.env,
					ASTROEX_DATA_DIR: path.join(root, "data"),
					ASTROEX_LOG_DIR: path.join(root, "logs"),
					ASTROEX_MATERIALS_DIR: path.join(root, "materials"),
					ASTROEX_PROFILE_DIR: profileDirectory,
				},
			},
		);
		const result = JSON.parse(stdout);
		assert.equal(result.repository.integrity, "ok");
		assert.deepEqual(result.missingProfileFiles, []);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
