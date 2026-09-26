// Differential oracle generator for robust JSON repair.
//
// Usage:
//   node tests/differential/generate_json_repair_oracle.js /path/to/AstroEX-node \
//     > tests/fixtures/json_repair_oracle.json
//
// Calls the real (TypeScript-private, runtime-accessible) LLMService
// robustJsonParse on a corpus of malformed LLM responses and records either
// the parsed value or `null` when the repair pipeline ultimately fails.
// Consumed by tests/json_repair_differential.rs.

const path = require("path");
const nodeRepo = process.argv[2];
if (!nodeRepo) {
  console.error("usage: node generate_json_repair_oracle.js /path/to/AstroEX-node");
  process.exit(2);
}
const { llmService } = require(path.join(nodeRepo, "dist/llmService.js"));

const inputs = [
  '{"a": 1}',
  '{"a": 1, "b": [1, 2, 3]}',
  "```json\n{\"a\": [1, 2, 3]}\n```",
  "```\n{\"a\": 1}\n```",
  "Here's the JSON: {\"a\": 1}",
  "JSON: {\"a\": 1}",
  "{\"a\": 1} JSON",
  "  {\"a\": 1}  ",
  '{"a": 1, "b": [1, 2,],}',
  '{"a": 1, "b": 2,}',
  "[1, 2, 3,]",
  '{"a": {"b": 1',
  '[1, 2, {"x": 3',
  '{"s": "a{b" }',
  '{"s": "a}b" }',
  "Here is some preamble text [1, 2, 3] and trailing text",
  'noise before {"a": 1} middle noise {"b": {"c": 2}} after',
  "no json here",
  "plain text, nothing parseable",
  '[{"a": 1}, {"b": 2}',
  '```json\n{"name": "x", "items": [{"k": 1}, {"k": 2}],}\n```',
  '{"nested": {"deep": {"deeper": [1, 2, 3',
  '{"escaped": "line\\nbreak"}',
  '{"path": "C:\\\\temp\\\\file"}',
  '{"quote": "say \\"hi\\""}',
  "[]",
  "{}",
  '{"trailing": "text"} trailing junk',
  "prefix {\"a\": [1, 2, 3]} suffix",
  '{"unicode": "caf\\u00e9"}',
  '{"ok": true, "nil": null}',
  "text before [{\"a\": 1}] text after",
  '{"a": "unterminated',
  '{"a": 1}}',
  "{{}}",
];

(async () => {
  const out = [];
  for (const input of inputs) {
    let ok = true;
    let parsed = null;
    try {
      const result = await llmService.robustJsonParse(input, {
        enableAggressiveRepairs: true,
      });
      parsed = result === undefined ? null : result;
    } catch {
      ok = false;
    }
    out.push({ input, ok, parsed });
  }
  console.log(JSON.stringify(out, null, 2));
})();
