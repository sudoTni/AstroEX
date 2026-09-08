const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
	deployMaterials,
	findMaterialTextFiles,
	executePipeline,
} = require("../dist/commands/runPipeline");
const { buildPipelineConfig } = require("../dist/pipelineConfig");
const { llmService } = require("../dist/llmService");

function makeJob(id, title, company, overrides = {}) {
	return {
		id: `indeed:${id}`,
		source: "indeed",
		sourceJobId: id,
		canonicalUrl: `https://www.indeed.com/viewjob?jk=${id}`,
		title,
		company,
		location: "New York, NY, USA",
		description: `Full job description for ${title} at ${company}. Requires security experience.`,
		descriptionText: `Full job description for ${title} at ${company}. Requires security experience.`,
		descriptionRepresentation: "markdown",
		acquiredAt: new Date().toISOString(),
		...overrides,
	};
}

test("findMaterialTextFiles discovers only .txt files and ignores manifests and non-txt files", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "astroex-find-txt-"));
	t.after(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	const subDir1 = path.join(root, "Job_One_123");
	const subDir2 = path.join(root, "Job_Two_456");
	await fs.mkdir(subDir1, { recursive: true });
	await fs.mkdir(subDir2, { recursive: true });

	const txt1 = path.join(subDir1, "Resume_One.txt");
	const manifest1 = path.join(subDir1, "Resume_One.txt.manifest.json");
	const txt2 = path.join(subDir2, "Resume_Two.txt");
	const manifest2 = path.join(subDir2, "Resume_Two.txt.manifest.json");
	const otherFile = path.join(subDir2, "notes.json");
	const rootTxt = path.join(root, "Root_Resume.txt");

	await fs.writeFile(txt1, "Resume 1", "utf8");
	await fs.writeFile(manifest1, '{"version":"1.0"}', "utf8");
	await fs.writeFile(txt2, "Resume 2", "utf8");
	await fs.writeFile(manifest2, '{"version":"1.0"}', "utf8");
	await fs.writeFile(otherFile, '{"info":"test"}', "utf8");
	await fs.writeFile(rootTxt, "Root Resume", "utf8");

	const found = await findMaterialTextFiles(root);
	assert.equal(found.length, 3);
	assert.ok(found.includes(txt1));
	assert.ok(found.includes(txt2));
	assert.ok(found.includes(rootTxt));
	assert.ok(!found.includes(manifest1));
	assert.ok(!found.includes(manifest2));
	assert.ok(!found.includes(otherFile));
});

test("deployMaterials uploads only .txt files directly to destination without containing folders or manifests", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "astroex-deploy-test-"));
	t.after(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	const materialsDir = path.join(root, "materials");
	const deployedMaterialsDir = path.join(root, "materials-deployed");
	const destDir = path.join(root, "remote-destination");

	await fs.mkdir(materialsDir, { recursive: true });
	await fs.mkdir(destDir, { recursive: true });

	// Setup job subdirectories with .txt and .manifest.json files
	const job1Dir = path.join(materialsDir, "Security_Engineer_1001");
	const job2Dir = path.join(materialsDir, "Cloud_Architect_1002");
	await fs.mkdir(job1Dir, { recursive: true });
	await fs.mkdir(job2Dir, { recursive: true });

	const txt1 = path.join(job1Dir, "Security_Engineer_Resume.txt");
	const manifest1 = path.join(
		job1Dir,
		"Security_Engineer_Resume.txt.manifest.json",
	);
	const txt2 = path.join(job2Dir, "Cloud_Architect_Resume.txt");
	const manifest2 = path.join(
		job2Dir,
		"Cloud_Architect_Resume.txt.manifest.json",
	);

	await fs.writeFile(txt1, "Content of Security Engineer Resume", "utf8");
	await fs.writeFile(manifest1, '{"jobId":"1001"}', "utf8");
	await fs.writeFile(txt2, "Content of Cloud Architect Resume", "utf8");
	await fs.writeFile(manifest2, '{"jobId":"1002"}', "utf8");

	// Run deployMaterials
	const result = await deployMaterials(
		materialsDir,
		deployedMaterialsDir,
		destDir,
	);

	assert.equal(result.deployed, 2);
	assert.equal(result.destination, destDir);

	// Destination must contain ONLY the .txt files directly
	const destEntries = await fs.readdir(destDir);
	assert.deepEqual(destEntries.sort(), [
		"Cloud_Architect_Resume.txt",
		"Security_Engineer_Resume.txt",
	]);

	// Verify content of uploaded files
	const uploadedTxt1 = await fs.readFile(
		path.join(destDir, "Security_Engineer_Resume.txt"),
		"utf8",
	);
	assert.equal(uploadedTxt1, "Content of Security Engineer Resume");

	// Destination must NOT contain any directories
	for (const entry of destEntries) {
		const stat = await fs.stat(path.join(destDir, entry));
		assert.ok(stat.isFile(), `Expected ${entry} to be a file, not a directory`);
	}

	// Destination must NOT contain manifests or folders
	assert.ok(
		!destEntries.includes("Security_Engineer_Resume.txt.manifest.json"),
	);
	assert.ok(!destEntries.includes("Cloud_Architect_Resume.txt.manifest.json"));
	assert.ok(!destEntries.includes("Security_Engineer_1001"));
	assert.ok(!destEntries.includes("Cloud_Architect_1002"));

	// materialsDir must now be empty locally
	const remainingMaterials = await fs.readdir(materialsDir);
	assert.equal(remainingMaterials.length, 0);

	// deployedMaterialsDir must contain the archived job folders
	const archivedEntries = await fs.readdir(deployedMaterialsDir);
	assert.ok(archivedEntries.includes("Security_Engineer_1001"));
	assert.ok(archivedEntries.includes("Cloud_Architect_1002"));
});

test("deployMaterials handles duplicate filenames across job folders without overwriting", async (t) => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-deploy-duplicate-"),
	);
	t.after(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	const materialsDir = path.join(root, "materials");
	const deployedMaterialsDir = path.join(root, "materials-deployed");
	const destDir = path.join(root, "destination");

	await fs.mkdir(materialsDir, { recursive: true });

	const job1Dir = path.join(materialsDir, "Job_1");
	const job2Dir = path.join(materialsDir, "Job_2");
	await fs.mkdir(job1Dir, { recursive: true });
	await fs.mkdir(job2Dir, { recursive: true });

	// Both jobs have the same filename
	await fs.writeFile(
		path.join(job1Dir, "Resume.txt"),
		"First Job Resume",
		"utf8",
	);
	await fs.writeFile(
		path.join(job2Dir, "Resume.txt"),
		"Second Job Resume",
		"utf8",
	);

	const result = await deployMaterials(
		materialsDir,
		deployedMaterialsDir,
		destDir,
	);
	assert.equal(result.deployed, 2);

	const destEntries = await fs.readdir(destDir);
	assert.equal(destEntries.length, 2);
	assert.ok(destEntries.includes("Resume.txt"));
	assert.ok(destEntries.includes("Resume_1.txt"));
});

test("deployMaterials handles empty materials directory gracefully", async (t) => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-deploy-empty-"),
	);
	t.after(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	const materialsDir = path.join(root, "materials");
	const deployedMaterialsDir = path.join(root, "materials-deployed");
	const destDir = path.join(root, "destination");

	await fs.mkdir(materialsDir, { recursive: true });

	const result = await deployMaterials(
		materialsDir,
		deployedMaterialsDir,
		destDir,
	);
	assert.equal(result.deployed, 0);
	assert.equal(result.destination, destDir);
});

test("executePipeline end-to-end optional deployment stage uploads only .txt files directly to destination", async (t) => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "astroex-pipeline-deploy-"),
	);

	const dataDir = path.join(root, "data");
	const logDir = path.join(root, "logs");
	const materialsDir = path.join(root, "materials");
	const deployedMaterialsDir = path.join(root, "materials-deployed");
	const profileDir = path.join(root, "profile");
	const destDir = path.join(root, "dest");

	await Promise.all([
		fs.mkdir(dataDir, { recursive: true }),
		fs.mkdir(logDir, { recursive: true }),
		fs.mkdir(materialsDir, { recursive: true }),
		fs.mkdir(deployedMaterialsDir, { recursive: true }),
		fs.mkdir(profileDir, { recursive: true }),
		fs.mkdir(destDir, { recursive: true }),
	]);

	const originalEnv = {
		ASTROEX_DATA_DIR: process.env.ASTROEX_DATA_DIR,
		ASTROEX_LOG_DIR: process.env.ASTROEX_LOG_DIR,
		ASTROEX_MATERIALS_DIR: process.env.ASTROEX_MATERIALS_DIR,
		ASTROEX_PROFILE_DIR: process.env.ASTROEX_PROFILE_DIR,
		AEX_CLEAN: process.env.AEX_CLEAN,
	};

	t.after(async () => {
		for (const [key, val] of Object.entries(originalEnv)) {
			if (val === undefined) delete process.env[key];
			else process.env[key] = val;
		}
		await fs.rm(root, { recursive: true, force: true });
	});

	process.env.ASTROEX_DATA_DIR = dataDir;
	process.env.ASTROEX_LOG_DIR = logDir;
	process.env.ASTROEX_MATERIALS_DIR = materialsDir;
	process.env.ASTROEX_PROFILE_DIR = profileDir;
	process.env.AEX_CLEAN = "0";

	// Setup profile files
	await fs.writeFile(
		path.join(profileDir, "search_terms.txt"),
		"Security Engineer\n",
		"utf8",
	);
	await fs.writeFile(
		path.join(profileDir, "my_resume.txt"),
		"the candidate - Experienced Cloud Security Engineer.\n",
		"utf8",
	);
	await fs.writeFile(
		path.join(profileDir, "company_filters.txt"),
		"BlocklistCorp\n",
		"utf8",
	);
	await fs.writeFile(
		path.join(profileDir, "title_filters.txt"),
		"Intern\n",
		"utf8",
	);
	await fs.writeFile(
		path.join(profileDir, "my_professional_title.txt"),
		"Cloud Security Engineer\n",
		"utf8",
	);
	await fs.writeFile(
		path.join(profileDir, "my_professional_summary.txt"),
		"Expert in cloud security.\n",
		"utf8",
	);
	await fs.writeFile(
		path.join(profileDir, "my_key_skills.txt"),
		"Cloud Security, DevSecOps\n",
		"utf8",
	);
	await fs.writeFile(
		path.join(profileDir, "my_testimonials.txt"),
		"Top security professional.\n",
		"utf8",
	);

	// Fixture jobs for acquisition
	const fixtureJobs = [
		makeJob("job-101", "Cloud Security Engineer", "Acme Security"),
	];
	await fs.writeFile(
		path.join(dataDir, "acquired_jobs_indeed.json"),
		JSON.stringify(fixtureJobs, null, 2),
		"utf8",
	);

	// Mock LLM service
	const originalLlmCall = llmService.call;
	t.after(() => {
		llmService.call = originalLlmCall;
	});

	llmService.call = async (req) => {
		const contentStr = JSON.stringify(req.messages);

		if (
			contentStr.includes("classification engine") ||
			contentStr.includes("JOB-TITLE-LEVEL") ||
			contentStr.includes("job-title")
		) {
			return {
				content: [
					{
						jobTitle: "Cloud Security Engineer",
						isVeryHighlyAligned: true,
						rationale: "Strong alignment with security profile.",
						confidence: 0.95,
					},
				],
				usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
			};
		}

		if (
			contentStr.includes("ROP") ||
			contentStr.includes("Resume Optimization") ||
			contentStr.includes("cover_length")
		) {
			return {
				content: `# Resume Filename
Candidate_Materials_Cloud_Security_Engineer

# Cover Letter Filename
Candidate_Cover_Letter_Acme_Security.txt

# Optimized & Tailored Professional Title
Lead Cloud Security Engineer

# Optimized & Tailored Professional Summary
High-impact Security Engineer.

# Optimized & Tailored Key Skills
- Cloud Security Architecture

# Optimized & Tailored Cover Letter
Dear Hiring Team at Acme Security,\n\nI am thrilled to apply...`,
				usage: { promptTokens: 150, completionTokens: 100, totalTokens: 250 },
			};
		}

		return {
			content: [
				{
					jobTitle: "Cloud Security Engineer",
					isVeryHighlyAligned: true,
					rationale: "Candidate has deep cloud security experience.",
					confidence: 0.96,
				},
			],
			usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
		};
	};

	const config = buildPipelineConfig({
		paths: {
			dataDir,
			logDir,
			materialsDir,
			deployedMaterialsDir,
			profileDir,
			searchTermsFile: path.join(profileDir, "search_terms.txt"),
		},
		deployment: {
			enabled: true,
			destination: destDir,
		},
		presets: {
			jobCloth: "jc_glm-5.3-flash",
			jobJudge: "jep_glm-5.3-flash",
			makeMaterials: "rop_g5.6-luna_or",
		},
		options: {
			clean: false,
			sleep: 0,
		},
		jobDefaults: {
			apiKey: "mock-api-key",
			sleep: 0,
		},
	});

	const result = await executePipeline(config, {
		skipAcquisition: true,
	});

	assert.equal(result.success, true);
	assert.equal(result.stages.deployment.deployed, 1);
	assert.equal(result.stages.deployment.destination, destDir);

	// Destination must contain ONLY the .txt file directly
	const destContents = await fs.readdir(destDir);
	assert.deepEqual(destContents, [
		"Candidate_Materials_Cloud_Security_Engineer.txt",
	]);

	// Verify no directories exist in destination
	const destStat = await fs.stat(
		path.join(destDir, "Candidate_Materials_Cloud_Security_Engineer.txt"),
	);
	assert.ok(destStat.isFile());

	// Verify materials-deployed contains the archived directory with both txt and manifest
	const archivedEntries = await fs.readdir(deployedMaterialsDir);
	assert.equal(archivedEntries.length, 1);
	const archivedJobDir = path.join(deployedMaterialsDir, archivedEntries[0]);
	const archivedFiles = await fs.readdir(archivedJobDir);
	assert.ok(
		archivedFiles.includes("Candidate_Materials_Cloud_Security_Engineer.txt"),
	);
	assert.ok(
		archivedFiles.includes(
			"Candidate_Materials_Cloud_Security_Engineer.txt.manifest.json",
		),
	);
});
