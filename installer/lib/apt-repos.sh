#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  NIMBUS — MongoDB APT repository audit & repair
#
#  Parses the CONTENTS of every active APT source (traditional .list and
#  deb822 .sources), finds MongoDB repository entries, reports version and
#  codename, and safely disables entries that do not match the selected
#  MongoDB series — with backups, never deletion, never touching unrelated
#  repositories or database files.
#
#  APT_SOURCES_DIR overrides /etc/apt for testing.
#
#  Functions:
#    mongo_repo_entries <file>            → "version codename" per entry
#    audit_mongo_repos                    → human-readable audit listing
#    repair_mongo_repos <series> <codename> [backup_dir]
#    apt_update_validated                 → fail-safe apt-get update
# ═══════════════════════════════════════════════════════════════════

APT_SOURCES_DIR="${APT_SOURCES_DIR:-/etc/apt}"

# Extract "version codename" from a MongoDB repo entry file (any format).
# Empty output = no MongoDB entry.
mongo_repo_entries() {
  local file="$1" out=""
  [ -r "${file}" ] || return 0
  case "${file}" in
    *.list)
      # deb [arch=… signed-by=…] https://repo.mongodb.org/apt/ubuntu resolute/mongodb-org/9.0 multiverse
      # Any host is matched (official repo AND mirrors) via the mongodb-org/<version> suite marker.
      while IFS= read -r line; do
        local ver codename
        ver=$(printf '%s' "${line}" | grep -oE 'mongodb-org/[0-9]+(\.[0-9]+)?' | head -1 | cut -d/ -f2 || true)
        codename=$(printf '%s' "${line}" | grep -oE '(apt/(ubuntu|debian)|/dists/) [a-z]+/mongodb-org' | awk '{print $2}' | cut -d/ -f1 || true)
        [ -n "${ver}" ] && out+="${ver} ${codename:-unknown}"$'\n'
      done < <(grep -E '^[[:space:]]*deb[[:space:]].*mongodb-org/[0-9]' "${file}")
      ;;
    *.sources)
      # deb822: Suites: resolute/mongodb-org/9.0
      if grep -qiE 'mongodb-org/[0-9]' "${file}"; then
        local ver codename
        ver=$(grep -iE '^Suites:' "${file}" | grep -oE 'mongodb-org/[0-9]+(\.[0-9]+)?' | head -1 | cut -d/ -f2 || true)
        codename=$(grep -iE '^Suites:' "${file}" | head -1 | sed -E 's/^[^:]*:[[:space:]]*//' | cut -d/ -f1 || true)
        [ -n "${ver}" ] && out+="${ver} ${codename:-unknown}"$'\n'
      fi
      ;;
  esac
  printf '%s' "${out}"
}

audit_mongo_repos() {
  local found=0 f info
  for f in "${APT_SOURCES_DIR}/sources.list" "${APT_SOURCES_DIR}"/sources.list.d/*.list "${APT_SOURCES_DIR}"/sources.list.d/*.sources; do
    [ -r "${f}" ] || continue
    info=$(mongo_repo_entries "${f}") || true
    [ -z "${info}" ] && continue
    found=1
    while IFS= read -r entry; do
      [ -z "${entry}" ] && continue
      printf 'mongo-repo: file=%s version=%s codename=%s\n' "$(basename "${f}")" ${entry}
    done <<< "${info}"
  done
  [ "${found}" -eq 0 ] && printf 'mongo-repo: none configured\n'
  return 0
}

# Disable every MongoDB repo entry that does not match <series>+<codename>.
# Matching entries are kept. Non-matching files are MOVED (not deleted) into
# the backup directory — apt only reads sources.list.d/*.list and *.sources,
# so relocation fully disables them while preserving the original content.
# Foreign (non-NIMBUS-filename) repositories are also disabled but flagged.
repair_mongo_repos() {
  local series="$1" codename="$2"
  local backup_dir="${3:-${APT_SOURCES_DIR}/nimbus-repo-backup-$(date +%Y%m%d-%H%M%S)}"
  local repaired=0 f info
  mkdir -p "${backup_dir}"

  for f in "${APT_SOURCES_DIR}/sources.list" "${APT_SOURCES_DIR}"/sources.list.d/*.list "${APT_SOURCES_DIR}"/sources.list.d/*.sources; do
    [ -r "${f}" ] || continue
    # sources.list (the main file) is never moved — entries are commented out.
    info=$(mongo_repo_entries "${f}") || true
    [ -z "${info}" ] && continue

    local conflicts=0
    while IFS= read -r entry; do
      [ -z "${entry}" ] && continue
      local ver cod
      ver=$(printf '%s' "${entry}" | awk '{print $1}')
      cod=$(printf '%s' "${entry}" | awk '{print $2}')
      if [ "${ver}" != "${series}" ] || [ "${cod}" != "${codename}" ]; then
        conflicts=$((conflicts + 1))
      fi
    done <<< "${info}"

    [ "${conflicts}" -eq 0 ] && continue

    local base fname
    base=$(basename "${f}")
    if [ "${f}" = "${APT_SOURCES_DIR}/sources.list" ]; then
      # Comment out conflicting MongoDB lines in the main sources file.
      cp "${f}" "${backup_dir}/${base}.bak"
      awk -v series="${series}" '
        /repo\.mongodb\.org/ && /^[[:space:]]*deb[[:space:]]/ && $0 !~ ("mongodb-org/" series "[[:space:]]") {
          print "# [nimbus-disabled stale MongoDB repo] " $0; next
        }
        { print }
      ' "${f}" > "${f}.nimbus-tmp" && mv "${f}.nimbus-tmp" "${f}"
      log "Disabled conflicting MongoDB repository entries inside sources.list (backup: ${backup_dir}/${base}.bak)"
      repaired=$((repaired + 1))
    else
      fname="${base}"
      # Move out of sources.list.d — apt no longer reads it. Foreign repos
      # (not written by NIMBUS) are flagged loudly but handled the same way:
      # preserved in the backup, never destroyed.
      mv "${f}" "${backup_dir}/${fname}"
      case "${base}" in
        mongodb-org-*.list|mongodb-org-*.sources)
          log "Disabled NIMBUS-managed stale repository ${base} (moved to ${backup_dir})"
          ;;
        *)
          warn "Disabled FOREIGN MongoDB repository ${base} (moved to ${backup_dir}) — review it if you configured it manually."
          ;;
      esac
      repaired=$((repaired + 1))
    fi
  done

  # Final consistency enforcement: no non-matching version OR codename may
  # remain active anywhere.
  local line ver cod bad=0
  while IFS= read -r line; do
    case "${line}" in
      *"none configured") continue ;;
      mongo-repo:*) ;;
      *) continue ;;
    esac
    ver=$(printf '%s' "${line}" | sed -E 's/.*version=([^ ]+).*/\1/')
    cod=$(printf '%s' "${line}" | sed -E 's/.*codename=([^ ]+).*/\1/')
    if [ "${ver}" != "${series}" ] || [ "${cod}" != "${codename}" ]; then
      bad=1
      printf '[nimbus] Conflicting entry still active: %s\n' "${line}" >&2
    fi
  done < <(audit_mongo_repos)
  if [ "${bad}" -ne 0 ]; then
    die "Conflicting MongoDB repositories remain active after repair — refusing to continue. Inspect ${APT_SOURCES_DIR}/sources.list.d/ manually."
  fi
  [ "${repaired}" -gt 0 ] && log "MongoDB repository repair complete: ${repaired} source(s) disabled, backups in ${backup_dir}"
  return 0
}

# apt-get update with real failure reporting: prints failing repo URLs and
# the APT error lines, then returns non-zero. Never hides errors.
apt_update_validated() {
  local out
  if ! out=$(apt-get update 2>&1); then
    printf '[nimbus] ERROR: apt-get update failed.\n' >&2
    printf '%s\n' "${out}" | grep -E '^(E:|Err:)' | head -10 >&2 || true
    local failing
    failing=$(printf '%s\n' "${out}" | grep -oE 'https?://[^ "]+|^https?://[^ "]+' | sort -u | head -5 || true)
    [ -n "${failing}" ] && printf 'Failing repository URL(s):\n%s\n' "${failing}" >&2
    printf 'Recovery: fix or remove the failing APT source (files in %s), then re-run the installer.\n' "${APT_SOURCES_DIR}/sources.list.d" >&2
    return 1
  fi
  return 0
}
