# jobDB duplicate-protection lifecycle

## Overview

`jobDB` is the shared, JSON-backed duplicate guard for the job pipeline. It protects a job description (JD) from repeat processing for 30 days while allowing it to advance through three distinct stages:

1. `scrape-search` discovers a LinkedIn job post.
2. `scrape-job` or `scrape-jobs` downloads and persists its detailed job description (JD).
3. `jobJudge` evaluates the JD.

The stages are intentionally independent. Discovering a post must not prevent its first JD download, and downloading a JD must not prevent its first evaluation.

## Default behavior

- Database: `data/jobDB.json`
- Retention: 30 days (`2,592,000,000` milliseconds)
- Enabled by default in `acquire-jobs`, `scrape-search`, `scrape-job`, `scrape-jobs`, and `jobJudge`
- Disable for an exceptional replay with `--no-use-jobdb`
- Expired entries are removed when each protected command starts

The retention value is shared through `JOB_DB_RETENTION_MS` in `src/constants.ts`.

## Matching rules

- All supported sources: the source-qualified provider ID is authoritative (`linkedin:…` and `indeed:…` cannot collide). If an explicit ID is missing, a canonicalized job URL is used. Company/title is a fallback only when neither is available.
- `scrape-search`: records discovery and removes duplicates found more than once during one search run.
- `scrape-job` and `scrape-jobs`: check the independent JD checkpoint; `scrape-jobs` also uses a same-run ID/URL set. This prevents historical files from causing repeat JD downloads.
- `jobJudge`: checks the independent judged checkpoint. A discovered or downloaded-but-not-yet-judged job still receives its first evaluation.

Two distinct provider IDs with the same company and title are never treated as duplicates. This avoids dropping separate listings from the same employer while still preventing the same JD from being handled again.

## Entry schema

```json
{
  "linkedInJobId": "1234567890",
  "source": "linkedin",
  "sourceJobId": "1234567890",
  "company": "Tech Corp",
  "title": "Security Engineer",
  "admitTime": 1786352201875,
  "descriptionScrapedAt": 1786352801875,
  "lastProcessed": 1786353401875,
  "searchOnly": true
}
```

- `linkedInJobId`: legacy on-disk compatibility ID. Its name is retained for existing databases.
- `source` and `sourceJobId`: the authoritative, source-qualified identity for LinkedIn and Indeed records.
- `company`, `title`: identity and judge-level duplicate fields.
- `admitTime`: retention anchor; refreshed when the JD is downloaded or the job is judged.
- `descriptionScrapedAt`: set after `scrape-job` or `scrape-jobs` successfully writes the JD.
- `lastProcessed`: set after `jobJudge` processes the job.
- `searchOnly`: remains `true` until jobJudge. A description checkpoint can therefore suppress another download without suppressing the first evaluation. It is removed when the job is judged.

Older entries without `descriptionScrapedAt` remain compatible. A legacy judged entry is treated as having already passed the JD-download stage.

## Lifecycle

### Search discovery

`addSearchedJobs()` adds a new `searchOnly` entry. `isJobSeen()` prevents that post from being emitted by later search runs during the retention window.

### JD download

`isJobDescriptionScraped()` allows a search-only entry through once. After a successful output write, `markJobDescriptionScraped()` records the checkpoint. Failed downloads are not checkpointed and remain retryable.

### Evaluation

`isJobMatched()` ignores search-only entries, including entries with a downloaded JD, so the first evaluation proceeds. `addJob()` promotes the existing entry in place only after the evaluation result is written, sets `lastProcessed`, and clears `searchOnly`. Failed downloads, API calls, and evaluation-result writes receive no judged checkpoint and remain retryable.

### Expiration

`cleanupExpired()` removes entries whose `admitTime` is at least 30 days old. The post may then be discovered, downloaded, and evaluated again.

### Capacity behavior

The default capacity is 250,000 entries, sized for high-volume 30-day searches. If a configured capacity is reached, jobDB removes the oldest *discovery-only* entries first. It will not evict a still-active JD-download or judged checkpoint, because doing so would break the duplicate-processing guarantee. If every retained record is protected, further discovery records are safely left unrecorded (and a warning is logged); a new JD or judgment checkpoint fails explicitly rather than silently weakening the 30-day window.

## CLI examples

```bash
# Protection is enabled by default
npm run scrape:search
npm run scrape:job -- --url "https://www.linkedin.com/jobs/view/..."
npm run scrape:jobs
npm run job:judge

# Exceptional replay without jobDB protection
npm run scrape:jobs -- --no-use-jobdb
```

## API reference

- `initialize()`, `load()`, `save()`, `close()`
- `cleanupExpired()`
- `isJobSeen()`, `addSearchedJobs()`
- `isJobDescriptionScraped()`, `markJobDescriptionScraped()`
- `isJobMatched()`, `addJob()`
- `removeJob()`, `size()`, `getAllEntries()`, `getStats()`

## Verification

```bash
npm run test:jobdb-flow
```

The regression suite covers exact-ID search suppression, same-run duplicates, the full stage lifecycle, direct JD scraping, judge promotion, historical file exclusion, 30-day configuration, and expiration/re-entry.

## Troubleshooting

- If jobs are unexpectedly repeated, confirm all three commands use the same `data/jobDB.json` and were not run with `--no-use-jobdb`.
- If a new job is unexpectedly skipped at search or JD download, inspect its `linkedInJobId` and timestamps.
- If a job is skipped only by jobJudge, compare its normalized company/title with judged entries.
- Do not delete `data/jobDB.json` between normal pipeline runs; it is the retained state that provides the 30-day guarantee.
