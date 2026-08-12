# AstroEX 5.0.0

<img width="847" height="447" alt="ss5" src="https://github.com/user-attachments/assets/6034093d-56f0-4030-913a-737013aa2e72" />

AstroEX is a Node.js and TypeScript pipeline for acquiring, filtering, ranking,
and evaluating job listings, then generating tailored application materials.
It supports source-neutral LinkedIn and Indeed acquisition, a legacy
Puppeteer-based LinkedIn workflow, configurable LLM providers, structured
logging, run statistics, and a shared duplicate checkpoint.

> [!CAUTION]
> Web scraping may violate a website's terms of service or other restrictions.
> Review the applicable terms, robots guidance, rate limits, and laws before
> using AstroEX. LinkedIn expressly restricts automated data extraction in its
> [crawling terms](https://www.linkedin.com/legal/crawling-terms). This project
> is intended for education and personal experimentation; you are responsible
> for how you use it.

## Highlights

- Acquire normalized job records from LinkedIn and Indeed.
- Scrape LinkedIn search results and full job descriptions with Puppeteer.
- Process, filter, and deduplicate JSON and NDJSON artifacts across stages.
- Prefilter titles and evaluate full descriptions with configurable LLM presets.
- Generate tailored professional summaries, skills, and cover letters.
- Suppress repeated work for 30 days with the shared JobDB checkpoint.
- Write redacted JSON Lines logs and machine-readable run statistics.
- Keep profile data, credentials, logs, and generated artifacts out of Git.

The `acquire-jobs` implementation vendors and adapts selected components from
[`ts-jobspy`](https://github.com/alpharomercoma/ts-jobspy), the MIT-licensed
TypeScript job-scraping project by Alpha Romer Coma. See
[Acknowledgments](#acknowledgments) and the
[integration note](docs/jobspy-integration.md) for full provenance.

## Workflow

The main stages are independent, so you can stop after acquisition or provide
your own compatible artifact at a later stage.

```text
acquire-jobs ─┐
              ├─> processData ─> jobCloth ─> scrape-jobs ─> jobJudge ─> makeMaterials
scrape-search ┘                       (LinkedIn descriptions)
```

- `acquire-jobs` is the source-neutral path for LinkedIn and Indeed.
- `scrape-search`, `scrape-job`, and `scrape-jobs` are LinkedIn-specific.
- `scrape-jobs` skips non-LinkedIn URLs; Indeed descriptions should be retained
  during acquisition with `--description-mode available` or `full`.
- `jobCloth`, `jobJudge`, and `makeMaterials` call third-party LLM APIs and may
  incur provider charges.

## Requirements

- Node.js 20 or newer
- npm and network access for installation and external services
- A provider API key for AI-assisted stages
- `INDEED_API_KEY` when Indeed is included in `acquire-jobs`

Puppeteer downloads a compatible Chromium build during a normal install.

## Installation

```bash
git clone <repository-url>
cd astroex
npm ci

# Create ignored local copies of the public templates.
for file in user_data/*.example; do cp "$file" "${file%.example}"; done

npm run start -- --help
```

Replace every bracketed placeholder in the copied `user_data/*.txt` files
before using AI evaluation or materials generation. The `.example` files are
public templates and must not contain real personal information.

## Credentials and private data

Pass secrets through your shell or a secret manager. For example:

```bash
export OPENROUTER_API_KEY="replace-with-a-real-key"
export INDEED_API_KEY="replace-with-a-real-key"
```

Never put keys in `config/presets.json`, prompt files, command scripts, examples,
or committed configuration. `.env.example` provides blank placeholders for
common provider variable names, but AstroEX does not load `.env` files by
itself; your shell, process manager, or secret manager must inject them.

The primary AI commands accept `--api-key`. Supplying the value from an
environment variable keeps the literal key out of the command:

```bash
npm run job:cloth -- \
  --preset jc_mai-ds-r1 \
  --api-key "$OPENROUTER_API_KEY"
```

Treat generated data as private. Job descriptions, evaluation results,
materials, and logs can contain personal details or provider payloads. The
default `.gitignore` excludes `data/`, `logs/`, `materials/`, private
`user_data/*.txt` files, `.env*`, and common credential-file formats.

## Quick start

This example runs the LinkedIn-only path, so it does not require an Indeed key.
It uses current presets from `config/presets.json`; change them to match your
provider.

```bash
# 1. Acquire recent remote listings.
npm run acquire:jobs -- \
  --sites linkedin \
  --search-terms-file ./user_data/search_terms.txt \
  --locations Remote \
  --hours-old 72 \
  --results-wanted 25 \
  --description-mode full

# 2. Merge, filter, and deduplicate acquisition artifacts.
npm run process -- \
  --input-dir ./data \
  --output-file ./data/processed_jobs.json

# 3. Use an LLM to retain promising titles.
npm run job:cloth -- \
  --preset jc_mai-ds-r1 \
  --api-key "$OPENROUTER_API_KEY"

# 4. Download detailed LinkedIn descriptions for retained jobs.
npm run scrape:jobs

# 5. Evaluate the detailed records.
npm run job:judge -- \
  --preset jep_mai-ds-r1 \
  --api-key "$OPENROUTER_API_KEY"

# 6. Generate materials for jobs that passed evaluation.
npm run makeMaterials -- \
  --preset rop_ds-v3-0324 \
  --api-key "$OPENROUTER_API_KEY"
```

Before a real run, inspect the generic templates in `prompts/` and configure
them for your intended evaluation criteria and output format.

## Acquisition

### LinkedIn and Indeed with `acquire-jobs`

`acquire-jobs` writes a source-aware JSON array to
`data/acquired_jobs_<timestamp>.json`. Supported `--sites` values are
`linkedin` and `indeed`; both are selected by default. If Indeed is selected,
`INDEED_API_KEY` must be present in the environment.

```bash
npm run acquire:jobs -- \
  --sites indeed,linkedin \
  --search-terms "Security Engineer,SOC Analyst" \
  --locations Remote \
  --hours-old 24 \
  --results-wanted 25 \
  --linkedin-results-wanted 100 \
  --indeed-country USA \
  --description-mode available
```

Relevant defaults and options:

- Searches remote roles by default; use `--no-remote` for a broader search.
- `--results-wanted 25` applies per source, term, and location.
- LinkedIn has a separate conservative limit of
  `--linkedin-results-wanted 100` per term and location.
- `--hours-old 168` limits results to the previous seven days.
- `--description-mode` accepts `none`, `available`, or `full`; `full` also
  requests each LinkedIn public detail page.
- `--description-format` accepts `markdown`, `html`, or `plain`.
- `--job-type` accepts `fulltime`, `parttime`, `contract`, or `internship`.
- `--output-file` can name a stable checkpoint. A rerun with the same path
  resumes from records already written there.

Use `npm run acquire:jobs -- --help` for the complete option list, including
distance, easy-apply, proxies, and user-agent settings.

When an acquired record already has `descriptionText`, you can pass a specific
processed or clothed JSON file directly to `jobJudge` with `--input-file`.
Otherwise, use `scrape-jobs` to retrieve detailed LinkedIn records first.

### LinkedIn-specific acquisition

The legacy browser workflow remains available when you need direct control over
LinkedIn pagination and description scraping.

```bash
# Search result cards. Search terms default to user_data/search_terms.txt.
npm run scrape:search -- \
  --search-terms "Security Engineer,SOC Analyst" \
  --locations Remote \
  --max-pages 10 \
  --sleep-min 3 \
  --sleep-max 7 \
  --retry-max 3

# One job description.
npm run scrape:job -- \
  --url "https://www.linkedin.com/jobs/view/example-1234567890"

# All LinkedIn URLs retained by jobCloth; output is NDJSON.
npm run scrape:jobs -- \
  --input-file "./data/clothed_jobs_*.json" \
  --sleep-min 2.5 \
  --sleep-max 4.5 \
  --max-retries 3
```

For `scrape-search`, `--company-filters` is an inclusion filter: only matching
companies are kept. In `processData`, company and title filters are exclusions.

## Processing and AI stages

### Process acquired data

`processData` reads `scraped_search_*.json` and `acquired_jobs_*.json` artifacts,
then filters and deduplicates them by ID and company/title.

```bash
npm run process -- \
  --input-dir ./data \
  --output-file ./data/processed_jobs.json \
  --company-filters "Example Staffing" \
  --title-filters "Intern,Director"
```

Filters from the command line are added to the ignored lists in
`user_data/company_filters.txt` and `user_data/title_filters.txt`.

### Prefilter with `jobCloth`

`jobCloth` detects `data/processed_jobs*.json` when no input is specified,
evaluates titles in batches, and writes `data/clothed_jobs_<timestamp>.json` by
default. Supply `--input-file` when multiple matching inputs are present and
you need to select one explicitly.

```bash
npm run job:cloth -- \
  --preset jc_mai-ds-r1 \
  --api-key "$OPENROUTER_API_KEY" \
  --batch 100 \
  --retries 3
```

### Evaluate with `jobJudge`

`jobJudge` auto-detects `data/scraped_jobs_*.json` and accepts JSON arrays,
single JSON objects, or NDJSON. A preset is required.

```bash
npm run job:judge -- \
  --preset jep_mai-ds-r1 \
  --api-key "$OPENROUTER_API_KEY" \
  --eval-mode 4 \
  --sleep 2
```

Results are written to `data/astroapply_eval_pass/`,
`data/astroapply_eval_fail/`, and `data/astroapply_eval_dupe/`. Use
`--strict-parsing` to stop instead of applying fallback parsing when an LLM
response is malformed.

### Generate application materials

`makeMaterials` reads evaluated jobs from `data/astroapply_eval_pass/` unless
`--targ-jd` is supplied. It also reads the ignored candidate-profile files in
`user_data/` and writes one directory per job under `materials/`.

```bash
npm run makeMaterials -- \
  --preset rop_ds-v3-0324 \
  --api-key "$OPENROUTER_API_KEY" \
  --cover-length 275 \
  --sleep-min 2.5 \
  --sleep-max 4.5
```

Presets define the provider, endpoint, model, prompt, sampling values, and
token limit. Review `config/presets.json` before running a preset because model
availability, pricing, and provider identifiers can change. Do not store keys
in presets. The CLI help is the source of truth for currently available preset
names:

```bash
npm run job:cloth -- --help
npm run job:judge -- --help
npm run makeMaterials -- --help
```

## Local configuration

Public templates live in `user_data/*.example`; ignored working copies use the
same names without `.example`.

| File                          | Purpose                                                   |
| ----------------------------- | --------------------------------------------------------- |
| `search_terms.txt`            | One job-search term per line                              |
| `company_filters.txt`         | Company-name fragments to exclude during processing       |
| `title_filters.txt`           | Job-title fragments to exclude during processing          |
| `stacks.txt`                  | Technology keywords used during matching                  |
| `my_resume.txt`               | Resume text supplied to evaluation and generation prompts |
| `my_professional_title.txt`   | Current professional title                                |
| `my_professional_summary.txt` | Current professional summary                              |
| `my_key_skills.txt`           | Current skills text                                       |
| `my_testimonials.txt`         | Optional testimonial text                                 |

Blank lines and lines beginning with `#` are ignored in list files. See
[`user_data/README.md`](user_data/README.md) for privacy guidance.

The versioned configuration files are:

- `config/presets.json` — command-specific LLM presets
- `config/prompts.json` — prompt configuration
- `prompts/job_cloth.txt` — title-prefilter prompt
- `prompts/job_judge.txt` — full job-evaluation prompt
- `prompts/materials.txt` — application-materials prompt
- `sysprompts/veritas_sys_prompt.txt` — shared system prompt

## Commands

| npm script              | CLI command     | Purpose                                    | Default output                           |
| ----------------------- | --------------- | ------------------------------------------ | ---------------------------------------- |
| `npm run acquire:jobs`  | `acquire-jobs`  | Acquire normalized LinkedIn/Indeed records | `data/acquired_jobs_<timestamp>.json`    |
| `npm run scrape:search` | `scrape-search` | Scrape LinkedIn search cards               | `data/scraped_search_<timestamp>.json`   |
| `npm run scrape:job`    | `scrape-job`    | Scrape one LinkedIn description            | generated file under `data/`             |
| `npm run process`       | `processData`   | Merge, filter, and deduplicate             | `data/processed_jobs.json`               |
| `npm run job:cloth`     | `jobCloth`      | LLM title prefilter                        | `data/clothed_jobs_<timestamp>.json`     |
| `npm run scrape:jobs`   | `scrape-jobs`   | Scrape retained LinkedIn descriptions      | `data/scraped_jobs_<timestamp>.json`     |
| `npm run job:judge`     | `jobJudge`      | Evaluate detailed jobs                     | `data/astroapply_eval_{pass,fail,dupe}/` |
| `npm run makeMaterials` | `makeMaterials` | Generate tailored materials                | `materials/`                             |

Run command-specific help with either form:

```bash
npm run acquire:jobs -- --help
npm run start -- acquire-jobs --help
```

Four low-level compatibility commands (`rop-c3.7s`, `rop-g41`, `jdd-g41m`, and
`jdd-gf2.0t`) are also listed by `npm run start -- --help`. New workflows should
prefer `jobCloth`, `jobJudge`, and `makeMaterials` with external presets.

## JobDB, logging, and artifacts

`acquire-jobs`, `scrape-search`, `scrape-job`, `scrape-jobs`, and `jobJudge`
share `data/jobDB.json`. It records discovery, description, and evaluation
checkpoints for 30 days and is enabled by default. Use `--no-use-jobdb` only
when an intentional replay is worth the duplicate requests and API calls.

Common logging controls include:

- `--log-dir <path>` — log directory; defaults to `logs/`
- `--log-file <name>` — base log filename; a timestamp is prepended
- `--log-level <debug|info|warn|error>` — minimum emitted severity
- `--disable-file-logging` — write no log file
- `--no-color`, `NO_COLOR=1`, or `ASTROEX_NO_COLOR=1` — disable terminal color
- `--no-verbose` or `--quiet` — reduce high-volume diagnostic output

File logs are redacted JSON Lines records. `--log-payload`, `--show-reasoning`,
and `--show-stream` can expose sensitive prompts or provider output; enable them
only for deliberate local debugging.

Common generated artifacts include:

- `data/acquired_jobs_*.json` — source-aware acquisition results
- `data/scraped_search_*.json` — LinkedIn search cards
- `data/processed_jobs*.json` — filtered and deduplicated records
- `data/clothed_jobs_*.json` — LLM-prefiltered records
- `data/scraped_jobs_*.json` — detailed LinkedIn records in NDJSON form
- `data/astroapply_eval_*/` — evaluation results
- `data/job_judge_reports/` — Markdown evaluation reports
- `data/*-stats_*.json` and `materials/*stats*.json` — run statistics
- `logs/` — application and optional payload logs
- `materials/` — generated application materials

These locations are runtime state and are ignored by Git.

## Development

```bash
npm run build
npm run lint
npm run format:check

npm run test:acquisition
npm run test:file-discovery
npm run test:jobdb-flow
npm run test:logging
npm run test:statistics
```

The project uses TypeScript, Biome, Node's test runner, and an MIT license. See
[`CHANGELOG.md`](CHANGELOG.md) for release history and
[`VERSION`](VERSION) for the plain-text current version. Version 5.0.0 follows
[Semantic Versioning](https://semver.org/).

## Acknowledgments

- AstroEX's source-neutral acquisition layer vendors and adapts HTTP, proxy,
  retry, text-conversion, LinkedIn, and Indeed provider code from
  [`ts-jobspy`](https://github.com/alpharomercoma/ts-jobspy) by
  [Alpha Romer Coma](https://github.com/alpharomercoma), used under the MIT
  License. AstroEX ships the adapted code locally and does not require
  `ts-jobspy` at runtime.
- `ts-jobspy` is itself a TypeScript port of
  [`python-jobspy`](https://github.com/speedyapply/JobSpy), originally by Cullen
  Watson and Zachary Hampton.
- AstroEX originated from
  [`linkedin-jobs-scraper`](https://github.com/llpujol/linkedin-jobs-scraper)
  by [llpujol](https://github.com/llpujol).

See [`docs/jobspy-integration.md`](docs/jobspy-integration.md) for the precise
scope of the vendored acquisition code and [`LICENSE.md`](LICENSE.md) for this
project's license.
