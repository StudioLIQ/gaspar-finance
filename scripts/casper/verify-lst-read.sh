#!/usr/bin/env bash
#
# Verify LST Read Paths (Wrapper)
#
# Delegates to the primary script in casper/scripts/verify-lst-read.sh
#
# Usage:
#   ./scripts/casper/verify-lst-read.sh <network> <deployment-file>
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PRIMARY_SCRIPT="${REPO_ROOT}/casper/scripts/verify-lst-read.sh"

if [[ ! -f "$PRIMARY_SCRIPT" ]]; then
  echo "ERROR: Primary verify script not found: $PRIMARY_SCRIPT"
  exit 1
fi

exec "$PRIMARY_SCRIPT" "$@"

