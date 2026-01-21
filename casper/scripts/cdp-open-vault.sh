#!/usr/bin/env bash
# Open a CDP vault (multi-vault).
#
# Usage:
#   ./casper/scripts/cdp-open-vault.sh [network] [deployment-file] <secret-key-path> <cspr|scspr> <collateral> <borrow> <interest_bps>
#
# Examples:
#   ./casper/scripts/cdp-open-vault.sh testnet "" ~/keys/secret_key.pem cspr 10 100 300
#   ./casper/scripts/cdp-open-vault.sh testnet deployments/casper/testnet-YYYYMMDD-HHMMSS.json ~/keys/secret_key.pem scspr 5 50 250
#
# Amount formats:
# - <collateral> and <borrow> default to token units with 9 decimals max (same as frontend inputs).
# - Use "motes:<int>" for raw collateral motes (9 decimals already applied).
# - Use "raw18:<int>" for raw gUSD amount in 18 decimals.
#
# Notes:
# - For CSPR, attaches transferred value equal to collateral amount.
# - For stCSPR, runs CEP-18 approve on ybToken before opening the vault.
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
COLLATERAL_INPUT="${5:-}"
BORROW_INPUT="${6:-}"
INTEREST_BPS="${7:-}"

usage() {
  echo "Usage:"
  echo "  $0 [network] [deployment-file] <secret-key-path> <cspr|scspr> <collateral> <borrow> <interest_bps>"
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

if [ -z "$SECRET_KEY" ] || [ -z "$COLLATERAL_KIND" ] || [ -z "$COLLATERAL_INPUT" ] || [ -z "$BORROW_INPUT" ] || [ -z "$INTEREST_BPS" ]; then
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
BRANCH_CSPR_HASH=$(jq -r '.contracts.branchCspr.hash // empty' "$DEPLOY_FILE")
BRANCH_SCSPR_HASH=$(jq -r '.contracts.branchSCSPR.hash // empty' "$DEPLOY_FILE")
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

# Read-only helpers (Odra dictionary)
STATE_ROOT=$(casper-client get-state-root-hash --node-address "$NODE_ADDRESS" | jq -r '.result.state_root_hash')
ACCOUNT_HASH=$(casper-client account-address --public-key "$PUBLIC_KEY")
if [[ "$ACCOUNT_HASH" != account-hash-* ]]; then
  echo "ERROR: failed to derive account-hash from public key: $PUBLIC_KEY"
  exit 1
fi
OWNER_HEX="${ACCOUNT_HASH#account-hash-}"

odra_key_addr() {
  local field_index="$1"
  local account_hex="$2"
  python3 - "$field_index" "$account_hex" <<'PY'
import sys, hashlib, binascii
field_index = int(sys.argv[1])
account_hex = sys.argv[2].strip()
idx = field_index.to_bytes(4, "big")
acct = binascii.unhexlify(account_hex)
addr = b"\x00" + acct
print(hashlib.blake2b(idx + addr, digest_size=32).hexdigest())
PY
}

get_state_bytes() {
  local contract_hash="$1"
  local dict_key="$2"
  casper-client get-dictionary-item \
    --node-address "$NODE_ADDRESS" \
    --state-root-hash "$STATE_ROOT" \
    --contract-hash "$contract_hash" \
    --dictionary-name state \
    --dictionary-item-key "$dict_key" 2>/dev/null \
    | jq -r '.result.stored_value.CLValue.bytes // empty' 2>/dev/null || true
}

parse_u64_from_clvalue_bytes() {
  local hex_bytes="$1"
  python3 - "$hex_bytes" <<'PY'
import sys, binascii
hex_bytes = (sys.argv[1] or "").strip()
if not hex_bytes:
    print("0")
    sys.exit(0)

b = binascii.unhexlify(hex_bytes)
if len(b) >= 4:
    n = int.from_bytes(b[0:4], "little")
    if n == len(b) - 4:
        b = b[4:]

if len(b) < 8:
    print("0")
    sys.exit(0)
print(int.from_bytes(b[:8], "little"))
PY
}

to_amount_9() {
  local input="$1"
  python3 - "$input" <<'PY'
import sys
from decimal import Decimal, ROUND_DOWN, getcontext

getcontext().prec = 80
s = (sys.argv[1] or "").strip()
if not s:
    raise SystemExit("0")

if s.startswith(("motes:", "raw9:")):
    print(int(s.split(":", 1)[1]))
    raise SystemExit(0)

amt = Decimal(s)
if amt < 0:
    raise SystemExit("0")
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

# Frontend-style: 9 decimals input scaled to 18.
scaled9 = (amt * (10 ** 9)).to_integral_value(rounding=ROUND_DOWN)
print(int(scaled9) * (10 ** 9))
PY
}

COLLATERAL_ID=""
BRANCH_HASH=""
NEXT_ID_IDX=""
case "$COLLATERAL_KIND" in
  cspr|CSPR|0)
    COLLATERAL_ID="0"
    BRANCH_HASH="$BRANCH_CSPR_HASH"
    NEXT_ID_IDX="11"
    ;;
  scspr|SCSPR|1)
    COLLATERAL_ID="1"
    BRANCH_HASH="$BRANCH_SCSPR_HASH"
    NEXT_ID_IDX="12"
    ;;
  *)
    echo "ERROR: collateral must be cspr or scspr"
    exit 1
    ;;
esac

if [ -z "$BRANCH_HASH" ] || [ "$BRANCH_HASH" = "null" ]; then
  echo "ERROR: branch contract missing in deployment file for collateral: $COLLATERAL_KIND"
  exit 1
fi

COLLATERAL_MOTES="$(to_amount_9 "$COLLATERAL_INPUT")"
DEBT_U256="$(to_debt_u256 "$BORROW_INPUT")"

next_id_key="$(odra_key_addr "$NEXT_ID_IDX" "$OWNER_HEX")"
next_id_bytes="$(get_state_bytes "$BRANCH_HASH" "$next_id_key")"
EXPECTED_VAULT_ID="$(parse_u64_from_clvalue_bytes "$next_id_bytes")"
if [ "$EXPECTED_VAULT_ID" = "0" ]; then
  EXPECTED_VAULT_ID="1"
fi

echo "=== Open Vault ==="
echo "Network:  $NETWORK"
echo "Deploy:   $DEPLOY_FILE"
echo "Node:     $NODE_ADDRESS"
echo "Chain:    $CHAIN_NAME"
echo "Owner:    $ACCOUNT_HASH"
echo "Router:   $ROUTER_HASH"
echo "Branch:   $BRANCH_HASH"
echo "Type:     $COLLATERAL_KIND (collateral_id=$COLLATERAL_ID)"
echo "Expected: vault_id=$EXPECTED_VAULT_ID"
echo ""

# stCSPR requires approve on ybToken first.
if [ "$COLLATERAL_ID" = "1" ]; then
  if [ -z "$YBTOKEN_HASH" ] || [ "$YBTOKEN_HASH" = "null" ]; then
    echo "ERROR: scsprYbToken.hash missing in deployment file (required for stCSPR)"
    exit 1
  fi
  if [ "$COLLATERAL_MOTES" != "0" ]; then
    echo "--- Approve stCSPR ---"
    call_contract "$YBTOKEN_HASH" "approve" "" \
      --session-arg "spender:key='$ROUTER_HASH'" \
      --session-arg "amount:u256='$COLLATERAL_MOTES'"
    echo ""
  fi
fi

echo "--- open_vault ---"
TRANSFERRED_VALUE="0"
if [ "$COLLATERAL_ID" = "0" ]; then
  TRANSFERRED_VALUE="$COLLATERAL_MOTES"
fi

call_contract "$ROUTER_HASH" "open_vault" "$TRANSFERRED_VALUE" \
  --session-arg "collateral_id:u8='$COLLATERAL_ID'" \
  --session-arg "collateral_amount:u256='$COLLATERAL_MOTES'" \
  --session-arg "debt_amount:u256='$DEBT_U256'" \
  --session-arg "interest_rate_bps:u32='$INTEREST_BPS'"

echo ""
echo "✓ Submitted and executed."
echo "  Next: ./scripts/casper/cdp-vaults.sh $NETWORK \"$DEPLOY_FILE\" $ACCOUNT_HASH"
