#!/usr/bin/env bash
#
# CSPR-CDP LST Rate Sync Script (Wrapper)
#
# Delegates to the primary script in casper/scripts/sync-rate.sh
#
# Usage:
#   ./scripts/casper/sync-rate.sh <network> [secret-key-path]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PRIMARY_SCRIPT="${REPO_ROOT}/casper/scripts/sync-rate.sh"

if [[ ! -f "$PRIMARY_SCRIPT" ]]; then
  echo "ERROR: Primary rate sync script not found: $PRIMARY_SCRIPT"
  exit 1
fi

exec "$PRIMARY_SCRIPT" "$@"

