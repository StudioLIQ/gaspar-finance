#!/usr/bin/env bash
#
# CDP vault listing (Wrapper)
#
# Delegates to the primary script in casper/scripts/cdp-vaults.sh
#
# Usage:
#   ./scripts/casper/cdp-vaults.sh [network] [deployment-file] [owner-account-hash]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PRIMARY_SCRIPT="${REPO_ROOT}/casper/scripts/cdp-vaults.sh"

if [[ ! -f "$PRIMARY_SCRIPT" ]]; then
  echo "ERROR: Primary script not found: $PRIMARY_SCRIPT"
  exit 1
fi

exec "$PRIMARY_SCRIPT" "$@"

