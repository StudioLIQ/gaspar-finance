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

PAYMENT_AMOUNT="${PAYMENT_AMOUNT:-}"
INSTALL_PAYMENT_AMOUNT="${INSTALL_PAYMENT_AMOUNT:-${PAYMENT_AMOUNT:-20000000000}}" # 20 CSPR default
CALL_PAYMENT_AMOUNT="${CALL_PAYMENT_AMOUNT:-${PAYMENT_AMOUNT:-3000000000}}" # 3 CSPR default

# Required network values
: "${CSPR_DECIMALS:?Set CSPR_DECIMALS (confirmed value)}"
: "${SCSPR_DECIMALS:?Set SCSPR_DECIMALS (confirmed value)}"

# LST deployment flag (set to "true" to deploy ybToken and WithdrawQueue)
DEPLOY_LST="${DEPLOY_LST:-true}"
# If true, auto-use the deployed ybToken as the stCSPR token + LST contract.
# This allows fully-local testnet deployments without pre-existing stCSPR contracts.
USE_DEPLOYED_LST_AS_SCSPR="${USE_DEPLOYED_LST_AS_SCSPR:-false}"

if [ "$USE_DEPLOYED_LST_AS_SCSPR" = "true" ] && [ "$DEPLOY_LST" != "true" ]; then
  echo "ERROR: USE_DEPLOYED_LST_AS_SCSPR=true requires DEPLOY_LST=true"
  exit 1
fi

# External dependency contracts (optional if USE_DEPLOYED_LST_AS_SCSPR=true)
if [ "$USE_DEPLOYED_LST_AS_SCSPR" != "true" ]; then
  : "${SCSPR_TOKEN_HASH:?Set SCSPR_TOKEN_HASH (hash-...)}"
  : "${SCSPR_LST_HASH:?Set SCSPR_LST_HASH (hash-...)}"
fi

# Ensure variables are always bound (set -u safe) even when populated later.
SCSPR_TOKEN_HASH="${SCSPR_TOKEN_HASH:-}"
SCSPR_LST_HASH="${SCSPR_LST_HASH:-}"

# Protocol parameters (defaults from code, override if needed)
MCR_BPS="${MCR_BPS:-11000}"
MIN_DEBT="${MIN_DEBT:-2000000000000000000000}"
BORROWING_FEE_BPS="${BORROWING_FEE_BPS:-50}"
REDEMPTION_FEE_BPS="${REDEMPTION_FEE_BPS:-50}"
LIQUIDATION_PENALTY_BPS="${LIQUIDATION_PENALTY_BPS:-1000}"
INTEREST_MIN_BPS="${INTEREST_MIN_BPS:-0}"
INTEREST_MAX_BPS="${INTEREST_MAX_BPS:-4000}"

ACCOUNT_HASH=$(casper-client account-address --public-key "$PUBLIC_KEY")

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
    "scsprAdapter": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
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

wait_for_deploy() {
  local deploy_hash="$1"
  local attempts=0
  local max_attempts=40
  local sleep_secs=5

  while [ $attempts -lt $max_attempts ]; do
    local result
    result=$(casper-client get-deploy --node-address "$NODE_ADDRESS" "$deploy_hash" 2>/dev/null || true)

    local success
    success=$(echo "$result" | jq -r '.result.execution_results[0].result.Success // empty')
    if [ -n "$success" ]; then
      return 0
    fi

    local failure
    failure=$(echo "$result" | jq -r '.result.execution_results[0].result.Failure // empty')
    if [ -n "$failure" ]; then
      echo "ERROR: deploy failed: $deploy_hash"
      echo "$result" | jq '.result.execution_results[0].result.Failure'
      exit 1
    fi

    attempts=$((attempts + 1))
    sleep "$sleep_secs"
  done

  echo "ERROR: deploy not finalized after $max_attempts attempts: $deploy_hash"
  exit 1
}

extract_contract_hash() {
  local deploy_hash="$1"
  local result
  result=$(casper-client get-deploy --node-address "$NODE_ADDRESS" "$deploy_hash")
  echo "$result" | jq -r '.result.execution_results[0].result.Success.effect.transforms[] | select(.transform.WriteContract != null) | .key' | head -n 1
}

extract_package_hash() {
  local deploy_hash="$1"
  local result
  result=$(casper-client get-deploy --node-address "$NODE_ADDRESS" "$deploy_hash")
  echo "$result" | jq -r '.result.execution_results[0].result.Success.effect.transforms[] | select(.transform.WriteContractPackage != null) | .key' | head -n 1
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

  echo ""
  echo "--- Installing $name ---"

  local deploy_hash
  deploy_hash=$(casper-client put-deploy \
    --node-address "$NODE_ADDRESS" \
    --chain-name "$CHAIN_NAME" \
    --secret-key "$SECRET_KEY" \
    --session-path "$WASM_FILE" \
    --session-entry-point "$entrypoint" \
    --payment-amount "$INSTALL_PAYMENT_AMOUNT" \
    "${args[@]}" | jq -r '.result.deploy_hash')

  echo "Deploy hash: $deploy_hash"
  wait_for_deploy "$deploy_hash"

  local contract_hash
  local package_hash
  contract_hash=$(extract_contract_hash "$deploy_hash")
  package_hash=$(extract_package_hash "$deploy_hash")

  if [ -z "$contract_hash" ] || [ "$contract_hash" = "null" ]; then
    echo "ERROR: failed to extract contract hash for $name"
    exit 1
  fi

  update_record "$name" "$deploy_hash" "$contract_hash" "$package_hash"
  echo "✓ $name installed: $contract_hash"

  echo "$contract_hash"
}

call_contract() {
  local contract_hash="$1"
  local entrypoint="$2"
  shift 2
  local args=("$@")

  local deploy_hash
  deploy_hash=$(casper-client put-deploy \
    --node-address "$NODE_ADDRESS" \
    --chain-name "$CHAIN_NAME" \
    --secret-key "$SECRET_KEY" \
    --session-hash "$contract_hash" \
    --session-entry-point "$entrypoint" \
    --payment-amount "$CALL_PAYMENT_AMOUNT" \
    "${args[@]}" | jq -r '.result.deploy_hash')

  echo "Deploy hash: $deploy_hash"
  wait_for_deploy "$deploy_hash"
}

# Entrypoint overrides (if needed)
REGISTRY_INIT_ENTRYPOINT="${REGISTRY_INIT_ENTRYPOINT:-init_simple}"
ROUTER_INIT_ENTRYPOINT="${ROUTER_INIT_ENTRYPOINT:-init}"
ACCESS_CONTROL_INIT_ENTRYPOINT="${ACCESS_CONTROL_INIT_ENTRYPOINT:-init}"
STABLECOIN_INIT_ENTRYPOINT="${STABLECOIN_INIT_ENTRYPOINT:-init}"
TREASURY_INIT_ENTRYPOINT="${TREASURY_INIT_ENTRYPOINT:-init}"
TOKEN_ADAPTER_INIT_ENTRYPOINT="${TOKEN_ADAPTER_INIT_ENTRYPOINT:-init}"
SCSPR_ADAPTER_INIT_ENTRYPOINT="${SCSPR_ADAPTER_INIT_ENTRYPOINT:-init}"
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
REGISTRY_HASH=$(install_contract "registry" "$REGISTRY_INIT_ENTRYPOINT" \
  --session-arg "admin:key='$ACCOUNT_HASH'" \
  --session-arg "mcr_bps:u32=$MCR_BPS" \
  --session-arg "min_debt:u256=$MIN_DEBT" \
  --session-arg "borrowing_fee_bps:u32=$BORROWING_FEE_BPS" \
  --session-arg "redemption_fee_bps:u32=$REDEMPTION_FEE_BPS" \
  --session-arg "liquidation_penalty_bps:u32=$LIQUIDATION_PENALTY_BPS" \
  --session-arg "interest_min_bps:u32=$INTEREST_MIN_BPS" \
  --session-arg "interest_max_bps:u32=$INTEREST_MAX_BPS")

ROUTER_HASH=$(install_contract "router" "$ROUTER_INIT_ENTRYPOINT" \
  --session-arg "registry:key='$REGISTRY_HASH'")

ACCESS_CONTROL_HASH=$(install_contract "accessControl" "$ACCESS_CONTROL_INIT_ENTRYPOINT" \
  --session-arg "initial_admin:key='$ACCOUNT_HASH'")

STABLECOIN_HASH=$(install_contract "stablecoin" "$STABLECOIN_INIT_ENTRYPOINT" \
  --session-arg "registry:key='$REGISTRY_HASH'")

TREASURY_HASH=$(install_contract "treasury" "$TREASURY_INIT_ENTRYPOINT" \
  --session-arg "registry:key='$REGISTRY_HASH'" \
  --session-arg "stablecoin:key='$STABLECOIN_HASH'")

TOKEN_ADAPTER_HASH=$(install_contract "tokenAdapter" "$TOKEN_ADAPTER_INIT_ENTRYPOINT" \
  --session-arg "registry:key='$REGISTRY_HASH'")

# Step 3b: Deploy LST contracts (stCSPR ybToken and WithdrawQueue) early (optional)
YBTOKEN_HASH=""
WITHDRAW_QUEUE_HASH=""

if [ "$DEPLOY_LST" = "true" ]; then
  echo ""
  echo "=== Step 3b: Deploy LST Contracts ==="

  # Operator address for ybToken (defaults to deployer)
  LST_OPERATOR="${LST_OPERATOR:-$ACCOUNT_HASH}"

  YBTOKEN_HASH=$(install_contract "scsprYbToken" "$SCSPR_YBTOKEN_INIT_ENTRYPOINT" \
    --session-arg "admin:key='$ACCOUNT_HASH'" \
    --session-arg "operator:key='$LST_OPERATOR'")

  WITHDRAW_QUEUE_HASH=$(install_contract "withdrawQueue" "$WITHDRAW_QUEUE_INIT_ENTRYPOINT" \
    --session-arg "ybtoken:key='$YBTOKEN_HASH'" \
    --session-arg "admin:key='$ACCOUNT_HASH'")

  # Configure ybToken to know about WithdrawQueue
  echo ""
  echo "--- Configuring ybToken-WithdrawQueue link ---"
  call_contract "$YBTOKEN_HASH" "set_withdraw_queue" \
    --session-arg "queue_address:key='$WITHDRAW_QUEUE_HASH'"
  echo "✓ ybToken.set_withdraw_queue configured"

  if [ "$USE_DEPLOYED_LST_AS_SCSPR" = "true" ]; then
    if [ -z "${SCSPR_TOKEN_HASH:-}" ]; then
      SCSPR_TOKEN_HASH="$YBTOKEN_HASH"
    fi
    if [ -z "${SCSPR_LST_HASH:-}" ]; then
      SCSPR_LST_HASH="$YBTOKEN_HASH"
    fi
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

SCSPR_ADAPTER_HASH=$(install_contract "scsprAdapter" "$SCSPR_ADAPTER_INIT_ENTRYPOINT" \
  --session-arg "token_adapter:key='$TOKEN_ADAPTER_HASH'" \
  --session-arg "scspr_address:key='$SCSPR_TOKEN_HASH'" \
  --session-arg "lst_contract:key='$SCSPR_LST_HASH'")

ORACLE_HASH=$(install_contract "oracleAdapter" "$ORACLE_INIT_ENTRYPOINT" \
  --session-arg "registry:key='$REGISTRY_HASH'" \
  --session-arg "router:key='$ROUTER_HASH'")

BRANCH_CSPR_HASH=$(install_contract "branchCspr" "$BRANCH_CSPR_INIT_ENTRYPOINT" \
  --session-arg "registry:key='$REGISTRY_HASH'" \
  --session-arg "router:key='$ROUTER_HASH'")

BRANCH_SCSPR_HASH=$(install_contract "branchSCSPR" "$BRANCH_SCSPR_INIT_ENTRYPOINT" \
  --session-arg "registry:key='$REGISTRY_HASH'" \
  --session-arg "router:key='$ROUTER_HASH'" \
  --session-arg "scspr_token:key='$SCSPR_TOKEN_HASH'")

# Deploy liquidation engine with placeholder stability pool (router), then patch later
LIQUIDATION_ENGINE_HASH=$(install_contract "liquidationEngine" "$LIQUIDATION_ENGINE_INIT_ENTRYPOINT" \
  --session-arg "registry:key='$REGISTRY_HASH'" \
  --session-arg "router:key='$ROUTER_HASH'" \
  --session-arg "stability_pool:key='$ROUTER_HASH'" \
  --session-arg "oracle:key='$ORACLE_HASH'")

STABILITY_POOL_HASH=$(install_contract "stabilityPool" "$STABILITY_POOL_INIT_ENTRYPOINT" \
  --session-arg "registry:key='$REGISTRY_HASH'" \
  --session-arg "router:key='$ROUTER_HASH'" \
  --session-arg "stablecoin:key='$STABLECOIN_HASH'" \
  --session-arg "liquidation_engine:key='$LIQUIDATION_ENGINE_HASH'")

REDEMPTION_ENGINE_HASH=$(install_contract "redemptionEngine" "$REDEMPTION_ENGINE_INIT_ENTRYPOINT" \
  --session-arg "registry:key='$REGISTRY_HASH'" \
  --session-arg "router:key='$ROUTER_HASH'" \
  --session-arg "stablecoin:key='$STABLECOIN_HASH'" \
  --session-arg "treasury:key='$TREASURY_HASH'" \
  --session-arg "oracle:key='$ORACLE_HASH'")

GOVERNANCE_HASH=$(install_contract "governance" "$GOVERNANCE_INIT_ENTRYPOINT" \
  --session-arg "access_control:key='$ACCESS_CONTROL_HASH'")

# Step 3c: Configure Oracle to use ybToken for exchange rate (if LST deployed)
if [ "$DEPLOY_LST" = "true" ] && [ -n "$YBTOKEN_HASH" ]; then
  echo ""
  echo "--- Configuring Oracle-ybToken link ---"
  call_contract "$ORACLE_HASH" "set_scspr_ybtoken" \
    --session-arg "ybtoken:key='$YBTOKEN_HASH'"
  echo "✓ Oracle.set_scspr_ybtoken configured"

  # Initial rate sync (R = 1.0 = 1e18)
  echo ""
  echo "--- Initial rate sync ---"
  INITIAL_RATE="1000000000000000000"  # 1e18 = 1.0
  call_contract "$ORACLE_HASH" "sync_rate_from_ybtoken" \
    --session-arg "rate:u256=$INITIAL_RATE"
  echo "✓ Initial exchange rate synced (R = 1.0)"
fi

# Step 4: Cross-configure registry and circular dependencies
call_contract "$REGISTRY_HASH" "set_router" --session-arg "router:key='$ROUTER_HASH'"
call_contract "$REGISTRY_HASH" "set_stablecoin" --session-arg "stablecoin:key='$STABLECOIN_HASH'"
call_contract "$REGISTRY_HASH" "set_treasury" --session-arg "treasury:key='$TREASURY_HASH'"
call_contract "$REGISTRY_HASH" "set_oracle" --session-arg "oracle:key='$ORACLE_HASH'"
call_contract "$REGISTRY_HASH" "set_stability_pool" --session-arg "stability_pool:key='$STABILITY_POOL_HASH'"
call_contract "$REGISTRY_HASH" "set_liquidation_engine" --session-arg "liquidation_engine:key='$LIQUIDATION_ENGINE_HASH'"

call_contract "$REGISTRY_HASH" "register_branch_cspr" \
  --session-arg "branch:key='$BRANCH_CSPR_HASH'" \
  --session-arg "decimals:u8=$CSPR_DECIMALS" \
  --session-arg "mcr_bps:u32=$MCR_BPS"

call_contract "$REGISTRY_HASH" "register_branch_scspr" \
  --session-arg "branch:key='$BRANCH_SCSPR_HASH'" \
  --session-arg "token_address:key='$SCSPR_TOKEN_HASH'" \
  --session-arg "decimals:u8=$SCSPR_DECIMALS" \
  --session-arg "mcr_bps:u32=$MCR_BPS"

# Patch circular dependency (requires contract entrypoints)
call_contract "$LIQUIDATION_ENGINE_HASH" "set_stability_pool" --session-arg "stability_pool:key='$STABILITY_POOL_HASH'"
call_contract "$STABILITY_POOL_HASH" "set_liquidation_engine" --session-arg "liquidation_engine:key='$LIQUIDATION_ENGINE_HASH'"

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
