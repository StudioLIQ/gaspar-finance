#!/usr/bin/env bash
#
# CDP adjust vault (Wrapper)
#
# Delegates to the primary script in casper/scripts/cdp-adjust-vault.sh
#
# Usage:
#   ./scripts/casper/cdp-adjust-vault.sh [network] [deployment-file] <secret-key-path> <cspr|scspr> <vault_id> <collateral_delta> <add|withdraw> <debt_delta> <borrow|repay>
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PRIMARY_SCRIPT="${REPO_ROOT}/casper/scripts/cdp-adjust-vault.sh"

if [[ ! -f "$PRIMARY_SCRIPT" ]]; then
  echo "ERROR: Primary script not found: $PRIMARY_SCRIPT"
  exit 1
fi

exec "$PRIMARY_SCRIPT" "$@"

