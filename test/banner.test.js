const assert = require("node:assert/strict");
const test = require("node:test");

const { applyBannerRainbow, applyRainbowText } = require("../dist/utils");

const ESCAPE = String.fromCharCode(27);
const ANSI_COLOR_TOKEN = new RegExp(
	`${ESCAPE}\\[38;2;\\d+;\\d+;\\d+m.${ESCAPE}\\[0m`,
	"g",
);
const ANSI_RGB_FOREGROUND = new RegExp(
	`${ESCAPE}\\[38;2;(\\d+;\\d+;\\d+)m`,
	"g",
);
const ANSI_RGB_BACKGROUND = new RegExp(
	`${ESCAPE}\\[48;2;(\\d+;\\d+;\\d+)m`,
	"g",
);
const ANSI_ESCAPE = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g");

test("banner fader ignores spaces and renders black glyphs over rainbow backgrounds", () => {
	const line = "░ ██▄▄▄▄██";
	const rendered = applyBannerRainbow(line);
	const expectedTokens =
		applyRainbowText("░██▄▄▄▄██ ").match(ANSI_COLOR_TOKEN) ?? [];
	const expectedBackgrounds = expectedTokens.map(
		(token) => token.match(/38;2;(\d+;\d+;\d+)m/)?.[1],
	);
	const renderedBackgrounds = [...rendered.matchAll(ANSI_RGB_BACKGROUND)]
		.map((match) => match[1])
		.filter((rgb) => rgb !== "216;216;216");
	const renderedForegrounds = [...rendered.matchAll(ANSI_RGB_FOREGROUND)].map(
		(match) => match[1],
	);

	assert.equal(rendered.replace(ANSI_ESCAPE, ""), line);
	assert.match(rendered, new RegExp(`${ESCAPE}\\[48;2;216;216;216m`));
	assert.deepEqual(renderedBackgrounds, expectedBackgrounds);
	assert.equal(renderedForegrounds.length, 9);
	assert.ok(renderedForegrounds.every((rgb) => rgb === "24;24;24"));
	assert.match(
		rendered,
		new RegExp(`${ESCAPE}\\[48;2;250;50;50m${ESCAPE}\\[38;2;24;24;24m░`),
	);
	assert.equal(
		(
			rendered.match(
				new RegExp(`${ESCAPE}\\[38;2;24;24;24m█${ESCAPE}\\[0m`, "g"),
			) ?? []
		).length,
		4,
	);
});

test("banner fader returns its input unchanged when colors are disabled", () => {
	assert.equal(applyBannerRainbow("░ ██▄▄▄▄██", false), "░ ██▄▄▄▄██");
});

test("banner fader can retain a wider pre-trim normalization width", () => {
	const rendered = applyBannerRainbow(" ▄▄ ", true, 10);
	const expectedTokens =
		applyRainbowText("▄▄        ").match(ANSI_COLOR_TOKEN) ?? [];
	const expectedBackgrounds = expectedTokens.map(
		(token) => token.match(/38;2;(\d+;\d+;\d+)m/)?.[1],
	);
	const renderedBackgrounds = [...rendered.matchAll(ANSI_RGB_BACKGROUND)]
		.map((match) => match[1])
		.filter((rgb) => rgb !== "216;216;216");

	assert.deepEqual(renderedBackgrounds, expectedBackgrounds);
	assert.equal(rendered.replace(ANSI_ESCAPE, ""), " ▄▄ ");
});
