#!/usr/bin/env bash
set -euo pipefail

# Always run the remastered development checkout, regardless of the caller's
# current directory. Runtime state may be redirected outside this checkout.
echo ":: astroex wrapper"
echo
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
if [ -f "$SCRIPT_DIR/.env" ]; then
  echo ":: Sourcing $SCRIPT_DIR/.env..."
  source "$SCRIPT_DIR/.env"
  echo ":: ...sourced $SCRIPT_DIR/.env"
else
  echo ":: No .env file found, using existing environment variables"
fi
echo
echo ":: Cleaning $SCRIPT_DIR/logs/..."
rm -rfv $SCRIPT_DIR/logs/*
echo ":: ...cleaned $SCRIPT_DIR/logs/"
echo

: "${AEX_OR_API_KEY:?Set AEX_OR_API_KEY in the environment before running LLM stages.}"
DATA_DIR="${ASTROEX_DATA_DIR:-$SCRIPT_DIR/data}"
LOG_DIR="${ASTROEX_LOG_DIR:-$SCRIPT_DIR/logs}"
MATERIALS_DIR="${ASTROEX_MATERIALS_DIR:-$SCRIPT_DIR/materials}"
PROFILE_DIR="${ASTROEX_PROFILE_DIR:-$SCRIPT_DIR/profile.example}"
export ASTROEX_DATA_DIR="$DATA_DIR"
export ASTROEX_LOG_DIR="$LOG_DIR"
export ASTROEX_MATERIALS_DIR="$MATERIALS_DIR"
export ASTROEX_PROFILE_DIR="$PROFILE_DIR"

# Thin compatibility wrapper around consolidated run-pipeline command
ARGS=(
  --job-provider indeed,linkedin
  --search-terms-file "$PROFILE_DIR/search_terms.txt"
  --api-key "$AEX_OR_API_KEY"
  --jobcloth-preset "jc_glm-5.3-flash"
  --remoteeval-preset "re_glm-5.3-flash"
  --jobjudge-preset "jep_glm-5.3-flash"
  --makematerials-preset "rop_glm-5.3-flash"
  --batch 10
  --sleep 2
  --results-wanted 200
  --hours-old 24
  --jc-provider astro_auto_provider
  --jc-provider-quant fp8
  --jc-reasoning-effort low
  --re-provider astro_auto_provider
  --re-provider-quant fp8
  --re-reasoning-level high
  --jj-provider astro_auto_provider
  --j-provider-quant fp8
  --jj-reasoning-effort high
  --mm-provider astro_auto_provider
  --mm-provider-quant fp8
  --mm-reasoning-effort high
  --astro_auto_provider-top 3
  --remote-only true
  --track-or-costs
  --internet-watchdog
  --log-cool-offs
)

if [[ "${AEX_CLEAN:-0}" == "1" ]]; then
  ARGS+=(--clean)
fi

if [[ "${AEX_DEPLOY:-0}" == "1" ]]; then
  : "${AEX_DEPLOY_DESTINATION:?Set AEX_DEPLOY_DESTINATION, e.g. GoogleDrive:/autoJobGen-src}"
  ARGS+=(--deploy --deploy-destination "$AEX_DEPLOY_DESTINATION")
fi

npm run start -- run-pipeline "${ARGS[@]}" "$@"
