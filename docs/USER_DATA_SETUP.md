# Setting Up Your `user_data/` Directory

The `user_data/` directory is your **personal workspace** for AstroEX. It is listed in `.gitignore` and is never committed to the repository. You must create it and populate it with your own files before running most pipeline commands.

---

## Quick Setup Checklist

Create the following files before running AstroEX commands:

| # | File | Required by | Fatal if missing? |
|---|------|------------|------------------|
| 1 | [`my_resume.txt`](#1-my_resumetxt) | `jobCloth`, `jobJudge`, `makeMaterials` | ✅ Yes — pipeline halts |
| 2 | [`my_professional_title.txt`](#2-my_professional_titletxt) | `makeMaterials` | ✅ Yes — pipeline halts |
| 3 | [`my_professional_summary.txt`](#3-my_professional_summarytxt) | `makeMaterials` | ✅ Yes — pipeline halts |
| 4 | [`my_key_skills.txt`](#4-my_key_skillstxt) | `makeMaterials` | ✅ Yes — pipeline halts |
| 5 | [`my_testimonials.txt`](#5-my_testimonialstxt) | `makeMaterials`, `jobJudge` | ✅ Yes — pipeline halts |
| 6 | [`search_terms.txt`](#6-search_termstxt) | `scrape-search` | ⚠️ Soft — falls back to 9 generic terms |
| 7 | [`company_filters.txt`](#7-company_filterstxt) | `processData` | ⚠️ Soft — falls back to built-in list |
| 8 | [`title_filters.txt`](#8-title_filterstxt) | `processData` | ⚠️ Soft — falls back to built-in list |

**Minimum to run the full pipeline:** all 5 required files plus `search_terms.txt`.

---

## File Reference

### 1. `my_resume.txt`

**What it does:** Your source résumé, injected verbatim into LLM prompts by:
- `jobCloth` — to score job title alignment against your background
- `jobJudge` — to evaluate full job descriptions against your profile
- `makeMaterials` — to generate tailored, ATS-optimized résumé and cover letter content

**Format:** Plain text only. No markdown, no HTML, no special characters. Use simple section headings and line breaks.

**Tips:**
- Keep under **5,000 characters** for best token efficiency across all providers
- Use factual content — the LLM tailors phrasing per job automatically
- Include: professional summary, work history (title + company + dates + bullets), education, certifications, and skills

**Example structure:**
```
Your Name
Your Professional Title
City, State | email@example.com | linkedin.com/in/yourprofile

Professional Summary
Brief overview of your background and target role...

Work Experience

[Most Recent Title] — [Company] (YYYY–Present)
- Key accomplishment with measurable result
- Key accomplishment with measurable result

[Previous Title] — [Company] (YYYY–YYYY)
- Key accomplishment with measurable result

Education
B.S. [Field] — [University], YYYY

Certifications
- [Certification Name] (active)

Skills
[Skill 1], [Skill 2], [Skill 3], ...
```

---

### 2. `my_professional_title.txt`

**What it does:** A single-line string used as the `{myProfessionalTitle}` placeholder in `makeMaterials` prompt templates.

**Format:** One line only. No punctuation or newlines at the end.

**Example:**
```
Senior Cybersecurity Analyst
```

**Tips:**
- Use a broad title that covers your target role family — the LLM will tailor it per job posting
- Avoid overly specific or seniority-locked titles

---

### 3. `my_professional_summary.txt`

**What it does:** A short paragraph used as the `{myProfessionalSummary}` placeholder. Injected into tailored résumé output by `makeMaterials`.

**Format:** 2–4 sentences of plain prose. No bullet points.

**Example:**
```
Results-driven security professional with 10+ years of experience protecting
enterprise networks across regulated industries. Proven track record in SOC
operations, incident response, and SIEM engineering. Passionate about threat
hunting and communicating complex security concepts to stakeholders at all levels.
```

---

### 4. `my_key_skills.txt`

**What it does:** A curated list of your core competencies injected as `{myKeySkills}`. Used by `makeMaterials` to generate an optimized skills section in tailored résumé output.

**Format:** Flexible — the entire file is passed as a string to the LLM. Comma-separated, newline-separated, or grouped by category all work.

**Example (grouped by category):**
```
Security Operations: SIEM, Splunk, Azure Sentinel, QRadar, Sumo Logic
Endpoint & Detection: Carbon Black, CrowdStrike, SentinelOne, Defender for Endpoint
Incident Response: Digital Forensics, Threat Hunting, MITRE ATT&CK, DFIR
Networking: Packet Analysis, Wireshark, TCP/IP, Firewall Administration
Scripting: Python, PowerShell, Bash
```

---

### 5. `my_testimonials.txt`

**What it does:** Professional endorsements used in cover letter generation by `makeMaterials`. Injected as `{myTestimonials}`.

**Format:** Free-form. Include the testimonial text followed by attribution.

**Example:**
```
"[Your name] consistently exceeded our expectations — she reduced detection time
by 75% in her first six months and built our threat hunting program from scratch."
— [Name], [Title], [Company]

"I've worked with many analysts over my career, and [your name] stands out for her
ability to communicate complex threats clearly to non-technical executives."
— [Name], [Title], [Company]
```

**Tips:**
- If you don't have written testimonials, paraphrase endorsements from past managers
- Attribution format: name, title, company

---

### 6. `search_terms.txt`

**What it does:** Drives the `scrape-search` command. Each line is submitted to LinkedIn's search API as a separate query.

**How the code parses this file:**
- Split on newlines
- Lines trimmed of leading/trailing whitespace
- Lines starting with `#` are treated as comments and skipped
- Empty lines are skipped

**Fallback:** If this file is missing, the pipeline uses these 9 built-in terms:
`cybersecurity`, `information security`, `security analyst`, `security engineer`, `cybersecurity analyst`, `cybersecurity engineer`, `infosec`, `security specialist`, `security consultant`

**Format:**
```
# One job search term or title per line.
# Lines beginning with # are ignored.

Security Analyst
SOC Analyst
Threat Hunter
Cloud Security Engineer
Incident Response Analyst
SIEM Engineer
Splunk
CrowdStrike
```

**Tips:**
- Specific titles yield more targeted results than broad keywords
- Include tool names (e.g., "Splunk", "CrowdStrike") to surface tool-specific postings
- 20–100 terms is a practical range; scrape time scales linearly with term count

---

### 7. `company_filters.txt`

**What it does:** Suppresses unwanted job postings during `processData`. Any job whose company name **contains** one of these substrings (case-insensitive) is dropped.

**How the code parses this file:**
- Same rules as `search_terms.txt` (newline-split, trim, skip `#` and empty lines)
- Matching is **substring**, not exact — `staff` will match "TechStaff Inc", "Staffing Solutions LLC", etc.

**Fallback:** If missing, the pipeline uses this built-in list:
`jobs via dice`, `lensa`, `jobot`, `talentify.io`, `piper companies`, `talent`, `motion recruitment`, `braintrust`, `recruit`, `teksystems`, `robert half`, `zachary piper`

**Format:**
```
# One lowercase company name substring per line.
# Matching is case-insensitive and partial.
# Lines beginning with # are ignored.

staffing
recruiting
robert half
manpower
dice
lensa
```

> **Warning:** Short substrings like `tech` or `net` will broadly match many company names. Use longer, more specific substrings to avoid over-filtering.

---

### 8. `title_filters.txt`

**What it does:** Suppresses unwanted job postings during `processData`. Any job whose title **contains** one of these substrings (case-insensitive) is dropped.

**How the code parses this file:**
- Same rules as `company_filters.txt`
- Matching is substring, case-insensitive

**Fallback:** If missing, the pipeline uses this built-in list:
`grc`, `compliance`, `product`, `application`, `manager`, `director`, `red`, `penetration test`, `pentest`, `devops`, `devsecops`

**Format:**
```
# One lowercase job title substring per line.
# Matching is case-insensitive and partial.
# Lines beginning with # are ignored.

director
manager
compliance
grc
devops
devsecops
penetration
intern
```

> **Note:** Title filters stack with company filters — a job is dropped if it matches **either** list.

---

## Optional Files

The following may be needed if you define custom presets in `config/presets.json` that reference them:

| File | Purpose |
|---|---|
| `stacks.txt` | Technology stack keywords used in job matching/filtering |
| `*_prompt.txt` | Custom LLM prompt templates for non-standard presets |

---

## Privacy

Everything in `user_data/` is excluded from Git via `.gitignore`. No file in this directory will ever appear in `git status` output or be pushed to any remote repository. Always verify with `git status` before your first commit.
