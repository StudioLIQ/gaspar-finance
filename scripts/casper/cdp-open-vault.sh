#!/usr/bin/env bash
#
# CDP open vault (Wrapper)
#
# Delegates to the primary script in casper/scripts/cdp-open-vault.sh
#
# Usage:
#   ./scripts/casper/cdp-open-vault.sh [network] [deployment-file] <secret-key-path> <cspr|scspr> <collateral> <borrow> <interest_bps>
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PRIMARY_SCRIPT="${REPO_ROOT}/casper/scripts/cdp-open-vault.sh"

if [[ ! -f "$PRIMARY_SCRIPT" ]]; then
  echo "ERROR: Primary script not found: $PRIMARY_SCRIPT"
  exit 1
fi

exec "$PRIMARY_SCRIPT" "$@"

