#!/usr/bin/env bash
#
# CSPR-CDP Smoke Test Script (Wrapper)
#
# Delegates to the primary script in casper/scripts/smoke-test.sh
#
# Usage:
#   ./scripts/casper/smoke-test.sh <network> [deployment-file]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PRIMARY_SCRIPT="${REPO_ROOT}/casper/scripts/smoke-test.sh"

if [[ ! -f "$PRIMARY_SCRIPT" ]]; then
  echo "ERROR: Primary smoke test script not found: $PRIMARY_SCRIPT"
  exit 1
fi

exec "$PRIMARY_SCRIPT" "$@"

