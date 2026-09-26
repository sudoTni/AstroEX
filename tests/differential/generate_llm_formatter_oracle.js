// Differential oracle generator for the LLM terminal formatter parity suite.
//
// Usage:
//   node tests/differential/generate_llm_formatter_oracle.js /path/to/AstroEX-node \
//     > tests/fixtures/llm_formatter_oracle.json
//
// It runs the real AstroEX-node `src/logging/llmFormatter.ts` (compiled to
// dist/) with colors disabled over a fixed corpus, and prints JSON goldens
// consumed by tests/llm_formatter_differential.rs. This script is a development
// aid; the test itself never invokes Node.

const path = require("path");

const nodeRepo = process.argv[2];
if (!nodeRepo) {
  console.error(
    "usage: node generate_llm_formatter_oracle.js /path/to/AstroEX-node",
  );
  process.exit(2);
}

// The formatter would otherwise read this from the environment.
delete process.env.ASTROEX_LOG_MAX_PAYLOAD_LENGTH;

const {
  formatLLMRequest,
  formatLLMResponse,
  formatReasoningBlock,
  formatToolCallBlock,
  formatToolResultBlock,
} = require(path.join(nodeRepo, "dist/logging/llmFormatter.js"));

const cases = [];

function request(name, data, maxPayloadLength) {
  const output = formatLLMRequest(data, { useColor: false, maxPayloadLength });
  const { provider, model, requestId, ...payload } = data;
  cases.push({
    kind: "request",
    name,
    provider,
    model,
    requestId,
    payload,
    maxPayloadLength: maxPayloadLength === undefined ? null : maxPayloadLength,
    output,
  });
}

function response(name, provider, model, data, maxPayloadLength) {
  const output = formatLLMResponse(
    { provider, model, ...data },
    { useColor: false, maxPayloadLength },
  );
  cases.push({
    kind: "response",
    name,
    provider,
    model,
    duration: data.duration === undefined ? null : data.duration,
    payload: data,
    maxPayloadLength: maxPayloadLength === undefined ? null : maxPayloadLength,
    output,
  });
}

function reasoning(name, input) {
  const obj = typeof input === "string" ? { reasoningContent: input } : input;
  cases.push({
    kind: "reasoning",
    name,
    provider: obj.provider ?? null,
    model: obj.model ?? null,
    reasoningContent: obj.reasoningContent ?? null,
    reasoningSummary: obj.reasoningSummary ?? null,
    reasoningTokens: obj.reasoningTokens === undefined ? null : obj.reasoningTokens,
    output: formatReasoningBlock(input, { useColor: false }),
  });
}

function toolCall(name, data, maxPayloadLength) {
  cases.push({
    kind: "toolCall",
    name,
    toolName: data.toolName,
    callId: data.callId ?? null,
    arguments: data.arguments,
    maxPayloadLength: maxPayloadLength === undefined ? null : maxPayloadLength,
    output: formatToolCallBlock(data, { useColor: false, maxPayloadLength }),
  });
}

function toolResult(name, data, maxPayloadLength) {
  cases.push({
    kind: "toolResult",
    name,
    toolName: data.toolName,
    duration: data.duration === undefined ? null : data.duration,
    result: data.result === undefined ? null : data.result,
    error: data.error === undefined ? null : String(data.error),
    maxPayloadLength: maxPayloadLength === undefined ? null : maxPayloadLength,
    output: formatToolResultBlock(data, { useColor: false, maxPayloadLength }),
  });
}

// --- Requests ---------------------------------------------------------------
request(
  "request-full",
  {
    provider: "openrouter",
    model: "z-ai/glm-5.3-flash",
    requestId: "req-123",
    temperature: 0.6,
    topP: 0.95,
    maxTokens: 64000,
    timeout: 30000,
    reasoning_effort: "high",
    providerRouting: {
      order: ["openai", "together"],
      only: ["openai", "together"],
      ignore: ["deepinfra"],
      quantizations: ["fp8"],
      allow_fallbacks: false,
    },
    responseSchema: true,
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Line one\nLine two with sk-or-v1-abc123secret" },
    ],
    tools: [{ type: "function", function: { name: "lookup", parameters: { q: "value" } } }],
  },
  1000,
);

request(
  "request-minimal",
  {
    provider: "openai",
    model: "gpt-4.1",
    messages: [],
  },
  undefined,
);

request(
  "request-defaults",
  {
    provider: "cerebras",
    model: "llama-3.3-70b",
    temperature: 1,
    topP: 1,
    maxTokens: 1024,
    messages: [{ role: "user", content: "hello" }],
  },
  undefined,
);

// --- Responses --------------------------------------------------------------
response("response-full", "openrouter", "z-ai/glm-5.3-flash", {
  duration: 1234.6,
  responseId: "gen-abc",
  finishReason: "stop",
  usage: {
    promptTokens: 120,
    completionTokens: 45,
    totalTokens: 165,
    cachedTokens: 10,
    reasoningTokens: 5,
  },
  content: "Here is the answer.",
});

response("response-snake-usage", "openai", "gpt-4.1", {
  duration: 50,
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  content: { nested: ["a", "b"], ok: true },
});

response("response-streamed", "openrouter", "m", {
  duration: 10,
  contentStreamed: true,
  content: "ignored",
});

response("response-omit", "poe", "m", {
  omitContent: true,
});

response("response-tool-calls", "openai", "gpt-4.1", {
  duration: 5,
  usage: { total_tokens: 9 },
  toolCalls: [
    { id: "call-1", name: "lookup", arguments: { a: 1, b: "two" } },
    { name: "noop", arguments: [] },
  ],
  content: "done",
});

response(
  "response-truncation",
  "openai",
  "gpt-4.1",
  {
    duration: 1,
    usage: { total_tokens: 1 },
    content: "x".repeat(50),
  },
  10,
);

// --- Reasoning --------------------------------------------------------------
reasoning("reasoning-content", {
  provider: "openrouter",
  model: "z-ai/glm-5.3-flash",
  reasoningContent: "Step one\nStep two",
});
reasoning("reasoning-summary", {
  provider: "openai",
  model: "o3",
  reasoningSummary: "Condensed rationale",
  reasoningTokens: 42,
});
reasoning("reasoning-tokens-only", {
  provider: "openai",
  model: "o3",
  reasoningTokens: 42,
});
reasoning("reasoning-bare-string", "just thinking");

// --- Tool call / result blocks ---------------------------------------------
toolCall(
  "tool-call-full",
  {
    toolName: "lookup",
    callId: "call-9",
    arguments: { query: "weather", limit: 3 },
  },
  1000,
);
toolResult(
  "tool-result-success",
  { toolName: "lookup", duration: 12.4, result: { temp: 20 } },
  1000,
);
toolResult(
  "tool-result-error",
  { toolName: "lookup", error: "boom" },
  1000,
);

console.log(JSON.stringify(cases, null, 2));
