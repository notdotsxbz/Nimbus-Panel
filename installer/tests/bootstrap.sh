#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  NIMBUS installer tests — dependency bootstrap
#
#  Exercises the real bootstrap code path against a local mock of
#  raw.githubusercontent.com. No system packages are touched; nothing
#  outside /tmp is modified. All runs stop safely at the tty guard or
#  the root check by design.
#
#  Usage: bash installer/tests/bootstrap.sh
# ═══════════════════════════════════════════════════════════════════
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

PASS=0
FAIL=0
check() { # check <name> <expected-exit> <actual-exit>
  if [ "$2" -eq "$3" ]; then
    PASS=$((PASS + 1)); echo "  PASS  $1"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL  $1 — expected exit $2, got $3"
  fi
}
check_str() { # check_str <name> <needle> <haystack>
  case "$3" in
    *"$2"*) PASS=$((PASS + 1)); echo "  PASS  $1" ;;
    *)      FAIL=$((FAIL + 1)); echo "  FAIL  $1 — missing [$2] in output" ;;
  esac
}
check_eq() { # check_eq <name> <expected> <actual>
  if [ "$2" = "$3" ]; then
    PASS=$((PASS + 1)); echo "  PASS  $1"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL  $1 — expected [$2] got [$3]"
  fi
}
check_none() { # check_none <name> <haystack> <needle1> [needle2…]
  local name="$1" haystack="$2"; shift 2
  local needle
  for needle in "$@"; do
    case "${haystack}" in
      *"${needle}"*) FAIL=$((FAIL + 1)); echo "  FAIL  ${name} — unexpectedly matched: ${needle}"; return 1 ;;
    esac
  done
  PASS=$((PASS + 1)); echo "  PASS  ${name}"
  return 0
}
check_any() { # check_any <name> <haystack> <needle1> [needle2…]
  local name="$1" haystack="$2"; shift 2
  local needle
  for needle in "$@"; do
    case "${haystack}" in
      *"${needle}"*) PASS=$((PASS + 1)); echo "  PASS  ${name} (matched: ${needle})"; return 0 ;;
    esac
  done
  FAIL=$((FAIL + 1)); echo "  FAIL  ${name} — matched none of: $*"
  return 1
}

PORT_FILE=$(mktemp)
node installer/tests/mock-server.cjs "$(pwd)" "${PORT_FILE}" &
SERVER_PID=$!
WORK=$(mktemp -d)
trap 'kill "${SERVER_PID}" 2>/dev/null; rm -f "${PORT_FILE}"; rm -rf "${WORK}"' EXIT
sleep 1
PORT=$(cat "${PORT_FILE}")
BASE="http://127.0.0.1:${PORT}"
echo "Bootstrap dependency tests (mock server: ${BASE})"

# ── 1. Successful bundle download + helper actually works ────────
# shellcheck disable=SC1091
. installer/lib/bootstrap.sh
rm -rf "${WORK}/a"
OUT=$(bootstrap_download_bundle "${BASE}/ok" "${WORK}/a" 2>&1); RC=$?
check "bundle download succeeds" 0 "$RC"
[ -s "${WORK}/a/installer/install.sh" ] && [ -s "${WORK}/a/installer/lib/bootstrap.sh" ] && [ -s "${WORK}/a/installer/lib/mongo-compat.sh" ]
check "all three bundle files exist and are non-empty" 0 "$?"
# shellcheck disable=SC1090,SC1091
. "${WORK}/a/installer/lib/mongo-compat.sh"
TMP_OS=$(mktemp)
printf 'ID="ubuntu"\nVERSION_ID="26.04"\nVERSION_CODENAME="resolute"\n' > "${TMP_OS}"
select_mongodb_compat "${TMP_OS}" amd64
check_eq "downloaded mongo-compat selects 9.0 for Ubuntu 26.04" "9.0" "${MONGO_VERSION}"
check_eq "downloaded mongo-compat marks it supported" "yes" "${MONGO_SUPPORTED}"

# ── 2. Missing helper file → clear error, safe stop ──────────────
rm -rf "${WORK}/b"
OUT=$(bootstrap_download_bundle "${BASE}/missing" "${WORK}/b" 2>&1); RC=$?
check "missing dependency fails" 1 "$RC"
check_str "error names the missing file" "installer/lib/mongo-compat.sh" "${OUT}"
check_str "error mentions safe stop" "stopped safely" "${OUT}"

# ── 3. Empty helper file → rejected ──────────────────────────────
rm -rf "${WORK}/c"
OUT=$(bootstrap_download_bundle "${BASE}/empty" "${WORK}/c" 2>&1); RC=$?
check "empty dependency fails" 1 "$RC"
check_str "error explains empty download" "EMPTY" "${OUT}"

# ── 4. Corrupted (non-bash) helper → rejected, never executed ────
rm -rf "${WORK}/d"
OUT=$(bootstrap_download_bundle "${BASE}/corrupt" "${WORK}/d" 2>&1); RC=$?
check "corrupted dependency fails" 1 "$RC"
check_str "error explains syntax verification" "syntax verification" "${OUT}"
[ ! -e "${WORK}/d/installer/lib/mongo-compat.sh" ]
check "corrupted file removed (never executed)" 0 "$?"

# ── 5. Method B: lone downloaded install.sh, different CWD ───────
# Only install.sh exists in an arbitrary directory — helper libs must be
# bootstrapped from the repo. Runs must stop safely (no root / no tty).
rm -rf "${WORK}/e"; mkdir -p "${WORK}/e"
cp installer/install.sh "${WORK}/e/install.sh"
OUT=$(cd / && timeout 60 env NIMBUS_RAW_BASE="${BASE}/ok" bash "${WORK}/e/install.sh" < /dev/null 2>&1)
check_any "lone script bootstraps helpers and stops safely" "${OUT}" \
  "Run with sudo" "Re-launching installer" "interactive terminal" "Fetch installer dependencies"
check_none "no fatal dependency failure" "${OUT}" \
  "not found next to the installer" "Failed to download"

# ── 6. Method A simulation: piped execution (curl | bash) ────────
# Piping the script through stdin exactly like the one-command install:
# must download + verify the full bundle and stop safely (root/tty guard).
INSTALLER_ABS="$(pwd)/installer/install.sh"
OUT=$(cd / && timeout 60 env NIMBUS_RAW_BASE="${BASE}/ok" bash < "${INSTALLER_ABS}" 2>&1)
check_any "piped execution bootstraps verified bundle" "${OUT}" \
  "Re-launching installer" "interactive terminal" "Run with sudo"

# ── 7. Cleanup helper ────────────────────────────────────────────
mkdir -p "${WORK}/cleanup"
bootstrap_clean "${WORK}/cleanup"
[ ! -d "${WORK}/cleanup" ]
check "bootstrap_clean removes the directory" 0 "$?"

echo
echo "${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ] || exit 1
