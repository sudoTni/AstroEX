// Differential oracle generator for the terminal/JSON log formatters.
//
// Usage:
//   TZ=UTC node tests/differential/generate_logging_oracle.js /path/to/AstroEX-node \
//     > tests/fixtures/logging_oracle.json
//
// Runs the real AstroEX-node formatTerminal/formatJson over a fixed corpus of
// LogRecords for both color modes and prints JSON goldens consumed by
// tests/logging_differential.rs. Tests run with TZ=UTC so the localized
// timestamps are deterministic.

process.env.TZ = "UTC";

const path = require("path");
const nodeRepo = process.argv[2];
if (!nodeRepo) {
  console.error("usage: node generate_logging_oracle.js /path/to/AstroEX-node");
  process.exit(2);
}
const formatter = require(path.join(nodeRepo, "dist/logging/formatter.js"));

const base = "2026-01-02T03:04:05.678Z";
const records = [
  { timestamp: base, level: "trace", component: "Pipeline", message: "trace message" },
  { timestamp: base, level: "debug", component: "Pipeline", message: "debug message" },
  { timestamp: base, level: "info", component: "Pipeline", message: "info message" },
  { timestamp: base, level: "success", component: "Pipeline", message: "success message" },
  { timestamp: base, level: "warn", component: "Pipeline", message: "warn message" },
  { timestamp: base, level: "error", component: "Pipeline", message: "error message" },
  { timestamp: base, level: "fatal", component: "Pipeline", message: "fatal message" },
  { timestamp: base, level: "info", component: "Pipeline", message: "====================" },
  { timestamp: base, level: "info", component: "Pipeline", message: "=== STAGE 2/8 ===" },
  { timestamp: base, level: "info", component: "Pipeline", message: "Stage 2/8: processData" },
  { timestamp: base, level: "info", component: "Pipeline", message: "Phase 3: jobCloth" },
  {
    timestamp: base,
    level: "info",
    component: "AcquireJobs",
    message: "Query complete",
    context: { site: "indeed", results: 42, ok: true, ratio: 0.5, location: "remote" },
  },
  {
    timestamp: base,
    level: "info",
    component: "AcquireJobs",
    message: "Files",
    context: {
      outputFile: "/tmp/data/acquired_jobs_indeed.json",
      inputFile: "processed_jobs.json",
      preset: "jc_glm-5.3-flash",
      model: "z-ai/glm-5.3-flash",
      provider: "openrouter",
      stage: "jobCloth",
      requestId: "abc-123",
      nested: { a: 1, b: "two" },
      list: [1, 2, 3],
      empty: null,
    },
  },
  {
    timestamp: base,
    level: "warn",
    component: "Stage",
    message: "Retrying",
    context: { durationMs: 123.4, attempt: 2, message: "with spaces", blank: "" },
  },
  {
    timestamp: base,
    level: "error",
    component: "Stage",
    message: "Failed",
    context: {
      error: {
        name: "TypeError",
        message: "boom happened",
        stack: "TypeError: boom happened\n    at foo (/a/b.js:1:2)\n    at bar (/a/c.js:3:4)\n    at baz (/a/d.js:5:6)\n    at qux (/a/e.js:7:8)\n    at quux (/a/f.js:9:10)",
      },
    },
  },
  {
    timestamp: base,
    level: "error",
    component: "Stage",
    message: "Path error",
    context: { error: { message: "no stack here" } },
  },
  {
    timestamp: base,
    level: "info",
    component: "Stage",
    message: "Duration only",
    context: { durationMs: 1500 },
  },
];

const out = [];
for (const record of records) {
  out.push({
    record,
    color: {
      pretty: formatter.formatTerminal(record, true),
      plain: formatter.formatTerminal(record, false),
      json: formatter.formatJson(record),
    },
  });
}
console.log(JSON.stringify(out, null, 2));
