#!/usr/bin/env bash
# Upgrade stCSPR ybToken (ScsprYbToken) in-place (Odra upgrade)
#
# Purpose:
# - Ship contract fixes without redeploying a brand-new package.
# - Preserve existing protocol state (contract package hash stays the same; new contract version is added).
#
# Usage:
#   ./casper/scripts/upgrade-scspr-ybtoken.sh <network> <secret-key-path> [package-hash-hex]
#
# Examples:
#   ./casper/scripts/upgrade-scspr-ybtoken.sh testnet /path/to/secret_key.pem
#   ./casper/scripts/upgrade-scspr-ybtoken.sh testnet /path/to/secret_key.pem 2ee4...fb3051
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/.." && pwd)"
WASM_DIR="$ROOT_DIR/wasm"
WASM_PATH="$WASM_DIR/ScsprYbToken.wasm"

NETWORK="${1:-testnet}"
SECRET_KEY="${2:-}"
PACKAGE_HEX="${3:-}"

if [ -z "$SECRET_KEY" ]; then
  echo "ERROR: secret key path is required"
  echo "Usage: $0 <network> <secret-key-path> [package-hash-hex]"
  exit 1
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

require_cmd() {
  if ! command -v "$1" &> /dev/null; then
    echo "ERROR: missing dependency: $1"
    exit 1
  fi
}

require_cmd casper-client
require_cmd jq

if [ ! -f "$WASM_PATH" ]; then
  echo "ERROR: wasm not found: $WASM_PATH"
  echo "Build first: cd casper && make wasm"
  exit 1
fi

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

extract_contract_hash() {
  local deploy_hash="$1"
  local result
  result=$(casper-client get-transaction --node-address "$NODE_ADDRESS" "$deploy_hash")
  result=$(json_only "$result")

  echo "$result" | jq -r '(
      .result.execution_info.execution_result.Version2.effects
      // .result.execution_info.execution_result.Version1.effects
      // []
    )[] | select((.kind | type) == "object" and .kind.Write.Contract != null) | .key' 2>/dev/null | head -n 1
}

resolve_package_hex_from_configs() {
  local network="$1"
  local cfg1="$REPO_ROOT/config/casper-${network}.json"
  local cfg2="$REPO_ROOT/frontend/public/config/casper-${network}.json"

  local pkg=""
  if [ -f "$cfg1" ]; then
    pkg=$(jq -r '.contracts.scsprYbTokenPackage // empty' "$cfg1" 2>/dev/null || true)
  fi
  if [ -z "$pkg" ] && [ -f "$cfg2" ]; then
    pkg=$(jq -r '.contracts.scsprYbTokenPackage // empty' "$cfg2" 2>/dev/null || true)
  fi

  if [ -z "$pkg" ] || [ "$pkg" = "null" ]; then
    echo ""
    return
  fi

  if [[ "$pkg" == contract-package-* ]]; then
    echo "${pkg#contract-package-}"
    return
  fi

  if [[ "$pkg" == hash-* ]]; then
    echo "${pkg#hash-}"
    return
  fi

  echo "$pkg"
}

resolve_package_hex_from_account_named_key() {
  local key_name="ScsprYbToken"
  local account_hash
  account_hash=$(casper-client account-address --public-key "$PUBLIC_KEY")

  local state_root
  state_root=$(casper-client get-state-root-hash --node-address "$NODE_ADDRESS" | jq -r '.result.state_root_hash')

  local pkg_key
  pkg_key=$(casper-client query-global-state \
    --node-address "$NODE_ADDRESS" \
    --state-root-hash "$state_root" \
    --key "$account_hash" | jq -r --arg k "$key_name" '
      .result.stored_value.Account.named_keys[] | select(.name == $k) | .key
    ' | head -n1)

  if [ -z "$pkg_key" ] || [ "$pkg_key" = "null" ]; then
    echo ""
    return
  fi

  if [[ "$pkg_key" == hash-* ]]; then
    echo "${pkg_key#hash-}"
    return
  fi

  echo "$pkg_key"
}

if [ -z "$PACKAGE_HEX" ]; then
  PACKAGE_HEX="$(resolve_package_hex_from_configs "$NETWORK")"
fi

if [ -z "$PACKAGE_HEX" ]; then
  PACKAGE_HEX="$(resolve_package_hex_from_account_named_key)"
fi

if [ -z "$PACKAGE_HEX" ] || [ "$PACKAGE_HEX" = "null" ]; then
  echo "ERROR: could not determine scsprYbToken package hash."
  echo "Provide it explicitly as the 3rd argument (64-hex), or ensure config files exist:"
  echo "  - config/casper-${NETWORK}.json"
  echo "  - frontend/public/config/casper-${NETWORK}.json"
  exit 1
fi

# Transaction config (defaults match deploy.sh)
PRICING_MODE="${PRICING_MODE:-classic}"
GAS_PRICE_TOL="${GAS_PRICE_TOL:-10}"
TTL="${TTL:-30min}"
PAYMENT_AMOUNT="${PAYMENT_AMOUNT:-}"
INSTALL_PAYMENT_AMOUNT="${INSTALL_PAYMENT_AMOUNT:-${PAYMENT_AMOUNT:-800000000000}}"

echo "=== Upgrade stCSPR ybToken (ScsprYbToken) ==="
echo "Network: $NETWORK"
echo "Node: $NODE_ADDRESS"
echo "Chain: $CHAIN_NAME"
echo "Package (hex): $PACKAGE_HEX"
echo "Wasm: $WASM_PATH"
echo ""

cmd=(
  casper-client put-transaction session
  --node-address "$NODE_ADDRESS"
  --chain-name "$CHAIN_NAME"
  --secret-key "$SECRET_KEY"
  --wasm-path "$WASM_PATH"
  --pricing-mode "$PRICING_MODE"
  --gas-price-tolerance "$GAS_PRICE_TOL"
  --payment-amount "$INSTALL_PAYMENT_AMOUNT"
  --standard-payment true
  --install-upgrade
  --ttl "$TTL"
  --session-arg "odra_cfg_is_upgrade:bool='true'"
  --session-arg "odra_cfg_package_hash_to_upgrade:byte_array_32='$PACKAGE_HEX'"
  --session-arg "odra_cfg_package_hash_key_name:string='ScsprYbToken'"
  --session-arg "odra_cfg_allow_key_override:bool='true'"
  --session-arg "odra_cfg_create_upgrade_group:bool='false'"
)

output=$("${cmd[@]}" 2>&1)
output_json=$(json_only "$output")
if [ -z "$output_json" ]; then
  echo "ERROR: failed to parse casper-client output"
  echo "$output"
  exit 1
fi

deploy_hash=$(echo "$output_json" | jq -r '.result.transaction_hash.Version1 // .result.transaction_hash // .result.deploy_hash // empty')
if [ -z "$deploy_hash" ]; then
  echo "ERROR: failed to get deploy hash"
  echo "$output_json"
  exit 1
fi

echo "Deploy hash: $deploy_hash"
wait_for_txn "$deploy_hash"

new_contract_hash=$(extract_contract_hash "$deploy_hash")
if [ -z "$new_contract_hash" ] || [ "$new_contract_hash" = "null" ]; then
  echo "ERROR: could not extract new contract hash from transaction."
  exit 1
fi

echo "✓ Upgraded. New contract hash: $new_contract_hash"
echo ""

update_runtime_config() {
  local file_path="$1"
  local contract_hash="$2"
  if [ ! -f "$file_path" ]; then
    return
  fi
  jq \
    --arg h "$contract_hash" \
    --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.contracts.scsprYbToken = $h | .generatedAt = $now' \
    "$file_path" > "$file_path.tmp" && mv "$file_path.tmp" "$file_path"
}

update_runtime_config "$REPO_ROOT/config/casper-${NETWORK}.json" "$new_contract_hash"
update_runtime_config "$REPO_ROOT/frontend/public/config/casper-${NETWORK}.json" "$new_contract_hash"

echo "✓ Updated runtime config files (if present):"
echo "  - config/casper-${NETWORK}.json"
echo "  - frontend/public/config/casper-${NETWORK}.json"
echo ""

DEPLOY_DIR="$REPO_ROOT/deployments/casper"
mkdir -p "$DEPLOY_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
UPGRADE_RECORD="$DEPLOY_DIR/${NETWORK}-upgrade-scsprYbToken-${TIMESTAMP}.json"

withdraw_queue_hash=$(jq -r '.contracts.withdrawQueue // "null"' "$REPO_ROOT/config/casper-${NETWORK}.json" 2>/dev/null || echo "null")
if [ "$withdraw_queue_hash" = "null" ] || [ -z "$withdraw_queue_hash" ]; then
  withdraw_queue_hash=$(jq -r '.contracts.withdrawQueue // "null"' "$REPO_ROOT/frontend/public/config/casper-${NETWORK}.json" 2>/dev/null || echo "null")
fi

deployer_account=$(casper-client account-address --public-key "$PUBLIC_KEY" 2>/dev/null || echo "")

cat > "$UPGRADE_RECORD" <<EOF
{
  "network": "$NETWORK",
  "chainName": "$CHAIN_NAME",
  "nodeAddress": "$NODE_ADDRESS",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "deployer": "$deployer_account",
  "contracts": {
    "scsprYbToken": {
      "hash": "$new_contract_hash",
      "package_hash": "contract-package-$PACKAGE_HEX",
      "deployed": true,
      "deploy_hash": "$deploy_hash"
    },
    "withdrawQueue": {
      "hash": $([ "$withdraw_queue_hash" = "null" ] && echo null || echo "\"$withdraw_queue_hash\""),
      "package_hash": null,
      "deployed": $([ "$withdraw_queue_hash" = "null" ] && echo false || echo true),
      "deploy_hash": null
    }
  },
  "status": "upgraded"
}
EOF

echo "✓ Wrote upgrade record:"
echo "  - $UPGRADE_RECORD"
echo ""
echo "Next:"
echo "  - Verify: ./casper/scripts/verify-lst-read.sh $NETWORK $UPGRADE_RECORD"
echo "  - Redeploy frontend (Vercel) to publish updated config."
