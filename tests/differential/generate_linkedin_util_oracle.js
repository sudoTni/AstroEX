// Differential oracle generator for LinkedIn utility pure functions.
//
// Usage:
//   node tests/differential/generate_linkedin_util_oracle.js /path/to/AstroEX-node \
//     > tests/fixtures/linkedin_util_oracle.json

const path = require("path");
const nodeRepo = process.argv[2];
if (!nodeRepo) {
  console.error("usage: node generate_linkedin_util_oracle.js /path/to/AstroEX-node");
  process.exit(2);
}
const util = require(path.join(nodeRepo, "dist/acquisition/jobspy/linkedinUtil.js"));

const jobTypeInputs = [
  undefined,
  null,
  "",
  "fulltime",
  "full-time",
  "FULL_TIME",
  "full time",
  "parttime",
  "Internship",
  "contract",
  "temporary",
  "unknown",
];

const jobType = jobTypeInputs.map((input) => ({
  input: input === undefined ? null : input,
  output: util.jobTypeCode(input === undefined ? undefined : input),
}));

const linkedinRemote = [
  { title: "Remote Engineer", description: null, location: null },
  { title: "Software Engineer", description: "Work from home available", location: "Austin" },
  { title: "Engineer", description: null, location: "WFH" },
  { title: "Telecommute role", description: null, location: null },
  { title: "Onsite Engineer", description: null, location: "New York" },
  { title: "Virtual assistant", description: "", location: "" },
  { title: null, description: null, location: null },
  { title: "Office based role", description: null, location: null },
].map((c) => ({ ...c, output: util.isLinkedInRemote(c.title, c.description, c.location) }));

const nonRemote = [
  { title: "Onsite Engineer", location: "New York" },
  { title: "On-site role", location: "NYC" },
  { title: "In-office position", location: null },
  { title: "Office based", location: "" },
  { title: "Onsite but remote friendly", location: null },
  { title: "Remote", location: null },
  { title: null, location: null },
].map((c) => ({ ...c, output: util.isExplicitlyNonRemote(c.title, c.location) }));

const jobIds = [
  "https://www.linkedin.com/jobs/view/1234567890",
  "https://www.linkedin.com/jobs/view/senior-engineer-1234567890?refId=abc",
  "https://www.linkedin.com/jobs/search/?currentJobId=987654321",
  "https://www.linkedin.com/jobs/search/?currentJobId=notnumeric",
  "https://www.linkedin.com/jobs/view/12345",
  "https://www.linkedin.com/jobs/view/12345678",
  "not a url 123456789",
  "https://example.com/path/87654321",
  "",
  "https://www.linkedin.com/jobs/view/title-without-digits",
].map((url) => ({ input: url, output: util.extractJobIdFromUrl(url) ?? null }));

const salaryIntervals = [
  "120000/yr",
  "120,000 per year",
  "$5000 monthly",
  "100000 annually",
  "200 per week",
  "300 daily",
  "50 hourly",
  "50 /hr",
  "no interval here",
  "YEARLY PAY",
].map((text) => ({ input: text, output: util.parseSalaryInterval(text) ?? null }));

const currencySymbols = [
  "$120,000",
  "€90000",
  "£80000",
  "₹1500000",
  "C$100000",
  "A$100000",
  "120000",
  "CAD 100000",
].map((text) => ({ input: text, output: util.parseCurrencySymbol(text) }));

const salaryInfos = [
  "$120,000 - $150,000/yr",
  "€90,000 - €110,000 per year",
  "100000 - 120000",
  "50000",
  "C$100000 - C$120000",
  "invalid",
  "",
  "120000 - abc",
  "50.5 - 60.5 hourly",
].map((text) => {
  const result = util.parseSalaryInfo(text);
  return { input: text, output: result ?? null };
});

console.log(
  JSON.stringify({ jobType, linkedinRemote, nonRemote, jobIds, salaryIntervals, currencySymbols, salaryInfos }, null, 2),
);
