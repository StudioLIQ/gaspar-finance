#!/bin/bash
# CSPR-CDP Automated Deployment Script
#
# Fully automated build + deploy + initial configuration.
# Usage:
#   - (recommended, from repo root)  ./scripts/casper/deploy.sh [network] [secret-key-path]
#   - (direct, from repo root)       ./casper/scripts/deploy.sh [network] [secret-key-path]
#
# Example:
#   ./casper/scripts/deploy.sh testnet /path/to/secret_key.pem

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/.." && pwd)"
WASM_DIR="$ROOT_DIR/wasm"
WASM_FILE="$WASM_DIR/cspr_cdp_contracts.wasm"
DEPLOY_DIR="$ROOT_DIR/../deployments/casper"

NETWORK="${1:-testnet}"
SECRET_KEY="${2:-}"

if [ -z "$SECRET_KEY" ]; then
  echo "ERROR: secret key path is required"
  echo "Usage: $0 [testnet|mainnet|local] /path/to/secret_key.pem"
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

require_cmd cargo
require_cmd make
require_cmd casper-client
require_cmd jq

resolve_wasm_path() {
  local name="$1"
  case "$name" in
    registry) echo "$WASM_DIR/Registry.wasm" ;;
    router) echo "$WASM_DIR/Router.wasm" ;;
    accessControl) echo "$WASM_DIR/AccessControl.wasm" ;;
    stablecoin)
      if [ -f "$WASM_DIR/CsprUsd.wasm" ]; then
        echo "$WASM_DIR/CsprUsd.wasm"
      else
        echo "$WASM_DIR/Stablecoin.wasm"
      fi
      ;;
    treasury) echo "$WASM_DIR/Treasury.wasm" ;;
    tokenAdapter) echo "$WASM_DIR/TokenAdapter.wasm" ;;
    oracleAdapter) echo "$WASM_DIR/OracleAdapter.wasm" ;;
    branchCspr) echo "$WASM_DIR/BranchCspr.wasm" ;;
    branchSCSPR) echo "$WASM_DIR/BranchScspr.wasm" ;;
    liquidationEngine) echo "$WASM_DIR/LiquidationEngine.wasm" ;;
    stabilityPool) echo "$WASM_DIR/StabilityPool.wasm" ;;
    redemptionEngine) echo "$WASM_DIR/RedemptionEngine.wasm" ;;
    governance) echo "$WASM_DIR/Governance.wasm" ;;
    scsprYbToken) echo "$WASM_DIR/ScsprYbToken.wasm" ;;
    withdrawQueue) echo "$WASM_DIR/WithdrawQueue.wasm" ;;
    *) echo "$WASM_FILE" ;;
  esac
}

wasm_exists() {
  local name="$1"
  local path
  path=$(resolve_wasm_path "$name")
  [ -f "$path" ]
}

resolve_package_key_name() {
  local name="$1"
  case "$name" in
    registry) echo "Registry" ;;
    router) echo "Router" ;;
    accessControl) echo "AccessControl" ;;
    stablecoin) echo "CsprUsd" ;;
    treasury) echo "Treasury" ;;
    tokenAdapter) echo "TokenAdapter" ;;
    oracleAdapter) echo "OracleAdapter" ;;
    branchCspr) echo "BranchCspr" ;;
    branchSCSPR) echo "BranchScspr" ;;
    liquidationEngine) echo "LiquidationEngine" ;;
    stabilityPool) echo "StabilityPool" ;;
    redemptionEngine) echo "RedemptionEngine" ;;
    governance) echo "Governance" ;;
    scsprYbToken) echo "ScsprYbToken" ;;
    withdrawQueue) echo "WithdrawQueue" ;;
    *) echo "$name" ;;
  esac
}

# Convert contract package hash (contract-package-...) into a Key-friendly hash-...
key_from_pkg() {
  local pkg="$1"
  if [ -z "$pkg" ] || [ "$pkg" = "null" ]; then
    echo ""
    return
  fi
  if [[ "$pkg" == contract-package-* ]]; then
    echo "hash-${pkg#contract-package-}"
    return
  fi
  echo "$pkg"
}

# Transaction config (Casper 2.x uses put-transaction)
PRICING_MODE="${PRICING_MODE:-classic}"
GAS_PRICE_TOL="${GAS_PRICE_TOL:-10}"
TTL="${TTL:-30min}"

PAYMENT_AMOUNT="${PAYMENT_AMOUNT:-}"
# Defaults tuned for Casper Testnet contract installs (higher than legacy deploy defaults)
INSTALL_PAYMENT_AMOUNT="${INSTALL_PAYMENT_AMOUNT:-${PAYMENT_AMOUNT:-800000000000}}" # 800 CSPR default
CALL_PAYMENT_AMOUNT="${CALL_PAYMENT_AMOUNT:-${PAYMENT_AMOUNT:-20000000000}}" # 20 CSPR default

# Required network values
: "${CSPR_DECIMALS:?Set CSPR_DECIMALS (confirmed value)}"
: "${SCSPR_DECIMALS:?Set SCSPR_DECIMALS (confirmed value)}"

# LST deployment flag (set to "true" to deploy ybToken and WithdrawQueue)
DEPLOY_LST="${DEPLOY_LST:-true}"
# If true, auto-use the deployed ybToken as the stCSPR token + LST contract.
# This allows testnet deployments without pre-existing stCSPR contracts.
USE_DEPLOYED_LST_AS_SCSPR="${USE_DEPLOYED_LST_AS_SCSPR:-false}"

# Auto-enable internal LST usage when external hashes are missing
if [ -z "${SCSPR_TOKEN_HASH:-}" ] && [ -z "${SCSPR_LST_HASH:-}" ] && [ "$DEPLOY_LST" = "true" ] && [ "${USE_DEPLOYED_LST_AS_SCSPR:-}" != "true" ]; then
  USE_DEPLOYED_LST_AS_SCSPR="true"
  echo "Note: SCSPR_TOKEN_HASH/SCSPR_LST_HASH not set. Using deployed LST as stCSPR (USE_DEPLOYED_LST_AS_SCSPR=true)."
fi

if [ "$USE_DEPLOYED_LST_AS_SCSPR" = "true" ] && [ "$DEPLOY_LST" != "true" ]; then
  echo "ERROR: USE_DEPLOYED_LST_AS_SCSPR=true requires DEPLOY_LST=true"
  exit 1
fi

# External dependency contracts (optional if USE_DEPLOYED_LST_AS_SCSPR=true)
if [ "$USE_DEPLOYED_LST_AS_SCSPR" != "true" ]; then
  : "${SCSPR_TOKEN_HASH:?Set SCSPR_TOKEN_HASH (hash-...)}"
  : "${SCSPR_LST_HASH:?Set SCSPR_LST_HASH (hash-...)}"
  SCSPR_TOKEN_PKG="${SCSPR_TOKEN_PKG:-$SCSPR_TOKEN_HASH}"
  SCSPR_LST_PKG="${SCSPR_LST_PKG:-$SCSPR_LST_HASH}"
  SCSPR_TOKEN_PKG_KEY="$(key_from_pkg "$SCSPR_TOKEN_PKG")"
  SCSPR_LST_PKG_KEY="$(key_from_pkg "$SCSPR_LST_PKG")"
  if [[ "$SCSPR_TOKEN_PKG" != contract-package-* ]]; then
    echo "WARNING: SCSPR_TOKEN_PKG not set; defaulting to SCSPR_TOKEN_HASH (may break internal calls)" >&2
  fi
  if [[ "$SCSPR_LST_PKG" != contract-package-* ]]; then
    echo "WARNING: SCSPR_LST_PKG not set; defaulting to SCSPR_LST_HASH (may break internal calls)" >&2
  fi
fi

# Ensure variables are always bound (set -u safe) even when populated later.
SCSPR_TOKEN_HASH="${SCSPR_TOKEN_HASH:-}"
SCSPR_LST_HASH="${SCSPR_LST_HASH:-}"

# Protocol parameters (defaults from code, override if needed)
MCR_BPS="${MCR_BPS:-11000}"
MIN_DEBT="${MIN_DEBT:-1000000000000000000}"
BORROWING_FEE_BPS="${BORROWING_FEE_BPS:-50}"
REDEMPTION_FEE_BPS="${REDEMPTION_FEE_BPS:-50}"
LIQUIDATION_PENALTY_BPS="${LIQUIDATION_PENALTY_BPS:-1000}"
INTEREST_MIN_BPS="${INTEREST_MIN_BPS:-200}"
INTEREST_MAX_BPS="${INTEREST_MAX_BPS:-4000}"

ACCOUNT_HASH=$(casper-client account-address --public-key "$PUBLIC_KEY")

json_only() {
  # Strip any non-JSON preamble from casper-client output (e.g. warnings).
  printf '%s\n' "$1" | sed -n '/^[[:space:]]*[{[]/,$p'
}

echo "=== CSPR-CDP Automated Deployment ==="
echo "Network: $NETWORK"
echo "Node: $NODE_ADDRESS"
echo "Chain: $CHAIN_NAME"
echo "Deployer: $ACCOUNT_HASH"
echo ""

# Step 1: Build WASM
echo "=== Step 1: Build WASM ==="
cd "$ROOT_DIR"
make wasm

if [ ! -f "$WASM_FILE" ]; then
  echo "ERROR: WASM file not found: $WASM_FILE"
  exit 1
fi

echo "✓ WASM ready: $WASM_FILE"

# Step 2: Initialize deployment record
mkdir -p "$DEPLOY_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DEPLOY_RECORD="$DEPLOY_DIR/${NETWORK}-${TIMESTAMP}.json"

cat > "$DEPLOY_RECORD" << EOF
{
  "network": "$NETWORK",
  "chainName": "$CHAIN_NAME",
  "nodeAddress": "$NODE_ADDRESS",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "deployer": "$ACCOUNT_HASH",
  "contracts": {
    "registry": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "router": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "branchCspr": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "branchSCSPR": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "stablecoin": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "treasury": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "oracleAdapter": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "stabilityPool": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "liquidationEngine": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "redemptionEngine": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "tokenAdapter": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "accessControl": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "governance": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "scsprYbToken": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "withdrawQueue": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null }
  },
  "configuration": {
    "mcrBps": $MCR_BPS,
    "minDebt": "$MIN_DEBT",
    "borrowingFeeBps": $BORROWING_FEE_BPS,
    "redemptionFeeBps": $REDEMPTION_FEE_BPS,
    "liquidationPenaltyBps": $LIQUIDATION_PENALTY_BPS,
    "interestMinBps": $INTEREST_MIN_BPS,
    "interestMaxBps": $INTEREST_MAX_BPS,
    "csprDecimals": $CSPR_DECIMALS,
    "scsprDecimals": $SCSPR_DECIMALS,
    "scsprTokenHash": "$SCSPR_TOKEN_HASH",
    "scsprLstHash": "$SCSPR_LST_HASH"
  },
  "status": "pending"
}
EOF

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

  local hash
  hash=$(echo "$result" | jq -r '(
      .result.execution_info.execution_result.Version2.effects
      // .result.execution_info.execution_result.Version1.effects
      // []
    )[] | select((.kind | type) == "object" and .kind.Write.Contract != null) | .key' 2>/dev/null | head -n 1)
  if [ -n "$hash" ] && [ "$hash" != "null" ]; then
    echo "$hash"
    return
  fi

  hash=$(echo "$result" | jq -r '(
      .result.execution_info.execution_result.Version2.effects
      // .result.execution_info.execution_result.Version1.effects
      // []
    )[] | select((.kind | type) == "object" and .kind.Write != null and (.key | startswith("addressable-entity-"))) | .key' 2>/dev/null | head -n 1)
  if [ -n "$hash" ] && [ "$hash" != "null" ]; then
    echo "$hash"
    return
  fi

  hash=$(echo "$result" | jq -r '[
      (.result.execution_info.execution_result.Version2.effects
       // .result.execution_info.execution_result.Version1.effects
       // [])[] | .key
       | select(type == "string" and (startswith("hash-") or startswith("entity-contract-") or startswith("addressable-entity-")))
    ] | unique | .[0]' 2>/dev/null)
  if [ -n "$hash" ] && [ "$hash" != "null" ]; then
    echo "$hash"
    return
  fi

  echo ""
}

extract_package_hash() {
  local deploy_hash="$1"
  local result
  result=$(casper-client get-transaction --node-address "$NODE_ADDRESS" "$deploy_hash")
  result=$(json_only "$result")

  local hash
  hash=$(echo "$result" | jq -r '(
      .result.execution_info.execution_result.Version2.effects
      // .result.execution_info.execution_result.Version1.effects
      // []
    )[] | select((.kind | type) == "object" and .kind.Write.Contract != null)
     | .kind.Write.Contract.contract_package_hash' 2>/dev/null | head -n 1)
  if [ -n "$hash" ] && [ "$hash" != "null" ]; then
    echo "$hash"
    return
  fi

  hash=$(echo "$result" | jq -r '(
      .result.execution_info.execution_result.Version2.effects
      // .result.execution_info.execution_result.Version1.effects
      // []
    )[] | select((.kind | type) == "object" and .kind.Write.ContractPackage != null) | .key' 2>/dev/null | head -n 1)
  if [ -n "$hash" ] && [ "$hash" != "null" ]; then
    echo "$hash"
    return
  fi

  hash=$(echo "$result" | jq -r '[
      (.result.execution_info.execution_result.Version2.effects
       // .result.execution_info.execution_result.Version1.effects
       // [])[] | .key
       | select(type == "string" and (startswith("contract-package-") or startswith("package-")))
    ] | unique | .[0]' 2>/dev/null)
  if [ -n "$hash" ] && [ "$hash" != "null" ]; then
    echo "$hash"
    return
  fi

  echo ""
}

# Lookup package_hash from contract_hash via RPC query
lookup_package_hash_from_contract() {
  local contract_hash="$1"
  local state_root
  state_root=$(casper-client get-state-root-hash --node-address "$NODE_ADDRESS" 2>/dev/null | jq -r '.result.state_root_hash // empty')
  if [ -z "$state_root" ]; then
    echo ""
    return
  fi

  local result
  result=$(casper-client query-global-state \
    --node-address "$NODE_ADDRESS" \
    --state-root-hash "$state_root" \
    --key "$contract_hash" 2>/dev/null || true)
  result=$(json_only "$result")

  if [ -z "$result" ]; then
    echo ""
    return
  fi

  local pkg_hash
  pkg_hash=$(echo "$result" | jq -r '.result.stored_value.Contract.contract_package_hash // .result.stored_value.AddressableEntity.package_hash // empty' 2>/dev/null)
  if [ -n "$pkg_hash" ] && [ "$pkg_hash" != "null" ]; then
    echo "$pkg_hash"
    return
  fi

  echo ""
}

update_configuration() {
  jq \
    --arg cspr_decimals "$CSPR_DECIMALS" \
    --arg scspr_decimals "$SCSPR_DECIMALS" \
    --arg scspr_token_hash "${SCSPR_TOKEN_HASH:-}" \
    --arg scspr_lst_hash "${SCSPR_LST_HASH:-}" \
    '.configuration.csprDecimals = ($cspr_decimals | tonumber)
     | .configuration.scsprDecimals = ($scspr_decimals | tonumber)
     | .configuration.scsprTokenHash = $scspr_token_hash
     | .configuration.scsprLstHash = $scspr_lst_hash' \
    "$DEPLOY_RECORD" > "$DEPLOY_RECORD.tmp" && mv "$DEPLOY_RECORD.tmp" "$DEPLOY_RECORD"
}

update_record() {
  local name="$1"
  local deploy_hash="$2"
  local contract_hash="$3"
  local package_hash="$4"

  jq \
    --arg name "$name" \
    --arg deploy_hash "$deploy_hash" \
    --arg contract_hash "$contract_hash" \
    --arg package_hash "$package_hash" \
    '.contracts[$name].deploy_hash = $deploy_hash
     | .contracts[$name].hash = $contract_hash
     | .contracts[$name].package_hash = $package_hash
     | .contracts[$name].deployed = true' \
    "$DEPLOY_RECORD" > "$DEPLOY_RECORD.tmp" && mv "$DEPLOY_RECORD.tmp" "$DEPLOY_RECORD"
}

install_contract() {
  local name="$1"
  local entrypoint="$2"
  shift 2
  local args=("$@")
  local wasm_path
  wasm_path=$(resolve_wasm_path "$name")
  local package_key_name
  package_key_name=$(resolve_package_key_name "$name")

  if [ ! -f "$wasm_path" ]; then
    echo "ERROR: wasm file not found for $name: $wasm_path" >&2
    exit 1
  fi

  echo "" >&2
  echo "--- Installing $name ---" >&2

  local cmd=(
    casper-client put-transaction session
    --node-address "$NODE_ADDRESS"
    --chain-name "$CHAIN_NAME"
    --secret-key "$SECRET_KEY"
    --wasm-path "$wasm_path"
    --session-entry-point "$entrypoint"
    --pricing-mode "$PRICING_MODE"
    --gas-price-tolerance "$GAS_PRICE_TOL"
    --payment-amount "$INSTALL_PAYMENT_AMOUNT"
    --standard-payment true
    --install-upgrade
    --ttl "$TTL"
    --session-arg "odra_cfg_is_upgrade:bool='false'"
    --session-arg "odra_cfg_package_hash_key_name:string='$package_key_name'"
    --session-arg "odra_cfg_allow_key_override:bool='true'"
    --session-arg "odra_cfg_is_upgradable:bool='true'"
  )

  for arg in "${args[@]}"; do
    cmd+=("$arg")
  done

  local output
  output=$("${cmd[@]}" 2>&1)
  local output_json
  output_json=$(json_only "$output")
  if [ -z "$output_json" ]; then
    echo "ERROR: failed to parse casper-client output for $name" >&2
    echo "$output" >&2
    exit 1
  fi

  local deploy_hash
  deploy_hash=$(echo "$output_json" | jq -r '.result.transaction_hash.Version1 // .result.transaction_hash // .result.deploy_hash // empty')
  if [ -z "$deploy_hash" ]; then
    echo "ERROR: failed to get deploy hash for $name" >&2
    echo "$output_json" >&2
    exit 1
  fi

  echo "Deploy hash: $deploy_hash" >&2
  wait_for_txn "$deploy_hash"

  local contract_hash
  local package_hash
  contract_hash=$(extract_contract_hash "$deploy_hash")
  package_hash=$(extract_package_hash "$deploy_hash")

  if [ -z "$contract_hash" ] || [ "$contract_hash" = "null" ]; then
    echo "ERROR: failed to extract contract hash for $name" >&2
    exit 1
  fi

  if [ -z "$package_hash" ] || [ "$package_hash" = "null" ]; then
    echo "  (package_hash not in transforms, querying contract...)" >&2
    package_hash=$(lookup_package_hash_from_contract "$contract_hash")
  fi

  if [ -z "$package_hash" ] || [ "$package_hash" = "null" ]; then
    echo "  WARNING: could not extract package_hash for $name" >&2
    package_hash=""
  else
    echo "  package_hash: $package_hash" >&2
  fi

  update_record "$name" "$deploy_hash" "$contract_hash" "$package_hash"
  echo "✓ $name installed: $contract_hash" >&2

  printf '%s %s\n' "$contract_hash" "$package_hash"
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
    --payment-amount "$CALL_PAYMENT_AMOUNT"
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
      --payment-amount "$CALL_PAYMENT_AMOUNT"
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
    echo "ERROR: failed to parse casper-client output for call $entrypoint" >&2
    echo "$output" >&2
    exit 1
  fi

  local deploy_hash
  deploy_hash=$(echo "$output_json" | jq -r '.result.transaction_hash.Version1 // .result.transaction_hash // .result.deploy_hash // empty')
  if [ -z "$deploy_hash" ]; then
    echo "ERROR: failed to get deploy hash for call $entrypoint" >&2
    echo "$output_json" >&2
    exit 1
  fi

  echo "Deploy hash: $deploy_hash" >&2
  wait_for_txn "$deploy_hash"
}

# Entrypoint overrides (if needed)
REGISTRY_INIT_ENTRYPOINT="${REGISTRY_INIT_ENTRYPOINT:-init}"
ROUTER_INIT_ENTRYPOINT="${ROUTER_INIT_ENTRYPOINT:-init}"
ACCESS_CONTROL_INIT_ENTRYPOINT="${ACCESS_CONTROL_INIT_ENTRYPOINT:-init}"
STABLECOIN_INIT_ENTRYPOINT="${STABLECOIN_INIT_ENTRYPOINT:-init}"
TREASURY_INIT_ENTRYPOINT="${TREASURY_INIT_ENTRYPOINT:-init}"
TOKEN_ADAPTER_INIT_ENTRYPOINT="${TOKEN_ADAPTER_INIT_ENTRYPOINT:-init}"
ORACLE_INIT_ENTRYPOINT="${ORACLE_INIT_ENTRYPOINT:-init}"
BRANCH_CSPR_INIT_ENTRYPOINT="${BRANCH_CSPR_INIT_ENTRYPOINT:-init}"
BRANCH_SCSPR_INIT_ENTRYPOINT="${BRANCH_SCSPR_INIT_ENTRYPOINT:-init}"
STABILITY_POOL_INIT_ENTRYPOINT="${STABILITY_POOL_INIT_ENTRYPOINT:-init}"
LIQUIDATION_ENGINE_INIT_ENTRYPOINT="${LIQUIDATION_ENGINE_INIT_ENTRYPOINT:-init}"
REDEMPTION_ENGINE_INIT_ENTRYPOINT="${REDEMPTION_ENGINE_INIT_ENTRYPOINT:-init}"
GOVERNANCE_INIT_ENTRYPOINT="${GOVERNANCE_INIT_ENTRYPOINT:-init}"
SCSPR_YBTOKEN_INIT_ENTRYPOINT="${SCSPR_YBTOKEN_INIT_ENTRYPOINT:-init}"
WITHDRAW_QUEUE_INIT_ENTRYPOINT="${WITHDRAW_QUEUE_INIT_ENTRYPOINT:-init}"

# Step 3: Deploy contracts
read -r REGISTRY_HASH REGISTRY_PKG <<< "$(install_contract "registry" "$REGISTRY_INIT_ENTRYPOINT" \
  --session-arg "admin:key='$ACCOUNT_HASH'" \
  --session-arg "mcr_bps:u32='$MCR_BPS'" \
  --session-arg "min_debt:u256='$MIN_DEBT'" \
  --session-arg "borrowing_fee_bps:u32='$BORROWING_FEE_BPS'" \
  --session-arg "redemption_fee_bps:u32='$REDEMPTION_FEE_BPS'" \
  --session-arg "liquidation_penalty_bps:u32='$LIQUIDATION_PENALTY_BPS'" \
  --session-arg "interest_min_bps:u32='$INTEREST_MIN_BPS'" \
  --session-arg "interest_max_bps:u32='$INTEREST_MAX_BPS'")"
REGISTRY_PKG_KEY="$(key_from_pkg "$REGISTRY_PKG")"

read -r ROUTER_HASH ROUTER_PKG <<< "$(install_contract "router" "$ROUTER_INIT_ENTRYPOINT" \
  --session-arg "registry:key='$REGISTRY_PKG_KEY'")"
ROUTER_PKG_KEY="$(key_from_pkg "$ROUTER_PKG")"

read -r ACCESS_CONTROL_HASH ACCESS_CONTROL_PKG <<< "$(install_contract "accessControl" "$ACCESS_CONTROL_INIT_ENTRYPOINT" \
  --session-arg "initial_admin:key='$ACCOUNT_HASH'")"
ACCESS_CONTROL_PKG_KEY="$(key_from_pkg "$ACCESS_CONTROL_PKG")"

read -r STABLECOIN_HASH STABLECOIN_PKG <<< "$(install_contract "stablecoin" "$STABLECOIN_INIT_ENTRYPOINT" \
  --session-arg "registry:key='$REGISTRY_PKG_KEY'")"
STABLECOIN_PKG_KEY="$(key_from_pkg "$STABLECOIN_PKG")"

read -r TREASURY_HASH TREASURY_PKG <<< "$(install_contract "treasury" "$TREASURY_INIT_ENTRYPOINT" \
  --session-arg "registry:key='$REGISTRY_PKG_KEY'" \
  --session-arg "stablecoin:key='$STABLECOIN_PKG_KEY'")"
TREASURY_PKG_KEY="$(key_from_pkg "$TREASURY_PKG")"

read -r TOKEN_ADAPTER_HASH TOKEN_ADAPTER_PKG <<< "$(install_contract "tokenAdapter" "$TOKEN_ADAPTER_INIT_ENTRYPOINT" \
  --session-arg "registry:key='$REGISTRY_PKG_KEY'")"
TOKEN_ADAPTER_PKG_KEY="$(key_from_pkg "$TOKEN_ADAPTER_PKG")"

# Step 3b: Deploy LST contracts (stCSPR ybToken and WithdrawQueue) early (optional)
YBTOKEN_HASH=""
WITHDRAW_QUEUE_HASH=""

if [ "$DEPLOY_LST" = "true" ]; then
  echo ""
  echo "=== Step 3b: Deploy LST Contracts ==="

  # Operator address for ybToken (defaults to deployer)
  LST_OPERATOR="${LST_OPERATOR:-$ACCOUNT_HASH}"

  read -r YBTOKEN_HASH YBTOKEN_PKG <<< "$(install_contract "scsprYbToken" "$SCSPR_YBTOKEN_INIT_ENTRYPOINT" \
    --session-arg "admin:key='$ACCOUNT_HASH'" \
    --session-arg "operator:key='$LST_OPERATOR'")"
  YBTOKEN_PKG_KEY="$(key_from_pkg "$YBTOKEN_PKG")"

  read -r WITHDRAW_QUEUE_HASH WITHDRAW_QUEUE_PKG <<< "$(install_contract "withdrawQueue" "$WITHDRAW_QUEUE_INIT_ENTRYPOINT" \
    --session-arg "ybtoken:key='$YBTOKEN_PKG_KEY'" \
    --session-arg "admin:key='$ACCOUNT_HASH'")"
  WITHDRAW_QUEUE_PKG_KEY="$(key_from_pkg "$WITHDRAW_QUEUE_PKG")"

  # Configure ybToken to know about WithdrawQueue
  echo ""
  echo "--- Configuring ybToken-WithdrawQueue link ---"
  call_contract "$YBTOKEN_HASH" "set_withdraw_queue" \
    --session-arg "queue_address:key='$WITHDRAW_QUEUE_PKG_KEY'"
  echo "✓ ybToken.set_withdraw_queue configured"

  if [ "$USE_DEPLOYED_LST_AS_SCSPR" = "true" ]; then
    if [ -z "${SCSPR_TOKEN_HASH:-}" ]; then
      SCSPR_TOKEN_HASH="$YBTOKEN_HASH"
    fi
    if [ -z "${SCSPR_TOKEN_PKG:-}" ]; then
      SCSPR_TOKEN_PKG="$YBTOKEN_PKG"
    fi
    SCSPR_TOKEN_PKG_KEY="$(key_from_pkg "$SCSPR_TOKEN_PKG")"
    if [ -z "${SCSPR_LST_HASH:-}" ]; then
      SCSPR_LST_HASH="$YBTOKEN_HASH"
    fi
    if [ -z "${SCSPR_LST_PKG:-}" ]; then
      SCSPR_LST_PKG="$YBTOKEN_PKG"
    fi
    SCSPR_LST_PKG_KEY="$(key_from_pkg "$SCSPR_LST_PKG")"
    update_configuration
    echo "✓ Using deployed ybToken for stCSPR:"
    echo "  - SCSPR_TOKEN_HASH=$SCSPR_TOKEN_HASH"
    echo "  - SCSPR_LST_HASH=$SCSPR_LST_HASH"
  fi
else
  echo ""
  echo "=== Skipping LST deployment (DEPLOY_LST != true) ==="
fi

if [ "$USE_DEPLOYED_LST_AS_SCSPR" != "true" ]; then
  # Ensure configuration is consistent if the user provided external hashes.
  update_configuration
fi

if [ -z "${SCSPR_TOKEN_HASH:-}" ] || [ -z "${SCSPR_LST_HASH:-}" ]; then
  echo "ERROR: SCSPR_TOKEN_HASH / SCSPR_LST_HASH are required (or set USE_DEPLOYED_LST_AS_SCSPR=true)"
  exit 1
fi

read -r ORACLE_HASH ORACLE_PKG <<< "$(install_contract "oracleAdapter" "$ORACLE_INIT_ENTRYPOINT" \
  --session-arg "registry:key='$REGISTRY_PKG_KEY'" \
  --session-arg "router:key='$ROUTER_PKG_KEY'")"
ORACLE_PKG_KEY="$(key_from_pkg "$ORACLE_PKG")"

read -r BRANCH_CSPR_HASH BRANCH_CSPR_PKG <<< "$(install_contract "branchCspr" "$BRANCH_CSPR_INIT_ENTRYPOINT" \
  --session-arg "registry:key='$REGISTRY_PKG_KEY'" \
  --session-arg "router:key='$ROUTER_PKG_KEY'")"
BRANCH_CSPR_PKG_KEY="$(key_from_pkg "$BRANCH_CSPR_PKG")"

read -r BRANCH_SCSPR_HASH BRANCH_SCSPR_PKG <<< "$(install_contract "branchSCSPR" "$BRANCH_SCSPR_INIT_ENTRYPOINT" \
  --session-arg "registry:key='$REGISTRY_PKG_KEY'" \
  --session-arg "router:key='$ROUTER_PKG_KEY'" \
  --session-arg "scspr_token:key='$SCSPR_TOKEN_PKG_KEY'")"
BRANCH_SCSPR_PKG_KEY="$(key_from_pkg "$BRANCH_SCSPR_PKG")"

# Deploy liquidation engine with placeholder stability pool (router), then patch later
read -r LIQUIDATION_ENGINE_HASH LIQUIDATION_ENGINE_PKG <<< "$(install_contract "liquidationEngine" "$LIQUIDATION_ENGINE_INIT_ENTRYPOINT" \
  --session-arg "registry:key='$REGISTRY_PKG_KEY'" \
  --session-arg "router:key='$ROUTER_PKG_KEY'" \
  --session-arg "stability_pool:key='$ROUTER_PKG_KEY'" \
  --session-arg "styks_oracle:key='$ORACLE_PKG_KEY'")"
LIQUIDATION_ENGINE_PKG_KEY="$(key_from_pkg "$LIQUIDATION_ENGINE_PKG")"

read -r STABILITY_POOL_HASH STABILITY_POOL_PKG <<< "$(install_contract "stabilityPool" "$STABILITY_POOL_INIT_ENTRYPOINT" \
  --session-arg "registry:key='$REGISTRY_PKG_KEY'" \
  --session-arg "router:key='$ROUTER_PKG_KEY'" \
  --session-arg "stablecoin:key='$STABLECOIN_PKG_KEY'" \
  --session-arg "liquidation_engine:key='$LIQUIDATION_ENGINE_PKG_KEY'")"
STABILITY_POOL_PKG_KEY="$(key_from_pkg "$STABILITY_POOL_PKG")"

read -r REDEMPTION_ENGINE_HASH REDEMPTION_ENGINE_PKG <<< "$(install_contract "redemptionEngine" "$REDEMPTION_ENGINE_INIT_ENTRYPOINT" \
  --session-arg "registry:key='$REGISTRY_PKG_KEY'" \
  --session-arg "router:key='$ROUTER_PKG_KEY'" \
  --session-arg "stablecoin:key='$STABLECOIN_PKG_KEY'" \
  --session-arg "treasury:key='$TREASURY_PKG_KEY'" \
  --session-arg "styks_oracle:key='$ORACLE_PKG_KEY'")"
REDEMPTION_ENGINE_PKG_KEY="$(key_from_pkg "$REDEMPTION_ENGINE_PKG")"

GOVERNANCE_HASH=""
if wasm_exists "governance"; then
  read -r GOVERNANCE_HASH GOVERNANCE_PKG <<< "$(install_contract "governance" "$GOVERNANCE_INIT_ENTRYPOINT" \
    --session-arg "access_control:key='$ACCESS_CONTROL_HASH'")"
  GOVERNANCE_PKG_KEY="$(key_from_pkg "$GOVERNANCE_PKG")"
else
  echo "WARNING: Governance.wasm not found; skipping governance deployment" >&2
fi

# Step 3c: Configure Oracle to use ybToken for exchange rate (if LST deployed)
if [ "$DEPLOY_LST" = "true" ] && [ -n "$YBTOKEN_HASH" ]; then
  echo ""
  echo "--- Configuring Oracle-ybToken link ---"
  call_contract "$ORACLE_HASH" "set_scspr_ybtoken" \
    --session-arg "ybtoken:key='$YBTOKEN_PKG_KEY'"
  echo "✓ Oracle.set_scspr_ybtoken configured"

  # Initial rate sync (R = 1.0 = 1e18)
  echo ""
  echo "--- Initial rate sync ---"
  INITIAL_RATE="1000000000000000000"  # 1e18 = 1.0
  call_contract "$ORACLE_HASH" "sync_rate_from_ybtoken" \
    --session-arg "rate:u256='$INITIAL_RATE'"
  echo "✓ Initial exchange rate synced (R = 1.0)"
fi

# Step 4: Cross-configure registry and circular dependencies
call_contract "$REGISTRY_HASH" "set_router" --session-arg "router:key='$ROUTER_PKG_KEY'"
call_contract "$REGISTRY_HASH" "set_stablecoin" --session-arg "stablecoin:key='$STABLECOIN_PKG_KEY'"
call_contract "$REGISTRY_HASH" "set_treasury" --session-arg "treasury:key='$TREASURY_PKG_KEY'"
call_contract "$REGISTRY_HASH" "set_oracle" --session-arg "oracle:key='$ORACLE_PKG_KEY'"
call_contract "$REGISTRY_HASH" "set_stability_pool" --session-arg "stability_pool:key='$STABILITY_POOL_PKG_KEY'"
call_contract "$REGISTRY_HASH" "set_liquidation_engine" --session-arg "liquidation_engine:key='$LIQUIDATION_ENGINE_PKG_KEY'"

# Allow Router to mint/burn gUSD on behalf of users
call_contract "$STABLECOIN_HASH" "add_minter" --session-arg "minter:key='$ROUTER_PKG_KEY'"

call_contract "$REGISTRY_HASH" "register_branch_cspr" \
  --session-arg "branch:key='$BRANCH_CSPR_PKG_KEY'" \
  --session-arg "decimals:u8='$CSPR_DECIMALS'" \
  --session-arg "mcr_bps:u32='$MCR_BPS'"

call_contract "$REGISTRY_HASH" "register_branch_scspr" \
  --session-arg "branch:key='$BRANCH_SCSPR_PKG_KEY'" \
  --session-arg "token_address:key='$SCSPR_TOKEN_PKG_KEY'" \
  --session-arg "decimals:u8='$SCSPR_DECIMALS'" \
  --session-arg "mcr_bps:u32='$MCR_BPS'"

# Patch circular dependency (requires contract entrypoints)
call_contract "$LIQUIDATION_ENGINE_HASH" "set_stability_pool" --session-arg "stability_pool:key='$STABILITY_POOL_PKG_KEY'"
call_contract "$STABILITY_POOL_HASH" "set_liquidation_engine" --session-arg "liquidation_engine:key='$LIQUIDATION_ENGINE_PKG_KEY'"

# Wire liquidation and redemption engines to branches/tokens
if [ -n "${LIQUIDATION_ENGINE_HASH:-}" ] && [ "$LIQUIDATION_ENGINE_HASH" != "null" ]; then
  call_contract "$LIQUIDATION_ENGINE_HASH" "set_branch_cspr" --session-arg "branch:key='$BRANCH_CSPR_PKG_KEY'"
  call_contract "$LIQUIDATION_ENGINE_HASH" "set_branch_scspr" --session-arg "branch:key='$BRANCH_SCSPR_PKG_KEY'"
  call_contract "$LIQUIDATION_ENGINE_HASH" "set_stablecoin" --session-arg "stablecoin:key='$STABLECOIN_PKG_KEY'"
  call_contract "$LIQUIDATION_ENGINE_HASH" "set_scspr_token" --session-arg "scspr_token:key='$SCSPR_TOKEN_PKG_KEY'"
  if [ -n "${YBTOKEN_HASH:-}" ]; then
    call_contract "$LIQUIDATION_ENGINE_HASH" "set_scspr_ybtoken" --session-arg "scspr_ybtoken:key='$YBTOKEN_PKG_KEY'"
  fi
fi

if [ -n "${REDEMPTION_ENGINE_HASH:-}" ] && [ "$REDEMPTION_ENGINE_HASH" != "null" ]; then
  call_contract "$REDEMPTION_ENGINE_HASH" "set_branch_cspr" --session-arg "branch:key='$BRANCH_CSPR_PKG_KEY'"
  call_contract "$REDEMPTION_ENGINE_HASH" "set_branch_scspr" --session-arg "branch:key='$BRANCH_SCSPR_PKG_KEY'"
  call_contract "$REDEMPTION_ENGINE_HASH" "set_scspr_token" --session-arg "scspr_token:key='$SCSPR_TOKEN_PKG_KEY'"
  if [ -n "${YBTOKEN_HASH:-}" ]; then
    call_contract "$REDEMPTION_ENGINE_HASH" "set_scspr_ybtoken" --session-arg "scspr_ybtoken:key='$YBTOKEN_PKG_KEY'"
  fi
fi

# Mark deployment as completed
jq '.status = "deployed"' "$DEPLOY_RECORD" > "$DEPLOY_RECORD.tmp" && mv "$DEPLOY_RECORD.tmp" "$DEPLOY_RECORD"

echo ""
echo "=== Deployment Complete ==="
echo "Deployment record: $DEPLOY_RECORD"
echo ""

if [ "$DEPLOY_LST" = "true" ] && [ -n "$YBTOKEN_HASH" ]; then
  echo "=== LST Configuration Summary ==="
  echo "  stCSPR ybToken: $YBTOKEN_HASH"
  echo "  Withdraw Queue: $WITHDRAW_QUEUE_HASH"
  echo "  Oracle linked to ybToken: ✓"
  echo "  Initial rate (R = 1.0): ✓"
  echo ""
  echo "Rate Sync (run periodically via keeper):"
  echo "  1. Read rate: ybtoken.get_exchange_rate()"
  echo "  2. Sync to oracle: oracle.sync_rate_from_ybtoken(rate)"
  echo ""
fi

echo "Next steps:"
echo "  1. Bind frontend:"
echo "     - (from repo root)  ./scripts/casper/bind-frontend.sh $NETWORK"
echo "     - (from repo root)  ./casper/scripts/bind-frontend.sh $NETWORK"
echo "     - (from casper dir) ./scripts/bind-frontend.sh $NETWORK"
echo "  2. Update CONTRACT.md:"
echo "     - (from repo root)  ./scripts/update-contracts-md.sh $NETWORK"
echo "     - (from casper dir) ../scripts/update-contracts-md.sh $NETWORK"
echo "  3. Run smoke test:"
echo "     - (from repo root)  ./scripts/casper/smoke-test.sh $NETWORK"
echo "     - (from repo root)  ./casper/scripts/smoke-test.sh $NETWORK"
echo "     - (from casper dir) ./scripts/smoke-test.sh $NETWORK"
if [ "$DEPLOY_LST" = "true" ]; then
  echo "  4. Set up rate sync keeper (see docs/casper/ops/runbook-styks-oracle.md)"
fi
