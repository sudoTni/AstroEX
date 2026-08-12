# Standalone JobSpy-derived acquisition layer

AstroEX vendors and adapts the small set of components needed for public LinkedIn and Indeed acquisition under `src/acquisition/jobspy/`. The copied/adapted code is present in this repository; AstroEX does not import, execute, or otherwise require the sibling `ts-jobspy-main` project at runtime or build time.

Origin: `ts-jobspy-main` (MIT License), specifically its HTTP/proxy/retry/text helpers and LinkedIn/Indeed provider logic. The relevant source modules carry an inline provenance notice. The retained implementation is intentionally limited to `linkedin` and `indeed`; no experimental board adapters or default multi-site behavior are exposed.

The new `acquire-jobs` command writes canonical `acquired_jobs_*.json` arrays. `processData` recognizes those artifacts and projects them into AstroEX's existing job shape so the established filtering and LLM steps remain compatible. `JobDB` records a source alongside each provider ID; old source-less entries remain interpreted as LinkedIn records for backward compatibility.

Use scraping responsibly. Operators are responsible for complying with each site's applicable terms, robots guidance, rate limits, and law.
