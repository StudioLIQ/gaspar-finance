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

# Query current exchange rate from ybToken
echo ""
echo "=== Step 1: Query ybToken Exchange Rate ==="

if [ -n "${OVERRIDE_YBTOKEN_RATE:-}" ]; then
    YBTOKEN_RATE="$OVERRIDE_YBTOKEN_RATE"
    echo "Using OVERRIDE_YBTOKEN_RATE: $YBTOKEN_RATE"
else
    YBTOKEN_STATE=$(casper-client query-global-state \
      --node-address "$NODE_ADDRESS" \
      --state-root-hash "$STATE_ROOT" \
      --key "$YBTOKEN_HASH" 2>/dev/null || echo '{}')

    if ! echo "$YBTOKEN_STATE" | jq -e '.result.stored_value.Contract.named_keys' > /dev/null 2>&1; then
        echo "ERROR: Could not read ybToken named_keys from global state."
        echo "Set OVERRIDE_YBTOKEN_RATE=<u256_scaled_by_1e18> to proceed."
        exit 1
    fi

    ASSETS_KEY=$(echo "$YBTOKEN_STATE" | jq -r '.result.stored_value.Contract.named_keys[] | select(.name == "assets") | .key' | head -1)
    TOTAL_SHARES_KEY=$(echo "$YBTOKEN_STATE" | jq -r '.result.stored_value.Contract.named_keys[] | select(.name == "total_shares") | .key' | head -1)

    if [ -z "$ASSETS_KEY" ] || [ "$ASSETS_KEY" = "null" ] || [ -z "$TOTAL_SHARES_KEY" ] || [ "$TOTAL_SHARES_KEY" = "null" ]; then
        echo "ERROR: Could not find required ybToken keys (assets, total_shares)."
        echo "Set OVERRIDE_YBTOKEN_RATE=<u256_scaled_by_1e18> to proceed."
        exit 1
    fi

    ASSETS_VALUE=$(casper-client query-global-state \
      --node-address "$NODE_ADDRESS" \
      --state-root-hash "$STATE_ROOT" \
      --key "$ASSETS_KEY" 2>/dev/null || echo '{}')

    TOTAL_SHARES_VALUE=$(casper-client query-global-state \
      --node-address "$NODE_ADDRESS" \
      --state-root-hash "$STATE_ROOT" \
      --key "$TOTAL_SHARES_KEY" 2>/dev/null || echo '{}')

    # Odra Var<T> is stored as a CLValue. We expect:
    # - assets: parsed object with fields idle_cspr/delegated_cspr/undelegating_cspr/claimable_cspr/protocol_fees/realized_losses
    # - total_shares: parsed U256 (string or number)
    YBTOKEN_RATE=$(printf '%s\n%s\n' "$ASSETS_VALUE" "$TOTAL_SHARES_VALUE" | python3 - << 'PY'
import json, sys

SCALE = 10**18

assets_json = json.loads(sys.stdin.readline())
shares_json = json.loads(sys.stdin.readline())

def parsed(obj):
    return (((obj.get("result") or {}).get("stored_value") or {}).get("CLValue") or {}).get("parsed")

assets = parsed(assets_json)
total_shares = parsed(shares_json)

if assets is None or total_shares in (None, ""):
    raise SystemExit("missing parsed fields")

def u256(x):
    if isinstance(x, int):
        return x
    if isinstance(x, str):
        return int(x)
    raise SystemExit(f"unexpected u256 type: {type(x)}")

total_shares_i = u256(total_shares)
if total_shares_i == 0:
    print(SCALE)
    sys.exit(0)

required_fields = [
    "idle_cspr",
    "delegated_cspr",
    "undelegating_cspr",
    "claimable_cspr",
    "protocol_fees",
    "realized_losses",
]
if not isinstance(assets, dict) or any(f not in assets for f in required_fields):
    raise SystemExit("unexpected assets shape")

idle = u256(assets["idle_cspr"])
delegated = u256(assets["delegated_cspr"])
undelegating = u256(assets["undelegating_cspr"])
claimable = u256(assets["claimable_cspr"])
fees = u256(assets["protocol_fees"])
losses = u256(assets["realized_losses"])

gross = idle + delegated + undelegating + claimable
deductions = fees + losses
total_assets = gross - deductions if gross > deductions else 0

rate = (total_assets * SCALE) // total_shares_i
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
