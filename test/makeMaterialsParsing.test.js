const assert = require("node:assert/strict");
const test = require("node:test");
const { parseMaterialsResponse } = require("../dist/commands/makeMaterials");

const validResponse = `# Resume Filename
resume.txt
# Optimized & Tailored Professional Title
Security Engineer
# Optimized & Tailored Professional Summary
Summary
# Optimized & Tailored Key Skills
Skill A
# Optimized & Tailored Cover Letter
Letter`;

test("materials parser accepts every required structured section", () => {
	assert.equal(
		parseMaterialsResponse(validResponse)["Resume Filename"],
		"resume.txt",
	);
});

test("materials parser rejects incomplete LLM output", () => {
	assert.throws(() => parseMaterialsResponse("# Resume Filename\nresume.txt"));
});
