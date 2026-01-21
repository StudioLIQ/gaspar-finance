#!/usr/bin/env bash
# Adjust an existing CDP vault (multi-vault).
#
# Usage:
#   ./casper/scripts/cdp-adjust-vault.sh [network] [deployment-file] <secret-key-path> <cspr|scspr> <vault_id> <collateral_delta> <add|withdraw> <debt_delta> <borrow|repay>
#
# Examples:
#   # Add 2 CSPR collateral and borrow 10 gUSD
#   ./casper/scripts/cdp-adjust-vault.sh testnet "" ~/keys/secret_key.pem cspr 1 2 add 10 borrow
#
#   # Repay 5 gUSD only
#   ./casper/scripts/cdp-adjust-vault.sh testnet "" ~/keys/secret_key.pem cspr 1 0 add 5 repay
#
# Amount formats:
# - collateral_delta and debt_delta default to token units with 9 decimals max (same as frontend inputs).
# - Use "motes:<int>" for raw collateral motes (9 decimals already applied).
# - Use "raw18:<int>" for raw gUSD delta in 18 decimals.
#
# Notes:
# - For CSPR collateral add, attaches transferred value equal to collateral_delta.
# - For stCSPR collateral add, runs CEP-18 approve on ybToken before adjust.
# - For debt repay, runs CEP-18 approve on gUSD before adjust.
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
COLLATERAL_DELTA_INPUT="${6:-}"
COLLATERAL_OP="${7:-}"
DEBT_DELTA_INPUT="${8:-}"
DEBT_OP="${9:-}"

usage() {
  echo "Usage:"
  echo "  $0 [network] [deployment-file] <secret-key-path> <cspr|scspr> <vault_id> <collateral_delta> <add|withdraw> <debt_delta> <borrow|repay>"
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
require_cmd python3

if [ -z "$SECRET_KEY" ] || [ -z "$COLLATERAL_KIND" ] || [ -z "$VAULT_ID" ] || [ -z "$COLLATERAL_DELTA_INPUT" ] || [ -z "$COLLATERAL_OP" ] || [ -z "$DEBT_DELTA_INPUT" ] || [ -z "$DEBT_OP" ]; then
  usage
fi

if [ ! -f "$SECRET_KEY" ]; then
  echo "ERROR: secret key file not found: $SECRET_KEY"
  exit 1
fi

PUBLIC_KEY="${PUBLIC_KEY:-}"
if [ -z "$PUBLIC_KEY" ]; then
  GUESSED_PUBLIC_KEY="${SECRET_KEY%secret_key.pem}public_key.pem"
  if [ -f "$GUESSED_PUBLIC_KEY" ]; then
    PUBLIC_KEY="$GUESSED_PUBLIC_KEY"
  else
    echo "ERROR: public key not provided. Set PUBLIC_KEY or place public_key.pem next to secret_key.pem"
    exit 1
  fi
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
STABLECOIN_HASH=$(jq -r '.contracts.stablecoin.hash // empty' "$DEPLOY_FILE")
YBTOKEN_HASH=$(jq -r '.contracts.scsprYbToken.hash // empty' "$DEPLOY_FILE")

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
if [ -z "$STABLECOIN_HASH" ] || [ "$STABLECOIN_HASH" = "null" ]; then
  echo "ERROR: stablecoin.hash missing in deployment file"
  exit 1
fi

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
  local transferred_value="${3:-}"
  shift 3
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

  if [ -n "$transferred_value" ] && [ "$transferred_value" != "0" ]; then
    cmd+=(--transferred-value "$transferred_value")
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

to_amount_9() {
  local input="$1"
  python3 - "$input" <<'PY'
import sys
from decimal import Decimal, ROUND_DOWN, getcontext

getcontext().prec = 80
s = (sys.argv[1] or "").strip()
if not s:
    print("0")
    raise SystemExit(0)

if s.startswith(("motes:", "raw9:")):
    print(int(s.split(":", 1)[1]))
    raise SystemExit(0)

amt = Decimal(s)
if amt < 0:
    print("0")
    raise SystemExit(0)
motes = (amt * (10 ** 9)).to_integral_value(rounding=ROUND_DOWN)
print(int(motes))
PY
}

to_debt_u256() {
  local input="$1"
  python3 - "$input" <<'PY'
import sys
from decimal import Decimal, ROUND_DOWN, getcontext

getcontext().prec = 80
s = (sys.argv[1] or "").strip()
if not s:
    print("0")
    raise SystemExit(0)

if s.startswith("raw18:"):
    print(int(s.split(":", 1)[1]))
    raise SystemExit(0)

amt = Decimal(s)
if amt < 0:
    print("0")
    raise SystemExit(0)

scaled9 = (amt * (10 ** 9)).to_integral_value(rounding=ROUND_DOWN)
print(int(scaled9) * (10 ** 9))
PY
}

COLLATERAL_ID=""
case "$COLLATERAL_KIND" in
  cspr|CSPR|0) COLLATERAL_ID="0" ;;
  scspr|SCSPR|1) COLLATERAL_ID="1" ;;
  *) echo "ERROR: collateral must be cspr or scspr"; exit 1 ;;
esac

COLLATERAL_IS_WITHDRAW="false"
case "$COLLATERAL_OP" in
  withdraw|w|1|true) COLLATERAL_IS_WITHDRAW="true" ;;
  add|deposit|d|0|false) COLLATERAL_IS_WITHDRAW="false" ;;
  *) echo "ERROR: collateral op must be add or withdraw"; exit 1 ;;
esac

DEBT_IS_REPAY="false"
case "$DEBT_OP" in
  repay|r|1|true) DEBT_IS_REPAY="true" ;;
  borrow|b|0|false) DEBT_IS_REPAY="false" ;;
  *) echo "ERROR: debt op must be borrow or repay"; exit 1 ;;
esac

COLLATERAL_DELTA="$(to_amount_9 "$COLLATERAL_DELTA_INPUT")"
DEBT_DELTA_U256="$(to_debt_u256 "$DEBT_DELTA_INPUT")"

ACCOUNT_HASH=$(casper-client account-address --public-key "$PUBLIC_KEY")
echo "=== Adjust Vault ==="
echo "Network:  $NETWORK"
echo "Deploy:   $DEPLOY_FILE"
echo "Node:     $NODE_ADDRESS"
echo "Chain:    $CHAIN_NAME"
echo "Owner:    $ACCOUNT_HASH"
echo "Router:   $ROUTER_HASH"
echo "Type:     $COLLATERAL_KIND (collateral_id=$COLLATERAL_ID)"
echo "Vault:    $VAULT_ID"
echo ""

# Approve gUSD if repaying debt.
if [ "$DEBT_IS_REPAY" = "true" ] && [ "$DEBT_DELTA_U256" != "0" ]; then
  echo "--- Approve gUSD ---"
  call_contract "$STABLECOIN_HASH" "approve" "" \
    --session-arg "spender:key='$ROUTER_HASH'" \
    --session-arg "amount:u256='$DEBT_DELTA_U256'"
  echo ""
fi

# Approve stCSPR if depositing collateral.
if [ "$COLLATERAL_ID" = "1" ] && [ "$COLLATERAL_IS_WITHDRAW" = "false" ] && [ "$COLLATERAL_DELTA" != "0" ]; then
  if [ -z "$YBTOKEN_HASH" ] || [ "$YBTOKEN_HASH" = "null" ]; then
    echo "ERROR: scsprYbToken.hash missing in deployment file (required for stCSPR)"
    exit 1
  fi
  echo "--- Approve stCSPR ---"
  call_contract "$YBTOKEN_HASH" "approve" "" \
    --session-arg "spender:key='$ROUTER_HASH'" \
    --session-arg "amount:u256='$COLLATERAL_DELTA'"
  echo ""
fi

TRANSFERRED_VALUE="0"
if [ "$COLLATERAL_ID" = "0" ] && [ "$COLLATERAL_IS_WITHDRAW" = "false" ] && [ "$COLLATERAL_DELTA" != "0" ]; then
  TRANSFERRED_VALUE="$COLLATERAL_DELTA"
fi

echo "--- adjust_vault ---"
call_contract "$ROUTER_HASH" "adjust_vault" "$TRANSFERRED_VALUE" \
  --session-arg "collateral_id:u8='$COLLATERAL_ID'" \
  --session-arg "vault_id:u64='$VAULT_ID'" \
  --session-arg "collateral_delta:u256='$COLLATERAL_DELTA'" \
  --session-arg "collateral_is_withdraw:bool='$COLLATERAL_IS_WITHDRAW'" \
  --session-arg "debt_delta:u256='$DEBT_DELTA_U256'" \
  --session-arg "debt_is_repay:bool='$DEBT_IS_REPAY'"

echo ""
echo "✓ Submitted and executed."
echo "  Next: ./scripts/casper/cdp-vaults.sh $NETWORK \"$DEPLOY_FILE\" $ACCOUNT_HASH"

