#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  NIMBUS installer tests — MongoDB APT repository audit & repair
#
#  Uses isolated fixture directories (APT_SOURCES_DIR override). No real
#  APT configuration or packages are touched. Real bash.
#
#  Usage: bash installer/tests/apt-repos.sh
# ═══════════════════════════════════════════════════════════════════
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# Installer framework stubs (the lib expects them from install.sh)
log()  { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*"; }
die()  { printf 'DIE: %s\n' "$*" >&2; exit 1; }

PASS=0
FAIL=0
check() { if [ "$2" -eq "$3" ]; then PASS=$((PASS+1)); echo "  PASS  $1"; else FAIL=$((FAIL+1)); echo "  FAIL  $1 — expected exit $2 got $3"; fi; }
check_eq() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  PASS  $1"; else FAIL=$((FAIL+1)); echo "  FAIL  $1 — expected [$2] got [$3]"; fi; }

FIX=$(mktemp -d)
trap 'rm -rf "${FIX}"' EXIT

new_root() { # new_root <name> → fresh apt root dir
  mkdir -p "${FIX}/$1/sources.list.d"
  echo "${FIX}/$1"
}

write_7_list() { # classic stale NIMBUS 7.0 repo (the reported failure)
  printf 'deb [ arch=amd64 signed-by=/etc/apt/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu resolute/mongodb-org/7.0 multiverse\n' > "$1/sources.list.d/mongodb-org-7.0.list"
}
write_7_sources() { # stale deb822 format
  cat > "$1/sources.list.d/mongodb-org-7.0.sources" <<'EOF'
X-Repolib-Name: MongoDB
Enabled: yes
URIs: https://repo.mongodb.org/apt/ubuntu
Suites: resolute/mongodb-org/7.0
Components: multiverse
Signed-By: /etc/apt/keyrings/mongodb-server-7.0.gpg
EOF
}
write_9_list() {
  printf 'deb [ arch=amd64 signed-by=/etc/apt/keyrings/mongodb-server-9.0.gpg ] https://repo.mongodb.org/apt/ubuntu resolute/mongodb-org/9.0 multiverse\n' > "$1/sources.list.d/mongodb-org-9.0.list"
}
write_unrelated() {
  printf 'deb https://nginx.org/packages/ubuntu noble nginx\n' > "$1/sources.list.d/nginx.list"
  printf 'deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main\n' > "$1/sources.list.d/nodesource.sources"
}

# shellcheck disable=SC1091
. installer/lib/apt-repos.sh

echo "MongoDB APT repository audit & repair tests"

# ── Parsing: both formats ─────────────────────────────────────────
R=$(new_root parse); write_7_list "${R}"; write_7_sources "${R}"
OUT=$(APT_SOURCES_DIR="${R}" audit_mongo_repos)
check_eq ".list parse: version"     "7.0"      "$(printf '%s\n' "${OUT}" | grep 'mongodb-org-7.0.list' | awk '{print $3}' | cut -d= -f2)"
check_eq ".list parse: codename"    "resolute" "$(printf '%s\n' "${OUT}" | grep 'mongodb-org-7.0.list' | awk '{print $4}' | cut -d= -f2)"
check_eq ".sources parse: version"  "7.0"      "$(printf '%s\n' "${OUT}" | grep 'mongodb-org-7.0.sources' | awk '{print $3}' | cut -d= -f2)"
check_eq ".sources parse: codename" "resolute" "$(printf '%s\n' "${OUT}" | grep 'mongodb-org-7.0.sources' | awk '{print $4}' | cut -d= -f2)"

# ── Repair 1: stale NIMBUS 7.0 .list on Ubuntu 26.04 ─────────────
R=$(new_root r1); write_7_list "${R}"; write_unrelated "${R}"
APT_SOURCES_DIR="${R}" repair_mongo_repos "9.0" "resolute" >/dev/null 2>&1
check "stale 7.0 .list disabled (removed from sources.list.d)" 0 "$([ -e "${R}/sources.list.d/mongodb-org-7.0.list" ] && echo 1 || echo 0)"
check "stale 7.0 .list preserved in backup" 0 "$([ -s "$(find "${R}"/nimbus-repo-backup-* -name 'mongodb-org-7.0.list' 2>/dev/null | head -1)" ] && echo 0 || echo 1)"
[ -e "${R}/sources.list.d/nginx.list" ] && [ -e "${R}/sources.list.d/nodesource.sources" ]
check "unrelated repositories untouched" 0 "$?"

# ── Repair 2: stale deb822 7.0 .sources ──────────────────────────
R=$(new_root r2); write_7_sources "${R}"
APT_SOURCES_DIR="${R}" repair_mongo_repos "9.0" "resolute" >/dev/null 2>&1
check "stale 7.0 .sources disabled" 0 "$([ -e "${R}/sources.list.d/mongodb-org-7.0.sources" ] && echo 1 || echo 0)"
check "stale 7.0 .sources preserved in backup" 0 "$([ -s "$(find "${R}"/nimbus-repo-backup-* -name 'mongodb-org-7.0.sources' 2>/dev/null | head -1)" ] && echo 0 || echo 1)"

# ── Repair 3: correct 9.0 repo is PRESERVED ──────────────────────
R=$(new_root r3); write_9_list "${R}"
APT_SOURCES_DIR="${R}" repair_mongo_repos "9.0" "resolute" >/dev/null 2>&1
check "correct 9.0 repo kept in place" 0 "$([ -s "${R}/sources.list.d/mongodb-org-9.0.list" ] && echo 0 || echo 1)"

# ── Repair 4: duplicates — wrong removed, right kept ─────────────
R=$(new_root r4); write_7_list "${R}"; write_9_list "${R}"
APT_SOURCES_DIR="${R}" repair_mongo_repos "9.0" "resolute" >/dev/null 2>&1
check "duplicate 7.0 removed" 0 "$([ -e "${R}/sources.list.d/mongodb-org-7.0.list" ] && echo 1 || echo 0)"
check "correct 9.0 kept" 0 "$([ -s "${R}/sources.list.d/mongodb-org-9.0.list" ] && echo 0 || echo 1)"

# ── Repair 5: conflicting entry in main sources.list ─────────────
R=$(new_root r5)
{
  printf 'deb http://archive.ubuntu.com/ubuntu resolute main\n'
  printf 'deb [ arch=amd64 ] https://repo.mongodb.org/apt/ubuntu resolute/mongodb-org/7.0 multiverse\n'
} > "${R}/sources.list"
APT_SOURCES_DIR="${R}" repair_mongo_repos "9.0" "resolute" >/dev/null 2>&1
grep -q '^deb http://archive.ubuntu.com/ubuntu resolute main' "${R}/sources.list"
check "unrelated main sources.list line kept" 0 "$?"
grep -q '^# \[nimbus-disabled stale MongoDB repo\] deb' "${R}/sources.list"
check "conflicting mongo line commented out" 0 "$?"

# ── Repair 6: foreign MongoDB repo flagged and disabled ──────────
R=$(new_root r6)
printf 'deb https://mongo.example.com/apt/ubuntu resolute/mongodb-org/7.0 multiverse\n' > "${R}/sources.list.d/my-mongo.list"
OUT=$(APT_SOURCES_DIR="${R}" repair_mongo_repos "9.0" "resolute" 2>&1)
check "foreign mongo repo disabled" 0 "$([ -e "${R}/sources.list.d/my-mongo.list" ] && echo 1 || echo 0)"
case "${OUT}" in *FOREIGN*) PASS=$((PASS+1)); echo "  PASS  foreign repo flagged loudly";; *) FAIL=$((FAIL+1)); echo "  FAIL  foreign repo not flagged";; esac

# ── Repair 7: version-only conflict (right codename, wrong version) ─
R=$(new_root r7)
printf 'deb [ arch=amd64 ] https://repo.mongodb.org/apt/ubuntu resolute/mongodb-org/8.0 multiverse\n' > "${R}/sources.list.d/mongodb-org-8.0.list"
APT_SOURCES_DIR="${R}" repair_mongo_repos "9.0" "resolute" >/dev/null 2>&1
check "wrong-version repo disabled" 0 "$([ -e "${R}/sources.list.d/mongodb-org-8.0.list" ] && echo 1 || echo 0)"

# ── Repair 8: codename-only conflict (right version, wrong codename) ─
R=$(new_root r8)
printf 'deb [ arch=amd64 ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/9.0 multiverse\n' > "${R}/sources.list.d/mongodb-org-9.0-jammy.list"
APT_SOURCES_DIR="${R}" repair_mongo_repos "9.0" "resolute" >/dev/null 2>&1
check "wrong-codename repo disabled" 0 "$([ -e "${R}/sources.list.d/mongodb-org-9.0-jammy.list" ] && echo 1 || echo 0)"

# ── Consistency: audit after repair shows no conflicts ───────────
R=$(new_root r9); write_7_list "${R}"; write_9_list "${R}"
APT_SOURCES_DIR="${R}" repair_mongo_repos "9.0" "resolute" >/dev/null 2>&1
OUT=$(APT_SOURCES_DIR="${R}" audit_mongo_repos)
case "${OUT}" in *7.0*) FAIL=$((FAIL+1)); echo "  FAIL  audit still shows 7.0 after repair";; *) PASS=$((PASS+1)); echo "  PASS  audit clean after repair";; esac

# ── apt_update_validated: failure reporting with URL ─────────────
STUB=$(mktemp -d)
cat > "${STUB}/apt-get" <<'EOF'
#!/bin/bash
echo "Hit:1 http://archive.ubuntu.com/ubuntu resolute InRelease" >&2
echo "Err:5 https://repo.mongodb.org/apt/ubuntu resolute/mongodb-org/7.0 Release" >&2
echo "E: The repository 'https://repo.mongodb.org/apt/ubuntu resolute/mongodb-org/7.0 Release' does not have a Release file." >&2
exit 100
EOF
chmod +x "${STUB}/apt-get"
OUT=$(PATH="${STUB}:${PATH}" APT_SOURCES_DIR="${FIX}/nonexistent" apt_update_validated 2>&1); RC=$?
check "apt_update_validated fails on apt error" 1 "$RC"
case "${OUT}" in
  *"repo.mongodb.org"*) PASS=$((PASS+1)); echo "  PASS  failing repository URL reported"; ;;
  *) FAIL=$((FAIL+1)); echo "  FAIL  failing URL missing from output"; ;;
esac
case "${OUT}" in
  *"does not have a Release file"*) PASS=$((PASS+1)); echo "  PASS  original APT error shown"; ;;
  *) FAIL=$((FAIL+1)); echo "  FAIL  original APT error hidden"; ;;
esac
case "${OUT}" in
  *"Recovery:"*) PASS=$((PASS+1)); echo "  PASS  recovery action printed"; ;;
  *) FAIL=$((FAIL+1)); echo "  FAIL  recovery action missing"; ;;
esac

cat > "${STUB}/apt-get" <<'EOF'
#!/bin/bash
echo "Hit:1 http://archive.ubuntu.com/ubuntu resolute InRelease"
exit 0
EOF
chmod +x "${STUB}/apt-get"
PATH="${STUB}:${PATH}" APT_SOURCES_DIR="${FIX}/nonexistent" apt_update_validated >/dev/null 2>&1
check "apt_update_validated succeeds on healthy output" 0 "$?"

echo
echo "${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ] || exit 1
