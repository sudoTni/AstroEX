const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const runtimePaths = require("../dist/runtimePaths");

test("runtime directories honor explicit environment overrides", () => {
	const original = {
		data: process.env.ASTROEX_DATA_DIR,
		profile: process.env.ASTROEX_PROFILE_DIR,
		logs: process.env.ASTROEX_LOG_DIR,
		materials: process.env.ASTROEX_MATERIALS_DIR,
	};
	try {
		process.env.ASTROEX_DATA_DIR = "/tmp/astroex-data";
		process.env.ASTROEX_PROFILE_DIR = "/tmp/astroex-profile";
		process.env.ASTROEX_LOG_DIR = "/tmp/astroex-logs";
		process.env.ASTROEX_MATERIALS_DIR = "/tmp/astroex-materials";
		assert.equal(runtimePaths.getDataDirectory(), "/tmp/astroex-data");
		assert.equal(runtimePaths.getProfileDirectory(), "/tmp/astroex-profile");
		assert.equal(runtimePaths.getLogsDirectory(), "/tmp/astroex-logs");
		assert.equal(
			runtimePaths.getMaterialsDirectory(),
			"/tmp/astroex-materials",
		);
		assert.equal(
			runtimePaths.getProfileFile("my_resume.txt"),
			path.join("/tmp/astroex-profile", "my_resume.txt"),
		);
		assert.throws(() => runtimePaths.getProfileFile("../private.txt"));
	} finally {
		for (const [name, value] of Object.entries(original)) {
			const variable = `ASTROEX_${name.toUpperCase()}_DIR`;
			if (value === undefined) delete process.env[variable];
			else process.env[variable] = value;
		}
	}
});
