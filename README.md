# AstroOM

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE.md)
[![Rust](https://img.shields.io/badge/rust-stable-orange.svg)](https://www.rust-lang.org/tools/install)
[![Platform](https://img.shields.io/badge/platform-x86__64--linux-lightgrey.svg)](#supported-platforms)
[![portable to Win/Mac](https://img.shields.io/badge/portable%20to-Win/Mac-4692f7?labelColor=555555)](#supported-platforms)<br>
[![Google Antigravity](https://img.shields.io/badge/Google-Antigravity-4285F4)](https://antigravity.google/)
[![OpenAI Codex](https://img.shields.io/badge/OpenAI-Codex-000000?labelColor=555555)](https://openai.com/codex/)
[![Anomaly OpenCode](https://img.shields.io/badge/Anomaly-OpenCode-C6C4C4?labelColor=555555)](https://opencode.ai/)
[![OpenRouter](https://img.shields.io/badge/OpenRouter-141210?style=flat-square&logo=openrouter&logoColor=white)](https://openrouter.ai)

> **AstroOM** is an autonomous, multi-phase job acquisition and tailored application materials generation engine, written in Rust for Linux. It combines lightweight, headless job search querying with multi-provider LLM grounding to systematically evaluate opportunities, match candidate qualifications, and produce tailored application packages.

<p align = "center"><img width = "640" alt="AstroOM animated logo" src="screenshots/AstroOM-logo.gif" /></p>

Terminal captures are in [`screenshots/`](screenshots).

---

> [!NOTE]
> **[AstroEX](https://github.com/sudoTni/AstroEX/) ↔ [AstroOM](https://github.com/sudoTni/AstroOM):** Both projects are fully functional, feature-equivalent, and ready for your job search. Going forward, **[AstroOM](https://github.com/sudoTni/AstroOM)** is the recommended version and may receive future updates.

---

## Legal & Compliance Disclaimer

> [!WARNING]
> ### Legal Disclaimer & Terms of Service Notice
> AstroOM is provided strictly for educational, research, and personal productivity purposes.
>
> Scraping job board platforms (including LinkedIn, Indeed, and others) may be subject to the respective platforms' Terms of Service, User Agreements, robots.txt directives, and applicable local laws. The developers and contributors of AstroOM:
> 1. Do not encourage, endorse, or promote unauthorized automated scraping, rate-limit evasion, or commercial extraction of proprietary data.
> 2. Assume no liability for account restrictions, IP blocks, CAPTCHA challenges, legal claims, or service suspensions resulting from the use of this software.
> 3. Urge all users to employ reasonable request throttling, respect robots.txt guidelines, and utilize official developer APIs whenever available for commercial or high-volume workflows.
>
> You are solely responsible for ensuring that your execution of AstroOM complies with all relevant terms of service, platform guidelines, and legal requirements.

---

## Privacy & Data Handling

- **AstroOM has no telemetry.** Nothing is phoned home except the requests you explicitly make to the job boards and to your configured LLM provider.
- **Your personal data lives in one place:** the `profile/` directory you create from `profile.example/`. The application only reads it; it never writes to it and never bundles it into a release.
- **`profile/` is git-ignored.** Keep your résumé and testimonials out of version control and out of bug reports.
- Profile text is sent to whichever LLM provider your preset names (the shipped presets target OpenRouter). Treat it the same way you would any data you submit to a third-party API.
- A public Indeed mobile client key is compiled into the binary; it is not a user secret. See "Credentials" below.

---

## Core Pipeline Architecture

AstroOM organizes job application automation into 8 decoupled, cache-backed pipeline stages:

```mermaid
flowchart TD
    S1["Stage 1: Acquire Jobs<br/>(Indeed & LinkedIn JobSpy query)"] --> S2["Stage 2: Process Data<br/>(Deduplication & Keyword filtering)"]
    S2 --> S3["Stage 3: Job Cloth<br/>(Candidate Profile grounding)"]
    S3 --> S4["Stage 4: Enrich Jobs<br/>(Detail page & description fetch)"]
    S4 --> S5["Stage 5: Remote Eval<br/>(Optional remote/geo verification)"]
    S5 --> S6["Stage 6: Job Judge<br/>(Multidimensional scoring & gating)"]
    S6 --> S7["Stage 7: Make Materials<br/>(Tailored resume & cover letters)"]
    S7 --> S8["Stage 8: Deploy Materials<br/>(Archival & optional cloud export)"]
```

1. **Acquire Jobs**: Headless querying of LinkedIn and Indeed using resilient HTTP session retry policies, rotating proxy pools, and provider-specific header sets.
2. **Process Data**: Normalizes listings, removes blocklisted companies and titles, and filters out previously seen opportunities via SQLite.
3. **Job Cloth**: Reconciles raw job requirements against the candidate's skills and background.
4. **Enrich Jobs**: Fetches complete long-form job descriptions and employer profiles.
5. **Remote Eval**: Evaluates residency requirements, time zones, and remote eligibility rules.
6. **Job Judge**: Evaluates opportunities against candidate-defined gates (seniority, compensation, tech stack match) to generate a fit score (0–100).
7. **Make Materials**: Generates tailored resumes and cover letters for qualified opportunities.
8. **Deploy Materials**: Packages materials into formatted markdown files, JSON deployment payloads, and optional cloud storage sync via Google Apps Script.

Each stage writes a JSON artifact plus a companion `<artifact>.json.manifest.json` sidecar containing a SHA-256 digest, so a resumed or third-party artifact can always be verified with `astroom artifact verify <file>`.

---

## LLM Provider Support & Model Caveats

> [!NOTE]
> AstroOM speaks the OpenAI chat-completions protocol, so it can target OpenRouter as well as any OpenAI-compatible endpoint (local Ollama, vLLM, LM Studio, Groq, …).
>
> - **The shipped presets all target OpenRouter** (`config/presets.json`). To use another endpoint, either override the base URL for every stage with `--llm-base-url <url>`, or add a preset with your own `provider` and `base_url`.
> - **Prompt Adherence & JSON Formatting:** High-parameter reasoning models (e.g. Claude 3.5 Sonnet, GPT-4o) reliably produce valid schema-compliant JSON during the `jobCloth` and `jobJudge` phases. Smaller local models (7B or 8B parameters) may occasionally omit required delimiters or hallucinate keys.
> - **Context Windows:** Ensure your local LLM server context window is configured for at least 16,000 tokens to handle full resume inventories and lengthy job postings without silent truncation.
> - **Prompt presets:** Every stage selects a preset by name from `config/presets.json`. Each preset names its own `promptTemplate`; the tree ships both compact `*-mini.txt` prompts (referenced by the shipped presets) and longer full-size variants you can switch to by editing a preset.
> - **Prompts are yours to tune.** `prompts/` and `sysprompts/` are plain text with `{placeholder}` tokens. They encode one candidate's screening philosophy, including a hard-coded work-jurisdiction and commute area — edit them to match your own search before relying on the scores.

---

## Quick Start Guide

> [!NOTE]
> The AOM contributors highly recommend the use of a codex / AI coding assistant for rapidly porting to your platform and configuring the software with your application materials!

### 1. Prerequisites

**Option A — use the prebuilt binary.** No toolchain needed.

The repository ships prebuilt release binaries at `target/release/astroom` for Linux (`x86_64-unknown-linux-gnu`, glibc) and `target/x86_64-pc-windows-gnu/release/astroom.exe` for Windows (`x86_64-pc-windows-gnu`). They need the `config/`, `prompts/`, and `sysprompts/` directories alongside them, which is why the binaries are distributed inside the repository tree rather than as bare downloads.

```bash
# Linux
./target/release/astroom --help
```

```powershell
# Windows (PowerShell)
.\target\x86_64-pc-windows-gnu\release\astroom.exe --help
```

**Option B — build from source.** Requires the [Rust toolchain](https://www.rust-lang.org/tools/install) (stable; CI uses `dtolnay/rust-toolchain@stable`) and a C compiler (GCC/Clang on Linux; MSVC C++ Build Tools or MinGW-w64 on Windows) for the bundled SQLite build.

```bash
# Clone the repository
git clone https://github.com/sudoTni/AstroOM.git
cd AstroOM

# Linux
cargo build --release        # -> target/release/astroom
```

```powershell
# Windows (PowerShell)
cargo build --release        # -> target\release\astroom.exe
```

### 2. Candidate Profile Setup

AstroOM keeps all personal job-search data outside the code, in a `profile/` directory. The repository ships an annotated template:

```bash
# Linux
cp -r profile.example profile
```

```powershell
# Windows (PowerShell)
Copy-Item -Recurse profile.example profile
```

Then replace the sample content in each file. See [`profile.example/README.md`](profile.example/README.md) for a per-field table. In short:

| File | Required | What goes in it |
| :--- | :--- | :--- |
| `my_resume.txt` | **yes** | Your full plain-text résumé. Every factual claim in the generated materials must be defensible from this file. |
| `search_terms.txt` | **yes** | Target job titles, one per line. `#` comments and blank lines are ignored. |
| `my_professional_title.txt` | no | Your current professional title; `makeMaterials` tailors it per role. |
| `my_professional_summary.txt` | no | Your professional summary; tailored per role. |
| `my_key_skills.txt` | no | Comma-separated list of core competencies. |
| `my_testimonials.txt` | no | Quotes about you. Used only as qualitative evidence — never to establish a technology, a number of years, a certification, education, or clearance. |
| `company_filters.txt` | no | Company/agency names to exclude (case-insensitive substring match). |
| `title_filters.txt` | no | Title keywords to exclude (case-insensitive substring match). |

> The template content describes a **fictional** candidate. Replace it before your first run, or the generated application materials will describe someone who does not exist.

### 3. Credentials

AstroOM itself **reads no environment variables.** Every setting reaches it through an explicit CLI flag, passed with either:

- `--api-key "<YOUR_KEY>"`, or
- `--api-key-file /path/to/key` (mutually exclusive with `--api-key`).

For convenience the wrapper scripts (`astro_launcher.bash` / `astro_launcher.ps1`) read `AOM_OR_API_KEY` from a local `.env` and forward it:

```bash
# Linux
cp .env.example .env
$EDITOR .env          # set AOM_OR_API_KEY
```

```powershell
# Windows (PowerShell)
Copy-Item .env.example .env
notepad .env          # set AOM_OR_API_KEY
```

`.env` is git-ignored. Never commit a real key; rotate any key that is ever committed or shared.

The Indeed scraper uses a public Indeed mobile client key that is compiled into the binary. It is not a user secret. Supply your own with `--indeed-api-key` (or `AOM_INDEED_API_KEY`) if you have an Indeed API credential.

### 4. Running the Pipeline

Run the full 8-phase pipeline with the wrapper script:

```bash
# Linux
./astro_launcher.bash
```

```powershell
# Windows (PowerShell)
# If script execution is restricted on your system, enable it for the current process:
# Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\astro_launcher.ps1
```

The wrapper applies a tuned policy argv (presets, provider routing, `--remote-only`, cost tracking, internet watchdog) and appends any arguments you pass it **last**, so they override those defaults:

```bash
# Linux
./astro_launcher.bash --batch 50 --results-wanted 500 --clean
```

```powershell
# Windows (PowerShell)
.\astro_launcher.ps1 --batch 50 --results-wanted 500 --clean
```

Or invoke the binary directly:

```bash
# Linux
./target/release/astroom run-pipeline \
  --job-provider indeed,linkedin \
  --profile-dir ./profile \
  --api-key "<YOUR_KEY>" \
  --jobcloth-preset jc_glm-5.3-flash \
  --remoteeval-preset re_glm-5.3-flash \
  --jobjudge-preset jep_glm-5.3-flash \
  --makematerials-preset rop_glm-5.3-flash \
  --batch 25 --sleep 2 --results-wanted 200 --remote-only true
```

```powershell
# Windows (PowerShell)
.\target\x86_64-pc-windows-gnu\release\astroom.exe run-pipeline `
  --job-provider indeed,linkedin `
  --profile-dir .\profile `
  --api-key "<YOUR_KEY>" `
  --jobcloth-preset jc_glm-5.3-flash `
  --remoteeval-preset re_glm-5.3-flash `
  --jobjudge-preset jep_glm-5.3-flash `
  --makematerials-preset rop_glm-5.3-flash `
  --batch 25 --sleep 2 --results-wanted 200 --remote-only true
```

Validate the setup before spending any tokens:

```bash
# Linux
./target/release/astroom preflight --profile-dir ./profile --json
```

```powershell
# Windows (PowerShell)
.\target\x86_64-pc-windows-gnu\release\astroom.exe preflight --profile-dir .\profile --json
```

---

## CLI Command Reference

All subcommands support `--help` for comprehensive option listings.

| Command | Description |
| :--- | :--- |
| `run-pipeline` | Execute the complete end-to-end 8-phase acquisition and materials generation pipeline |
| `acquire-jobs` | Query job board platforms (Indeed, LinkedIn) and write raw acquired listings |
| `processData` | Filter acquired listings by company, title, and database deduplication |
| `jobCloth` | Ground job descriptions against candidate profile data |
| `enrich-jobs` | Fetch detailed long-form descriptions and company metadata |
| `jobJudge` | Score and filter jobs based on candidate gates and alignment rules |
| `makeMaterials` | Generate optimized, tailored resumes and cover letters for qualified opportunities |
| `preflight` | Validate system prerequisites, runtime paths, API keys, and model presets |
| `jobDb` | Inspect the local SQLite deduplication repository (`status`, `verify`, `backup`, `rotate-backups`) |
| `artifact` | Verify an artifact against its companion SHA-256 manifest (`artifact verify <file>`) |

**Stage 5 (Remote Eval) has no standalone subcommand.** It runs inside `run-pipeline` when `--remote-only` is enabled, which is the only supported way to use it.

### Global Flags
- `--verbose`, `-v`: Enable verbose debug logging output.
- `--no-color`, `--no-colors`: Disable ANSI terminal coloring and gradient banners.
- `--json`: Output machine-readable JSON records (implies banner suppression, `--log-level error`, and JSON log format).
- `--log-level <level>`: Set minimum log level (`trace`, `debug`, `info`, `success`, `warn`, `error`, `fatal`).
- `--log-format <fmt>`: `pretty` (default) or `json`.
- `--data-dir`, `--log-dir`, `--materials-dir`, `--profile-dir`: Override the default directories.
- `--llm-base-url <url>`: Override the OpenAI-compatible endpoint for every stage.
- `--indeed-api-key <key>`: Supply your own Indeed API credential.
- `-hr`, `--hide-reasoning`, `--no-show-reasoning`: Suppress reasoning output and force non-streaming requests.
- `-sr`, `--show-reasoning`, `--show-reasoning-tokens`: Print reasoning tokens and stream responses live.
- `--api-key`, `--api-key-file`: LLM credential (mutually exclusive).
- `--max-llm-requests`, `--max-llm-output-tokens`, `--max-total-llm-output-tokens`, `--llm-deadline-ms`: LLM spend and time budgets.
- `--log-llm-payloads`, `--log-max-payload-length`: Write every outbound LLM request body to `logs/*_payload_logs/`.

---

## Google Apps Script Deployment

Stage 8 can export materials with `rclone` (`--deploy --deploy-destination <remote>`), which is what the built-in pipeline uses.

[`deployMaterials.gs`](deployMaterials.gs) is an **optional, richer alternative** that runs entirely inside Google Workspace: it reads generated markdown from Drive, uses an LLM to discover company contact addresses, renders tailored Google Docs and PDFs, and creates or sends Gmail drafts.

To use it:
1. Open [Google Apps Script](https://script.google.com/) and create a new project.
2. Copy the contents of [`deployMaterials.gs`](deployMaterials.gs) into your script editor.
3. In **Project Settings → Script Properties**, define every key listed in the file's `SCRIPT_PROPERTIES` block — including the source, target, processed, and template folder IDs, your `APPLICANT_NAME` and `APPLICANT_EMAIL`, the log spreadsheet and folder, and your `OR_API_KEY`. No credential is hard-coded in the file.
4. Run `deployMaterials()` directly, or deploy as an API executable.

---

## Supported Platforms

| Target | Status |
| :--- | :--- |
| `x86_64-unknown-linux-gnu` | **Primary target.** Full native Linux support. Prebuilt binary shipped. |
| `x86_64-pc-windows-gnu` / `x86_64-pc-windows-msvc` | **Windows native.** Full native Windows support via `astro_launcher.ps1` or direct CLI execution. |
| Other POSIX (macOS, other Linux architectures) | Build from source with `cargo build --release`. |

AstroOM natively dual-targets Linux and Windows. On Linux, it uses POSIX pipes and descriptors to tee its execution log (`src/logging/execution_log.rs`) and reads `/proc/self/status` for process metrics. On Windows, it uses Win32 standard handle redirection and pipes with virtual terminal processing for ANSI styling.

---

## Development

```bash
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

The test suite is fully offline. LLM-dependent paths run against a local mock OpenAI-compatible server (`tests/common/mod.rs`), and the Node-parity differential tests replay committed oracles from `tests/fixtures/`. The Node oracle generators in `tests/differential/` and the Node-vs-Rust CLI differ (`run_cli_differential.sh`) require a separate Node checkout of the predecessor project and are intentionally not part of `cargo test`.

### Reproducible releases

`Cargo.lock` is committed. For a release build that contains no machine-specific paths, remap the build paths:

```bash
RUSTFLAGS="--remap-path-prefix=$(pwd)=/astroom --remap-path-prefix=$HOME=/build" \
  cargo build --release
sha256sum target/release/astroom > astroom-$(cat VERSION)-x86_64-unknown-linux-gnu.sha256
```

Without the remap, Rust embeds source paths in panic-location strings, which leaks the builder's directory layout into the artifact.

---

## Third-Party Notices & Attribution

AstroOM is licensed under the [MIT License](LICENSE.md). Copyright © 2025-2026 AstroOM Contributors.

This project incorporates adapted algorithms and code from upstream open-source projects:
- **`ts-jobspy`** (Copyright 2025-2026 Alpha Romer Coma, MIT License)
- **`JobSpy`** (Copyright 2023 Cullen Watson, Zachary Hampton, MIT License)
- **`linkedin-jobs-scraper`** (Copyright 2023 llpujol, MIT License)

It also redistributes the **Dina** font family (Dina by Jani Nurminen; `DinaRemasterII` remastered by Zachary Shoals), embedded in the binary and used by the GIF logo renderer. The Rust implementation additionally depends on the crates.io packages pinned in `Cargo.lock`, each under its own license.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for full license texts and copyright notices, and [`assets/fonts/README.md`](assets/fonts/README.md) for font provenance.
