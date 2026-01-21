#!/usr/bin/env bash
# Close a CDP vault (multi-vault).
#
# Usage:
#   ./casper/scripts/cdp-close-vault.sh [network] [deployment-file] <secret-key-path> <cspr|scspr> <vault_id>
#
# Example:
#   ./casper/scripts/cdp-close-vault.sh testnet "" ~/keys/secret_key.pem cspr 1
#
# Notes:
# - Reads vault debt from Odra state dictionary to approve gUSD before closing.
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

usage() {
  echo "Usage:"
  echo "  $0 [network] [deployment-file] <secret-key-path> <cspr|scspr> <vault_id>"
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

if [ -z "$SECRET_KEY" ] || [ -z "$COLLATERAL_KIND" ] || [ -z "$VAULT_ID" ]; then
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

COLLATERAL_ID=""
BRANCH_HASH=""
case "$COLLATERAL_KIND" in
  cspr|CSPR|0)
    COLLATERAL_ID="0"
    BRANCH_HASH="$BRANCH_CSPR_HASH"
    ;;
  scspr|SCSPR|1)
    COLLATERAL_ID="1"
    BRANCH_HASH="$BRANCH_SCSPR_HASH"
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

# Read vault debt from Odra dictionary.
STATE_ROOT=$(casper-client get-state-root-hash --node-address "$NODE_ADDRESS" | jq -r '.result.state_root_hash')
ACCOUNT_HASH=$(casper-client account-address --public-key "$PUBLIC_KEY")
if [[ "$ACCOUNT_HASH" != account-hash-* ]]; then
  echo "ERROR: failed to derive account-hash from public key: $PUBLIC_KEY"
  exit 1
fi
OWNER_HEX="${ACCOUNT_HASH#account-hash-}"

odra_key_addr_u64() {
  local field_index="$1"
  local account_hex="$2"
  local u64_value="$3"
  python3 - "$field_index" "$account_hex" "$u64_value" <<'PY'
import sys, hashlib, binascii
field_index = int(sys.argv[1])
account_hex = sys.argv[2].strip()
u64_value = int(sys.argv[3])
idx = field_index.to_bytes(4, "big")
acct = binascii.unhexlify(account_hex)
addr = b"\x00" + acct
u64_le = u64_value.to_bytes(8, "little")
print(hashlib.blake2b(idx + addr + u64_le, digest_size=32).hexdigest())
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

parse_debt_from_vault_clvalue_bytes() {
  local hex_bytes="$1"
  python3 - "$hex_bytes" <<'PY'
import sys, binascii

hex_bytes = (sys.argv[1] or "").strip()
if not hex_bytes:
    print("0")
    raise SystemExit(0)

b = binascii.unhexlify(hex_bytes)
if len(b) >= 4:
    n = int.from_bytes(b[0:4], "little")
    if n == len(b) - 4:
        b = b[4:]

off = 0
# Skip owner Address (tag + 32)
if len(b) - off >= 33 and b[off] in (0, 1):
    off += 33
elif len(b) - off >= 32:
    off += 32
else:
    print("0")
    raise SystemExit(0)

if off >= len(b):
    print("0")
    raise SystemExit(0)

# collateral_id u8
off += 1

def read_u256(buf, offset):
    if offset >= len(buf):
        return 0, offset
    ln = buf[offset]
    offset += 1
    val = 0
    for i in range(ln):
        if offset + i < len(buf):
            val |= buf[offset + i] << (8 * i)
    offset += ln
    return val, offset

_, off = read_u256(b, off)  # collateral
debt, off = read_u256(b, off)
print(debt)
PY
}

# vaults mapping is field index 3 in both branches (Odra, 1-indexed)
VAULTS_IDX="3"
vault_key="$(odra_key_addr_u64 "$VAULTS_IDX" "$OWNER_HEX" "$VAULT_ID")"
vault_bytes="$(get_state_bytes "$BRANCH_HASH" "$vault_key")"
DEBT="$(parse_debt_from_vault_clvalue_bytes "$vault_bytes")"

if [ "$DEBT" = "0" ] && [ -z "$vault_bytes" ]; then
  echo "ERROR: vault not found (owner=$ACCOUNT_HASH, vault_id=$VAULT_ID)"
  exit 1
fi

echo "=== Close Vault ==="
echo "Network:  $NETWORK"
echo "Deploy:   $DEPLOY_FILE"
echo "Node:     $NODE_ADDRESS"
echo "Chain:    $CHAIN_NAME"
echo "Owner:    $ACCOUNT_HASH"
echo "Router:   $ROUTER_HASH"
echo "Branch:   $BRANCH_HASH"
echo "Type:     $COLLATERAL_KIND (collateral_id=$COLLATERAL_ID)"
echo "Vault:    $VAULT_ID"
echo "Debt:     $DEBT"
echo ""

if [ "$DEBT" != "0" ]; then
  echo "--- Approve gUSD ---"
  call_contract "$STABLECOIN_HASH" "approve" "" \
    --session-arg "spender:key='$ROUTER_HASH'" \
    --session-arg "amount:u256='$DEBT'"
  echo ""
fi

echo "--- close_vault ---"
call_contract "$ROUTER_HASH" "close_vault" "" \
  --session-arg "collateral_id:u8='$COLLATERAL_ID'" \
  --session-arg "vault_id:u64='$VAULT_ID'"

echo ""
echo "✓ Submitted and executed."
echo "  Next: ./scripts/casper/cdp-vaults.sh $NETWORK \"$DEPLOY_FILE\" $ACCOUNT_HASH"

