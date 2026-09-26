const assert = require("node:assert/strict");
const test = require("node:test");
const {
	StreamRepetitionDetector,
	PathologicalReasoningRepetitionError,
} = require("../dist/repetitionDetector");

test("repetitionDetector: detects motivating 'locklocklock...' pattern quickly", () => {
	const detector = new StreamRepetitionDetector();
	let match = detector.feed(
		"Initial reasoning about the job title: Senior Cloud Security Engineer. ",
	);
	assert.equal(match.detected, false);

	// Feed "lock" repeated in small stream chunks
	for (let i = 0; i < 20; i++) {
		match = detector.feed("lock");
		if (match.detected) break;
	}

	assert.equal(match.detected, true);
	assert.equal(match.period, 4);
	assert.equal(match.repeatedText, "lock");
	assert.ok(match.repeats >= 16);
	assert.ok(match.totalChars >= 64);
	// Total observed characters before detection should be very small (< 150 chars, ~35 tokens)
	assert.ok(detector.totalObserved < 150);
});

test("repetitionDetector: detects repeated single alphanumeric characters", () => {
	const detector = new StreamRepetitionDetector();
	let match = detector.feed("Evaluating candidate background... ");
	assert.equal(match.detected, false);

	// 40 identical letters triggers alphanumeric p=1 threshold
	match = detector.feed("a".repeat(45));
	assert.equal(match.detected, true);
	assert.equal(match.period, 1);
	assert.equal(match.repeatedText, "a");
	assert.ok(match.repeats >= 40);
});

test("repetitionDetector: detects repeated multi-character substring", () => {
	const detector = new StreamRepetitionDetector();
	detector.feed("Some prelude text. ");

	// 25 repeats of "xyz" = 75 characters (p=3, threshold: repeats >= 8 && totalChars >= 64)
	const match = detector.feed("xyz".repeat(25));
	assert.equal(match.detected, true);
	assert.equal(match.period, 3);
	assert.equal(match.repeatedText, "xyz");
	assert.ok(match.repeats >= 8);
	assert.ok(match.totalChars >= 64);
});

test("repetitionDetector: detects periodic repetition across arbitrary chunk boundaries", () => {
	const detector = new StreamRepetitionDetector();
	// Chunks split in irregular pieces
	const chunks = [
		"Intro thought. ",
		"lo",
		"cklock",
		"loc",
		"klock",
		"locklock",
		"locklocklock",
		"locklocklocklock",
		"locklocklocklock",
	];

	let match = { detected: false };
	for (const chunk of chunks) {
		match = detector.feed(chunk);
		if (match.detected) break;
	}

	assert.equal(match.detected, true);
	assert.equal(match.period, 4);
	assert.equal(match.repeatedText, "lock");
});

test("repetitionDetector: detects periodic sentence/phrase repetition", () => {
	const detector = new StreamRepetitionDetector();
	const phrase = "Let me verify the candidate's clearance requirements. ";
	// 4 repeats of 54-char sentence = 216 chars (p=54, threshold: repeats >= 3 && totalChars >= 120)
	let match = { detected: false };
	for (let i = 0; i < 4; i++) {
		match = detector.feed(phrase);
		if (match.detected) break;
	}

	assert.equal(match.detected, true);
	assert.equal(match.period, phrase.length);
	assert.equal(match.repeatedText, phrase);
	assert.ok(match.repeats >= 3);
	assert.ok(match.totalChars >= 120);
});

test("repetitionDetector: does NOT trigger on realistic, complex reasoning prose", () => {
	const detector = new StreamRepetitionDetector();
	const realisticReasoning = [
		"First, let me carefully review the candidate's resume for Cloud Security credentials. ",
		"The job description specifies AWS, Terraform, and Kubernetes experience. ",
		"Looking at Alex Morgan's experience: ",
		"They worked at ExampleCorp as a Software Engineer from 2021 to 2024. ",
		"Their key accomplishments include deploying microservices across Kubernetes clusters, ",
		"configuring Prometheus alerts, and optimizing database latency. ",
		"However, the job explicitly requires Secret clearance. ",
		"Checking the resume for clearance: Alex has Public Trust suitability only. ",
		"Since the job mandates an active Secret clearance prior to start date, this triggers Gate 3 failure. ",
		"Therefore, the candidate is not eligible for this specific position.",
	];

	for (const chunk of realisticReasoning) {
		const match = detector.feed(chunk);
		assert.equal(match.detected, false);
	}
	assert.ok(detector.totalObserved > 500);
});

test("repetitionDetector: does NOT trigger on legitimate Markdown dividers and tables", () => {
	const detector = new StreamRepetitionDetector();
	// Standard 60-character markdown divider line
	let match = detector.feed(`Section 1\n${"-".repeat(60)}\nSection 2\n`);
	assert.equal(match.detected, false);

	// Standard markdown table header
	match = detector.feed(
		"| Candidate Skill | JD Requirement | Match Status |\n" +
			"|---|---|---|\n" +
			"| AWS | Required | Match |\n" +
			"| SIEM | Required | Match |\n" +
			"| CISSP | Preferred | Lacking |\n",
	);
	assert.equal(match.detected, false);
});

test("repetitionDetector: maintains bounded memory on very long non-repeating streams", () => {
	const detector = new StreamRepetitionDetector({ maxWindowChars: 1024 });

	// Feed 50,000 characters of pseudo-random non-repeating stream
	for (let i = 0; i < 1000; i++) {
		const chunk = `Step ${i}: verifying parameter ${Math.random().toString(36).slice(2)} against schema. `;
		const match = detector.feed(chunk);
		assert.equal(match.detected, false);
		assert.ok(detector.bufferedLength <= 1024);
	}

	assert.ok(detector.totalObserved > 40000);
	assert.ok(detector.bufferedLength <= 1024);
});

test("repetitionDetector: detects Unicode multi-byte repetitive loops", () => {
	const detector = new StreamRepetitionDetector();
	// 35 repeats of "好的" (p=2, threshold: repeats >= 24 && totalChars >= 48)
	const match = detector.feed("好的".repeat(35));
	assert.equal(match.detected, true);
	assert.equal(match.period, 2);
	assert.equal(match.repeatedText, "好的");
	assert.ok(match.repeats >= 24);
});

test("repetitionDetector: PathologicalReasoningRepetitionError structure and metadata", () => {
	const details = {
		provider: "openrouter",
		model: "z-ai/glm-5.3-flash",
		period: 4,
		repeats: 16,
		repeatedText: "lock",
		totalChars: 64,
		attempt: 1,
	};
	const error = new PathologicalReasoningRepetitionError(details);

	assert.equal(error.name, "PathologicalReasoningRepetitionError");
	assert.equal(error.code, "PATHOLOGICAL_REASONING_REPETITION");
	assert.equal(error.isRetryable, true);
	assert.deepEqual(error.details, details);
	assert.ok(error.message.includes("lock"));
	assert.ok(error.message.includes("period=4"));
});
