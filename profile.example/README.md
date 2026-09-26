# Candidate Profile

AstroOM keeps **all** of your personal job-search data in one directory, outside
the application code. The application never writes to it and never uploads it;
it only reads these files and feeds them to the LLM stages.

## Getting started

```bash
cp -r profile.example profile
$EDITOR profile/my_resume.txt        # then the rest
```

AstroOM looks for your profile in `<repo>/profile` by default. Point it
somewhere else with `--profile-dir <path>`, or set `AOM_PROFILE_DIR` in `.env`
when using `./astro_launcher.bash`.

> `profile.example/` is a **template with sample content**, not a usable profile.
> The sample resume, summary, and testimonials describe a fictional candidate.
> Replace them before your first run, or the generated application materials will
> describe someone who does not exist.

## Files

| File | Required | Format | What goes in it |
| --- | --- | --- | --- |
| `my_resume.txt` | **yes** | Plain text | Your full resume. Every factual claim in the generated materials must be defensible from this file, so include dates, employers, scope, and quantified outcomes. Read by `jobCloth` and `jobJudge`. |
| `search_terms.txt` | **yes** | One job title per line | Target roles to search for. Blank lines and `#` comments are ignored. Read by `acquireJobs`. |
| `my_professional_title.txt` | no | Single line | Your current professional title. The `makeMaterials` prompt tailors it to each target role. Falls back to a placeholder if missing. |
| `my_professional_summary.txt` | no | Short paragraph | Your professional summary. Tailored per job by `makeMaterials`. |
| `my_key_skills.txt` | no | Comma-separated list | Your key skills. Rendered as a tailored "Key Skills" section by `makeMaterials`. |
| `my_testimonials.txt` | no | One quote per line | Colleagues' or managers' quotes about you. Used as **qualitative** evidence only — it cannot establish a technology, a number of years, a certification, education, or clearance. |
| `company_filters.txt` | no | One substring per line | Company names to exclude. Matched case-insensitively as a substring. Prefer agencies and job boards over real employers. |
| `title_filters.txt` | no | One substring per line | Title keywords to exclude. Matched case-insensitively as a substring. Keep entries specific. |

`#` comments and blank lines are ignored in every list file.

## Only two files are mandatory

`preflight` fails if `my_resume.txt` or `search_terms.txt` is missing or empty.
The rest degrade gracefully to visible placeholders, so a partial profile still
runs — but the generated materials will be weaker, and the prompts will warn
about the missing evidence.

## Data handling

- Everything stays on your machine. AstroOM sends this text to whichever LLM
  provider your preset names (the shipped presets target OpenRouter), so treat
  it the same way you would treat any other data you submit to a third-party
  API.
- `profile/` is git-ignored. Keep it out of version control and out of bug
  reports.
- Do not commit real profile content. If you are starting from this template in
  a repository you push, verify that `profile/` (not just `.env`) is ignored.

## Validating your profile

```bash
./target/release/astroom preflight --profile-dir profile --json
```

`valid: true` means the required files are present, `data/`, `logs/`, and
`materials/` are writable, the presets in `config/presets.json` resolve, and the
SQLite job repository passes an integrity check.
