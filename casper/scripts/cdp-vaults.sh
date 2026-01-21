#!/usr/bin/env bash
# List CDP vaults for an owner (multi-vault).
#
# Usage:
#   ./casper/scripts/cdp-vaults.sh [network] [deployment-file] [owner-account-hash]
#
# Examples:
#   ./casper/scripts/cdp-vaults.sh testnet
#   ./casper/scripts/cdp-vaults.sh testnet deployments/casper/testnet-YYYYMMDD-HHMMSS.json account-hash-...
#
# Notes:
# - Reads Odra state dictionary directly (no signing required).
# - Owner defaults to .deployer in the deployment file when not provided.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CASPER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CASPER_DIR/.." && pwd)"
DEPLOY_DIR="$REPO_ROOT/deployments/casper"

NETWORK="${1:-testnet}"
DEPLOY_FILE="${2:-}"
OWNER_ARG="${3:-}"

require_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "ERROR: missing dependency: $1"
    exit 1
  fi
}

require_cmd casper-client
require_cmd jq
require_cmd python3

if [ -z "$DEPLOY_FILE" ]; then
  DEPLOY_FILE=$(ls -t "$DEPLOY_DIR/${NETWORK}-"*.json 2>/dev/null | head -n1 || true)
fi

if [ -z "$DEPLOY_FILE" ] || [ ! -f "$DEPLOY_FILE" ]; then
  echo "ERROR: deployment record not found for network: $NETWORK"
  exit 1
fi

NODE_ADDRESS=$(jq -r '.nodeAddress // empty' "$DEPLOY_FILE")
CHAIN_NAME=$(jq -r '.chainName // empty' "$DEPLOY_FILE")
DEPLOYER=$(jq -r '.deployer // empty' "$DEPLOY_FILE")

BRANCH_CSPR_HASH=$(jq -r '.contracts.branchCspr.hash // empty' "$DEPLOY_FILE")
BRANCH_SCSPR_HASH=$(jq -r '.contracts.branchSCSPR.hash // empty' "$DEPLOY_FILE")

OWNER="${OWNER_ARG:-$DEPLOYER}"

if [ -z "$NODE_ADDRESS" ] || [ "$NODE_ADDRESS" = "null" ]; then
  echo "ERROR: nodeAddress missing in deployment file"
  exit 1
fi
if [ -z "$CHAIN_NAME" ] || [ "$CHAIN_NAME" = "null" ]; then
  echo "ERROR: chainName missing in deployment file"
  exit 1
fi
if [ -z "$OWNER" ] || [ "$OWNER" = "null" ]; then
  echo "ERROR: owner account-hash not provided and .deployer missing in deployment file"
  exit 1
fi

if [[ "$OWNER" != account-hash-* ]]; then
  echo "ERROR: owner must be in 'account-hash-<64hex>' format"
  exit 1
fi

OWNER_HEX="${OWNER#account-hash-}"

STATE_ROOT=$(casper-client get-state-root-hash --node-address "$NODE_ADDRESS" | jq -r '.result.state_root_hash')
if [ -z "$STATE_ROOT" ] || [ "$STATE_ROOT" = "null" ]; then
  echo "ERROR: failed to get state root hash"
  exit 1
fi

# Compute Odra mapping key for Mapping<Address, T>
odra_key_addr() {
  local field_index="$1"
  local account_hex="$2"
  python3 - "$field_index" "$account_hex" <<'PY'
import sys, hashlib, binascii
field_index = int(sys.argv[1])
account_hex = sys.argv[2].strip()
idx = field_index.to_bytes(4, "big")
acct = binascii.unhexlify(account_hex)
addr = b"\x00" + acct  # Address::Account tag + 32 bytes
key = hashlib.blake2b(idx + addr, digest_size=32).hexdigest()
print(key)
PY
}

# Compute Odra mapping key for Mapping<(Address, u64), T>
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
key = hashlib.blake2b(idx + addr + u64_le, digest_size=32).hexdigest()
print(key)
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

format_vault_row_from_clvalue_bytes() {
  local hex_bytes="$1"
  python3 - "$hex_bytes" <<'PY'
import sys, binascii

hex_bytes = (sys.argv[1] or "").strip()
if not hex_bytes:
    print("")
    sys.exit(0)

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
    print("")
    sys.exit(0)

if off >= len(b):
    print("")
    sys.exit(0)

collateral_id = b[off]
off += 1

def read_u256():
    global off
    if off >= len(b):
        return 0
    ln = b[off]
    off += 1
    val = 0
    for i in range(ln):
        if off + i < len(b):
            val |= b[off + i] << (8 * i)
    off += ln
    return val

collateral = read_u256()
debt = read_u256()

rate_bps = 0
if off + 4 <= len(b):
    rate_bps = int.from_bytes(b[off:off+4], "little")
    off += 4

collateral_f = collateral / 1e9
debt_f = debt / 1e18
rate_pct = rate_bps / 100

print(f"{collateral_id}\t{collateral}\t{collateral_f:.9f}\t{debt}\t{debt_f:.18f}\t{rate_bps}\t{rate_pct:.2f}")
PY
}

print_branch_vaults() {
  local label="$1"
  local branch_hash="$2"
  local user_vault_count_idx="$3"
  local user_vault_ids_idx="$4"
  local vaults_idx="$5"

  if [ -z "$branch_hash" ] || [ "$branch_hash" = "null" ]; then
    echo "=== $label ==="
    echo "Branch not deployed"
    echo ""
    return
  fi

  echo "=== $label ==="
  echo "Branch: $branch_hash"

  local count_key
  count_key="$(odra_key_addr "$user_vault_count_idx" "$OWNER_HEX")"
  local count_bytes
  count_bytes="$(get_state_bytes "$branch_hash" "$count_key")"
  local count
  count="$(parse_u64_from_clvalue_bytes "$count_bytes")"

  echo "Owner:  $OWNER"
  echo "Count:  $count"

  if [ "$count" = "0" ]; then
    echo ""
    return
  fi

  echo ""
  echo -e "id\tcollateral_id\tcollateral_raw\tcollateral\tdebt_raw\tdebt\tinterest_bps\tinterest_%"

  local max=50
  if [ "$count" -gt "$max" ]; then
    echo "Note: showing first $max vaults (of $count)"
    count="$max"
  fi

  local i=0
  while [ "$i" -lt "$count" ]; do
    local id_key
    id_key="$(odra_key_addr_u64 "$user_vault_ids_idx" "$OWNER_HEX" "$i")"
    local id_bytes
    id_bytes="$(get_state_bytes "$branch_hash" "$id_key")"
    local vault_id
    vault_id="$(parse_u64_from_clvalue_bytes "$id_bytes")"
    if [ "$vault_id" = "0" ]; then
      i=$((i + 1))
      continue
    fi

    local vault_key
    vault_key="$(odra_key_addr_u64 "$vaults_idx" "$OWNER_HEX" "$vault_id")"
    local vault_bytes
    vault_bytes="$(get_state_bytes "$branch_hash" "$vault_key")"
    local row
    row="$(format_vault_row_from_clvalue_bytes "$vault_bytes")"
    if [ -n "$row" ]; then
      echo -e "${vault_id}\t${row}"
    else
      echo -e "${vault_id}\t<unreadable>"
    fi

    i=$((i + 1))
  done

  echo ""
}

# Field indices (Odra, 1-indexed) for multi-vault branches.
# BranchCSPR tail: next_vault_id(14), user_vault_count(15), user_vault_ids(16)
# BranchSCSPR tail: next_vault_id(16), user_vault_count(17), user_vault_ids(18)
print_branch_vaults "CSPR Vaults" "$BRANCH_CSPR_HASH" 15 16 3
print_branch_vaults "stCSPR Vaults" "$BRANCH_SCSPR_HASH" 17 18 3

