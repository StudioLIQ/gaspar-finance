#!/usr/bin/env bash
#
# CSPR-CDP Casper Deployment Script
#
# This script delegates to the primary deploy script in casper/scripts/deploy.sh
#
# Usage:
#   ./scripts/casper/deploy.sh <network> <secret-key-path>
#
# OR using environment variables (legacy):
#   CSPR_CDP_DEPLOY_KEY=/path/to/secret_key.pem ./scripts/casper/deploy.sh --network testnet
#
# Networks:
#   testnet  - Casper Testnet
#   mainnet  - Casper Mainnet
#   local    - Local NCTL node
#
# Prerequisites:
#   - WASM artifacts built (run `cd casper && make wasm`)
#   - Casper client installed
#   - Deploy account keys configured
#
# Required environment variables:
#   CSPR_DECIMALS        - CSPR token decimals (e.g., 9)
#   SCSPR_DECIMALS       - stCSPR token decimals (e.g., 9)
#   SCSPR_TOKEN_HASH     - stCSPR CEP-18 token contract hash (hash-...)
#   SCSPR_LST_HASH       - stCSPR LST adapter contract hash (hash-...)
#
# Optional environment variables:
#   PUBLIC_KEY           - Path to public_key.pem (auto-detected if adjacent to secret key)
#   DEPLOY_LST           - Set to "true" to deploy ybToken + WithdrawQueue (default: true)
#   CSPR_NODE_ADDRESS    - Override default RPC endpoint
#   CSPR_CHAIN_NAME      - Override chain name
#
# Examples:
#   # Basic usage
#   ./scripts/casper/deploy.sh testnet /path/to/secret_key.pem
#
#   # With required env vars
#   CSPR_DECIMALS=9 SCSPR_DECIMALS=9 \
#   SCSPR_TOKEN_HASH=hash-abc123 SCSPR_LST_HASH=hash-def456 \
#   ./scripts/casper/deploy.sh testnet /path/to/secret_key.pem
#
#   # Legacy flag-based (converted to positional)
#   CSPR_CDP_DEPLOY_KEY=/path/to/secret_key.pem ./scripts/casper/deploy.sh --network testnet

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Primary deploy script (SSOT)
PRIMARY_DEPLOY_SCRIPT="${REPO_ROOT}/casper/scripts/deploy.sh"

if [[ ! -f "$PRIMARY_DEPLOY_SCRIPT" ]]; then
    echo "ERROR: Primary deploy script not found: $PRIMARY_DEPLOY_SCRIPT"
    exit 1
fi

# Parse arguments - support both legacy flags and positional args
NETWORK=""
SECRET_KEY=""

# Check for legacy flag-based usage
if [[ "${1:-}" == "--network" || "${1:-}" == "-n" ]]; then
    # Legacy flag mode: --network <network> [--dry-run]
    while [[ $# -gt 0 ]]; do
        case $1 in
            --network|-n)
                NETWORK="$2"
                shift 2
                ;;
            --dry-run)
                echo "Note: --dry-run is not supported by the primary deploy script."
                echo "Review the script output carefully before deployment."
                shift
                ;;
            --config|-c)
                echo "Note: --config is not supported by the primary deploy script."
                shift 2
                ;;
            *)
                echo "Unknown option: $1"
                exit 1
                ;;
        esac
    done

    # Get secret key from legacy env var
    SECRET_KEY="${CSPR_CDP_DEPLOY_KEY:-}"
    if [[ -z "$SECRET_KEY" ]]; then
        echo "ERROR: CSPR_CDP_DEPLOY_KEY environment variable not set."
        echo "Set it to the path of your deploy account secret key."
        exit 1
    fi
else
    # Positional mode: <network> <secret-key-path>
    NETWORK="${1:-}"
    SECRET_KEY="${2:-}"
fi

if [[ -z "$NETWORK" ]]; then
    echo "CSPR-CDP Deployment Script"
    echo ""
    echo "Usage:"
    echo "  $0 <network> <secret-key-path>"
    echo ""
    echo "Networks: testnet, mainnet, local"
    echo ""
    echo "Required environment variables:"
    echo "  CSPR_DECIMALS        CSPR token decimals"
    echo "  SCSPR_DECIMALS       stCSPR token decimals"
    echo "  SCSPR_TOKEN_HASH     stCSPR CEP-18 token hash"
    echo "  SCSPR_LST_HASH       stCSPR LST adapter hash"
    echo ""
    echo "Example:"
    echo "  CSPR_DECIMALS=9 SCSPR_DECIMALS=9 \\"
    echo "  SCSPR_TOKEN_HASH=hash-abc SCSPR_LST_HASH=hash-def \\"
    echo "  $0 testnet /path/to/secret_key.pem"
    exit 1
fi

if [[ -z "$SECRET_KEY" ]]; then
    echo "ERROR: secret key path is required"
    exit 1
fi

echo ">>> Delegating to primary deploy script: $PRIMARY_DEPLOY_SCRIPT"
echo ""

# Delegate to primary script
exec "$PRIMARY_DEPLOY_SCRIPT" "$NETWORK" "$SECRET_KEY"
