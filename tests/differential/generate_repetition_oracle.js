// Differential oracle generator for the stream repetition detector.
//
// Usage:
//   node tests/differential/generate_repetition_oracle.js /path/to/AstroEX-node \
//     > tests/fixtures/repetition_oracle.json
//
// Drives the real Node StreamRepetitionDetector over a corpus of chunked
// streams and records the per-feed match, final counters, and current match.
// Consumed by tests/repetition_differential.rs.

const path = require("path");
const nodeRepo = process.argv[2];
if (!nodeRepo) {
  console.error("usage: node generate_repetition_oracle.js /path/to/AstroEX-node");
  process.exit(2);
}
const {
  StreamRepetitionDetector,
} = require(path.join(nodeRepo, "dist/repetitionDetector.js"));

const scenarios = [
  {
    name: "lock-chunks",
    chunks: [
      "Initial reasoning about the job title: Senior Cloud Security Engineer. ",
      ...Array.from({ length: 20 }, () => "lock"),
    ],
  },
  {
    name: "single-alphanumeric",
    chunks: ["Evaluating candidate background... ", "a".repeat(45)],
  },
  {
    name: "period-3",
    chunks: ["Some prelude text. ", "xyz".repeat(25)],
  },
  {
    name: "whitespace-run",
    chunks: ["prelude ", " ".repeat(90)],
  },
  {
    name: "punctuation-run",
    chunks: ["prelude ", "-".repeat(90)],
  },
  {
    name: "period-2",
    chunks: ["prelude ", "ab".repeat(30)],
  },
  {
    name: "long-phrase",
    chunks: ["prelude ", "let me verify ".repeat(8)],
  },
  {
    name: "irregular-boundaries",
    chunks: [
      "Intro thought. ",
      "lo",
      "cklock",
      "loc",
      "klock",
      "locklock",
      "locklocklock",
      "locklocklocklock",
      "locklocklocklock",
    ],
  },
  {
    name: "no-repetition",
    chunks: ["The quick brown fox ", "jumps over the lazy dog. ", "Nothing to see here."],
  },
  {
    name: "empty-chunks",
    chunks: ["", "hello world ", "", "still going"],
  },
];

const oracle = [];
for (const scenario of scenarios) {
  const detector = new StreamRepetitionDetector();
  const feeds = [];
  for (const chunk of scenario.chunks) {
    const match = detector.feed(chunk);
    feeds.push({
      chunk,
      detected: match.detected,
      period: match.period,
      repeats: match.repeats,
      repeatedText: match.repeatedText,
      totalChars: match.totalChars,
    });
  }
  const current = detector.currentMatch;
  oracle.push({
    name: scenario.name,
    feeds,
    totalObserved: detector.totalObserved,
    bufferedLength: detector.bufferedLength,
    currentMatch: current
      ? {
          detected: current.detected,
          period: current.period,
          repeats: current.repeats,
          repeatedText: current.repeatedText,
          totalChars: current.totalChars,
        }
      : null,
  });
}

console.log(JSON.stringify(oracle, null, 2));
