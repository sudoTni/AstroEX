// Differential oracle generator for the canonical -> legacy job projection.
//
// Usage:
//   node tests/differential/generate_normalize_oracle.js /path/to/AstroEX-node \
//     > tests/fixtures/normalize_oracle.json
//
// Runs the real AstroEX-node toLegacyJob over a fixed corpus of canonical
// acquired jobs and prints JSON goldens consumed by
// tests/normalize_differential.rs.

const path = require("path");
const nodeRepo = process.argv[2];
if (!nodeRepo) {
  console.error("usage: node generate_normalize_oracle.js /path/to/AstroEX-node");
  process.exit(2);
}
const { toLegacyJob } = require(path.join(nodeRepo, "dist/acquisition/normalize.js"));

const base = {
  id: "job-1",
  source: "indeed",
  canonicalUrl: "https://www.indeed.com/viewjob?jk=abc123",
  title: "Senior Security Engineer",
  company: "Acme",
  descriptionRepresentation: "markdown",
  acquiredAt: "2026-01-02T03:04:05.678Z",
};

const corpus = [
  base,
  {
    ...base,
    id: "job-2",
    source: "linkedin",
    sourceJobId: "987654",
    canonicalUrl: "https://www.linkedin.com/jobs/view/987654",
    directUrl: "https://boards.greenhouse.io/acme/jobs/987654",
    companyUrl: "https://acme.com",
    location: "Austin, TX, United States",
    postedAt: "2026-01-05T10:00:00.000Z",
    description: "# About\n\nWe need you.",
    descriptionRepresentation: "markdown",
    isRemote: true,
    jobType: "Full-time",
    jobLevel: "Mid-Senior level",
    jobFunction: "Engineering",
    companyIndustry: "Software Development",
    companyLogo: "https://acme.com/logo.png",
    acquiredAt: "2026-01-06T08:00:00.000Z",
  },
  {
    ...base,
    id: "job-3",
    description: "<p>HTML description</p>",
    descriptionRepresentation: "html",
    location: "Remote",
    compensation: { minAmount: 120000, maxAmount: 160000, currency: "USD" },
  },
  {
    ...base,
    id: "job-4",
    descriptionRepresentation: "plain",
    location: "Berlin, Germany",
    postedAt: "2026-01-02T03:04:05+05:00",
    compensation: { minAmount: 90000 },
  },
  {
    ...base,
    id: "job-5",
    descriptionRepresentation: "unknown",
    isRemote: false,
    compensation: { maxAmount: 100000, currency: "EUR" },
  },
  {
    ...base,
    id: "job-6",
    location: "",
    description: "text only",
    descriptionRepresentation: "markdown",
  },
];

const out = corpus.map((canonical) => ({
  canonical,
  legacy: toLegacyJob(canonical),
}));
console.log(JSON.stringify(out, null, 2));
