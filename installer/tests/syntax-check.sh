#!/bin/bash
cd "$(dirname "$0")/../.."
for f in installer/install.sh installer/install-node.sh installer/upgrade.sh installer/backup.sh installer/recovery.sh installer/uninstall.sh installer/lib/mongo-compat.sh installer/lib/bootstrap.sh installer/lib/apt-repos.sh installer/tests/mongo-compat.sh installer/tests/bootstrap.sh installer/tests/apt-repos.sh scripts/health-check.sh scripts/rotate-logs.sh; do
  if bash -n "$f"; then echo "syntax OK: $f"; else echo "SYNTAX FAIL: $f"; exit 1; fi
done
