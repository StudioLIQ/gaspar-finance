#!/usr/bin/env bash
#
# CSPR-CDP Frontend Binding Script (Wrapper)
#
# Delegates to the primary script in casper/scripts/bind-frontend.sh
#
# Usage:
#   ./scripts/casper/bind-frontend.sh <network> [deployment-file]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PRIMARY_SCRIPT="${REPO_ROOT}/casper/scripts/bind-frontend.sh"

if [[ ! -f "$PRIMARY_SCRIPT" ]]; then
  echo "ERROR: Primary bind script not found: $PRIMARY_SCRIPT"
  exit 1
fi

exec "$PRIMARY_SCRIPT" "$@"

