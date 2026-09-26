// Differential oracle generator for the fader surface (stripAnsi, rainbow
// text, banner rainbow, and the stateful StreamFader).
//
// Usage:
//   node tests/differential/generate_fader_oracle.js /path/to/AstroEX-node \
//     > tests/fixtures/fader_oracle.json
//
// Consumed by tests/fader_differential.rs.

const path = require("path");
const nodeRepo = process.argv[2];
if (!nodeRepo) {
  console.error("usage: node generate_fader_oracle.js /path/to/AstroEX-node");
  process.exit(2);
}
const fader = require(path.join(nodeRepo, "dist/logging/fader.js"));

const ansiStrings = [
  "plain",
  "\u001b[31mred\u001b[0m",
  "\u001b[1m\u001b[38;2;1;2;3mbold rgb\u001b[0m normal",
  "https://\u001b]8;;http://example.com\u0007link\u001b]8;;\u0007 text",
  "\u001b[2Jclear",
  "\u001b(Bcharset",
  "",
  "no ansi at all",
  "\u001b[38;5;196m256color\u001b[0m",
];

const rainbowCases = [
  { text: "Hello, world!", startHue: 0, useColor: true },
  { text: "Hello, world!", startHue: 0.25, useColor: true },
  { text: "abcdef", startHue: 0, useColor: true },
  { text: "a b c", startHue: 0.1, useColor: true },
  { text: "plain", startHue: 0, useColor: false },
  { text: "", startHue: 0, useColor: true },
  { text: "caf\u00e9 \u2014 test", startHue: 0, useColor: true },
];

const bannerCases = [
  { line: "  __  __ ", useColor: true, faderWidth: 9 },
  { line: " /\\  ___", useColor: true, faderWidth: 8 },
  { line: "abc def", useColor: true, faderWidth: 7 },
  { line: "abc", useColor: false, faderWidth: 3 },
  { line: "   ", useColor: true, faderWidth: 3 },
];

const streamChunks = [
  ["Hello ", "world", "!"],
  ["chunk one ", "chunk two ", "chunk three"],
  ["a".repeat(200)],
  ["line1\nline2\n", "line3"],
  ["s p a c e s ", "and", " more"],
];

const streams = streamChunks.map((chunks) => {
  const stream = new fader.StreamFader("streaming");
  const steps = chunks.map((chunk) => stream.fadeChunk(chunk, true));
  return { chunks, steps, position: stream.getPosition() };
});

const out = {
  stripAnsi: ansiStrings.map((input) => ({ input, output: fader.stripAnsi(input) })),
  rainbow: rainbowCases.map(({ text, startHue, useColor }) => ({
    text,
    startHue,
    useColor,
    output: fader.applyRainbowText(text, startHue, useColor),
  })),
  banner: bannerCases.map(({ line, useColor, faderWidth }) => ({
    line,
    useColor,
    faderWidth,
    output: fader.applyBannerRainbow(line, useColor, faderWidth),
  })),
  streams,
};
console.log(JSON.stringify(out, null, 2));
