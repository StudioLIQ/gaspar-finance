#!/usr/bin/env bash
#
# Upgrade stCSPR ybToken (Wrapper)
#
# Delegates to the primary script in casper/scripts/upgrade-scspr-ybtoken.sh
#
# Usage:
#   ./scripts/casper/upgrade-scspr-ybtoken.sh <network> <secret-key-path> [package-hash-hex]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PRIMARY_SCRIPT="${REPO_ROOT}/casper/scripts/upgrade-scspr-ybtoken.sh"

if [[ ! -f "$PRIMARY_SCRIPT" ]]; then
  echo "ERROR: Primary upgrade script not found: $PRIMARY_SCRIPT"
  exit 1
fi

exec "$PRIMARY_SCRIPT" "$@"

