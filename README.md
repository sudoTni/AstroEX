# AstroEX v0.13.0

<p align = "center"><img width="803" height="550" alt="astroex_ss00" src="https://github.com/user-attachments/assets/3c8087fa-c043-4197-b436-91ef7e83d0a0" /></p>

AstroEX is a Node.js/TypeScript command-line pipeline for acquiring Indeed jobs, normalizing and filtering them, evaluating their fit with LLMs, and generating tailored application materials. It uses SQLite for durable duplicate protection and stage checkpoints so interrupted runs can resume safely.

The active product scope is Indeed only. LinkedIn acquisition and browser-scraping workflows have been retired.

**Disclaimer:** AstroEX automates the acquisition and processing of job-listing data associated with Indeed. Use of automated tools to access, query, crawl, scrape, collect, store, or otherwise process Indeed content may be restricted or prohibited by Indeed’s Terms of Service, Site Rules, robots.txt directives, API/developer agreements, documentation, rate limits, or other applicable policies unless the activity is expressly authorized by Indeed. Users are solely responsible for determining whether their particular configuration and use of AstroEX—including any scraper, automated acquisition mechanism, API integration, or third-party data-acquisition component—complies with the then-current terms, permissions, and applicable law. Unauthorized automated access may result in blocked requests, suspension or termination of accounts or API credentials, or other remedies available to Indeed. This project does not grant, imply, or represent permission from Indeed, is not affiliated with or endorsed by Indeed, and should not be construed as legal advice. Before using AstroEX with Indeed, users should review the current governing terms and obtain any required authorization or independent legal advice as appropriate.

## Pipeline at a glance

| Stage        | Command         | Reads                                                        | Writes                                             |
| ------------ | --------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| 1. Acquire   | `acquire-jobs`  | Search terms and Indeed results                              | Canonical `acquired_jobs_*.json`                   |
| 2. Process   | `processData`   | Every `acquired_jobs_*.json` in the selected input directory | Normalized, filtered, deduplicated job array       |
| 3. Prefilter | `jobCloth`      | Processed job array and applicant resume                     | Jobs whose titles merit deeper evaluation          |
| 4. Evaluate  | `jobJudge`      | Clothed jobs and applicant profile                           | Per-job JSON in `astroapply_eval_{pass,fail,dupe}` |
| 5. Generate  | `makeMaterials` | Passing evaluations and applicant profile                    | One tailored text bundle per job                   |

`run-pipeline` executes all five stages, runs preflight validation first, and can optionally deploy generated text files with `rclone`.

## Requirements

- Node.js 22.13.0 or newer
- npm
- An API key accepted by the LLM provider selected in `config/presets.json`
- An Indeed client key supplied through `ASTROEX_INDEED_API_KEY` for acquisition
- `rclone` only when deployment is enabled

From a source checkout:

```bash
npm ci
npm run build
cp -R profile.example profile
```

The project compiles as strict TypeScript to CommonJS in `dist/`.

## Configuration

AstroEX reads configuration from CLI arguments and environment variables. It does **not** automatically load a `.env` file. Use `.env.example` as a template for your shell, process manager, or secrets manager.

For example:

```bash
export AEX_OR_API_KEY="your-provider-key"
export ASTROEX_INDEED_API_KEY="your-indeed-client-key"
export ASTROEX_PROFILE_DIR="/private/path/astroex-profile"
export ASTROEX_DATA_DIR="/private/path/astroex-state/data"
export ASTROEX_LOG_DIR="/private/path/astroex-state/logs"
export ASTROEX_MATERIALS_DIR="/private/path/astroex-state/materials"
```

Never commit real credentials or pass them in scripts. A CLI `--api-key` value may also be visible in shell history and process listings; the environment-based `run-pipeline` workflow is preferred for unattended use.

### Profile directory

`ASTROEX_PROFILE_DIR` defaults to the ignored `profile` directory in the project. Copy `profile.example` to `profile`, then replace its generic sample content before a real run. A profile can contain:

| File                          | Purpose                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `search_terms.txt`            | One search term per line. Blank lines and lines beginning with `#` are ignored. |
| `my_resume.txt`               | Resume supplied to the LLM stages.                                              |
| `my_professional_title.txt`   | Current professional title.                                                     |
| `my_professional_summary.txt` | Current professional summary.                                                   |
| `my_key_skills.txt`           | Current skills inventory.                                                       |
| `my_testimonials.txt`         | Testimonials supplied during evaluation and generation.                         |
| `company_filters.txt`         | Case-insensitive company substrings excluded by `processData`.                  |
| `title_filters.txt`           | Case-insensitive title substrings excluded by `processData`.                    |

Preflight requires non-empty `search_terms.txt` and `my_resume.txt`. Missing optional applicant files are replaced with explicit placeholder text, so complete them before a real LLM run.

### Environment variables

| Variable                              | Effect                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `AEX_OR_API_KEY`                      | Preferred API-key fallback for `run-pipeline`.                             |
| `OPENAI_API_KEY`                      | Secondary pipeline fallback; also used directly by standalone `jobJudge`.  |
| `ASTROEX_INDEED_API_KEY`              | Indeed client key required by job acquisition.                             |
| `ASTROEX_PROFILE_DIR`                 | Applicant profile and filter directory.                                    |
| `ASTROEX_DATA_DIR`                    | Job artifacts, statistics, and `jobDB.sqlite`.                             |
| `ASTROEX_LOG_DIR`                     | Log and optional payload-diagnostic directory.                             |
| `ASTROEX_MATERIALS_DIR`               | Generated application-materials directory.                                 |
| `ASTROEX_DEPLOYED_MATERIALS_DIR`      | Local archive used after successful deployment.                            |
| `ASTROEX_JOB_CLOTH_PRESET`            | Default JobCloth preset for `run-pipeline`.                                |
| `ASTROEX_JOB_JUDGE_PRESET`            | Default JobJudge preset for `run-pipeline`.                                |
| `ASTROEX_MAKE_MATERIALS_PRESET`       | Default MakeMaterials preset for `run-pipeline`.                           |
| `ASTROEX_MAX_LLM_REQUESTS`            | Maximum provider requests for the process.                                 |
| `ASTROEX_MAX_LLM_OUTPUT_TOKENS`       | Maximum declared output tokens per request.                                |
| `ASTROEX_MAX_TOTAL_LLM_OUTPUT_TOKENS` | Maximum total reserved output tokens across requests.                      |
| `ASTROEX_LLM_DEADLINE_MS`             | Wall-clock deadline for LLM activity.                                      |
| `ASTROEX_HIDE_REASONING=1`            | Suppress reasoning/thinking-token display.                                 |
| `ASTROEX_REMOTE_ONLY=1`               | Strict remote-only retention for `run-pipeline`; standalone uses its flag. |
| `AEX_DEPLOY_DESTINATION`              | `rclone` destination used with `run-pipeline --deploy`.                    |
| `NO_COLOR` or `ASTROEX_NO_COLOR`      | Disable ANSI color output.                                                 |

Directory overrides may be absolute or relative to the directory from which AstroEX is invoked.

### Presets and prompts

`config/presets.json` selects the provider, base URL, model, prompt template, sampling values, and output-token ceiling for each LLM stage. Presets are grouped under `jobCloth`, `jobJudge`, and `makeMaterials`; each command validates that its selected preset belongs to the correct group.

Prompt templates live in `prompts/`. The shared Veritas system prompt lives in `sysprompts/veritas_sys_prompt.txt`.

OpenRouter and Poe use the implemented OpenAI-compatible transports. Direct Gemini and Mistral transports are currently stubs that throw at runtime; consequently, `jep_gas-gf2.0t` and `rop_m-l_01` are listed presets but are not operational until those integrations are implemented.

List current preset names and all supported options with:

```bash
npm run start -- jobCloth --help
npm run start -- jobJudge --help
npm run start -- makeMaterials --help
```

## Quick start: complete pipeline

Set the API key and profile directory, then validate the environment without making provider requests:

```bash
export AEX_OR_API_KEY="your-provider-key"
export ASTROEX_INDEED_API_KEY="your-indeed-client-key"
export ASTROEX_PROFILE_DIR="/private/path/astroex-profile"

npm run start -- preflight \
  --require-api-key \
  --require-indeed-api-key \
  --presets "jc_glm-5.3-flash,jep_glm-5.3-flash,rop_g5.6-luna_or"
```

Run the pipeline:

```bash
npm run pipeline -- \
  --search-terms-file "search_terms.txt" \
  --jobcloth-preset "jc_glm-5.3-flash" \
  --jobjudge-preset "jep_glm-5.3-flash" \
  --makematerials-preset "rop_g5.6-luna_or" \
  --batch 25 \
  --sleep 5 \
  --results-wanted 50 \
  --hours-old 24 \
  --jc-reasoning-effort "low" \
  --jj-reasoning-effort "high" \
  --mm-reasoning-effort "max"
```

For `run-pipeline`, a relative `--search-terms-file` is resolved **inside `ASTROEX_PROFILE_DIR`**. Pass `search_terms.txt`, as above, or pass an absolute path. Do not prefix the default filename with the profile-directory name.

The pipeline defaults are:

- Presets: `jc_glm-5.3-flash`, `jep_glm-5.3-flash`, and `rop_g5.6-luna_or`
- Acquisition: up to 9,999 results per search term, posted within 24 hours
- JobCloth batch size: 25
- JobJudge delay: 5 seconds per evaluation
- Reasoning and response streaming enabled unless suppressed
- Deployment and strict remote-only filtering disabled

Use `--skip-acquisition` to reuse acquisition artifacts, or `--skip-materials` to stop after JobJudge. Downstream stages still run when acquisition is skipped.

## Step-by-step workflow

Explicit paths make standalone runs deterministic. The examples below assume the default runtime directories. An isolated `ASTROEX_DATA_DIR` is recommended because `processData` intentionally reads every matching acquisition artifact in that directory; when using an override, update the explicit paths accordingly.

### 1. Acquire jobs

```bash
npm run acquire:jobs -- \
  --search-terms "security engineer" \
  --locations "New York, NY" \
  --results-wanted 50 \
  --hours-old 24 \
  --description-mode available \
  --output-file "./data/acquired_jobs_indeed.json"
```

Standalone `acquire-jobs` defaults to a remote source query (`--remote`). Use `--no-remote` for a broad search. `--remote-only` is a stricter post-acquisition filter that retains only records where `isRemote === true`; false, missing, null, and indeterminate values are discarded. The full pipeline performs a broad search by default and enables the remote source query and strict filter together when `--remote-only` or `ASTROEX_REMOTE_ONLY=1` is set.

An existing output file is treated as an acquisition checkpoint. Valid canonical jobs are loaded, deduplicated, and preserved before new search results are appended atomically.

### 2. Normalize, filter, and deduplicate

```bash
npm run process -- \
  --input-dir "./data" \
  --output-file "./data/processed_jobs_indeed.json"
```

`processData` reads `acquired_jobs_*.json`, accepts canonical or historical Indeed-shaped entries, rejects retired/unknown sources, applies the profile and CLI exclusion filters, and deduplicates by job ID and normalized title/company pair. It replaces its output atomically and writes a companion integrity manifest.

### 3. Prefilter with JobCloth

```bash
npm run job:cloth -- \
  --input-file "./data/processed_jobs_indeed.json" \
  --output-file "./data/clothed_jobs_indeed.json" \
  --preset "jc_glm-5.3-flash" \
  --api-key "$AEX_OR_API_KEY"
```

JobCloth evaluates unique job titles in batches against the resume, then retains all jobs associated with accepted titles. Failed batches are retried and can fall back to individual title evaluation. Its output has a SHA-256 manifest and a durable stage checkpoint.

### 4. Evaluate with JobJudge

```bash
npm run job:judge -- \
  --input-file "./data/clothed_jobs_indeed.json" \
  --preset "jep_glm-5.3-flash" \
  --api-key "$AEX_OR_API_KEY" \
  --sleep 2
```

JobJudge evaluates each Indeed job with a non-empty description against the applicant profile. Results are written to `astroapply_eval_pass`, `astroapply_eval_fail`, or `astroapply_eval_dupe` under the selected data directory. Each newly evaluated pass/fail result has a companion manifest; duplicate markers do not. The SQLite repository prevents an already-judged job from being evaluated again during the retention period.

### 5. Generate application materials

```bash
npm run makeMaterials -- \
  --preset "rop_g5.6-luna_or" \
  --api-key "$AEX_OR_API_KEY"
```

Without `--targ-jd`, MakeMaterials processes every non-manifest JSON file in `astroapply_eval_pass`. It creates a job-specific directory containing a text bundle with job metadata, tailored title, summary, skills, and cover letter, plus a companion integrity manifest. The standalone command currently requires `--api-key` even when an API-key environment variable is set.

## Reasoning, streaming, and payload diagnostics

Phase-specific reasoning-effort options are passed through as opaque provider values:

- `--jc-reasoning-effort <value>` for JobCloth
- `--jj-reasoning-effort <value>` for JobJudge
- `--mm-reasoning-effort <value>` for MakeMaterials

Standalone stage commands also accept `--reasoning-effort` as an alias for their phase-specific option. Omitting the option omits `reasoning_effort` from the provider payload and preserves the provider default.

Use `--hide-reasoning` (aliases: `--hr`, `--hide-reasoning-tokens`) or `ASTROEX_HIDE_REASONING=1` to suppress reasoning output. Standalone commands offer `--show-stream`/`--ss`; the complete pipeline streams response content by default.

`--log-payload` writes the complete outbound LLM payload to the configured log directory with owner-only file permissions. Those payloads can contain resumes, testimonials, and full job descriptions. Enable this only for controlled debugging, protect the log directory, and remove diagnostics when they are no longer needed.

## Runtime data and integrity

Default locations are relative to the project:

| Path                                       | Contents                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `data/acquired_jobs_*.json`                | Canonical Indeed acquisition checkpoints. The pipeline uses `acquired_jobs_indeed.json`. |
| `data/processed_jobs*.json`                | Normalized jobs. The pipeline uses `processed_jobs_indeed.json`.                         |
| `data/clothed_jobs*.json`                  | JobCloth output. The pipeline uses `clothed_jobs_indeed.json`.                           |
| `data/astroapply_eval_pass/*.json`         | Passing JobJudge results.                                                                |
| `data/astroapply_eval_fail/*.json`         | Failing JobJudge results.                                                                |
| `data/astroapply_eval_dupe/*.json`         | Jobs already marked evaluated in SQLite.                                                 |
| `data/jobDB.sqlite`                        | Duplicate-protection and stage-checkpoint database.                                      |
| `data/statistics/` and `data/*stats*.json` | Per-command execution statistics.                                                        |
| `logs/`                                    | Human-readable logs and optional sensitive payload diagnostics.                          |
| `materials/`                               | Generated application-material bundles and statistics.                                   |
| `materials-deployed/`                      | Local archive populated after deployment.                                                |

ProcessData, JobCloth, JobJudge, and MakeMaterials write `*.manifest.json` files containing the artifact basename, creation metadata, and SHA-256 digest. Verify one with:

```bash
npm run start -- artifact verify "./data/processed_jobs_indeed.json"
```

The command exits non-zero when the manifest is invalid or the artifact hash does not match.

### SQLite repository

`JobRepository` uses Node's built-in SQLite API with strict tables, transactional writes, WAL journaling, full synchronous writes, and a five-second busy timeout. Job records expire after 30 days by default, and the default capacity is 250,000 records. Capacity eviction removes only the oldest discovery-only records; completed evaluation records are protected from capacity eviction until normal expiry.

On first initialization, `data/jobDB.sqlite` imports valid Indeed records from the retired `data/jobDB.json` exactly once. The legacy JSON file is not changed or deleted. LinkedIn and source-less records are skipped. See [SQLite job-repository lifecycle](docs/jobDB_feature.md).

Stage checkpoints are keyed by stage, input hash, preset, and model. JobCloth, JobJudge, and MakeMaterials record incremental progress so completed work can be skipped after interruption. Changing the input content, preset, or model creates a different checkpoint identity.

Use the operational commands instead of editing the database directly:

```bash
npm run start -- jobdb status
npm run start -- jobdb verify
npm run start -- jobdb backup
npm run start -- jobdb rotate-backups --keep 10
```

`verify` exits non-zero when SQLite reports an integrity failure. `backup` creates a WAL-checkpointed timestamped `.bak` snapshot beside the database. `rotate-backups` removes older timestamped backups only; it never removes the live database or retired JSON file.

## Cleanup and deployment safety

`run-pipeline --clean` removes the configured acquired, processed, and clothed pipeline files plus the three evaluation directories before processing. It preserves `jobDB.sqlite`, logs, generated materials, and unrelated timestamped acquisition files. Because `processData` scans all `acquired_jobs_*.json` files in its input directory, use an isolated data directory when you need a completely clean input set.

Deployment is opt-in:

```bash
npm run pipeline -- \
  --deploy \
  --deploy-destination "RemoteName:/path/to/destination"
```

The deployment stage flattens generated `.txt` files into a temporary staging directory, renames duplicate basenames to prevent overwrites, and invokes `rclone copy`. After `rclone` succeeds—or immediately when no `.txt` files are found—**all entries in the local materials directory are moved to the local deployed-materials archive**. Confirm the destination and local directory overrides before enabling this option.

## Logging and machine-readable output

Common CLI controls include:

- `--log-dir <path>` and `--log-file <name>`
- `--log-level trace|debug|info|success|warn|error|fatal`
- `--log-format pretty|json`
- `--disable-file-logging`
- `--no-banner` and `--no-color`
- `--json` for machine-oriented output where supported
- `--verbose`/`-v` on commands that expose verbose diagnostics

Secrets and common credential-shaped fields are redacted from structured logs. Payload-diagnostic files are intentionally exempt because their purpose is to capture complete requests.

## Command reference

```text
run-pipeline   Run the complete workflow with preflight and optional deployment.
acquire-jobs   Acquire canonical Indeed records.
processData    Normalize, filter, and deduplicate acquisition artifacts.
jobCloth       Perform fast title-level LLM prefiltering.
jobJudge       Perform detailed applicant/job alignment evaluation.
makeMaterials  Generate tailored application materials for passing jobs.
preflight      Validate paths, profile files, presets, API key, and SQLite.
jobdb          Inspect, verify, back up, or rotate the SQLite repository.
artifact       Verify an artifact against its SHA-256 manifest.
```

Run `npm run start -- <command> --help` for the authoritative option list.

## Development and validation

```bash
npm run typecheck          # Strict TypeScript check without emitting files
npm test                   # Clean-build dist/ and run all Node test files
npm run check              # Typecheck, then clean-build and run all tests
npm run lint               # Run Biome checks
npm run format:check       # Check Biome formatting
npm run audit              # Run npm's dependency audit
```

Targeted scripts include `test:jobdb-flow`, `test:statistics`, `test:acquisition`, `test:logging`, `test:jobcloth-payload`, and `test:remote-only`.

The current `lint`, `lint:fix`, `format`, and `format:check` npm scripts remove `dist/` before running Biome. Run `npm run build` afterward when you need compiled CLI output.

Tests are JavaScript files under `test/` and exercise the compiled modules in `dist/`. `npm test` rebuilds `dist/` first.

## Troubleshooting

- **Search-term file not found:** for `run-pipeline`, use a filename relative to `ASTROEX_PROFILE_DIR` or an absolute path. Standalone `acquire-jobs` accepts a normal filesystem path.
- **No jobs reach JobJudge:** do not use `acquire-jobs --description-mode none`; JobJudge skips jobs without `descriptionText`.
- **Unexpected older jobs are processed:** `processData` merges every `acquired_jobs_*.json` in its input directory. Move unrelated artifacts or select an isolated directory.
- **A completed stage is skipped:** checkpoint reuse requires matching input content, preset, and model. Change one of those inputs or inspect the repository before removing state.
- **Preflight changes the filesystem:** it creates missing runtime directories, writes and removes owner-readable probe files, and initializes/verifies `jobDB.sqlite`; it makes no network requests.
- **Deployment fails:** confirm `rclone` is in `PATH`, the destination is configured, and the current credentials can write to it.

## LinkedIn retirement

LinkedIn URLs, artifacts, and repository records are not accepted by the active pipeline. Historical files are left untouched as user data, but they are neither imported into SQLite nor passed through ProcessData.

## Additional documentation

- [SQLite job-repository lifecycle](docs/jobDB_feature.md)
- [Indeed acquisition integration](docs/jobspy-integration.md)

## License

AstroEX is licensed under the MIT License; see [LICENSE.md](LICENSE.md). The Indeed acquisition implementation includes adapted components from `ts-jobspy-main` under the MIT License; see [Indeed acquisition integration](docs/jobspy-integration.md).
