#!/usr/bin/env bash
#
# CDP adjust vault interest rate (Wrapper)
#
# Delegates to the primary script in casper/scripts/cdp-adjust-rate.sh
#
# Usage:
#   ./scripts/casper/cdp-adjust-rate.sh [network] [deployment-file] <secret-key-path> <cspr|scspr> <vault_id> <interest_rate_bps>
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PRIMARY_SCRIPT="${REPO_ROOT}/casper/scripts/cdp-adjust-rate.sh"

if [[ ! -f "$PRIMARY_SCRIPT" ]]; then
  echo "ERROR: Primary script not found: $PRIMARY_SCRIPT"
  exit 1
fi

exec "$PRIMARY_SCRIPT" "$@"

