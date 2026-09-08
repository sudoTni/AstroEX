const assert = require("node:assert/strict");
const test = require("node:test");

const ESCAPE = String.fromCharCode(27);
const ANSI_COLOR_TOKEN = new RegExp(`${ESCAPE}\\[38;2;\\d+;\\d+;\\d+m`);
const ANSI_RESET_TOKEN = new RegExp(`${ESCAPE}\\[0m`);
const ANSI_COLOR_START = new RegExp(`${ESCAPE}\\[38;2;`);

const {
	hsvToRgb,
	rgbToAnsi,
	rgbToBgAnsi,
	stripAnsi,
	interpolateHue,
	interpolateHsv,
	applyHsvFade,
	createStreamFader,
	LOG_GRADIENTS,
	formatLLMRequest,
	formatLLMResponse,
	formatReasoningBlock,
	formatToolCallBlock,
	formatToolResultBlock,
	formatStructuredData,
} = require("../dist/logging");

test("hsvToRgb converts primary and boundary hues accurately", () => {
	// Pure red (h=0, s=1, v=1)
	assert.deepEqual(hsvToRgb(0, 1, 1), [255, 0, 0]);

	// Pure green (h=1/3, s=1, v=1)
	assert.deepEqual(hsvToRgb(1 / 3, 1, 1), [0, 255, 0]);

	// Pure blue (h=2/3, s=1, v=1)
	assert.deepEqual(hsvToRgb(2 / 3, 1, 1), [0, 0, 255]);

	// Pure white (s=0, v=1)
	assert.deepEqual(hsvToRgb(0, 0, 1), [255, 255, 255]);

	// Pure black (v=0)
	assert.deepEqual(hsvToRgb(0.5, 1, 0), [0, 0, 0]);

	// Gray (s=0, v=0.5)
	assert.deepEqual(hsvToRgb(0.2, 0, 0.5), [128, 128, 128]);

	// Normalized wrapping for negative and > 1 hues
	assert.deepEqual(hsvToRgb(1.0, 1, 1), [255, 0, 0]);
	assert.deepEqual(hsvToRgb(-1 / 3, 1, 1), [0, 0, 255]); // -120 deg == 240 deg (blue)
	assert.deepEqual(hsvToRgb(1.333333, 1, 1), [0, 255, 0]); // 480 deg == 120 deg (green)

	// Clamping out-of-bounds saturation and value
	assert.deepEqual(hsvToRgb(0, 1.5, 1.5), [255, 0, 0]);
	assert.deepEqual(hsvToRgb(0, -0.5, -0.2), [0, 0, 0]);
});

test("rgbToAnsi and rgbToBgAnsi generate correct 24-bit escape sequences", () => {
	assert.equal(rgbToAnsi(255, 128, 0), "\x1b[38;2;255;128;0m");
	assert.equal(rgbToBgAnsi(10, 20, 30), "\x1b[48;2;10;20;30m");
});

test("interpolateHue supports forward, reverse, shortest, and longest paths", () => {
	// Shortest path across 0.9 -> 0.1 crosses 0 (difference = +0.2)
	const midShort = interpolateHue(0.9, 0.1, 0.5, "shortest");
	assert.ok(Math.abs(midShort - 0.0) < 0.01 || Math.abs(midShort - 1.0) < 0.01);

	// Forward path from 0.8 to 0.2 goes through 0.9, 0.0, 0.1 -> span 0.4
	const midFwd = interpolateHue(0.8, 0.2, 0.5, "forward");
	assert.ok(Math.abs(midFwd - 0.0) < 0.01 || Math.abs(midFwd - 1.0) < 0.01);

	// Reverse path from 0.1 to 0.9 goes reverse through 0.0, span 0.2
	const midRev = interpolateHue(0.1, 0.9, 0.5, "reverse");
	assert.ok(Math.abs(midRev - 0.0) < 0.01 || Math.abs(midRev - 1.0) < 0.01);
});

test("interpolateHsv handles multi-stop gradients and symmetrical mode", () => {
	const multiStopProfile = {
		startHue: 0,
		endHue: 1,
		stops: [
			{ offset: 0.0, h: 0.0 }, // Red
			{ offset: 0.5, h: 1 / 3 }, // Green
			{ offset: 1.0, h: 2 / 3 }, // Blue
		],
		saturation: 1.0,
		value: 1.0,
	};

	// Start (offset 0)
	const rgbStart = interpolateHsv(multiStopProfile, 0.0);
	assert.deepEqual(rgbStart, [255, 0, 0]);

	// Midpoint (offset 0.5)
	const rgbMid = interpolateHsv(multiStopProfile, 0.5);
	assert.deepEqual(rgbMid, [0, 255, 0]);

	// End (offset 1.0)
	const rgbEnd = interpolateHsv(multiStopProfile, 1.0);
	assert.deepEqual(rgbEnd, [0, 0, 255]);

	// Symmetrical mode (t=0.5 reaches endHue, t=1.0 returns to startHue)
	const symProfile = {
		startHue: 0.0,
		endHue: 1 / 3,
		mode: "symmetrical",
		saturation: 1.0,
		value: 1.0,
	};
	const symStart = interpolateHsv(symProfile, 0.0);
	const symPeak = interpolateHsv(symProfile, 0.5);
	const symReturn = interpolateHsv(symProfile, 1.0);

	assert.deepEqual(symStart, [255, 0, 0]);
	assert.deepEqual(symPeak, [0, 255, 0]);
	assert.deepEqual(symReturn, [255, 0, 0]);
});

test("applyHsvFade renders intentional gradient profiles with proper resets", () => {
	const text = "AstroEX Pipeline Execution";
	const colored = applyHsvFade(text, "info", { useColor: true });

	// Should contain ANSI truecolor codes and resets
	assert.match(colored, ANSI_COLOR_TOKEN);
	assert.match(colored, ANSI_RESET_TOKEN);

	// Stripping ANSI should give original text
	assert.equal(stripAnsi(colored), text);

	// Disabling color returns plain text
	const plain = applyHsvFade(text, "info", { useColor: false });
	assert.equal(plain, text);
});

test("applyHsvFade handles edge cases: empty string, single char, and whitespace", () => {
	assert.equal(applyHsvFade("", "info", { useColor: true }), "");

	const singleChar = applyHsvFade("X", "success", { useColor: true });
	assert.match(singleChar, ANSI_COLOR_START);
	assert.match(singleChar, ANSI_RESET_TOKEN);
	assert.equal(stripAnsi(singleChar), "X");

	const whitespace = "   \n\t  ";
	const fadedWhitespace = applyHsvFade(whitespace, "warn", { useColor: true });
	assert.equal(stripAnsi(fadedWhitespace), whitespace);
});

test("applyHsvFade supports per-line vs continuous gradient modes across multiline text", () => {
	const multiline = "Line 1: Alpha\nLine 2: Beta\nLine 3: Gamma";

	const continuous = applyHsvFade(multiline, "request", {
		useColor: true,
		mode: "continuous",
	});
	const perLine = applyHsvFade(multiline, "request", {
		useColor: true,
		mode: "per-line",
	});

	assert.equal(stripAnsi(continuous), multiline);
	assert.equal(stripAnsi(perLine), multiline);

	// Both modes produce valid colored output
	assert.match(continuous, ANSI_COLOR_START);
	assert.match(perLine, ANSI_COLOR_START);
});

test("applyHsvFade correctly preserves Unicode emojis and box-drawing glyphs", () => {
	const unicodeText = "╭─ 🚀 AstroEX Job Evaluator ✔";
	const colored = applyHsvFade(unicodeText, "reasoning", { useColor: true });

	assert.equal(stripAnsi(colored), unicodeText);
	assert.match(colored, /🚀/);
	assert.match(colored, /╭/);
	assert.match(colored, /─/);
	assert.match(colored, /✔/);
});

test("StreamFader maintains continuous gradient progression across streaming chunks", () => {
	const fader = createStreamFader("streaming", {
		cycleLength: 30,
		useColor: true,
	});

	const chunk1 = "Thinking about ";
	const chunk2 = "cloud infrastructure requirements...";

	const faded1 = fader.fadeChunk(chunk1);
	const posAfter1 = fader.getPosition();
	assert.ok(posAfter1 > 0);

	const faded2 = fader.fadeChunk(chunk2);
	const posAfter2 = fader.getPosition();
	assert.ok(posAfter2 > posAfter1);

	assert.equal(stripAnsi(faded1), chunk1);
	assert.equal(stripAnsi(faded2), chunk2);

	// Reset resets position
	fader.reset();
	assert.equal(fader.getPosition(), 0);
});

test("StreamFader produces smooth transitions across cycle boundaries without harsh color jumps on long sentences", () => {
	// Test reasoning stream (cycleLength = 100) across 250 characters
	const reasoningFader = createStreamFader("reasoning", {
		cycleLength: 100,
		useColor: true,
	});
	const longReasoning =
		"Evaluating candidate requirements against job descriptions ".repeat(5);
	const fadedReasoning = reasoningFader.fadeChunk(longReasoning);

	const rgbPattern = new RegExp(`${ESCAPE}\\[38;2;(\\d+);(\\d+);(\\d+)m`, "g");
	const matches = [...fadedReasoning.matchAll(rgbPattern)].map((m) => [
		Number.parseInt(m[1], 10),
		Number.parseInt(m[2], 10),
		Number.parseInt(m[3], 10),
	]);

	assert.ok(
		matches.length > 200,
		"Should have rendered over 200 colored characters",
	);

	// Verify maximum delta between ANY adjacent characters is small (smooth gradient, no cliff)
	for (let i = 0; i < matches.length - 1; i++) {
		const [r1, g1, b1] = matches[i];
		const [r2, g2, b2] = matches[i + 1];
		const delta = Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
		assert.ok(
			delta <= 15,
			`Delta between char ${i} and ${i + 1} should be smooth (<= 15), got ${delta}`,
		);
	}
});

test("formatStructuredData handles circular references, nested objects, and secret redaction", () => {
	const circularObj = {
		name: "test",
		apiKey: ["sk-or-v1-", "0123456789abcdef".repeat(4)].join(""),
		nested: {
			token: "secret-token-1234567890",
		},
	};
	circularObj.self = circularObj;

	const formatted = formatStructuredData(circularObj);

	// Circular reference protected
	assert.match(formatted, /\[circular\]/i);

	// Sensitive keys masked
	assert.match(formatted, /\[redacted\]/);
	assert.doesNotMatch(formatted, /sk-or-v1/);
	assert.doesNotMatch(formatted, /secret-token/);
});

test("formatLLMRequest, formatLLMResponse, and formatReasoningBlock render structural blocks", () => {
	// Request formatting
	const req = formatLLMRequest(
		{
			provider: "openrouter",
			model: "z-ai/glm-5.3-flash",
			requestId: "req-123",
			temperature: 0.6,
			messages: [
				{ role: "system", content: "You are Veritas." },
				{ role: "user", content: "Analyze candidate profile." },
			],
		},
		{ useColor: true },
	);

	assert.match(stripAnsi(req), /╭─ LLM REQUEST/);
	assert.match(stripAnsi(req), /openrouter\/z-ai\/glm-5.3-flash/);
	assert.match(stripAnsi(req), /You are Veritas\./);
	assert.match(stripAnsi(req), /╰─/);
	assert.match(req, ANSI_COLOR_START); // Verify ANSI colors applied

	// Response formatting
	const res = formatLLMResponse(
		{
			provider: "openrouter",
			model: "z-ai/glm-5.3-flash",
			duration: 1250,
			finishReason: "stop",
			usage: {
				promptTokens: 100,
				completionTokens: 250,
				totalTokens: 350,
				reasoningTokens: 45,
			},
			content: "Candidate is an excellent match.",
		},
		{ useColor: true },
	);

	assert.match(stripAnsi(res), /╭─ LLM RESPONSE/);
	assert.match(stripAnsi(res), /Candidate is an excellent match\./);
	assert.match(stripAnsi(res), /reasoning=45/);
	assert.match(stripAnsi(res), /╰─/);
	assert.match(res, ANSI_COLOR_START);

	// Reasoning block formatting
	const reasoning = formatReasoningBlock(
		{
			provider: "openrouter",
			model: "z-ai/glm-5.3-flash",
			reasoningContent:
				"Step 1: Evaluate technical skills.\nStep 2: Compare years of experience.",
			reasoningTokens: 45,
		},
		{ useColor: true },
	);

	assert.match(stripAnsi(reasoning), /╭─ REASONING/);
	assert.match(stripAnsi(reasoning), /Step 1: Evaluate technical skills\./);
	assert.match(stripAnsi(reasoning), /45 tokens/);
	assert.match(stripAnsi(reasoning), /╰─/);
	assert.match(reasoning, ANSI_COLOR_START);

	// Tool call and result formatting
	const toolCall = formatToolCallBlock(
		{
			toolName: "fetch_job_description",
			callId: "call_abc123",
			arguments: { jobId: "indeed:12345" },
		},
		{ useColor: true },
	);
	assert.match(stripAnsi(toolCall), /╭─ TOOL CALL \[fetch_job_description\]/);
	assert.match(toolCall, ANSI_COLOR_START);

	const toolResult = formatToolResultBlock(
		{
			toolName: "fetch_job_description",
			duration: 85,
			result: { status: "found", title: "Senior TypeScript Engineer" },
		},
		{ useColor: true },
	);
	assert.match(
		stripAnsi(toolResult),
		/╭─ TOOL RESULT \[fetch_job_description\]/,
	);
	assert.match(toolResult, ANSI_COLOR_START);
});
