#!/bin/bash
# CSPR-CDP LST Rate Sync Keeper Script
#
# Syncs the stCSPR exchange rate from ybToken to OracleAdapter.
# Run this periodically (e.g., every 15-30 minutes) to keep the oracle fresh.
#
# Usage:
#   ./sync-rate.sh [network] [secret-key-path]
#
# Example:
#   ./sync-rate.sh testnet /path/to/keeper_secret_key.pem
#
# Environment variables:
#   CSPR_NODE_ADDRESS - Override default node address
#   PAYMENT_AMOUNT    - Payment for sync transaction (default: 1 CSPR)
#   DRY_RUN           - Set to "true" to query without submitting (default: false)
#   OVERRIDE_YBTOKEN_RATE - If set, use this u256 rate (scaled by 1e18) instead of reading storage

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_DIR="$ROOT_DIR/../deployments/casper"

NETWORK="${1:-testnet}"
SECRET_KEY="${2:-}"

# Validate network
case $NETWORK in
  testnet)
    NODE_ADDRESS="${CSPR_NODE_ADDRESS:-https://node.testnet.casper.network}"
    CHAIN_NAME="${CSPR_CHAIN_NAME:-casper-test}"
    ;;
  mainnet)
    NODE_ADDRESS="${CSPR_NODE_ADDRESS:-https://rpc.mainnet.casperlabs.io}"
    CHAIN_NAME="${CSPR_CHAIN_NAME:-casper}"
    ;;
  local)
    NODE_ADDRESS="${CSPR_NODE_ADDRESS:-http://localhost:11101}"
    CHAIN_NAME="${CSPR_CHAIN_NAME:-casper-net-1}"
    ;;
  *)
    echo "Unknown network: $NETWORK"
    exit 1
    ;;
esac

PAYMENT_AMOUNT="${PAYMENT_AMOUNT:-1000000000}"  # 1 CSPR
DRY_RUN="${DRY_RUN:-false}"

require_cmd() {
  if ! command -v "$1" &> /dev/null; then
    echo "ERROR: missing dependency: $1"
    exit 1
  fi
}

require_cmd casper-client
require_cmd jq
require_cmd python3

# Find latest deployment file
DEPLOY_FILE=$(ls -t "$DEPLOY_DIR/${NETWORK}-"*.json 2>/dev/null | head -n1)
if [ -z "$DEPLOY_FILE" ]; then
    echo "ERROR: No deployment file found for network: $NETWORK"
    exit 1
fi

echo "=== CSPR-CDP LST Rate Sync ==="
echo "Network: $NETWORK"
echo "Node: $NODE_ADDRESS"
echo "Deployment: $DEPLOY_FILE"
echo "Dry run: $DRY_RUN"
echo ""

# Extract contract hashes
ORACLE_HASH=$(jq -r '.contracts.oracleAdapter.hash // "null"' "$DEPLOY_FILE")
YBTOKEN_HASH=$(jq -r '.contracts.scsprYbToken.hash // "null"' "$DEPLOY_FILE")

if [ "$ORACLE_HASH" = "null" ]; then
    echo "ERROR: OracleAdapter not deployed"
    exit 1
fi

if [ "$YBTOKEN_HASH" = "null" ]; then
    echo "ERROR: stCSPR ybToken not deployed"
    exit 1
fi

echo "OracleAdapter: $ORACLE_HASH"
echo "stCSPR ybToken: $YBTOKEN_HASH"
echo ""

# Get current state root hash
STATE_ROOT=$(casper-client get-state-root-hash --node-address "$NODE_ADDRESS" | jq -r '.result.state_root_hash')
echo "State root: $STATE_ROOT"

# Odra Var field indices (1-indexed, matches contract field order)
SCSPR_TOTAL_SHARES_IDX=4
SCSPR_ASSETS_IDX=7

odra_var_key() {
  local idx="$1"
  python3 - <<PY
import hashlib
i=int("$idx")
print(hashlib.blake2b(i.to_bytes(4,'big'),digest_size=32).hexdigest())
PY
}

odra_var_parsed() {
  local contract_hash="$1"
  local idx="$2"
  local key
  key="$(odra_var_key "$idx")"
  local output
  output=$(casper-client get-dictionary-item \
    --node-address "$NODE_ADDRESS" \
    --state-root-hash "$STATE_ROOT" \
    --contract-hash "$contract_hash" \
    --dictionary-name state \
    --dictionary-item-key "$key" 2>/dev/null || true)
  if [ -z "$output" ]; then
    echo "null"
    return
  fi
  echo "$output" | jq -c '.result.stored_value.CLValue.parsed // null' 2>/dev/null || echo "null"
}

# Query current exchange rate from ybToken
echo ""
echo "=== Step 1: Query ybToken Exchange Rate ==="

if [ -n "${OVERRIDE_YBTOKEN_RATE:-}" ]; then
    YBTOKEN_RATE="$OVERRIDE_YBTOKEN_RATE"
    echo "Using OVERRIDE_YBTOKEN_RATE: $YBTOKEN_RATE"
else
    ASSETS_PARSED=$(odra_var_parsed "$YBTOKEN_HASH" "$SCSPR_ASSETS_IDX")
    TOTAL_SHARES_PARSED=$(odra_var_parsed "$YBTOKEN_HASH" "$SCSPR_TOTAL_SHARES_IDX")

    if [ -z "$ASSETS_PARSED" ] || [ "$ASSETS_PARSED" = "null" ] || [ -z "$TOTAL_SHARES_PARSED" ] || [ "$TOTAL_SHARES_PARSED" = "null" ]; then
        echo "ERROR: Could not read ybToken assets/total_shares from Odra state dictionary."
        echo "Set OVERRIDE_YBTOKEN_RATE=<u256_scaled_by_1e18> to proceed."
        exit 1
    fi

    YBTOKEN_RATE=$(python3 - "$ASSETS_PARSED" "$TOTAL_SHARES_PARSED" << 'PY'
import json, sys

SCALE = 10**18

assets = json.loads(sys.argv[1] or "null")
shares = json.loads(sys.argv[2] or "null")

def parse_u256_clvalue(data):
    if not isinstance(data, list) or len(data) == 0:
        return 0
    length = data[0]
    val = 0
    for i in range(length):
        if 1 + i < len(data):
            val += data[1 + i] << (8 * i)
    return val

def parse_asset_breakdown(data):
    if not isinstance(data, list):
        return [0, 0, 0, 0, 0, 0]
    vals = []
    i = 0
    for _ in range(6):
        if i >= len(data):
            vals.append(0)
            continue
        length = data[i]
        i += 1
        val = 0
        for j in range(length):
            if i + j < len(data):
                val += data[i + j] << (8 * j)
        i += length
        vals.append(val)
    return vals

total_shares = parse_u256_clvalue(shares)
if total_shares == 0:
    print(SCALE)
    sys.exit(0)

idle, delegated, undelegating, claimable, fees, losses = parse_asset_breakdown(assets)
gross = idle + delegated + undelegating + claimable
deductions = fees + losses
total_assets = gross - deductions if gross > deductions else 0

rate = (total_assets * SCALE) // total_shares
print(rate)
PY
    )

    if [ -z "$YBTOKEN_RATE" ]; then
        echo "ERROR: Failed to compute ybToken exchange rate."
        echo "Set OVERRIDE_YBTOKEN_RATE=<u256_scaled_by_1e18> to proceed."
        exit 1
    fi
fi

echo "Current ybToken rate: $YBTOKEN_RATE"

# Query current oracle rate for comparison
echo ""
echo "=== Step 2: Query Current Oracle Rate ==="

ORACLE_STATE=$(casper-client query-global-state \
  --node-address "$NODE_ADDRESS" \
  --state-root-hash "$STATE_ROOT" \
  --key "$ORACLE_HASH" 2>/dev/null || echo '{}')

ORACLE_RATE=""
if echo "$ORACLE_STATE" | jq -e '.result.stored_value.Contract.named_keys' > /dev/null 2>&1; then
    ORACLE_RATE_KEY=$(echo "$ORACLE_STATE" | jq -r '.result.stored_value.Contract.named_keys[] | select(.name == "last_good_exchange_rate" or .name == "exchange_rate") | .key' | head -1)
    if [ -n "$ORACLE_RATE_KEY" ] && [ "$ORACLE_RATE_KEY" != "null" ]; then
        RATE_VALUE=$(casper-client query-global-state \
          --node-address "$NODE_ADDRESS" \
          --state-root-hash "$STATE_ROOT" \
          --key "$ORACLE_RATE_KEY" 2>/dev/null | jq -r '.result.stored_value.CLValue.parsed // empty')
        if [ -n "$RATE_VALUE" ]; then
            ORACLE_RATE="$RATE_VALUE"
        fi
    fi
fi

if [ -n "$ORACLE_RATE" ]; then
    echo "Current Oracle rate: $ORACLE_RATE"
else
    echo "Could not read current Oracle rate (may be unset)"
    ORACLE_RATE="0"
fi

# Compare rates
if [ "$YBTOKEN_RATE" = "$ORACLE_RATE" ]; then
    echo ""
    echo "Rates are identical. No sync needed."
    exit 0
fi

echo ""
echo "Rate difference detected. Sync required."
echo "  ybToken rate: $YBTOKEN_RATE"
echo "  Oracle rate:  $ORACLE_RATE"

if [ "$DRY_RUN" = "true" ]; then
    echo ""
    echo "=== DRY RUN - Would sync rate ==="
    echo "Would call oracle.sync_rate_from_ybtoken with rate: $YBTOKEN_RATE"
    exit 0
fi

# Step 3: Sync rate to Oracle
echo ""
echo "=== Step 3: Sync Rate to Oracle ==="

if [ -z "$SECRET_KEY" ]; then
    echo "ERROR: Secret key required for sync transaction."
    echo "Usage: $0 $NETWORK /path/to/secret_key.pem"
    exit 1
fi

if [ ! -f "$SECRET_KEY" ]; then
    echo "ERROR: Secret key file not found: $SECRET_KEY"
    exit 1
fi

# Submit sync transaction
DEPLOY_HASH=$(casper-client put-deploy \
  --node-address "$NODE_ADDRESS" \
  --chain-name "$CHAIN_NAME" \
  --secret-key "$SECRET_KEY" \
  --session-hash "$ORACLE_HASH" \
  --session-entry-point "sync_rate_from_ybtoken" \
  --session-arg "rate:u256='$YBTOKEN_RATE'" \
  --payment-amount "$PAYMENT_AMOUNT" | jq -r '.result.deploy_hash')

echo "Deploy hash: $DEPLOY_HASH"
echo "Waiting for confirmation..."

# Wait for deploy
ATTEMPTS=0
MAX_ATTEMPTS=30
while [ $ATTEMPTS -lt $MAX_ATTEMPTS ]; do
    RESULT=$(casper-client get-deploy --node-address "$NODE_ADDRESS" "$DEPLOY_HASH" 2>/dev/null || true)

    SUCCESS=$(echo "$RESULT" | jq -r '.result.execution_results[0].result.Success // empty')
    if [ -n "$SUCCESS" ]; then
        echo ""
        echo "=== Rate Sync Successful ==="
        echo "New rate: $YBTOKEN_RATE"
        echo "Deploy: $DEPLOY_HASH"
        exit 0
    fi

    FAILURE=$(echo "$RESULT" | jq -r '.result.execution_results[0].result.Failure // empty')
    if [ -n "$FAILURE" ]; then
        echo ""
        echo "ERROR: Rate sync failed"
        echo "$RESULT" | jq '.result.execution_results[0].result.Failure'
        exit 1
    fi

    ATTEMPTS=$((ATTEMPTS + 1))
    sleep 5
done

echo "Warning: Deploy not confirmed after $MAX_ATTEMPTS attempts"
echo "Check deploy status manually: casper-client get-deploy --node-address $NODE_ADDRESS $DEPLOY_HASH"
exit 1
