// Differential oracle generator for secret redaction/sanitization.
//
// Usage:
//   node tests/differential/generate_redaction_oracle.js /path/to/AstroEX-node \
//     > tests/fixtures/redaction_oracle.json
//
// Runs the real AstroEX-node sanitizeString/sanitizeContext over a fixed
// corpus and prints JSON goldens consumed by tests/redaction_differential.rs.

const path = require("path");
const nodeRepo = process.argv[2];
if (!nodeRepo) {
  console.error("usage: node generate_redaction_oracle.js /path/to/AstroEX-node");
  process.exit(2);
}
const redaction = require(path.join(nodeRepo, "dist/logging/redaction.js"));

const strings = [
  "",
  "plain text without secrets",
  "key=sk-or-v1-" + "a".repeat(64),
  "key=sk-or-v1-" + "a".repeat(63),
  "token sk-abcdefghijklmnopqrstuvwxyz",
  "token sk-short",
  "AIza" + "A".repeat(35),
  "AIza" + "A".repeat(34),
  "ghp_" + "a".repeat(40),
  "gho_" + "b".repeat(36),
  "xoxb-1234567890",
  "Authorization: Bearer abcdefghijklmnop",
  "authorization: bearer abcdefghijklmnop",
  "Basic YWJjZGVmZ2hpamtsbW5vcA==",
  "https://user:supersecret@example.com/path",
  "http://alice:hunter2@host.tld",
  "no creds https://example.com/path",
  "x".repeat(9999),
  "x".repeat(10000),
  "x".repeat(10001),
  "x".repeat(20000),
  "prefix " + "y".repeat(20000) + " suffix",
  "sk-or-v1-" + "a".repeat(64) + " " + "z".repeat(20000),
];

const contexts = [
  null,
  true,
  42,
  1.5,
  "hello",
  "secret sk-abcdefghijklmnopqrstuvwxyz",
  { apiKey: "secret-value", model: "gpt", usage: { prompt_tokens: 10, totalTokens: 20 } },
  { Authorization: "Bearer abcdefghijklmnop", password: "hunter2" },
  { maxTokens: 64000, prompt_tokens: 5, tokenCount: 3, tokensUsed: 9 },
  { sessionId: "abc", csrf_token: "xyz", jwt: "a.b.c", credential: "c" },
  { nested: { deeper: { deepest: { value: "sk-abcdefghijklmnopqrstuvwxyz" } } } },
  [1, 2, "three", { api_key: "secret" }],
  Array.from({ length: 150 }, (_, i) => i),
  Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${i}`, i])),
  { a: { b: { c: { d: { e: { f: { g: { h: "deep" } } } } } } } },
  { normal: "value", error: "not an Error object" },
];

function deepObject(levels) {
  let value = "leaf";
  for (let i = 0; i < levels; i++) value = { nested: value };
  return value;
}

contexts.push(deepObject(7));
contexts.push(deepObject(9));

const out = {
  strings: strings.map((input) => ({
    input,
    output: redaction.sanitizeString(input),
  })),
  contexts: contexts.map((input) => ({
    input,
    output: redaction.sanitizeContext(input, 0, new WeakSet()),
  })),
};
const syntheticOrKey = "sk-or-v1-" + "a".repeat(64);
const placeholder = "__SK_OR_V1_64A__";
const serialized = JSON.stringify(out, null, 2).replaceAll(syntheticOrKey, placeholder);
console.log(serialized);
