#!/usr/bin/env bash
#
# AstroOM launcher.
#
# Sources a private .env for credentials and optional directory redirection,
# wipes the previous run's logs, then executes the release binary with a
# fixed policy argv. Any arguments passed to this script are appended LAST, so
# they override the policy defaults (same last-wins semantics as the Node
# predecessor's yargs parsing).
#
# Usage:
#   ./astro_launcher.bash                       # use the policy defaults
#   ./astro_launcher.bash --batch 50 --clean    # override selected flags
#
# The `astroom` binary itself reads NO environment variables; every setting
# reaches it through explicit flags. If you would rather not use this wrapper,
# invoke the binary directly with --api-key / --api-key-file.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ":: astroom launcher"
echo

if [[ -f "$SCRIPT_DIR/.env" ]]; then
  echo ":: Sourcing $SCRIPT_DIR/.env..."
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
  echo ":: ...sourced $SCRIPT_DIR/.env"
else
  echo ":: No .env found; using defaults and CLI flags only."
  echo "::   cp .env.example .env   # then set AOM_OR_API_KEY"
fi
echo

echo ":: Cleaning $SCRIPT_DIR/logs/..."
mkdir -p "$SCRIPT_DIR/logs"
rm -rfv "$SCRIPT_DIR"/logs/*
echo ":: ...cleaned $SCRIPT_DIR/logs/"
echo

: "${AOM_OR_API_KEY:?Set AOM_OR_API_KEY in .env (see .env.example), or pass --api-key directly to astroom.}"

# Candidate profile directory. Copy the shipped template once with:
#   cp -r profile.example profile
PROFILE_DIR="${AOM_PROFILE_DIR:-$SCRIPT_DIR/profile}"

ARGS=(
  run-pipeline
  --job-provider indeed,linkedin
  --search-terms-file "$PROFILE_DIR/search_terms.txt"
  --api-key "$AOM_OR_API_KEY"
  --jobcloth-preset "jc_glm-5.3-flash"
  --remoteeval-preset "re_glm-5.3-flash"
  --jobjudge-preset "jep_glm-5.3-flash"
  --makematerials-preset "rop_glm-5.3-flash"
  --batch 10 --sleep 2 --results-wanted 200 --hours-old 24
  --jc-provider astro_auto_provider --jc-provider-quant fp8 --jc-reasoning-effort low
  --re-provider astro_auto_provider --re-provider-quant fp8 --re-reasoning-level high
  --jj-provider astro_auto_provider --j-provider-quant fp8 --jj-reasoning-effort high
  --mm-provider astro_auto_provider --mm-provider-quant fp8 --mm-reasoning-effort high
  --astro_auto_provider-top 3
  --remote-only true --track-or-costs --internet-watchdog --log-cool-offs
)

[[ -n "${AOM_DATA_DIR:-}" ]] && ARGS+=(--data-dir "$AOM_DATA_DIR")
[[ -n "${AOM_LOG_DIR:-}" ]] && ARGS+=(--log-dir "$AOM_LOG_DIR")
[[ -n "${AOM_MATERIALS_DIR:-}" ]] && ARGS+=(--materials-dir "$AOM_MATERIALS_DIR")
[[ -n "${AOM_PROFILE_DIR:-}" ]] && ARGS+=(--profile-dir "$AOM_PROFILE_DIR")
[[ -n "${AOM_INDEED_API_KEY:-}" ]] && ARGS+=(--indeed-api-key "$AOM_INDEED_API_KEY")

[[ "${AOM_CLEAN:-0}" == "1" ]] && ARGS+=(--clean)
if [[ "${AOM_DEPLOY:-0}" == "1" ]]; then
  : "${AOM_DEPLOY_DESTINATION:?Set AOM_DEPLOY_DESTINATION, e.g. GoogleDrive:/my-astroom-output}"
  ARGS+=(--deploy --deploy-destination "$AOM_DEPLOY_DESTINATION")
fi

exec ./target/release/astroom "${ARGS[@]}" "$@"
