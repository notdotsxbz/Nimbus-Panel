#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  NIMBUS installer tests — helper loading & function validation
#
#  Regression coverage for the production failure:
#    "system_detect: command not found" — libs were sourced AFTER first use.
#
#  Usage: bash installer/tests/functions.sh
# ═══════════════════════════════════════════════════════════════════
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

PASS=0
FAIL=0
check() { if [ "$2" -eq "$3" ]; then PASS=$((PASS+1)); echo "  PASS  $1"; else FAIL=$((FAIL+1)); echo "  FAIL  $1 — expected exit $2 got $3"; fi; }
check_eq() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  PASS  $1"; else FAIL=$((FAIL+1)); echo "  FAIL  $1 — expected [$2] got [$3]"; fi; }

# Installer framework stubs (normally provided by install.sh)
log()  { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*"; }
die()  { printf 'DIE: %s\n' "$*" >&2; exit 1; }
step() { :; }
on_error() { :; }
tty_read() { :; }

echo "Helper loading & function validation tests"

# ── 1. Deterministic load order: all libs sourced, all functions defined ──
# shellcheck disable=SC1091
. installer/lib/bootstrap.sh
# shellcheck disable=SC1091
. installer/lib/mongo-compat.sh
# shellcheck disable=SC1091
. installer/lib/apt-repos.sh
# shellcheck disable=SC1091
. installer/lib/os-detect.sh
# shellcheck disable=SC1091
. installer/lib/validation.sh

validate_required_functions >/dev/null 2>&1
check "all required functions defined after sourcing all libs" 0 "$?"

# ── 2. Missing function is caught BY NAME with its expected file ──
unset -f system_detect
OUT=$(validate_required_functions 2>&1); RC=$?
check "validation fails when a required function is missing" 1 "$RC"
case "${OUT}" in
  *'"system_detect"'*) PASS=$((PASS+1)); echo "  PASS  error names the missing function (system_detect)";; *)
    FAIL=$((FAIL+1)); echo "  FAIL  missing function not named — output: ${OUT}";; esac
case "${OUT}" in
  *"installer/lib/os-detect.sh"*) PASS=$((PASS+1)); echo "  PASS  error names the expected source file";; *)
    FAIL=$((FAIL+1)); echo "  FAIL  expected file not named";; esac
# restore for later tests
# shellcheck disable=SC1091
. installer/lib/os-detect.sh

# ── 3. Missing helper FILE → its functions are all missing ───────
# Simulate: bootstrap.sh never loaded (fresh subshell without it).
OUT=$(bash -c '
  cd "$(dirname "$0")/../.." 2>/dev/null || cd .
  log(){ :; }; warn(){ :; }; die(){ printf "DIE: %s\n" "$*" >&2; exit 1; }
  step(){ :; }; on_error(){ :; }; tty_read(){ :; }
  . installer/lib/mongo-compat.sh
  . installer/lib/apt-repos.sh
  . installer/lib/os-detect.sh
  . installer/lib/validation.sh
  validate_required_functions
' "$0" 2>&1); RC=$?
check "missing bootstrap.sh detected by validation" 1 "$RC"
case "${OUT}" in
  *"bootstrap_fetch_file"*|*"bootstrap_download_bundle"*) PASS=$((PASS+1)); echo "  PASS  bootstrap functions named as missing";; *)
    FAIL=$((FAIL+1)); echo "  FAIL  bootstrap functions not reported — output: ${OUT}";; esac

# ── 4. Static ordering check: load_helper_libs BEFORE first lib call ──
LOAD_LINE=$(awk '/^load_helper_libs$/ {print NR; exit}' installer/install.sh)
DET_LINE=$(awk '/^system_detect$/ {print NR; exit}' installer/install.sh)
if [ -n "${LOAD_LINE}" ] && [ -n "${DET_LINE}" ] && [ "${LOAD_LINE}" -lt "${DET_LINE}" ]; then
  PASS=$((PASS+1)); echo "  PASS  load_helper_libs (line ${LOAD_LINE}) runs before system_detect (line ${DET_LINE})"
else
  FAIL=$((FAIL+1)); echo "  FAIL  ordering broken: load=${LOAD_LINE:-none} detect=${DET_LINE:-none}"
fi

# ── 5. Every function invoked by install.sh exists in the libs ────
# (dependency map: known lib functions used in install.sh)
MISSING=0
for fn in system_detect detect_busy_ports check_connectivity select_mongodb_compat \
          repair_mongo_repos audit_mongo_repos apt_update_validated \
          bootstrap_clean; do
  grep -qE "^${fn}$" installer/install.sh || continue
  declare -F "${fn}" >/dev/null 2>&1 || { echo "  FAIL  ${fn} used by install.sh but undefined in libs"; MISSING=1; }
done
[ "${MISSING}" -eq 0 ] && PASS=$((PASS+1)) && echo "  PASS  function dependency map complete"

# ── 6. Bundle contains every helper (bootstrap manifest == files on disk) ──
for f in installer/lib/bootstrap.sh installer/lib/mongo-compat.sh installer/lib/apt-repos.sh installer/lib/os-detect.sh installer/lib/validation.sh; do
  [ -s "$f" ] || { echo "  FAIL  helper missing/empty: $f"; FAIL=$((FAIL+1)); MISSING_BUNDLE=1; }
done
grep -q "validation.sh" installer/lib/bootstrap.sh && PASS=$((PASS+1)) && echo "  PASS  validation.sh included in bootstrap bundle" \
  || { FAIL=$((FAIL+1)); echo "  FAIL  validation.sh missing from bundle manifest"; }

# ── 7. Piped execution: no "command not found" anywhere ──────────
INSTALLER_ABS="$(pwd)/installer/install.sh"
OUT=$(cd / && timeout 60 bash < "${INSTALLER_ABS}" < /dev/null 2>&1 || true)
case "${OUT}" in
  *"command not found"*) FAIL=$((FAIL+1)); echo "  FAIL  piped execution hit an undefined command: $(printf '%s' "${OUT}" | grep 'command not found' | head -1)";; *)
    PASS=$((PASS+1)); echo "  PASS  piped execution: no command-not-found errors";; esac
case "${OUT}" in
  *"unbound variable"*) FAIL=$((FAIL+1)); echo "  FAIL  piped execution hit an unbound variable";; *)
    PASS=$((PASS+1)); echo "  PASS  piped execution: no unbound-variable errors";; esac

echo
echo "${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ] || exit 1
