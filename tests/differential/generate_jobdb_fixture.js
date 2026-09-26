// Generates a SQLite jobDB fixture with the real Node JobRepository so the Rust
// implementation can be tested for on-disk compatibility.
//
// Usage:
//   node tests/differential/generate_jobdb_fixture.js /path/to/AstroEX-node out/jobDB.sqlite

const path = require("path");
const nodeRepo = process.argv[2];
const output = process.argv[3];
if (!nodeRepo || !output) {
  console.error("usage: node generate_jobdb_fixture.js /path/to/AstroEX-node <out.sqlite>");
  process.exit(2);
}
const { JobRepository } = require(path.join(nodeRepo, "dist/jobRepository.js"));

(async () => {
  const repo = new JobRepository({
    dbFilePath: output,
    legacyJsonPath: null,
    enableJobDB: true,
    defaultExpirationMs: 30 * 24 * 60 * 60 * 1000,
    maxRecords: 250000,
  });
  await repo.initialize();

  // Discovery-only entries.
  await repo.addSearchedJobs([
    { id: "indeed:seen-1", source: "indeed", title: "Seen One", company: "Acme" },
    { id: "linkedin:seen-2", source: "linkedin", title: "Seen Two", company: "Globex" },
  ]);

  // Fully judged entries.
  await repo.addJob({ id: "indeed:judged-1", source: "indeed", title: "Judged One", company: "Acme" });
  await repo.addJob({ id: "linkedin:judged-2", source: "linkedin", title: "Judged Two", company: "Globex" });

  // jobCloth history (drives cool-off + last_processed).
  await repo.recordJobClothProcessed(
    [
      { id: "indeed:processed-1", source: "indeed", title: "Processed One", company: "Acme" },
      { id: "linkedin:processed-2", source: "linkedin", title: "Processed Two", company: "Globex" },
    ],
    1_700_000_000_000,
  );

  // A completed stage checkpoint.
  const inputHash = "a".repeat(64);
  repo.saveStageCheckpoint({
    stage: "jobCloth",
    inputPath: "/tmp/input.json",
    inputHash,
    outputPath: "/tmp/output.json",
    outputHash: "b".repeat(64),
    preset: "jc_glm-5.3-flash",
    model: "z-ai/glm-5.3-flash",
    status: "completed",
    completedJobs: 2,
    processedJobIds: ["indeed:processed-1", "linkedin:processed-2"],
    totalJobs: 2,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });
  repo.recordJobInCheckpoint(
    "jobCloth",
    inputHash,
    "jc_glm-5.3-flash",
    "z-ai/glm-5.3-flash",
    "indeed:processed-1",
  );

  const health = repo.verifyIntegrity();
  const stats = repo.getStats();
  await repo.close();

  process.stderr.write(`${JSON.stringify({ health, stats })}\n`);
})();
