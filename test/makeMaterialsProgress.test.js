const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runResumeOptimizationMode } = require("../dist/commands/makeMaterials");
const { llmService } = require("../dist/llmService");
const { getPreset, loadPresets } = require("../dist/presets");

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

function mockMaterialsResponse(index) {
	return `# Resume Filename
Alex_Morgan_Materials_Security_Engineer_${index}

# Cover Letter Filename
Alex_Morgan_Cover_Letter_${index}.txt

# Optimized & Tailored Professional Title
Security Engineer ${index}

# Optimized & Tailored Professional Summary
Summary for job ${index}.

# Optimized & Tailored Key Skills
- Skill ${index}

# Optimized & Tailored Cover Letter
Cover letter content for job ${index}.`;
}

test("makeMaterials reports progress after every completed LLM call beyond the default progress throttle", async (t) => {
	const testRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-materials-progress-"),
	);
	const originalEnv = {
		ASTROEX_DATA_DIR: process.env.ASTROEX_DATA_DIR,
		ASTROEX_MATERIALS_DIR: process.env.ASTROEX_MATERIALS_DIR,
		ASTROEX_PROFILE_DIR: process.env.ASTROEX_PROFILE_DIR,
	};
	const originalCall = llmService.call;

	t.after(async () => {
		llmService.call = originalCall;
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await fs.rm(testRoot, { recursive: true, force: true });
	});

	process.env.ASTROEX_DATA_DIR = path.join(testRoot, "data");
	process.env.ASTROEX_MATERIALS_DIR = path.join(testRoot, "materials");
	process.env.ASTROEX_PROFILE_DIR = path.join(testRoot, "profile");
	const passDirectory = path.join(
		process.env.ASTROEX_DATA_DIR,
		"astroapply_eval_pass",
	);
	await Promise.all([
		fs.mkdir(passDirectory, { recursive: true }),
		fs.mkdir(process.env.ASTROEX_MATERIALS_DIR, { recursive: true }),
		fs.mkdir(process.env.ASTROEX_PROFILE_DIR, { recursive: true }),
	]);

	// Create 16 job files (exceeds the default 12-update throttle)
	const totalJobs = 16;
	for (let i = 1; i <= totalJobs; i++) {
		const job = {
			id: `job-${i}`,
			title: `Security Engineer ${i}`,
			company: `Corp ${i}`,
			url: `https://example.test/jobs/${i}`,
			source: "indeed",
			descriptionText: `Description for job ${i}`,
		};
		await fs.writeFile(
			path.join(passDirectory, `job-${String(i).padStart(3, "0")}.json`),
			JSON.stringify(job, null, 2),
		);
	}

	let callCount = 0;
	llmService.call = async () => {
		callCount++;
		return { content: mockMaterialsResponse(callCount) };
	};

	const presets = await loadPresets();
	const preset = getPreset("makeMaterials", "rop_g5.6-luna_or", presets);
	assert.ok(preset);

	const output = await captureStdout(async () => {
		const result = await runResumeOptimizationMode(preset, {
			preset: preset.name,
			apiKey: "test-key",
			sleep: 0,
			jitter: false,
		});
		assert.equal(result.error, undefined);
		assert.equal(result.content.length, totalJobs);
	});

	assert.equal(callCount, totalJobs);
	assert.match(
		output,
		/Stage 7\/8: MakeMaterials progress initialized — tracking 16 planned jobs\./,
	);

	const updates = Array.from(
		output.matchAll(
			/Stage 7\/8: MakeMaterials progress — job (\d+)\/16 complete \((\d+)%\)/g,
		),
		(match) => ({
			completed: Number(match[1]),
			percent: Number(match[2]),
		}),
	);

	assert.equal(
		updates.length,
		totalJobs,
		`Expected progress emission after each of the ${totalJobs} jobs, but got ${updates.length} updates: ${JSON.stringify(updates.map((u) => u.completed))}`,
	);

	assert.deepStrictEqual(
		updates,
		Array.from({ length: totalJobs }, (_, index) => ({
			completed: index + 1,
			percent: Math.round(((index + 1) / totalJobs) * 100),
		})),
	);
});

test("makeMaterials reports progress after a single job execution", async (t) => {
	const testRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-materials-single-progress-"),
	);
	const originalEnv = {
		ASTROEX_DATA_DIR: process.env.ASTROEX_DATA_DIR,
		ASTROEX_MATERIALS_DIR: process.env.ASTROEX_MATERIALS_DIR,
		ASTROEX_PROFILE_DIR: process.env.ASTROEX_PROFILE_DIR,
	};
	const originalCall = llmService.call;

	t.after(async () => {
		llmService.call = originalCall;
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await fs.rm(testRoot, { recursive: true, force: true });
	});

	process.env.ASTROEX_DATA_DIR = path.join(testRoot, "data");
	process.env.ASTROEX_MATERIALS_DIR = path.join(testRoot, "materials");
	process.env.ASTROEX_PROFILE_DIR = path.join(testRoot, "profile");
	await Promise.all([
		fs.mkdir(process.env.ASTROEX_DATA_DIR, { recursive: true }),
		fs.mkdir(process.env.ASTROEX_MATERIALS_DIR, { recursive: true }),
		fs.mkdir(process.env.ASTROEX_PROFILE_DIR, { recursive: true }),
	]);

	llmService.call = async () => ({
		content: mockMaterialsResponse(1),
	});

	const presets = await loadPresets();
	const preset = getPreset("makeMaterials", "rop_g5.6-luna_or", presets);
	assert.ok(preset);

	const singleJob = {
		id: "single-1",
		title: "Single Job",
		company: "Single Corp",
		url: "https://example.test/single",
		source: "indeed",
		descriptionText: "Single job description",
	};

	const output = await captureStdout(async () => {
		const result = await runResumeOptimizationMode(preset, {
			preset: preset.name,
			apiKey: "test-key",
			targJD: JSON.stringify(singleJob),
			sleep: 0,
			jitter: false,
		});
		assert.equal(result.error, undefined);
		assert.equal(result.content.length, 1);
	});

	assert.match(
		output,
		/Stage 7\/8: MakeMaterials progress initialized — tracking 1 planned job\./,
	);
	assert.match(
		output,
		/Stage 7\/8: MakeMaterials progress — job 1\/1 complete \(100%\)\./,
	);
});

test("makeMaterials advances progress when skipping already-checkpointed jobs", async (t) => {
	const testRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-materials-checkpoint-progress-"),
	);
	const originalEnv = {
		ASTROEX_DATA_DIR: process.env.ASTROEX_DATA_DIR,
		ASTROEX_MATERIALS_DIR: process.env.ASTROEX_MATERIALS_DIR,
		ASTROEX_PROFILE_DIR: process.env.ASTROEX_PROFILE_DIR,
	};
	const originalCall = llmService.call;

	t.after(async () => {
		llmService.call = originalCall;
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await fs.rm(testRoot, { recursive: true, force: true });
	});

	process.env.ASTROEX_DATA_DIR = path.join(testRoot, "data");
	process.env.ASTROEX_MATERIALS_DIR = path.join(testRoot, "materials");
	process.env.ASTROEX_PROFILE_DIR = path.join(testRoot, "profile");
	const passDirectory = path.join(
		process.env.ASTROEX_DATA_DIR,
		"astroapply_eval_pass",
	);
	await Promise.all([
		fs.mkdir(passDirectory, { recursive: true }),
		fs.mkdir(process.env.ASTROEX_MATERIALS_DIR, { recursive: true }),
		fs.mkdir(process.env.ASTROEX_PROFILE_DIR, { recursive: true }),
	]);

	const totalJobs = 4;
	for (let i = 1; i <= totalJobs; i++) {
		const job = {
			id: `job-cp-${i}`,
			title: `Checkpoint Job ${i}`,
			company: `Corp ${i}`,
			url: `https://example.test/jobs/${i}`,
			source: "indeed",
			descriptionText: `Description for job ${i}`,
		};
		await fs.writeFile(
			path.join(passDirectory, `job-cp-${i}.json`),
			JSON.stringify(job, null, 2),
		);
	}

	let callCount = 0;
	llmService.call = async () => {
		callCount++;
		return { content: mockMaterialsResponse(callCount) };
	};

	const presets = await loadPresets();
	const preset = getPreset("makeMaterials", "rop_g5.6-luna_or", presets);
	assert.ok(preset);

	// First run: process all 4 jobs
	await runResumeOptimizationMode(preset, {
		preset: preset.name,
		apiKey: "test-key",
		sleep: 0,
		jitter: false,
	});
	assert.equal(callCount, 4);

	// Second run: checkpoint should detect completed stage and reuse checkpoint for all 4 jobs
	const output = await captureStdout(async () => {
		const result = await runResumeOptimizationMode(preset, {
			preset: preset.name,
			apiKey: "test-key",
			sleep: 0,
			jitter: false,
		});
		assert.equal(result.error, undefined);
	});

	// LLM call count should not increase
	assert.equal(callCount, 4);

	const reusedUpdates = Array.from(
		output.matchAll(
			/Stage 7\/8: MakeMaterials progress — job (\d+)\/4 complete \((\d+)%\) \(durable checkpoint reused\)/g,
		),
		(match) => Number(match[1]),
	);

	assert.deepStrictEqual(reusedUpdates, [1, 2, 3, 4]);
});
