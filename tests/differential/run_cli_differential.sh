#!/usr/bin/env bash
# Node-vs-Rust offline CLI differential harness (migration plan section 8.3).
#
# Runs deterministic, network-free `astroom` commands against the Node
# reference implementation in twin sandboxes, normalizes volatile fields
# (timestamps, pids, paths), and diffs the observable results. The Node
# reference receives its configuration through the historical ASTROEX_* env
# vars; the Rust binary receives the equivalent explicit CLI flags.
#
# Usage:
#   tests/differential/run_cli_differential.sh [NODE_REPO] [ASTROOM_BIN]
#
# Defaults: NODE_REPO=../AstroEX-node, ASTROOM_BIN=target/debug/astroom
#
# Exit status is non-zero if any case diverges. This is intentionally not part
# of `cargo test` because it requires a built Node checkout.
set -uo pipefail

NODE_REPO="$(cd "${1:-../AstroEX-node}" && pwd)"
ASTROOM_BIN="${2:-target/debug/astroom}"
ASTROOM_BIN="$(cd "$(dirname "$ASTROOM_BIN")" && pwd)/$(basename "$ASTROOM_BIN")"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

failures=0
pass() { printf 'PASS  %s\n' "$1"; }
fail_case() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/astroom-diff-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# normalize_json FILE: sort keys and drop volatile fields.
normalize_json() {
	python3 - "$1" <<'PY'
import json, sys
VOLATILE = {
    "createdAt", "generatedAt", "timestamp", "startTime", "endTime",
    "sessionId", "duration", "postedDate", "acquiredAt", "timeToNextExpiration",
    "memoryUsage", "cpuTime", "garbageCollections", "responseTimes",
    "averageResponseTime", "totalExecutionTime", "operationTimes", "sha256",
    "runner", "node", "nodeValid", "runtime", "runtimeValid",
}
def strip(value):
    if isinstance(value, dict):
        return {k: strip(v) for k, v in value.items() if k not in VOLATILE}
    if isinstance(value, list):
        return [strip(v) for v in value]
    return value
with open(sys.argv[1]) as fh:
    print(json.dumps(strip(json.load(fh)), indent=2, sort_keys=True))
PY
}

run_node() {
	env ASTROEX_DATA_DIR="$1" ASTROEX_LOG_DIR="$2" ASTROEX_PROFILE_DIR="$3" \
		AEX_OR_API_KEY="test-key" \
		node "$NODE_REPO/dist/index.js" --no-banner --json "${@:4}"
}

run_rust() {
	"$ASTROOM_BIN" --no-banner --json \
		--data-dir "$1" --log-dir "$2" --profile-dir "$3" --api-key "test-key" "${@:4}"
}

setup_sandbox() {
	local dir="$1"
	mkdir -p "$dir/data" "$dir/logs" "$dir/profile"
	for f in my_resume.txt my_professional_title.txt my_professional_summary.txt \
		my_key_skills.txt my_testimonials.txt; do
		echo "sample" > "$dir/profile/$f"
	done
	echo "engineer" > "$dir/profile/search_terms.txt"
}

write_legacy_fixture() {
	python3 - "$1" <<'PY'
import json, sys, os
d = sys.argv[1]
legacy = [
    {"id": "indeed-1", "title": "Staff Engineer", "company": "Acme",
     "url": "https://www.indeed.com/viewjob?jk=indeed-1", "source": "indeed",
     "description": "Full description", "descriptionText": "Full description"},
]
linkedin = [
    {"id": "linkedin-1", "title": "Staff Engineer", "company": "Acme",
     "url": "https://www.linkedin.com/jobs/view/123456789", "source": "linkedin"},
]
open(os.path.join(d, "acquired_jobs_indeed.json"), "w").write(json.dumps(legacy, indent=2))
open(os.path.join(d, "acquired_jobs_linkedin.json"), "w").write(json.dumps(linkedin, indent=2))
PY
}

# --- Case 1: processData on a legacy-acquisition fixture ---------------------
case_process_data() {
	local node="$WORK/pd-node" rust="$WORK/pd-rust"
	setup_sandbox "$node"; setup_sandbox "$rust"
	write_legacy_fixture "$node/data"
	write_legacy_fixture "$rust/data"
	run_node "$node/data" "$node/logs" "$node/profile" processData \
		--input-dir "$node/data" --output-file "$node/data/processed_jobs.json" >/dev/null 2>&1
	local nrc=$?
	run_rust "$rust/data" "$rust/logs" "$rust/profile" processData \
		--input-dir "$rust/data" --output-file "$rust/data/processed_jobs.json" >/dev/null 2>&1
	local rrc=$?
	if [[ $nrc -ne $rrc ]]; then fail_case "processData exit ($nrc vs $rrc)"; return; fi
	if diff -q <(normalize_json "$node/data/processed_jobs.json") \
		<(normalize_json "$rust/data/processed_jobs.json") >/dev/null; then
		pass "processData artifact"
	else
		fail_case "processData artifact"
		diff <(normalize_json "$node/data/processed_jobs.json") \
			<(normalize_json "$rust/data/processed_jobs.json") | head -40
	fi
}

# --- Case 2: preflight -------------------------------------------------------
case_preflight() {
	local node="$WORK/pf-node" rust="$WORK/pf-rust"
	setup_sandbox "$node"; setup_sandbox "$rust"
	run_node "$node/data" "$node/logs" "$node/profile" preflight > "$node/out.json" 2>/dev/null
	local nrc=$?
	run_rust "$rust/data" "$rust/logs" "$rust/profile" preflight > "$rust/out.json" 2>/dev/null
	local rrc=$?
	if [[ $nrc -ne $rrc ]]; then fail_case "preflight exit ($nrc vs $rrc)"; return; fi
	# profileDirectory inherently differs (sandbox path); node/runtime fields are
	# the documented D3 deviation.
	python3 - "$node/out.json" "$rust/out.json" <<'PY'
import json, sys
a = json.load(open(sys.argv[1])); b = json.load(open(sys.argv[2]))
for d in (a, b):
    d.pop("node", None); d.pop("nodeValid", None)
    d.pop("runtime", None); d.pop("runtimeValid", None)
    d["profileDirectory"] = "<profile>"
sys.exit(0 if a == b else 1)
PY
	if [[ $? -eq 0 ]]; then pass "preflight JSON (modulo D3 runtime fields)"; else fail_case "preflight JSON"; fi
}

# --- Case 3: artifact verify cross-compatibility -----------------------------
case_artifact() {
	local node="$WORK/art-node" rust="$WORK/art-rust"
	setup_sandbox "$node"; setup_sandbox "$rust"
	write_legacy_fixture "$node/data"
	run_node "$node/data" "$node/logs" "$node/profile" processData \
		--input-dir "$node/data" --output-file "$node/data/processed_jobs.json" >/dev/null 2>&1
	# Rust verifies a Node-written artifact+manifest.
	"$ASTROOM_BIN" --no-banner --json artifact verify "$node/data/processed_jobs.json" >/dev/null 2>&1
	if [[ $? -eq 0 ]]; then pass "artifact verify (Rust reads Node manifest)"; else fail_case "artifact verify cross"; fi
}

# --- Case 4: jobdb cross-compatibility --------------------------------------
case_jobdb() {
	local node="$WORK/db-node"
	setup_sandbox "$node"
	write_legacy_fixture "$node/data"
	run_node "$node/data" "$node/logs" "$node/profile" processData \
		--input-dir "$node/data" --output-file "$node/data/processed_jobs.json" >/dev/null 2>&1
	"$ASTROOM_BIN" --no-banner --json --data-dir "$node/data" jobdb verify > "$node/rust_verify.json" 2>/dev/null
	local rrc=$?
	run_node "$node/data" "$node/logs" "$node/profile" jobdb verify > "$node/node_verify.json" 2>/dev/null
	local nrc=$?
	if [[ $rrc -eq 0 && $nrc -eq 0 ]] && \
		diff -q <(normalize_json "$node/rust_verify.json") <(normalize_json "$node/node_verify.json") >/dev/null; then
		pass "jobdb verify on Node-created DB"
	else
		fail_case "jobdb verify"
	fi
}

# --- Case 5: launcher policy values are overridable by trailing argv --------
case_pipeline_argument_overrides() {
	local node="$WORK/argv-node" rust="$WORK/argv-rust"
	setup_sandbox "$node"; setup_sandbox "$rust"
	run_node "$node/data" "$node/logs" "$node/profile" run-pipeline \
		--resume deployment --batch 10 --remote-only true --clean \
		--batch 1 --remote-only false --clean false >/dev/null 2>&1
	local nrc=$?
	run_rust "$rust/data" "$rust/logs" "$rust/profile" run-pipeline \
		--resume deployment --batch 10 --remote-only true --clean \
		--batch 1 --remote-only false --clean false >/dev/null 2>&1
	local rrc=$?
	if [[ $nrc -eq 0 && $rrc -eq 0 ]]; then
		pass "run-pipeline trailing argument overrides"
	else
		fail_case "run-pipeline trailing argument overrides ($nrc vs $rrc)"
	fi
}

case_process_data
case_preflight
case_artifact
case_jobdb
case_pipeline_argument_overrides

echo
if [[ $failures -eq 0 ]]; then
	echo "differential: clean"
else
	echo "differential: $failures divergence(s)"
fi
exit $(( failures > 0 ? 1 : 0 ))
