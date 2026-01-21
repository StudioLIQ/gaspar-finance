#!/usr/bin/env bash
# Adjust a vault's interest rate (multi-vault).
#
# Usage:
#   ./casper/scripts/cdp-adjust-rate.sh [network] [deployment-file] <secret-key-path> <cspr|scspr> <vault_id> <interest_rate_bps>
#
# Example:
#   ./casper/scripts/cdp-adjust-rate.sh testnet "" ~/keys/secret_key.pem cspr 1 300
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CASPER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CASPER_DIR/.." && pwd)"
DEPLOY_DIR="$REPO_ROOT/deployments/casper"

NETWORK="${1:-testnet}"
DEPLOY_FILE="${2:-}"
SECRET_KEY="${3:-}"
COLLATERAL_KIND="${4:-}"
VAULT_ID="${5:-}"
INTEREST_BPS="${6:-}"

usage() {
  echo "Usage:"
  echo "  $0 [network] [deployment-file] <secret-key-path> <cspr|scspr> <vault_id> <interest_rate_bps>"
  exit 1
}

require_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "ERROR: missing dependency: $1"
    exit 1
  fi
}

require_cmd casper-client
require_cmd jq

if [ -z "$SECRET_KEY" ] || [ -z "$COLLATERAL_KIND" ] || [ -z "$VAULT_ID" ] || [ -z "$INTEREST_BPS" ]; then
  usage
fi

if [ ! -f "$SECRET_KEY" ]; then
  echo "ERROR: secret key file not found: $SECRET_KEY"
  exit 1
fi

if [ -z "$DEPLOY_FILE" ]; then
  DEPLOY_FILE=$(ls -t "$DEPLOY_DIR/${NETWORK}-"*.json 2>/dev/null | head -n1 || true)
fi

if [ -z "$DEPLOY_FILE" ] || [ ! -f "$DEPLOY_FILE" ]; then
  echo "ERROR: deployment record not found for network: $NETWORK"
  exit 1
fi

NODE_ADDRESS=$(jq -r '.nodeAddress // empty' "$DEPLOY_FILE")
CHAIN_NAME=$(jq -r '.chainName // empty' "$DEPLOY_FILE")
ROUTER_HASH=$(jq -r '.contracts.router.hash // empty' "$DEPLOY_FILE")

if [ -z "$NODE_ADDRESS" ] || [ "$NODE_ADDRESS" = "null" ]; then
  echo "ERROR: nodeAddress missing in deployment file"
  exit 1
fi
if [ -z "$CHAIN_NAME" ] || [ "$CHAIN_NAME" = "null" ]; then
  echo "ERROR: chainName missing in deployment file"
  exit 1
fi
if [ -z "$ROUTER_HASH" ] || [ "$ROUTER_HASH" = "null" ]; then
  echo "ERROR: router.hash missing in deployment file"
  exit 1
fi

COLLATERAL_ID=""
case "$COLLATERAL_KIND" in
  cspr|CSPR|0) COLLATERAL_ID="0" ;;
  scspr|SCSPR|1) COLLATERAL_ID="1" ;;
  *) echo "ERROR: collateral must be cspr or scspr"; exit 1 ;;
esac

# Transaction config
PRICING_MODE="${PRICING_MODE:-classic}"
GAS_PRICE_TOL="${GAS_PRICE_TOL:-10}"
TTL="${TTL:-30min}"
PAYMENT_AMOUNT="${PAYMENT_AMOUNT:-20000000000}" # 20 CSPR default

json_only() {
  printf '%s\n' "$1" | sed -n '/^[[:space:]]*[{[]/,$p'
}

wait_for_txn() {
  local deploy_hash="$1"
  local attempts=0
  local max_attempts=120
  local sleep_secs=5

  while [ $attempts -lt $max_attempts ]; do
    local result
    result=$(casper-client get-transaction --node-address "$NODE_ADDRESS" "$deploy_hash" 2>/dev/null || echo "{}")
    local result_json
    result_json=$(json_only "$result")
    if [ -z "$result_json" ]; then
      attempts=$((attempts + 1))
      sleep "$sleep_secs"
      continue
    fi

    local has_exec
    has_exec=$(echo "$result_json" | jq -r '.result.execution_info.execution_result != null')
    if [ "$has_exec" = "true" ]; then
      local error_message
      error_message=$(echo "$result_json" | jq -r '.result.execution_info.execution_result.Version2.error_message // .result.execution_info.execution_result.Version1.error_message // empty')
      if [ -n "$error_message" ] && [ "$error_message" != "null" ]; then
        echo "ERROR: transaction failed: $error_message"
        exit 1
      fi
      return 0
    fi

    attempts=$((attempts + 1))
    sleep "$sleep_secs"
  done

  echo "ERROR: transaction not finalized after $max_attempts attempts: $deploy_hash"
  exit 1
}

call_contract() {
  local contract_hash="$1"
  local entrypoint="$2"
  shift 2
  local args=("$@")

  local cmd=(
    casper-client put-transaction invocable-entity
    --node-address "$NODE_ADDRESS"
    --chain-name "$CHAIN_NAME"
    --secret-key "$SECRET_KEY"
    --contract-hash "$contract_hash"
    --session-entry-point "$entrypoint"
    --pricing-mode "$PRICING_MODE"
    --gas-price-tolerance "$GAS_PRICE_TOL"
    --payment-amount "$PAYMENT_AMOUNT"
    --standard-payment true
    --ttl "$TTL"
  )

  if [[ "$contract_hash" == addressable-entity-* ]] || [[ "$contract_hash" == entity-contract-* ]]; then
    cmd=(
      casper-client put-transaction invocable-entity
      --node-address "$NODE_ADDRESS"
      --chain-name "$CHAIN_NAME"
      --secret-key "$SECRET_KEY"
      --entity-address "$contract_hash"
      --session-entry-point "$entrypoint"
      --pricing-mode "$PRICING_MODE"
      --gas-price-tolerance "$GAS_PRICE_TOL"
      --payment-amount "$PAYMENT_AMOUNT"
      --standard-payment true
      --ttl "$TTL"
    )
  fi

  for arg in "${args[@]}"; do
    cmd+=("$arg")
  done

  local output
  output=$("${cmd[@]}" 2>&1)
  local output_json
  output_json=$(json_only "$output")
  if [ -z "$output_json" ]; then
    echo "ERROR: failed to parse casper-client output"
    echo "$output"
    exit 1
  fi

  local deploy_hash
  deploy_hash=$(echo "$output_json" | jq -r '.result.transaction_hash.Version1 // .result.transaction_hash // .result.deploy_hash // empty')
  if [ -z "$deploy_hash" ]; then
    echo "ERROR: failed to get deploy hash"
    echo "$output_json"
    exit 1
  fi

  echo "Deploy hash: $deploy_hash"
  wait_for_txn "$deploy_hash"
}

echo "=== Adjust Interest Rate ==="
echo "Network:  $NETWORK"
echo "Deploy:   $DEPLOY_FILE"
echo "Node:     $NODE_ADDRESS"
echo "Chain:    $CHAIN_NAME"
echo "Router:   $ROUTER_HASH"
echo "Type:     $COLLATERAL_KIND (collateral_id=$COLLATERAL_ID)"
echo "Vault:    $VAULT_ID"
echo "Rate:     $INTEREST_BPS bps"
echo ""

call_contract "$ROUTER_HASH" "adjust_interest_rate" \
  --session-arg "collateral_id:u8='$COLLATERAL_ID'" \
  --session-arg "vault_id:u64='$VAULT_ID'" \
  --session-arg "interest_rate_bps:u32='$INTEREST_BPS'"

echo ""
echo "✓ Submitted and executed."

