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
require_cmd python3

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

# Odra Var field indices (1-indexed, matches contract field order)
SCSPR_TOTAL_SHARES_IDX=4
SCSPR_ASSETS_IDX=7
SCSPR_LAST_SYNC_IDX=8
QUEUE_NEXT_REQUEST_ID_IDX=3
QUEUE_CONFIG_IDX=7
QUEUE_STATS_IDX=8

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

print_odra_u256() {
  local label="$1"
  local parsed_json="$2"
  python3 - "$label" "$parsed_json" <<'PY'
import json, sys
label=sys.argv[1]
data=json.loads(sys.argv[2] or "null")
if not isinstance(data, list):
    print(f"- {label}: (missing)")
    sys.exit(0)
if len(data)==0:
    print(f"- {label}: 0")
    sys.exit(0)
length=data[0]
val=0
for i in range(length):
    if 1+i < len(data):
        val += data[1+i] << (8*i)
print(f"- {label}: {val}")
PY
}

print_odra_u64() {
  local label="$1"
  local parsed_json="$2"
  python3 - "$label" "$parsed_json" <<'PY'
import json, sys
label=sys.argv[1]
data=json.loads(sys.argv[2] or "null")
if not isinstance(data, list) or len(data) < 8:
    print(f"- {label}: (missing)")
    sys.exit(0)
val=0
for i in range(8):
    val += data[i] << (8*i)
print(f"- {label}: {val}")
PY
}

print_asset_breakdown() {
  local label="$1"
  local parsed_json="$2"
  python3 - "$label" "$parsed_json" <<'PY'
import json, sys
label=sys.argv[1]
data=json.loads(sys.argv[2] or "null")
if not isinstance(data, list):
    print(f"- {label}: (missing)")
    sys.exit(0)
vals=[]
i=0
for _ in range(6):
    if i >= len(data):
        vals.append(0)
        continue
    length=data[i]
    i+=1
    val=0
    for j in range(length):
        if i+j < len(data):
            val += data[i+j] << (8*j)
    i+=length
    vals.append(val)
idle, delegated, undelegating, claimable, protocol_fees, realized_losses = vals
print(f"- {label}: {{idle_cspr:{idle}, delegated_cspr:{delegated}, undelegating_cspr:{undelegating}, claimable_cspr:{claimable}, protocol_fees:{protocol_fees}, realized_losses:{realized_losses}}}")
PY
}

print_queue_config() {
  local label="$1"
  local parsed_json="$2"
  python3 - "$label" "$parsed_json" <<'PY'
import json, sys
label=sys.argv[1]
data=json.loads(sys.argv[2] or "null")
if not isinstance(data, list) or len(data) < 8:
    print(f"- {label}: (missing)")
    sys.exit(0)
unbonding=0
for i in range(8):
    unbonding += data[i] << (8*i)
print(f"- {label}.unbonding_period: {unbonding}")
PY
}

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
YB_ASSETS_PARSED=$(odra_var_parsed "$YBTOKEN_HASH" "$SCSPR_ASSETS_IDX")
YB_TOTAL_SHARES_PARSED=$(odra_var_parsed "$YBTOKEN_HASH" "$SCSPR_TOTAL_SHARES_IDX")
YB_LAST_SYNC_PARSED=$(odra_var_parsed "$YBTOKEN_HASH" "$SCSPR_LAST_SYNC_IDX")
print_asset_breakdown "ybToken.assets" "$YB_ASSETS_PARSED"
print_odra_u256 "ybToken.total_shares" "$YB_TOTAL_SHARES_PARSED"
print_odra_u64 "ybToken.last_sync_timestamp" "$YB_LAST_SYNC_PARSED"
echo ""

echo "=== ybToken CEP-18 named_keys (for explorers) ==="
read_var_by_name "ybToken" "$YBTOKEN_HASH" "name"
read_var_by_name "ybToken" "$YBTOKEN_HASH" "symbol"
read_var_by_name "ybToken" "$YBTOKEN_HASH" "decimals"
read_var_by_name "ybToken" "$YBTOKEN_HASH" "total_supply"
echo ""

dump_named_keys "WithdrawQueue" "$QUEUE_HASH"
WQ_CONFIG_PARSED=$(odra_var_parsed "$QUEUE_HASH" "$QUEUE_CONFIG_IDX")
WQ_NEXT_PARSED=$(odra_var_parsed "$QUEUE_HASH" "$QUEUE_NEXT_REQUEST_ID_IDX")
WQ_STATS_PARSED=$(odra_var_parsed "$QUEUE_HASH" "$QUEUE_STATS_IDX")
print_queue_config "WithdrawQueue.config" "$WQ_CONFIG_PARSED"
print_odra_u64 "WithdrawQueue.next_request_id" "$WQ_NEXT_PARSED"
echo "- WithdrawQueue.stats: $WQ_STATS_PARSED"
echo ""

echo "=== Notes ==="
echo "- Odra stores Var<T> in a single dictionary named 'state' (hashed keys). Named keys may not include fields."
echo "- For cspr.live to recognize stCSPR as CEP-18, the ybToken contract should expose named_keys: name/symbol/decimals/total_supply and dictionaries: balances/allowances."
echo "- Frontend reads ybToken/WithdrawQueue via Odra dictionary queries in frontend/lib/casperRpc.ts."
echo ""
