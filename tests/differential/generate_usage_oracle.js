// Differential oracle generator for OpenRouter usage accounting.
//
// Usage:
//   node tests/differential/generate_usage_oracle.js /path/to/AstroEX-node \
//     > tests/fixtures/usage_oracle.json
//
// Exercises the real Node parseOpenRouterUsage, formatUsd, and
// OpenRouterUsageTracker with deterministic inputs. Consumed by
// tests/usage_differential.rs.

const path = require("path");
const nodeRepo = process.argv[2];
if (!nodeRepo) {
  console.error("usage: node generate_usage_oracle.js /path/to/AstroEX-node");
  process.exit(2);
}
const {
  parseOpenRouterUsage,
  formatUsd,
  OpenRouterUsageTracker,
} = require(path.join(nodeRepo, "dist/openRouterUsage.js"));

const metadata = {
  requestId: "req-1",
  timestamp: "2026-09-16T12:00:00.000Z",
  model: "test/model",
  stage: "jobJudge",
};

const parseInputs = [
  { label: "valid", raw: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125, cost: 0.00427 } },
  { label: "extra-keys", raw: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, cost: 0, extra: "ignored" } },
  { label: "missing-cost", raw: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
  { label: "missing-total", raw: { prompt_tokens: 1, completion_tokens: 2, cost: 0 } },
  { label: "negative", raw: { prompt_tokens: -1, completion_tokens: 2, total_tokens: 3, cost: 0 } },
  { label: "negative-cost", raw: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, cost: -0.5 } },
  { label: "fractional-int", raw: { prompt_tokens: 10.0, completion_tokens: 20.0, total_tokens: 30.0, cost: 0.1 } },
  { label: "non-integral", raw: { prompt_tokens: 1.5, completion_tokens: 2, total_tokens: 3, cost: 0 } },
  { label: "string-values", raw: { prompt_tokens: "1", completion_tokens: 2, total_tokens: 3, cost: 0 } },
  { label: "array", raw: [1, 2, 3] },
  { label: "null", raw: null },
  { label: "number", raw: 42 },
  { label: "nan-cost", raw: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, cost: NaN } },
];

const parseCases = parseInputs.map(({ label, raw }) => {
  let result = null;
  try {
    result = parseOpenRouterUsage(raw, metadata) ?? null;
  } catch {
    result = "THREW";
  }
  return { label, raw, metadata, result };
});

const formatValues = [
  0,
  0.00427,
  0.1,
  1.23456789,
  123.456789,
  99999999,
  100000000,
  123456789,
  1e-7,
  0.000000123456,
  1 / 3,
  1.5e21,
  123456789012345,
];

const formatCases = formatValues.map((value) => ({
  value,
  result: formatUsd(value),
}));

const usage = (overrides = {}) => ({
  timestamp: "2026-09-16T12:00:00.000Z",
  inputTokens: 100,
  outputTokens: 25,
  totalTokens: 125,
  costUsd: 0.00427,
  ...overrides,
});

const tracker = new OpenRouterUsageTracker();
const operations = [];
const step = (op) => operations.push(op);

const first = tracker.record("acct-a", usage());
step({ op: "record-a", recorded: first.recorded, callNumber: first.callNumber, summary: first.totals });
const dup = tracker.record("acct-a", usage());
step({ op: "record-a-again", recorded: dup.recorded, callNumber: dup.callNumber, summary: dup.totals });
const second = tracker.record("acct-b", usage({ inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.001 }));
step({ op: "record-b", recorded: second.recorded, callNumber: second.callNumber, summary: second.totals });
const unavailable = tracker.markUsageUnavailable();
step({ op: "mark-unavailable", summary: unavailable });
const third = tracker.record("acct-c", usage({ inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 }));
step({ op: "record-c", recorded: third.recorded, callNumber: third.callNumber, summary: third.totals });

console.log(
  JSON.stringify({ parseCases, formatCases, trackerOperations: operations }, null, 2),
);
