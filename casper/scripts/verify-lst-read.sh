#!/usr/bin/env bash
# Verify LST Read Paths (Casper RPC)
#
# Purpose:
# - Validate that frontend read logic can be backed by on-chain named_keys + dictionaries.
# - Print the exact named_keys present for ybToken and WithdrawQueue.
#
# Usage:
#   ./casper/scripts/verify-lst-read.sh <network> <deployment-file>
#
# Example:
#   ./casper/scripts/verify-lst-read.sh testnet deployments/casper/testnet-YYYYMMDD-HHMMSS.json
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_DIR="$ROOT_DIR/../deployments/casper"

NETWORK="${1:-testnet}"
DEPLOY_FILE="${2:-}"

require_cmd() {
  if ! command -v "$1" &> /dev/null; then
    echo "ERROR: missing dependency: $1"
    exit 1
  fi
}

require_cmd jq
require_cmd casper-client

if [ -z "$DEPLOY_FILE" ]; then
  DEPLOY_FILE=$(ls -t "$DEPLOY_DIR/${NETWORK}-"*.json 2>/dev/null | head -n1 || true)
fi

if [ -z "$DEPLOY_FILE" ] || [ ! -f "$DEPLOY_FILE" ]; then
  echo "ERROR: deployment file not found."
  echo "  Provide: ./casper/scripts/verify-lst-read.sh $NETWORK /path/to/deploy.json"
  echo "  Or ensure deployments exist under: $DEPLOY_DIR"
  exit 1
fi

NODE_ADDRESS=$(jq -r '.nodeAddress' "$DEPLOY_FILE")
CHAIN_NAME=$(jq -r '.chainName' "$DEPLOY_FILE")
YBTOKEN_HASH=$(jq -r '.contracts.scsprYbToken.hash // "null"' "$DEPLOY_FILE")
QUEUE_HASH=$(jq -r '.contracts.withdrawQueue.hash // "null"' "$DEPLOY_FILE")

if [ "$YBTOKEN_HASH" = "null" ] || [ -z "$YBTOKEN_HASH" ]; then
  echo "ERROR: scsprYbToken.hash missing in deployment record"
  exit 1
fi

if [ "$QUEUE_HASH" = "null" ] || [ -z "$QUEUE_HASH" ]; then
  echo "ERROR: withdrawQueue.hash missing in deployment record"
  exit 1
fi

echo "=== Verify LST Read Paths ==="
echo "Network: $NETWORK"
echo "Node: $NODE_ADDRESS"
echo "Chain: $CHAIN_NAME"
echo "Deployment: $DEPLOY_FILE"
echo ""
echo "ybToken: $YBTOKEN_HASH"
echo "WithdrawQueue: $QUEUE_HASH"
echo ""

STATE_ROOT=$(casper-client get-state-root-hash --node-address "$NODE_ADDRESS" | jq -r '.result.state_root_hash')
echo "State root: $STATE_ROOT"
echo ""

dump_named_keys() {
  local label="$1"
  local contract_hash="$2"
  echo "=== $label named_keys ==="
  casper-client query-global-state \
    --node-address "$NODE_ADDRESS" \
    --state-root-hash "$STATE_ROOT" \
    --key "$contract_hash" | jq -r '
      .result.stored_value.Contract.named_keys
      | (["name","key"] | @tsv),
        (.[] | [.name, .key] | @tsv)
    ' | column -t || true
  echo ""
}

read_var_by_name() {
  local label="$1"
  local contract_hash="$2"
  local key_name="$3"
  local uref
  uref=$(casper-client query-global-state \
    --node-address "$NODE_ADDRESS" \
    --state-root-hash "$STATE_ROOT" \
    --key "$contract_hash" | jq -r --arg k "$key_name" '
      .result.stored_value.Contract.named_keys[] | select(.name == $k) | .key
    ' | head -n1)

  if [ -z "$uref" ] || [ "$uref" = "null" ]; then
    echo "- $label.$key_name: (missing)"
    return 0
  fi

  local parsed
  parsed=$(casper-client query-global-state \
    --node-address "$NODE_ADDRESS" \
    --state-root-hash "$STATE_ROOT" \
    --key "$uref" | jq -c '.result.stored_value.CLValue.parsed // null' || echo "null")

  echo "- $label.$key_name: $parsed"
}

dump_named_keys "ybToken" "$YBTOKEN_HASH"
read_var_by_name "ybToken" "$YBTOKEN_HASH" "assets"
read_var_by_name "ybToken" "$YBTOKEN_HASH" "total_shares"
read_var_by_name "ybToken" "$YBTOKEN_HASH" "last_sync_timestamp"
echo ""

dump_named_keys "WithdrawQueue" "$QUEUE_HASH"
read_var_by_name "WithdrawQueue" "$QUEUE_HASH" "config"
read_var_by_name "WithdrawQueue" "$QUEUE_HASH" "next_request_id"
read_var_by_name "WithdrawQueue" "$QUEUE_HASH" "stats"
echo ""

echo "=== Notes ==="
echo "- Frontend expects ybToken Var keys: assets, total_shares (used to compute total_assets + exchange rate)."
echo "- Frontend expects WithdrawQueue Var key: config (unbonding_period)."
echo "- If these are missing or shapes differ, adjust FE parsing in frontend/lib/casperRpc.ts."
echo ""

