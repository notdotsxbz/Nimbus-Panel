#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  NIMBUS — MongoDB compatibility selection library
#
#  Sourced by install.sh. Centralised, testable OS→MongoDB mapping based
#  on MongoDB's official platform support documentation:
#  https://www.mongodb.com/docs/community-platform-support/
#
#  select_mongodb_compat <os-release-file> <architecture>
#    Sets: MONGO_VERSION  (e.g. 9.0)      MONGO_CODENAME (e.g. resolute)
#          MONGO_SUPPORTED ("yes"/"no")   MONGO_REASON   (human explanation)
#
#  Never constructs a repository for an unsupported codename, never
#  silently installs an unsupported version.
# ═══════════════════════════════════════════════════════════════════

# Mongo repo "codename" for Ubuntu follows $VERSION_CODENAME; for Debian
# releases the official repo also uses the codename (bookworm, bullseye…).

mongo_default_series() {
  # $1 = ID, $2 = codename → newest MongoDB series officially supporting it
  local id="$1" codename="$2"
  case "${id}:${codename}" in
    # Ubuntu 26.04 "Resolute" — supported from MongoDB 9.0 only
    ubuntu:resolute)   echo "9.0" ;;
    # Ubuntu 24.04 / 22.04 — 8.0 and 9.0 both officially supported; prefer newest
    ubuntu:noble)      echo "9.0" ;;
    ubuntu:jammy)      echo "9.0" ;;
    # Ubuntu 20.04 — supported through the 8.0 series (dropped in 9.0)
    ubuntu:focal)      echo "8.0" ;;
    # Debian 12 — 8.0 and 9.0 supported; Debian 11 — last supported by 7.0
    debian:bookworm)   echo "9.0" ;;
    debian:bullseye)   echo "7.0" ;;
    *) echo "" ;;
  esac
}

mongo_min_patch() {
  # First patch release of each series known to fix repo/resolute packaging.
  case "$1" in
    9.0) echo "9.0.4" ;;
    *)   echo "" ;;
  esac
}

select_mongodb_compat() {
  local os_release_file="$1" arch="$2"
  MONGO_VERSION="" MONGO_CODENAME="" MONGO_SUPPORTED="no" MONGO_REASON=""

  if [ ! -r "${os_release_file}" ]; then
    MONGO_REASON="Cannot read ${os_release_file} — OS detection failed."
    return 1
  fi

  # shellcheck disable=SC1090
  local id="" version_id="" codename=""
  id=$(          . "${os_release_file}" && echo "${ID:-}")
  version_id=$(  . "${os_release_file}" && echo "${VERSION_ID:-}")
  codename=$(    . "${os_release_file}" && echo "${VERSION_CODENAME:-}")

  # Architecture validation — MongoDB publishes official packages for these only
  case "${arch}" in
    amd64|x86_64) arch="x86_64" ;;
    arm64|aarch64) arch="aarch64" ;;
    *)
      MONGO_REASON="Unsupported CPU architecture '${arch}' — MongoDB Community publishes official packages for x86_64 and aarch64 only."
      return 1
      ;;
  esac

  case "${id}" in
    ubuntu)
      if [ -z "${codename}" ]; then
        MONGO_REASON="Ubuntu ${version_id} detected but VERSION_CODENAME is empty — cannot select an official MongoDB repository safely."
        return 1
      fi
      local series
      series=$(mongo_default_series "${id}" "${codename}")
      if [ -z "${series}" ]; then
        MONGO_REASON="Ubuntu ${version_id} (${codename}) is not in the NIMBUS tested matrix — refusing to construct an unverified MongoDB repository. See docs/INSTALLATION.md."
        return 1
      fi
      MONGO_VERSION="${series}"
      MONGO_CODENAME="${codename}"
      MONGO_SUPPORTED="yes"
      MONGO_REASON="Ubuntu ${version_id} (${codename}) → MongoDB ${series} (official platform support)"
      return 0
      ;;
    debian)
      if [ -z "${codename}" ]; then
        MONGO_REASON="Debian ${version_id} detected but VERSION_CODENAME is empty — cannot select an official MongoDB repository safely."
        return 1
      fi
      local series
      series=$(mongo_default_series "${id}" "${codename}")
      if [ -z "${series}" ]; then
        MONGO_REASON="Debian ${version_id} (${codename}) is not in the NIMBUS tested matrix — refusing to construct an unverified MongoDB repository. See docs/INSTALLATION.md."
        return 1
      fi
      MONGO_VERSION="${series}"
      MONGO_CODENAME="${codename}"
      MONGO_SUPPORTED="yes"
      MONGO_REASON="Debian ${version_id} (${codename}) → MongoDB ${series} (official platform support)"
      return 0
      ;;
    *)
      MONGO_REASON="Unsupported distribution '${id:-unknown}' — NIMBUS supports Ubuntu 20.04+/Debian 11+ releases listed in docs/INSTALLATION.md."
      return 1
      ;;
  esac
}
