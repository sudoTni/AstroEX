const assert = require("node:assert/strict");
const test = require("node:test");
const {
	JobAnalysisSchema,
	SplitTwoObjectJobAnalysisSchema,
	JobAnalysisResultsSchema,
	sanitizeJobForEvaluation,
} = require("../dist/commands/jobJudge");

const example1 = [
	{
		jobTitle: "Senior IT Support Engineer (Tier 3 / SME)",
		isVeryHighlyAligned: false,
		rationale:
			"This role fails Critical Gate 1 because it is explicitly designated as hybrid, requiring on-site attendance at the Greensboro, NC office 3 days per week, which is incompatible with Alex's San Francisco, CA residency. Although the role passes the employment-type, residency, clearance, certification, and salary gates (hourly ceiling annualizes to approximately $115,600), the mandatory hybrid attendance requirement is disqualifying regardless of the otherwise strong support-side alignment. Additionally, the position centers on enterprise contact-center/telephony platforms (NICE CXone, VoIP, ACD) where Alex has no documented professional hands-on experience, creating significant technical-interview risk even if location were resolved. Do not recommend applying.",
	},
	{
		confidence: 0.95,
	},
];

const example2 = [
	{
		jobTitle: "Senior Customer Support Engineer- Analytical Labs",
		isVeryHighlyAligned: false,
		rationale:
			"This role fails the Fully Remote and Base-Salary Ceiling critical gates (on-site instrument service in Cambridge, MA with territory travel, and a stated base-salary ceiling of $100,000), so it cannot be very highly aligned regardless of score. The role is a specialized laboratory-instrument field service position requiring deep expertise in chromatography and Waters Acquity/Alliance platforms plus 5-10 years of direct lab equipment repair experience, none of which is documented in Alex's background, yielding a low total score. Their genuine strengths in customer-facing troubleshooting, SLA-driven support, and professionalism overlap only marginally with the core repair and qualification duties for LC and mass spectrometry systems. Do not recommend applying.",
	},
	{
		confidence: 0.93,
	},
];

const example3 = [
	{
		jobTitle: "IT Technician Support",
		isVeryHighlyAligned: false,
		rationale:
			"The Critical Gates fail because this Fairmont Dallas role explicitly requires onsite attendance in Dallas, TX, which is incompatible with the fully-remote criteria. Although the position is Full-time with no certification, clearance, or salary-ceiling obstacles, and Alex's 10+ years of enterprise engineering, systems support, Linux, TCP/IP, and infrastructure experience would otherwise score competitively (approximately 88/100), the onsite location requirement cannot be overcome. Do not recommend applying.",
	},
	{
		confidence: 0.96,
	},
];

const example4 = [
	{
		jobTitle: "Hardware Support Technician",
		isVeryHighlyAligned: false,
		rationale:
			"The role fails Critical Gate 1: it is a Dallas, TX-based deskside position requiring on-site hardware break/fix and spares management, and fully remote status cannot be confirmed despite a remoteOk flag. All other gates pass (Full-time employment, no residency/clearance/certification barriers, and salary is unspecified so no ceiling violation), and the total score of 91 reflects strong alignment with Alex's hardware, endpoint, asset-management, and multi-platform support experience. However, the on-site deskside requirement and Texas location make this opportunity incompatible with the fully-remote criteria. Do not recommend applying.",
	},
	{
		confidence: 0.93,
	},
];

test("jobJudge response schema accepts Example Output 1", () => {
	const parsed = JobAnalysisResultsSchema.parse(example1);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].jobTitle, "Senior IT Support Engineer (Tier 3 / SME)");
	assert.equal(parsed[0].isVeryHighlyAligned, false);
	assert.equal(parsed[0].confidence, 0.95);
	assert.match(parsed[0].rationale, /fails Critical Gate 1/);
});

test("jobJudge response schema accepts Example Output 2", () => {
	const parsed = JobAnalysisResultsSchema.parse(example2);
	assert.equal(parsed.length, 1);
	assert.equal(
		parsed[0].jobTitle,
		"Senior Customer Support Engineer- Analytical Labs",
	);
	assert.equal(parsed[0].isVeryHighlyAligned, false);
	assert.equal(parsed[0].confidence, 0.93);
	assert.match(parsed[0].rationale, /fails the Fully Remote/);
});

test("jobJudge response schema accepts Example Output 3", () => {
	const parsed = JobAnalysisResultsSchema.parse(example3);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].jobTitle, "IT Technician Support");
	assert.equal(parsed[0].isVeryHighlyAligned, false);
	assert.equal(parsed[0].confidence, 0.96);
	assert.match(parsed[0].rationale, /requires onsite attendance in Dallas/);
});

test("jobJudge response schema accepts Example Output 4", () => {
	const parsed = JobAnalysisResultsSchema.parse(example4);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].jobTitle, "Hardware Support Technician");
	assert.equal(parsed[0].isVeryHighlyAligned, false);
	assert.equal(parsed[0].confidence, 0.93);
	assert.match(parsed[0].rationale, /fails Critical Gate 1/);
});

test("jobJudge response schema allows extra keys across two objects", () => {
	const payloadWithExtras = [
		{
			jobTitle: "Senior IT Support Engineer (Tier 3 / SME)",
			isVeryHighlyAligned: false,
			rationale: "Rationale with extras",
			score: 85,
			gates: { location: false },
		},
		{
			confidence: 0.95,
			scoringModel: "veritas-v4",
			notes: "extra evaluation note",
		},
	];

	const parsed = JobAnalysisResultsSchema.parse(payloadWithExtras);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].jobTitle, "Senior IT Support Engineer (Tier 3 / SME)");
	assert.equal(parsed[0].confidence, 0.95);
});

test("jobJudge response schema accepts reversed 2-object array order", () => {
	const reversedPayload = [
		{ confidence: 0.91, extraNote: "evaluated first" },
		{
			jobTitle: "Cloud Security Specialist",
			isVeryHighlyAligned: true,
			rationale: "Passes all gates with strong alignment.",
		},
	];

	const parsed = JobAnalysisResultsSchema.parse(reversedPayload);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].jobTitle, "Cloud Security Specialist");
	assert.equal(parsed[0].isVeryHighlyAligned, true);
	assert.equal(parsed[0].confidence, 0.91);
});

test("jobJudge response schema accepts envelope wrappers containing split 2-object arrays", () => {
	const envelopePayload = {
		jobs: [
			{
				jobTitle: "Systems Administrator",
				isVeryHighlyAligned: true,
				rationale: "Strong candidate match.",
				category: "infrastructure",
			},
			{
				confidence: 0.88,
				gateCount: 5,
			},
		],
		metadata: { batchId: "b-123" },
	};

	const parsed = JobAnalysisResultsSchema.parse(envelopePayload);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].jobTitle, "Systems Administrator");
	assert.equal(parsed[0].isVeryHighlyAligned, true);
	assert.equal(parsed[0].confidence, 0.88);
});

test("jobJudge response schema preserves standard unified formats", () => {
	// Single element array
	const singleArr = JobAnalysisResultsSchema.parse([
		{
			jobTitle: "Unified Job",
			isVeryHighlyAligned: true,
			rationale: "Matches",
			confidence: 0.9,
			unsolicitedField: true,
		},
	]);
	assert.equal(singleArr.length, 1);
	assert.equal(singleArr[0].jobTitle, "Unified Job");

	// Bare object
	const bareObj = JobAnalysisResultsSchema.parse({
		jobTitle: "Bare Job",
		isVeryHighlyAligned: false,
		rationale: "Fails gate",
		confidence: 0.7,
		unsolicitedField: 42,
	});
	assert.equal(bareObj.length, 1);
	assert.equal(bareObj[0].jobTitle, "Bare Job");

	// Multi-job array
	const multiArr = JobAnalysisResultsSchema.parse([
		{
			jobTitle: "Job 1",
			isVeryHighlyAligned: true,
			rationale: "Pass 1",
			confidence: 0.9,
		},
		{
			jobTitle: "Job 2",
			isVeryHighlyAligned: false,
			rationale: "Fail 2",
			confidence: 0.85,
		},
	]);
	assert.equal(multiArr.length, 2);
	assert.equal(multiArr[0].jobTitle, "Job 1");
	assert.equal(multiArr[1].jobTitle, "Job 2");
});

test("jobJudge 2-object schema strictly rejects missing canonical keys", () => {
	// Missing confidence across two objects
	assert.throws(
		() =>
			SplitTwoObjectJobAnalysisSchema.parse([
				{
					jobTitle: "Test Job",
					isVeryHighlyAligned: true,
					rationale: "Valid rationale",
				},
				{ irrelevantKey: "missing confidence" },
			]),
		/Across the two objects, required keys/,
	);

	// Missing rationale across two objects
	assert.throws(
		() =>
			SplitTwoObjectJobAnalysisSchema.parse([
				{
					jobTitle: "Test Job",
					isVeryHighlyAligned: true,
				},
				{ confidence: 0.95 },
			]),
		/Across the two objects, required keys/,
	);

	// Missing title across two objects
	assert.throws(
		() =>
			SplitTwoObjectJobAnalysisSchema.parse([
				{
					isVeryHighlyAligned: true,
					rationale: "Missing title",
				},
				{ confidence: 0.95 },
			]),
		/Across the two objects, required keys/,
	);

	// Missing alignment across two objects
	assert.throws(
		() =>
			SplitTwoObjectJobAnalysisSchema.parse([
				{
					jobTitle: "Test Job",
					rationale: "Missing alignment",
				},
				{ confidence: 0.95 },
			]),
		/Across the two objects, required keys/,
	);
});

test("sanitizeJobForEvaluation preserves isRemote and remoteOk while omitting subjective LLM verdicts", () => {
	const mockJob = {
		id: "indeed:123456",
		title: "Remote Security Engineer",
		company: "Acme Corp",
		url: "https://www.indeed.com/viewjob?jk=123456",
		descriptionText: "Requires cyber security experience.",
		isRemote: true,
		remoteOk: true,
		confidence: 0.9,
		rationale: "Should be omitted",
		isVeryHighlyAligned: true,
		isWorthInvestigating: true,
		isHighlyAligned: true,
	};

	const cleaned = sanitizeJobForEvaluation(mockJob);

	assert.strictEqual(cleaned.isRemote, true);
	assert.strictEqual("isRemote" in cleaned, true);
	assert.strictEqual(cleaned.remoteOk, true);
	assert.strictEqual("remoteOk" in cleaned, true);
	assert.strictEqual(cleaned.confidence, undefined);
	assert.strictEqual("confidence" in cleaned, false);
	assert.strictEqual(cleaned.rationale, undefined);
	assert.strictEqual("rationale" in cleaned, false);
	assert.strictEqual(cleaned.isVeryHighlyAligned, undefined);
	assert.strictEqual("isVeryHighlyAligned" in cleaned, false);
	assert.strictEqual(cleaned.isWorthInvestigating, undefined);
	assert.strictEqual("isWorthInvestigating" in cleaned, false);
	assert.strictEqual(cleaned.isHighlyAligned, undefined);
	assert.strictEqual("isHighlyAligned" in cleaned, false);
	assert.strictEqual(cleaned.title, "Remote Security Engineer");
	assert.strictEqual(cleaned.company, "Acme Corp");

	const serialized = JSON.stringify(cleaned);
	assert.strictEqual(serialized.includes('"isRemote":true'), true);
	assert.strictEqual(serialized.includes('"remoteOk":true'), true);
	assert.strictEqual(serialized.includes('"confidence"'), false);
	assert.strictEqual(serialized.includes('"rationale"'), false);
	assert.strictEqual(serialized.includes('"isVeryHighlyAligned"'), false);
	assert.strictEqual(serialized.includes('"isWorthInvestigating"'), false);
	assert.strictEqual(serialized.includes('"isHighlyAligned"'), false);
});

test("JobAnalysisSchema accepts jobTtitle typo and alias keys", () => {
	const parsed = JobAnalysisSchema.parse({
		jobTtitle: "Network Engineer",
		isWorthInvestigating: false,
		rationale: "Network engineer core is out of scope.",
		confidence: 0.8,
	});

	assert.strictEqual(parsed.jobTitle, "Network Engineer");
	assert.strictEqual(parsed.isVeryHighlyAligned, false);
	assert.strictEqual(parsed.isWorthInvestigating, false);
	assert.strictEqual(parsed.confidence, 0.8);
	assert.strictEqual(
		parsed.rationale,
		"Network engineer core is out of scope.",
	);

	// Also test PascalCase JobTitle
	const parsedPascal = JobAnalysisSchema.parse({
		JobTitle: "Security Analyst",
		isVeryHighlyAligned: true,
		rationale: "Strong alignment.",
		confidence: 0.9,
	});
	assert.strictEqual(parsedPascal.jobTitle, "Security Analyst");
	assert.strictEqual(parsedPascal.isVeryHighlyAligned, true);
});
