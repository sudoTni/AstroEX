const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runResumeOptimizationMode } = require("../dist/commands/makeMaterials");
const { llmService } = require("../dist/llmService");
const { getPreset, loadPresets } = require("../dist/presets");

async function captureConsole(run) {
	const originalStdoutWrite = process.stdout.write;
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
		return { result: await run(), output };
	} finally {
		process.stdout.write = originalStdoutWrite;
		process.stderr.write = originalStderrWrite;
	}
}

const successfulMaterialsResponse = `# Resume Filename
Alex_Morgan_Materials_Remote_Security_Engineer

# Cover Letter Filename
Alex_Morgan_Cover_Letter_Example.txt

# Optimized & Tailored Professional Title
Remote Security Engineer

# Optimized & Tailored Professional Summary
Security engineer with relevant experience.

# Optimized & Tailored Key Skills
- Cloud Security
- Incident Response

# Optimized & Tailored Cover Letter
Dear Hiring Team,\n\nI am excited to apply.`;

function extractReceivedJob(request) {
	const userMessage = request.messages.find(
		(message) => message.role === "user",
	);
	const targJdContent =
		userMessage?.content.match(
			/``` Job Description - targJD\s*([\s\S]*?)```/,
		)?.[1] ?? "";
	assert.ok(targJdContent.length > 0);
	return JSON.parse(targJdContent);
}

test("makeMaterials omits isRemote from direct and auto-loaded JSON without mutation", async (t) => {
	const testRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-materials-payload-"),
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

	const sourceJob = {
		id: "indeed:materials-boundary-1",
		title: "Remote Security Engineer",
		company: "Example Corp",
		url: "https://www.indeed.com/viewjob?jk=materials-boundary-1",
		source: "indeed",
		isRemote: true,
		remoteOk: true,
		descriptionText: "Cloud security and incident response role.",
		evaluationResult: {
			isPass: true,
			confidence: 0.97,
		},
	};
	const originalSnapshot = structuredClone(sourceJob);
	const capturedRequests = [];
	llmService.call = async (request) => {
		capturedRequests.push(request);
		return { content: successfulMaterialsResponse };
	};

	const presets = await loadPresets();
	const preset = getPreset("makeMaterials", "rop_g5.6-luna_or", presets);
	assert.ok(preset);
	const { result, output: consoleOutput } = await captureConsole(() =>
		runResumeOptimizationMode(preset, {
			preset: preset.name,
			apiKey: "test-key",
			targJD: JSON.stringify(sourceJob, null, 2),
			myProfessionalTitle: "Security Engineer",
			myProfessionalSummary: "Security professional.",
			myKeySkills: "Cloud Security, Incident Response",
			resume: "Security engineering resume.",
			testimonials: "Excellent security engineer.",
			sleep: 0,
			jitter: false,
		}),
	);

	assert.equal(result.error, undefined);
	assert.equal(result.content.length, 1);
	assert.match(
		consoleOutput,
		/Stage 7\/8: MakeMaterials progress initialized — tracking 1 planned job\./,
	);
	assert.match(consoleOutput, /job 1\/1 complete \(100%\)/);
	assert.deepStrictEqual(sourceJob, originalSnapshot);
	assert.strictEqual(sourceJob.isRemote, true);

	const receivedJob = extractReceivedJob(capturedRequests[0]);
	const { isRemote: _isRemote, ...expectedJob } = sourceJob;
	assert.deepStrictEqual(receivedJob, expectedJob);
	assert.strictEqual("isRemote" in receivedJob, false);

	const autoLoadedJob = {
		...sourceJob,
		id: "indeed:materials-boundary-2",
		title: "Cloud Security Engineer",
		isRemote: false,
		remoteOk: false,
	};
	const passDirectory = path.join(
		process.env.ASTROEX_DATA_DIR,
		"astroapply_eval_pass",
	);
	const passFile = path.join(passDirectory, "materials-boundary-2.json");
	await fs.mkdir(passDirectory, { recursive: true });
	await fs.writeFile(passFile, JSON.stringify(autoLoadedJob, null, 2));

	const autoResult = await runResumeOptimizationMode(preset, {
		preset: preset.name,
		apiKey: "test-key",
		myProfessionalTitle: "Security Engineer",
		myProfessionalSummary: "Security professional.",
		myKeySkills: "Cloud Security, Incident Response",
		resume: "Security engineering resume.",
		testimonials: "Excellent security engineer.",
		sleep: 0,
		jitter: false,
	});

	assert.equal(autoResult.error, undefined);
	assert.equal(autoResult.content.length, 1);
	const persistedJob = JSON.parse(await fs.readFile(passFile, "utf8"));
	assert.deepStrictEqual(persistedJob, autoLoadedJob);
	assert.strictEqual(persistedJob.isRemote, false);
	const autoReceivedJob = extractReceivedJob(capturedRequests[1]);
	const { isRemote: _autoIsRemote, ...expectedAutoJob } = autoLoadedJob;
	assert.deepStrictEqual(autoReceivedJob, expectedAutoJob);
	assert.strictEqual("isRemote" in autoReceivedJob, false);
});
