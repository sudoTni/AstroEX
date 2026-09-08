# Indeed acquisition integration

AstroEX vendors and adapts the HTTP, proxy, retry, text-conversion, and Indeed-provider components it needs under `src/acquisition/jobspy/`. It does not require the sibling `ts-jobspy-main` project at build or runtime.

Origin: `ts-jobspy-main` (MIT License). The retained implementation is deliberately limited to Indeed; no other board adapter is exposed.

`acquire-jobs` writes canonical `acquired_jobs_*.json` arrays. `processData` projects those records into the existing AstroEX job shape, allowing the filtering, evaluation, and materials stages to retain their established artifact contract.

The provider accepts a search term, location, requested result count, Indeed country, optional description mode, proxy list, and user agent. Retryable provider failures are retried by the provider and the CLI applies a bounded cooldown between failed queries. Non-retryable rejections disable Indeed only for the active run.
