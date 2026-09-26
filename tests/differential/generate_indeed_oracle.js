// Differential oracle generator for Indeed pure helpers.
//
// Usage:
//   node tests/differential/generate_indeed_oracle.js /path/to/AstroEX-node \
//     > tests/fixtures/indeed_oracle.json

const path = require("path");
const nodeRepo = process.argv[2];
if (!nodeRepo) {
  console.error("usage: node generate_indeed_oracle.js /path/to/AstroEX-node");
  process.exit(2);
}
const indeed = require(path.join(nodeRepo, "dist/acquisition/jobspy/indeed.js"));

const filters = [
  {},
  { hoursOld: 24 },
  { hoursOld: 0 },
  { hoursOld: 48, remoteOnly: true, easyApply: true },
  { remoteOnly: true, easyApply: true },
  { remoteOnly: true },
  { remoteOnly: true, jobType: "fulltime" },
  { remoteOnly: true, jobType: "unknown" },
  { easyApply: true },
  { isRemote: true },
  { isRemote: false },
  { jobType: "contract" },
  { jobType: "internship", isRemote: true },
  { jobType: "parttime" },
  { jobType: "unknown" },
].map((options) => {
  let value;
  let error = null;
  try {
    value = indeed.buildIndeedFilters(options);
  } catch (err) {
    value = null;
    error = err.message;
  }
  return { options, value, error };
});

const remoteJobs = [
  { attributes: [{ key: "DSQF7", label: "Remote" }] },
  { title: "Remote Engineer" },
  { location: { formatted: { long: "Work from home" } } },
  { attributes: [{ key: "X", label: "remote friendly" }] },
  { title: "Engineer", location: { formatted: { long: "New York" } } },
  {},
  { attributes: [{ key: "WFH", label: "Work From Home" }] },
  { title: "work-from-home role" },
  { attributes: [] },
  { title: "Telework", location: { formatted: {} } },
].map((job) => ({ job, output: indeed.isIndeedRemoteJob(job) }));

console.log(JSON.stringify({ filters, remoteJobs }, null, 2));
