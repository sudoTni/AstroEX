// Differential oracle generator for delay/retry helpers.
//
// Usage:
//   node tests/differential/generate_delay_oracle.js /path/to/AstroEX-node \
//     > tests/fixtures/delay_oracle.json

const path = require("path");
const nodeRepo = process.argv[2];
if (!nodeRepo) {
  console.error("usage: node generate_delay_oracle.js /path/to/AstroEX-node");
  process.exit(2);
}
const delay = require(path.join(nodeRepo, "dist/utils/delayUtils.js"));

const statuses = [];
for (let status = 0; status <= 600; status += 1) {
  statuses.push({ status, output: delay.isRetryableError(status) });
}

const messages = [
  "",
  "plain failure",
  "Network Error",
  "request timeout",
  "Connection refused",
  "fetch failed",
  "request aborted",
  "errno ECONNRESET",
  "read ECONNRESET",
  "connect ECONNREFUSED",
  "getaddrinfo ENOTFOUND",
  "socket hang up",
  "500 Internal Server Error",
  "VALIDATION failed",
].map((input) => ({ input, output: delay.isNetworkError(input) }));

const jitter = [
  { min: -1, max: 2 },
  { min: 2, max: -1 },
  { min: 5, max: 1 },
].map(({ min, max }) => {
  let error = null;
  try {
    delay.getRandomJitterDelay(min, max);
  } catch (err) {
    error = err.message;
  }
  return { min, max, error };
});

console.log(JSON.stringify({ statuses, messages, jitter }, null, 2));
