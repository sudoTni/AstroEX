# SQLite job-repository lifecycle

`JobRepository` is the shared, SQLite-backed duplicate guard for the Indeed pipeline. It retains three independent checkpoints for the configured retention period (30 days by default):

1. `acquire-jobs` records discovery.
2. A job-description producer may record a description checkpoint.
3. `jobJudge` records successful evaluation.

Discovery alone does not cause `jobJudge` to skip a job. Only an active evaluation checkpoint does. All active commands can disable repository use for a deliberate replay with `--no-use-jobdb`.

## Storage and migration

- Database: `data/jobDB.sqlite`
- Journal mode: WAL
- Write durability: SQLite `synchronous=FULL`
- Capacity: 250,000 records by default

At first database initialization, the repository reads `data/jobDB.json` if it exists. It imports only well-formed records explicitly marked `source: "indeed"`, records an import-complete marker in SQLite, and leaves the JSON file unchanged. LinkedIn and source-less legacy entries are skipped. Subsequent starts do not re-import the JSON file.

## Identity and retention

An Indeed source ID is authoritative. When it is absent, the `jk` URL query parameter is used; company and title are the final fallback. Expired rows are removed before normal operations.

When capacity is reached, the repository removes only the oldest discovery-only records. Description and evaluation checkpoints are never evicted for capacity. If all rows are protected, new discovery records are safely left unrecorded; a new description or evaluation checkpoint fails explicitly instead of weakening duplicate protection.

## Backups and tests

`createBackup()` produces a checkpointed SQLite copy beside the database with a `.bak` suffix. The repository behavior is covered by:

```bash
npm run test:jobdb-flow
```
