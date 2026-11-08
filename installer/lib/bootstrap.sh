#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  NIMBUS — installer dependency bootstrap
#
#  Fetches required helper files from the official repository into an
#  explicit bootstrap directory and verifies them. A piped script has NO
#  usable script directory ($0 and $BASH_SOURCE are meaningless), so all
#  helper loading goes through this module instead of relative paths.
#
#  Public functions:
#    bootstrap_fetch_files <raw_base> <dest_dir> <relative_path>…
#        Downloads each file to <dest_dir>/<relative_path>, rejecting
#        empty responses and non-bash syntax. Returns non-zero with a
#        detailed message on any failure — never silently skips.
#
#    bootstrap_clean <dest_dir>
#
#  Integrity model:
#    - same-origin fetch from the official repo only
#    - NIMBUS_INSTALL_REF env pins an exact commit (recommended for prod)
#    - every file must be non-empty AND pass `bash -n` before execution
# ═══════════════════════════════════════════════════════════════════

bootstrap_fetch_file() {
  local raw_base="$1" dest_dir="$2" rel="$3"
  local dest="${dest_dir}/${rel}"
  local url="${raw_base}/${rel}"
  mkdir -p "$(dirname "${dest}")"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "${url}" -o "${dest}" || {
      printf '[NIMBUS] ERROR: Failed to download required installer dependency.\n' >&2
      printf 'File: %s\nURL:  %s\n' "${rel}" "${url}" >&2
      printf 'Possible causes:\n  - File is missing from the GitHub repository\n  - File was not pushed to the selected branch/ref\n  - GitHub download failed (network, DNS, proxy)\nInstallation stopped safely. No changes were made.\n' >&2
      return 1
    }
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "${dest}" "${url}" || {
      printf '[NIMBUS] ERROR: Failed to download required installer dependency.\nFile: %s\nURL:  %s\nInstallation stopped safely. No changes were made.\n' "${rel}" "${url}" >&2
      return 1
    }
  else
    printf '[NIMBUS] ERROR: Neither curl nor wget is available to fetch %s.\n' "${rel}" >&2
    return 1
  fi

  if [ ! -s "${dest}" ]; then
    printf '[NIMBUS] ERROR: Downloaded dependency is EMPTY — refusing to use it.\nFile: %s\nExpected location: %s\n' "${rel}" "${dest}" >&2
    rm -f "${dest}"
    return 1
  fi

  if ! bash -n "${dest}" 2>/dev/null; then
    printf '[NIMBUS] ERROR: Downloaded dependency failed bash syntax verification — possibly a truncated or corrupted download.\nFile: %s\nExpected location: %s\n' "${rel}" "${dest}" >&2
    rm -f "${dest}"
    return 1
  fi
  return 0
}

bootstrap_fetch_files() {
  local raw_base="$1" dest_dir="$2"
  shift 2
  local rel
  for rel in "$@"; do
    bootstrap_fetch_file "${raw_base}" "${dest_dir}" "${rel}" || return 1
  done
  return 0
}

bootstrap_clean() {
  local dest_dir="$1"
  [ -d "${dest_dir}" ] && rm -rf "${dest_dir}"
  return 0
}

# Downloads and verifies the COMPLETE installer bundle (self + helpers)
# into <dest_dir>. Used by the piped-execution guard and available to
# tests via a mocked raw base. Fails safely on any missing/invalid file.
bootstrap_download_bundle() {
  local raw_base="$1" dest_dir="$2"
  bootstrap_fetch_files "${raw_base}" "${dest_dir}" \
    "installer/install.sh" \
    "installer/lib/bootstrap.sh" \
    "installer/lib/mongo-compat.sh" \
    "installer/lib/apt-repos.sh" \
    "installer/lib/os-detect.sh" \
    "installer/lib/validation.sh" || return 1
  local f
  for f in "installer/install.sh" "installer/lib/bootstrap.sh" "installer/lib/mongo-compat.sh" "installer/lib/apt-repos.sh" "installer/lib/os-detect.sh" "installer/lib/validation.sh"; do
    [ -s "${dest_dir}/${f}" ] || {
      printf '[NIMBUS] ERROR: Bundle file missing after download: %s\n' "${f}" >&2
      return 1
    }
  done
  return 0
}
