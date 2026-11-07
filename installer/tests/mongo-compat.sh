#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  NIMBUS installer tests — MongoDB compatibility selection
#
#  Runs with real bash (CI: ubuntu-latest). Mocks /etc/os-release via
#  temporary fixture files — no packages are installed or modified.
#
#  Usage: bash installer/tests/mongo-compat.sh
#  Exits non-zero on any failure.
# ═══════════════════════════════════════════════════════════════════
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# shellcheck disable=SC1091
. installer/lib/mongo-compat.sh

TMP=$(mktemp -d)
trap 'rm -rf "${TMP}"' EXIT

PASS=0
FAIL=0

# make_os <id> <version_id> <codename> → writes fixture, prints path
make_os() {
  local f="${TMP}/os-$1-$2-$3"
  printf 'ID="%s"\nVERSION_ID="%s"\nVERSION_CODENAME="%s"\nPRETTY_NAME="%s %s"\n' \
    "$1" "$2" "$3" "$1" "$2" > "${f}"
  echo "${f}"
}

check() { # check <name> <expected> <actual>
  if [ "${2}" = "${3}" ]; then
    PASS=$((PASS + 1))
    echo "  PASS  ${1}"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL  ${1} — expected [${2}] got [${3}]"
  fi
}

select() { # select <fixture> <arch> → runs selection, returns its exit code
  select_mongodb_compat "$1" "$2" >/dev/null 2>&1
}

echo "MongoDB compatibility selection tests"

# ── Ubuntu 26.04 (the previously broken release) ──────────────────
f=$(make_os ubuntu 26.04 resolute); select "${f}" amd64
check "Ubuntu 26.04 detected as supported"      "yes"  "${MONGO_SUPPORTED}"
check "Ubuntu 26.04 selects MongoDB 9.0"        "9.0"  "${MONGO_VERSION}"
check "Ubuntu 26.04 codename resolute"          "resolute" "${MONGO_CODENAME}"

# ── Ubuntu 24.04 / 22.04 / 20.04 ──────────────────────────────────
f=$(make_os ubuntu 24.04 noble); select "${f}" amd64
check "Ubuntu 24.04 supported"                  "yes"  "${MONGO_SUPPORTED}"
check "Ubuntu 24.04 selects 9.0"                "9.0"  "${MONGO_VERSION}"

f=$(make_os ubuntu 22.04 jammy); select "${f}" amd64
check "Ubuntu 22.04 supported"                  "yes"  "${MONGO_SUPPORTED}"
check "Ubuntu 22.04 selects 9.0"                "9.0"  "${MONGO_VERSION}"

f=$(make_os ubuntu 20.04 focal); select "${f}" amd64
check "Ubuntu 20.04 supported"                  "yes"  "${MONGO_SUPPORTED}"
check "Ubuntu 20.04 selects 8.0 (last for focal)" "8.0" "${MONGO_VERSION}"

# ── Debian releases ───────────────────────────────────────────────
f=$(make_os debian 12 bookworm); select "${f}" amd64
check "Debian 12 supported"                     "yes"  "${MONGO_SUPPORTED}"
check "Debian 12 selects 9.0"                   "9.0"  "${MONGO_VERSION}"

f=$(make_os debian 11 bullseye); select "${f}" amd64
check "Debian 11 supported"                     "yes"  "${MONGO_SUPPORTED}"
check "Debian 11 selects 7.0 (last for bullseye)" "7.0" "${MONGO_VERSION}"

# ── Unsupported releases must be REJECTED (no repo ever constructed) ─
f=$(make_os ubuntu 25.10 questing); select "${f}" amd64
check "Ubuntu 25.10 (interim) rejected"         "no"   "${MONGO_SUPPORTED}"
check "Ubuntu 25.10 selects no version"         ""     "${MONGO_VERSION}"

f=$(make_os ubuntu 23.10 mantic); select "${f}" amd64
check "Ubuntu 23.10 (EOL interim) rejected"     "no"   "${MONGO_SUPPORTED}"

f=$(make_os centos 9 stream); select "${f}" amd64
check "CentOS rejected"                         "no"   "${MONGO_SUPPORTED}"

# ── Architecture validation ───────────────────────────────────────
f=$(make_os ubuntu 26.04 resolute); select "${f}" ppc64le
check "ppc64le rejected"                        "no"   "${MONGO_SUPPORTED}"

f=$(make_os ubuntu 26.04 resolute); select "${f}" arm64
check "arm64 supported"                         "yes"  "${MONGO_SUPPORTED}"

select "${f}" x86_64
check "x86_64 alias of amd64 supported"         "yes"  "${MONGO_SUPPORTED}"

# ── Degenerate inputs ─────────────────────────────────────────────
select "${TMP}/does-not-exist" amd64
check "missing os-release rejected"             "no"   "${MONGO_SUPPORTED}"

f=$(make_os ubuntu 26.04 ""); select "${f}" amd64
check "empty codename rejected (no repo guess)" "no"   "${MONGO_SUPPORTED}"

# ── Override helper sanity ────────────────────────────────────────
check "mongo_default_series ubuntu/resolute"    "9.0"  "$(mongo_default_series ubuntu resolute)"
check "mongo_default_series debian/bullseye"    "7.0"  "$(mongo_default_series debian bullseye)"
check "mongo_default_series unknown"            ""     "$(mongo_default_series ubuntu questing)"

echo
echo "${PASS} passed, ${FAIL} failed"
exit $([ "${FAIL}" -eq 0 ] && echo 0 || echo 1)
