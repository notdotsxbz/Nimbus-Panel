#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  NIMBUS — installer function validation
#
#  After the helper libraries are sourced, this module verifies that
#  EVERY function the installer will call is actually defined in the
#  current shell. A missing helper surfaces here — with the function
#  name and the file expected to provide it — instead of as a mid-install
#  "command not found" (exit 127) later in the pipeline.
#
#  validate_required_functions
# ═══════════════════════════════════════════════════════════════════

validate_required_functions() {
  # function_name : file expected to provide it
  local manifest=(
    "log:install.sh"                                       "warn:install.sh"
    "die:install.sh"                                       "step:install.sh"
    "on_error:install.sh"                                  "tty_read:install.sh"
    "bootstrap_fetch_file:installer/lib/bootstrap.sh"      "bootstrap_fetch_files:installer/lib/bootstrap.sh"
    "bootstrap_download_bundle:installer/lib/bootstrap.sh" "bootstrap_clean:installer/lib/bootstrap.sh"
    "mongo_default_series:installer/lib/mongo-compat.sh"   "select_mongodb_compat:installer/lib/mongo-compat.sh"
    "mongo_repo_entries:installer/lib/apt-repos.sh"        "audit_mongo_repos:installer/lib/apt-repos.sh"
    "repair_mongo_repos:installer/lib/apt-repos.sh"        "apt_update_validated:installer/lib/apt-repos.sh"
    "system_detect:installer/lib/os-detect.sh"             "detect_busy_ports:installer/lib/os-detect.sh"
    "check_connectivity:installer/lib/os-detect.sh"
  )
  local missing=0 entry fn file
  for entry in "${manifest[@]}"; do
    fn="${entry%%:*}"
    file="${entry#*:}"
    if ! declare -F "${fn}" >/dev/null 2>&1; then
      printf '\033[1;31m[nimbus] ERROR:\033[0m Required function "%s" is not defined (expected from %s).\n' "${fn}" "${file}" >&2
      missing=1
    fi
  done
  [ "${missing}" -eq 0 ] || die "Helper library loading is incomplete — installation stopped safely. No changes were made."
  return 0
}
