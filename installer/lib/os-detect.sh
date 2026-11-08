#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  NIMBUS — centralized OS / system detection
#
#  All expansions are guarded for strict mode (set -u) and all pipelines
#  are guarded for pipefail: a non-matching grep must never abort the
#  installer. OS_RELEASE_FILE overrides /etc/os-release for tests.
#
#  system_detect           → sets OS_*, ARCH, KERNEL, CPU_CORES,
#                            TOTAL_RAM_MB, DISK_GB, PKG_MANAGER
#  check_connectivity      → 3 retries; returns non-zero when offline
#  detect_busy_ports       → echoes busy NIMBUS ports (never fails)
# ═══════════════════════════════════════════════════════════════════

OS_RELEASE_FILE="${OS_RELEASE_FILE:-/etc/os-release}"

system_detect() {
  OS_ID="" OS_VERSION_ID="" OS_CODENAME="" OS_PRETTY="unknown"
  KERNEL="$(uname -r 2>/dev/null || true)"
  ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m || true)"
  PKG_MANAGER="apt"
  command -v apt-get >/dev/null 2>&1 || PKG_MANAGER="none"

  if [ -r "${OS_RELEASE_FILE}" ]; then
    # Clear variables a previous os-release source may have left behind —
    # sourcing must never leak stale values into this detection.
    unset ID VERSION_ID VERSION_CODENAME PRETTY_NAME 2>/dev/null || true
    # shellcheck disable=SC1090
    . "${OS_RELEASE_FILE}"
    OS_ID="${ID:-}"
    OS_VERSION_ID="${VERSION_ID:-}"
    OS_CODENAME="${VERSION_CODENAME:-}"
    OS_PRETTY="${PRETTY_NAME:-unknown}"
  fi

  TOTAL_RAM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
  CPU_CORES=$(nproc 2>/dev/null || echo 1)
  DISK_GB=$(df -BG / 2>/dev/null | awk 'NR==2 {print int($4)}' || echo 0)
  return 0
}

# Print advisory busy-port list. MUST never fail: grep returning no match
# is a normal result, and under pipefail a failing pipeline inside a
# command substitution would abort a strict-mode caller (the line-221 bug).
detect_busy_ports() {
  local ports="${1:-3000 4000}"
  command -v ss >/dev/null 2>&1 || return 0
  local pattern
  pattern=$(printf ':(%s)\\b' "$(printf '%s' "${ports}" | tr ' ' '|')")
  ss -ltn 2>/dev/null | grep -oE "${pattern}" | sort -u | tr -d ':' | tr '\n' ' ' || true
  return 0
}

# Connectivity probe with bounded retries (uses curl or wget).
check_connectivity() {
  local attempts="${1:-3}" i
  for i in $(seq 1 "${attempts}"); do
    if command -v curl >/dev/null 2>&1; then
      curl -fsI --max-time 10 https://repo.mongodb.org/ >/dev/null 2>&1 \
        && return 0
      curl -fsI --max-time 10 http://archive.ubuntu.com/ubuntu/ >/dev/null 2>&1 \
        && return 0
    elif command -v wget >/dev/null 2>&1; then
      wget -q --spider --timeout=10 https://repo.mongodb.org/ 2>/dev/null && return 0
      wget -q --spider --timeout=10 http://archive.ubuntu.com/ubuntu/ 2>/dev/null && return 0
    else
      return 1
    fi
    [ "${i}" -lt "${attempts}" ] && sleep 5
  done
  return 1
}
