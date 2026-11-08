#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  NIMBUS installer tests — OS detection & strict-mode safety
#
#  Real bash, fixture os-release files, stub ss binary. Includes
#  regression tests for the two production failures:
#    - BASH_SOURCE[0]: unbound variable (piped execution, set -u)
#    - line-221 abort: no-match grep + pipefail inside a substitution
#
#  Usage: bash installer/tests/os-detect.sh
# ═══════════════════════════════════════════════════════════════════
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

PASS=0
FAIL=0
check() { if [ "$2" -eq "$3" ]; then PASS=$((PASS+1)); echo "  PASS  $1"; else FAIL=$((FAIL+1)); echo "  FAIL  $1 — expected exit $2 got $3"; fi; }
check_eq() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  PASS  $1"; else FAIL=$((FAIL+1)); echo "  FAIL  $1 — expected [$2] got [$3]"; fi; }
check_none() {
  local name="$1" haystack="$2"; shift 2
  local needle
  for needle in "$@"; do
    case "${haystack}" in
      *"${needle}"*) FAIL=$((FAIL+1)); echo "  FAIL  ${name} — unexpectedly matched: ${needle}"; return 1 ;;
    esac
  done
  PASS=$((PASS+1)); echo "  PASS  ${name}"
}

# shellcheck disable=SC1091
. installer/lib/os-detect.sh

FIX=$(mktemp -d)
trap 'rm -rf "${FIX}"' EXIT

make_os() { # make_os <name> <content>
  printf '%s\n' "$2" > "${FIX}/os-$1"
  echo "${FIX}/os-$1"
}

echo "OS detection & strict-mode safety tests"

# ── 1. Ubuntu 26.04 (target release) ─────────────────────────────
f=$(make_os 2604 'ID="ubuntu"
VERSION_ID="26.04"
VERSION_CODENAME="resolute"
PRETTY_NAME="Ubuntu 26.04.1 LTS"')
OS_RELEASE_FILE="${f}" system_detect
check_eq "26.04: id"            "ubuntu"  "${OS_ID}"
check_eq "26.04: codename"      "resolute" "${OS_CODENAME}"
check_eq "26.04: pretty"        "Ubuntu 26.04.1 LTS" "${OS_PRETTY}"
# Package manager is environment-dependent (CI runners are non-Debian).
case "${PKG_MANAGER}" in apt|none) PASS=$((PASS+1)); echo "  PASS  26.04: package manager detected (${PKG_MANAGER})";; *) FAIL=$((FAIL+1)); echo "  FAIL  26.04: unexpected package manager [${PKG_MANAGER}]";; esac
[ -n "${KERNEL}" ] && [ -n "${ARCH}" ] && [ "${CPU_CORES}" -ge 1 ] && [ "${TOTAL_RAM_MB}" -ge 0 ] && [ "${DISK_GB}" -ge 0 ]
check "26.04: kernel/arch/cpu/ram/disk populated" 0 "$?"

# ── 2. Ubuntu 24.04 / 22.04 / Debian ─────────────────────────────
f=$(make_os 2404 'ID="ubuntu"
VERSION_ID="24.04"
VERSION_CODENAME="noble"')
OS_RELEASE_FILE="${f}" system_detect
check_eq "24.04: codename" "noble" "${OS_CODENAME}"

f=$(make_os 2204 'ID="ubuntu"
VERSION_ID="22.04"
VERSION_CODENAME="jammy"')
OS_RELEASE_FILE="${f}" system_detect
check_eq "22.04: codename" "jammy" "${OS_CODENAME}"

f=$(make_os deb12 'ID="debian"
VERSION_ID="12"
VERSION_CODENAME="bookworm"')
OS_RELEASE_FILE="${f}" system_detect
check_eq "Debian 12: codename" "bookworm" "${OS_CODENAME}"

# ── 3. Optional values missing — must not abort under set -u ─────
f=$(make_os minimal 'ID="ubuntu"')
OS_RELEASE_FILE="${f}" system_detect
check_eq "minimal os-release: empty codename tolerated" "" "${OS_CODENAME}"
check_eq "minimal os-release: pretty fallback" "unknown" "${OS_PRETTY}"

# ── 4. Missing os-release file — must not abort ──────────────────
OS_RELEASE_FILE="${FIX}/does-not-exist" system_detect
check_eq "missing os-release: safe fallback" "unknown" "${OS_PRETTY}"

# ── 5. detect_busy_ports never fails (the line-221 regression) ───
# Stub `ss` that listens on nothing → grep no-match (the exact crash).
STUB="${FIX}/stub-bin"
mkdir -p "${STUB}"
printf '#!/bin/bash\necho "State Recv-Q Send-Q Local Address:Port"\n' > "${STUB}/ss"
chmod +x "${STUB}/ss"
OUT=$(PATH="${STUB}:${PATH}" detect_busy_ports "3000 4000"); RC=$?
check "busy-port scan with NO listeners does not fail" 0 "$RC"
check_eq "busy-port scan empty output" "" "${OUT}"

printf '#!/bin/bash\necho "LISTEN 0 511 0.0.0.0:4000"\necho "LISTEN 0 511 *:3000"\n' > "${STUB}/ss"
chmod +x "${STUB}/ss"
OUT=$(PATH="${STUB}:${PATH}" detect_busy_ports "3000 4000"); RC=$?
check "busy-port scan with listeners does not fail" 0 "$RC"
case "${OUT}" in *3000*4000*) PASS=$((PASS+1)); echo "  PASS  both busy ports reported";; *) FAIL=$((FAIL+1)); echo "  FAIL  ports missing from output: [${OUT}]";; esac

# No ss binary at all → safe empty result
OUT=$(PATH="${FIX}/empty-path" detect_busy_ports "3000 4000"); RC=$?
check "busy-port scan without ss does not fail" 0 "$RC"

# ── 6. Strict-mode regression: piped install.sh must not print
#      BASH_SOURCE unbound-variable errors ────────────────────────
INSTALLER_ABS="$(pwd)/installer/install.sh"
OUT=$(cd / && timeout 60 bash < "${INSTALLER_ABS}" < /dev/null 2>&1 || true)
check_none "piped execution: no BASH_SOURCE unbound error" "${OUT}" \
  "unbound variable" "BASH_SOURCE"
check_none "piped execution: no strict-mode crash" "${OUT}" \
  "unbound variable"

echo
echo "${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ] || exit 1
