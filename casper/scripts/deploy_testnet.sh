#!/bin/bash
# =============================================================================
# GasperFinance Testnet Deployment Script (casper-client with --pricing-mode classic)
# =============================================================================
#
# This script deploys 14 contracts using casper-client put-txn session command
# with Casper 2.0 API and --pricing-mode classic.
#
# Prerequisites:
#   - casper-client >= 5.0.0
#   - keys/secret_key.pem
#   - wasm/*.wasm files built
#
# Usage:
#   cd casper && ./scripts/deploy_testnet.sh
#
# Environment Variables (optional):
#   NODE_ADDRESS      - RPC node address (default: https://node.testnet.casper.network)
#   CHAIN_NAME        - Chain name (default: casper-test)
#   PAYMENT_AMOUNT    - Payment amount in motes (default: 200000000000 = 200 CSPR)
#   GAS_PRICE_TOL     - Gas price tolerance (default: 10)
# =============================================================================

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# =============================================================================
# Configuration
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WASM_DIR="$ROOT_DIR/wasm"
KEYS_DIR="${KEYS_DIR:-$ROOT_DIR/../keys}"
SECRET_KEY="${SECRET_KEY:-$KEYS_DIR/secret_key.pem}"

# Network configuration
NODE_ADDRESS="${NODE_ADDRESS:-https://node.testnet.casper.network}"
CHAIN_NAME="${CHAIN_NAME:-casper-test}"

# Transaction configuration
PAYMENT_AMOUNT="${PAYMENT_AMOUNT:-200000000000}"    # 200 CSPR for install
CALL_PAYMENT="${CALL_PAYMENT:-10000000000}"         # 10 CSPR for calls
GAS_PRICE_TOL="${GAS_PRICE_TOL:-10}"
TTL="${TTL:-30min}"

# Protocol parameters
MCR_BPS="${MCR_BPS:-11000}"                          # 110%
MIN_DEBT="${MIN_DEBT:-2000000000000000000000}"       # 2000 gUSD (18 decimals)
BORROWING_FEE_BPS="${BORROWING_FEE_BPS:-50}"         # 0.5%
REDEMPTION_FEE_BPS="${REDEMPTION_FEE_BPS:-50}"       # 0.5%
LIQUIDATION_PENALTY_BPS="${LIQUIDATION_PENALTY_BPS:-1000}"  # 10%
INTEREST_MIN_BPS="${INTEREST_MIN_BPS:-0}"            # 0%
INTEREST_MAX_BPS="${INTEREST_MAX_BPS:-4000}"         # 40%
CSPR_DECIMALS="${CSPR_DECIMALS:-9}"
SCSPR_DECIMALS="${SCSPR_DECIMALS:-9}"

# Deployment state file (compatible with bind-frontend.sh)
DEPLOY_DIR="$ROOT_DIR/../deployments/casper"
mkdir -p "$DEPLOY_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DEPLOY_STATE="$DEPLOY_DIR/testnet-${TIMESTAMP}.json"

# =============================================================================
# Prerequisites Check
# =============================================================================

log_info "Checking prerequisites..."

command -v casper-client >/dev/null 2>&1 || log_error "casper-client not found"
command -v jq >/dev/null 2>&1 || log_error "jq not found"

if [ ! -f "$SECRET_KEY" ]; then
    log_error "Secret key not found: $SECRET_KEY"
fi

# Get deployer account hash
PUBLIC_KEY="${PUBLIC_KEY:-${SECRET_KEY%secret_key.pem}public_key.pem}"
if [ ! -f "$PUBLIC_KEY" ]; then
    log_error "Public key not found: $PUBLIC_KEY"
fi

DEPLOYER=$(casper-client account-address --public-key "$PUBLIC_KEY")
log_info "Deployer: $DEPLOYER"
log_info "Node: $NODE_ADDRESS"
log_info "Chain: $CHAIN_NAME"

# Check WASM files exist
WASM_FILES=(
    "AccessControl.wasm"
    "Registry.wasm"
    "ScsprYbToken.wasm"
    "WithdrawQueue.wasm"
    "Router.wasm"
    "CsprUsd.wasm"
    "TokenAdapter.wasm"
    "OracleAdapter.wasm"
    "BranchCspr.wasm"
    "BranchScspr.wasm"
    "Treasury.wasm"
    "LiquidationEngine.wasm"
    "StabilityPool.wasm"
    "RedemptionEngine.wasm"
)

for wasm in "${WASM_FILES[@]}"; do
    if [ ! -f "$WASM_DIR/$wasm" ]; then
        log_error "WASM not found: $WASM_DIR/$wasm"
    fi
done

log_success "All prerequisites OK"
echo ""

# =============================================================================
# Helper Functions
# =============================================================================

# Initialize deployment state (compatible with bind-frontend.sh format)
init_state() {
    cat > "$DEPLOY_STATE" << EOF
{
  "network": "testnet",
  "chainName": "$CHAIN_NAME",
  "nodeAddress": "$NODE_ADDRESS",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "deployer": "$DEPLOYER",
  "contracts": {
    "registry": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "router": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "stablecoin": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "oracleAdapter": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "stabilityPool": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "liquidationEngine": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "redemptionEngine": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "treasury": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "branchCspr": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "branchSCSPR": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "accessControl": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "tokenAdapter": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "scsprYbToken": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null },
    "withdrawQueue": { "hash": null, "package_hash": null, "deployed": false, "deploy_hash": null }
  },
  "configuration": {
    "mcrBps": $MCR_BPS,
    "minDebt": "$MIN_DEBT",
    "csprDecimals": $CSPR_DECIMALS,
    "scsprDecimals": $SCSPR_DECIMALS
  },
  "status": "pending"
}
EOF
}

# Save contract address to state (bind-frontend.sh compatible format)
save_contract() {
    local name="$1"
    local hash="$2"
    local deploy_hash="${3:-}"

    jq --arg name "$name" \
       --arg hash "$hash" \
       --arg deploy_hash "$deploy_hash" \
       '.contracts[$name].hash = $hash
        | .contracts[$name].deploy_hash = $deploy_hash
        | .contracts[$name].deployed = true' \
       "$DEPLOY_STATE" > "$DEPLOY_STATE.tmp"
    mv "$DEPLOY_STATE.tmp" "$DEPLOY_STATE"
}

# Get contract hash from state
get_contract() {
    local name="$1"
    jq -r --arg name "$name" '.contracts[$name].hash // empty' "$DEPLOY_STATE"
}

# Bind frontend: generate .env.local and config JSON
bind_frontend() {
    local FRONTEND_DIR="$ROOT_DIR/../frontend"
    local CONFIG_DIR="$ROOT_DIR/../config"

    mkdir -p "$CONFIG_DIR"

    # Get RPC URL (add /rpc if needed)
    local FRONTEND_NODE_ADDRESS="$NODE_ADDRESS"
    if [[ "$FRONTEND_NODE_ADDRESS" != */rpc ]]; then
        FRONTEND_NODE_ADDRESS="${FRONTEND_NODE_ADDRESS%/}/rpc"
    fi

    # Read contract hashes from state
    local REGISTRY_H=$(jq -r '.contracts.registry.hash // "null"' "$DEPLOY_STATE")
    local ROUTER_H=$(jq -r '.contracts.router.hash // "null"' "$DEPLOY_STATE")
    local STABLECOIN_H=$(jq -r '.contracts.stablecoin.hash // "null"' "$DEPLOY_STATE")
    local ORACLE_H=$(jq -r '.contracts.oracleAdapter.hash // "null"' "$DEPLOY_STATE")
    local SP_H=$(jq -r '.contracts.stabilityPool.hash // "null"' "$DEPLOY_STATE")
    local LE_H=$(jq -r '.contracts.liquidationEngine.hash // "null"' "$DEPLOY_STATE")
    local RE_H=$(jq -r '.contracts.redemptionEngine.hash // "null"' "$DEPLOY_STATE")
    local TREASURY_H=$(jq -r '.contracts.treasury.hash // "null"' "$DEPLOY_STATE")
    local BC_H=$(jq -r '.contracts.branchCspr.hash // "null"' "$DEPLOY_STATE")
    local BS_H=$(jq -r '.contracts.branchSCSPR.hash // "null"' "$DEPLOY_STATE")
    local YB_H=$(jq -r '.contracts.scsprYbToken.hash // "null"' "$DEPLOY_STATE")
    local WQ_H=$(jq -r '.contracts.withdrawQueue.hash // "null"' "$DEPLOY_STATE")

    # 1. Create config JSON
    cat > "$CONFIG_DIR/casper-testnet.json" << EOF
{
  "network": "testnet",
  "chainName": "$CHAIN_NAME",
  "nodeAddress": "$FRONTEND_NODE_ADDRESS",
  "contracts": {
    "registry": "$REGISTRY_H",
    "router": "$ROUTER_H",
    "stablecoin": "$STABLECOIN_H",
    "oracleAdapter": "$ORACLE_H",
    "stabilityPool": "$SP_H",
    "liquidationEngine": "$LE_H",
    "redemptionEngine": "$RE_H",
    "treasury": "$TREASURY_H",
    "branchCspr": "$BC_H",
    "branchSCSPR": "$BS_H",
    "scsprYbToken": "$YB_H",
    "withdrawQueue": "$WQ_H"
  },
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
    log_success "Created: $CONFIG_DIR/casper-testnet.json"

    # 2. Create .env.local
    cat > "$FRONTEND_DIR/.env.local" << EOF
# GasperFinance Frontend Configuration
# Auto-generated by deploy_testnet.sh at $(date -u +%Y-%m-%dT%H:%M:%SZ)

# Network Configuration
NEXT_PUBLIC_CASPER_NETWORK=testnet
NEXT_PUBLIC_CASPER_NODE_ADDRESS=$FRONTEND_NODE_ADDRESS
NEXT_PUBLIC_CASPER_CHAIN_NAME=$CHAIN_NAME

# Contract Addresses
NEXT_PUBLIC_REGISTRY_HASH=$REGISTRY_H
NEXT_PUBLIC_ROUTER_HASH=$ROUTER_H
NEXT_PUBLIC_STABLECOIN_HASH=$STABLECOIN_H
NEXT_PUBLIC_ORACLE_ADAPTER_HASH=$ORACLE_H
NEXT_PUBLIC_STABILITY_POOL_HASH=$SP_H
NEXT_PUBLIC_LIQUIDATION_ENGINE_HASH=$LE_H
NEXT_PUBLIC_REDEMPTION_ENGINE_HASH=$RE_H
NEXT_PUBLIC_TREASURY_HASH=$TREASURY_H
NEXT_PUBLIC_BRANCH_CSPR_HASH=$BC_H
NEXT_PUBLIC_BRANCH_SCSPR_HASH=$BS_H
NEXT_PUBLIC_SCSPR_YBTOKEN_HASH=$YB_H
NEXT_PUBLIC_WITHDRAW_QUEUE_HASH=$WQ_H
EOF
    log_success "Created: $FRONTEND_DIR/.env.local"

    # 3. Copy to .env.local.example as backup
    cp "$FRONTEND_DIR/.env.local" "$FRONTEND_DIR/.env.local.example"
    log_success "Created: $FRONTEND_DIR/.env.local.example"
}

# Wait for transaction to be processed
wait_for_txn() {
    local deploy_hash="$1"
    local max_attempts="${2:-60}"
    local sleep_secs=5
    local attempts=0

    log_info "Waiting for txn: $deploy_hash"

    while [ $attempts -lt $max_attempts ]; do
        local result
        result=$(casper-client get-deploy \
            --node-address "$NODE_ADDRESS" \
            "$deploy_hash" 2>/dev/null || echo "{}")

        # Check for success
        local success
        success=$(echo "$result" | jq -r '.result.execution_results[0].result.Success // empty')
        if [ -n "$success" ]; then
            log_success "Transaction successful"
            return 0
        fi

        # Check for failure
        local failure
        failure=$(echo "$result" | jq -r '.result.execution_results[0].result.Failure // empty')
        if [ -n "$failure" ]; then
            log_error "Transaction failed: $(echo "$result" | jq -r '.result.execution_results[0].result.Failure.error_message // "unknown"')"
        fi

        attempts=$((attempts + 1))
        sleep "$sleep_secs"
    done

    log_error "Transaction not finalized after $max_attempts attempts"
}

# Extract entity/contract hash from deploy result
extract_contract_hash() {
    local deploy_hash="$1"
    local result
    result=$(casper-client get-deploy --node-address "$NODE_ADDRESS" "$deploy_hash")

    # Try to get AddressableEntity (Casper 2.0)
    local entity_hash
    entity_hash=$(echo "$result" | jq -r '
        .result.execution_results[0].result.Success.effects[]
        | select(.kind == "Write" and .key | startswith("addressable-entity-"))
        | .key' 2>/dev/null | head -n 1)

    if [ -n "$entity_hash" ] && [ "$entity_hash" != "null" ]; then
        echo "$entity_hash"
        return
    fi

    # Fallback: Try legacy contract hash
    local contract_hash
    contract_hash=$(echo "$result" | jq -r '
        .result.execution_results[0].result.Success.effect.transforms[]
        | select(.transform.WriteContract != null)
        | .key' 2>/dev/null | head -n 1)

    if [ -n "$contract_hash" ] && [ "$contract_hash" != "null" ]; then
        echo "$contract_hash"
        return
    fi

    # Try entity-contract format
    contract_hash=$(echo "$result" | jq -r '
        .result.execution_results[0].result.Success.effects[]
        | select(.kind == "Write" and (.key | startswith("entity-contract-") or startswith("hash-")))
        | .key' 2>/dev/null | head -n 1)

    echo "$contract_hash"
}

# Deploy a contract
deploy_contract() {
    local name="$1"
    local wasm="$2"
    shift 2
    local args=("$@")

    echo ""
    log_info "=========================================="
    log_info "Deploying: $name"
    log_info "WASM: $wasm"
    log_info "=========================================="

    local cmd=(
        casper-client put-txn session
        --node-address "$NODE_ADDRESS"
        --chain-name "$CHAIN_NAME"
        --secret-key "$SECRET_KEY"
        --wasm-path "$WASM_DIR/$wasm"
        --session-entry-point "call"
        --pricing-mode classic
        --gas-price-tolerance "$GAS_PRICE_TOL"
        --payment-amount "$PAYMENT_AMOUNT"
        --standard-payment true
        --install-upgrade
        --ttl "$TTL"
    )

    # Add session args
    for arg in "${args[@]}"; do
        cmd+=(--session-arg "$arg")
    done

    log_info "Command: ${cmd[*]}"

    local output
    output=$("${cmd[@]}" 2>&1)

    local deploy_hash
    deploy_hash=$(echo "$output" | jq -r '.result.transaction_hash // .result.deploy_hash // empty')

    if [ -z "$deploy_hash" ]; then
        log_error "Failed to get deploy hash. Output: $output"
    fi

    log_info "Deploy hash: $deploy_hash"
    wait_for_txn "$deploy_hash"

    local contract_hash
    contract_hash=$(extract_contract_hash "$deploy_hash")

    if [ -z "$contract_hash" ] || [ "$contract_hash" = "null" ]; then
        log_warn "Could not extract contract hash automatically"
        log_warn "Please check the deploy manually: casper-client get-deploy --node-address $NODE_ADDRESS $deploy_hash"
        # For debugging, print the full result
        casper-client get-deploy --node-address "$NODE_ADDRESS" "$deploy_hash" | jq '.result.execution_results[0].result.Success.effects' 2>/dev/null || true
        read -p "Enter contract hash manually (or press Enter to abort): " contract_hash
        if [ -z "$contract_hash" ]; then
            log_error "Aborting deployment"
        fi
    fi

    save_contract "$name" "$contract_hash" "$deploy_hash"
    log_success "$name deployed: $contract_hash"

    echo "$contract_hash"
}

# Call a contract entrypoint
call_contract() {
    local contract_hash="$1"
    local entrypoint="$2"
    shift 2
    local args=("$@")

    log_info "Calling $entrypoint on $contract_hash"

    local cmd=(
        casper-client put-txn invocable-entity
        --node-address "$NODE_ADDRESS"
        --chain-name "$CHAIN_NAME"
        --secret-key "$SECRET_KEY"
        --contract-hash "$contract_hash"
        --session-entry-point "$entrypoint"
        --pricing-mode classic
        --gas-price-tolerance "$GAS_PRICE_TOL"
        --payment-amount "$CALL_PAYMENT"
        --standard-payment true
        --ttl "$TTL"
    )

    # Handle entity address format if needed
    if [[ "$contract_hash" == addressable-entity-* ]] || [[ "$contract_hash" == entity-contract-* ]]; then
        cmd=(
            casper-client put-txn invocable-entity
            --node-address "$NODE_ADDRESS"
            --chain-name "$CHAIN_NAME"
            --secret-key "$SECRET_KEY"
            --entity-address "$contract_hash"
            --session-entry-point "$entrypoint"
            --pricing-mode classic
            --gas-price-tolerance "$GAS_PRICE_TOL"
            --payment-amount "$CALL_PAYMENT"
            --standard-payment true
            --ttl "$TTL"
        )
    fi

    for arg in "${args[@]}"; do
        cmd+=(--session-arg "$arg")
    done

    local output
    output=$("${cmd[@]}" 2>&1)

    local deploy_hash
    deploy_hash=$(echo "$output" | jq -r '.result.transaction_hash // .result.deploy_hash // empty')

    if [ -z "$deploy_hash" ]; then
        log_error "Failed to get deploy hash. Output: $output"
    fi

    log_info "Deploy hash: $deploy_hash"
    wait_for_txn "$deploy_hash"
    log_success "Call successful: $entrypoint"
}

# =============================================================================
# Main Deployment
# =============================================================================

main() {
    echo ""
    echo "============================================================"
    echo "  GasperFinance Testnet Deployment"
    echo "  Using casper-client with --pricing-mode classic"
    echo "============================================================"
    echo ""

    init_state

    # =========================================================================
    # Phase 1: Independent Contracts
    # =========================================================================
    echo ""
    log_info "=== Phase 1: Independent Contracts ==="

    # 1. AccessControl
    ACCESS_CONTROL_HASH=$(deploy_contract "AccessControl" "AccessControl.wasm" \
        "initial_admin:key='${DEPLOYER}'")

    # 2. Registry
    REGISTRY_HASH=$(deploy_contract "Registry" "Registry.wasm" \
        "admin:key='$DEPLOYER'" \
        "mcr_bps:u32='$MCR_BPS'" \
        "min_debt:u256='$MIN_DEBT'" \
        "borrowing_fee_bps:u32='$BORROWING_FEE_BPS'" \
        "redemption_fee_bps:u32='$REDEMPTION_FEE_BPS'" \
        "liquidation_penalty_bps:u32='$LIQUIDATION_PENALTY_BPS'" \
        "interest_min_bps:u32='$INTEREST_MIN_BPS'" \
        "interest_max_bps:u32='$INTEREST_MAX_BPS'")

    # 3. ScsprYbToken
    SCSPR_YBTOKEN_HASH=$(deploy_contract "ScsprYbToken" "ScsprYbToken.wasm" \
        "admin:key='$DEPLOYER'" \
        "operator:key='$DEPLOYER'")

    # =========================================================================
    # Phase 2: Registry-dependent Contracts
    # =========================================================================
    echo ""
    log_info "=== Phase 2: Registry-dependent Contracts ==="

    # 4. WithdrawQueue
    WITHDRAW_QUEUE_HASH=$(deploy_contract "WithdrawQueue" "WithdrawQueue.wasm" \
        "ybtoken:key='$SCSPR_YBTOKEN_HASH'" \
        "admin:key='$DEPLOYER'")

    # 5. Router
    ROUTER_HASH=$(deploy_contract "Router" "Router.wasm" \
        "registry:key='$REGISTRY_HASH'")

    # 6. CsprUsd (Stablecoin)
    STABLECOIN_HASH=$(deploy_contract "CsprUsd" "CsprUsd.wasm" \
        "registry:key='$REGISTRY_HASH'")

    # 7. TokenAdapter
    TOKEN_ADAPTER_HASH=$(deploy_contract "TokenAdapter" "TokenAdapter.wasm" \
        "registry:key='$REGISTRY_HASH'")

    # 8. OracleAdapter
    ORACLE_HASH=$(deploy_contract "OracleAdapter" "OracleAdapter.wasm" \
        "registry:key='$REGISTRY_HASH'" \
        "router:key='$ROUTER_HASH'")

    # =========================================================================
    # Phase 3: Branch Contracts
    # =========================================================================
    echo ""
    log_info "=== Phase 3: Branch Contracts ==="

    # 9. BranchCspr
    BRANCH_CSPR_HASH=$(deploy_contract "BranchCspr" "BranchCspr.wasm" \
        "registry:key='$REGISTRY_HASH'" \
        "router:key='$ROUTER_HASH'")

    # 10. BranchSCSPR
    BRANCH_SCSPR_HASH=$(deploy_contract "BranchSCSPR" "BranchScspr.wasm" \
        "registry:key='$REGISTRY_HASH'" \
        "router:key='$ROUTER_HASH'" \
        "scspr_token:key='$SCSPR_YBTOKEN_HASH'")

    # 11. Treasury
    TREASURY_HASH=$(deploy_contract "Treasury" "Treasury.wasm" \
        "registry:key='$REGISTRY_HASH'" \
        "stablecoin:key='$STABLECOIN_HASH'")

    # =========================================================================
    # Phase 4: Engines (with circular dependency)
    # =========================================================================
    echo ""
    log_info "=== Phase 4: Engines ==="

    # 12. LiquidationEngine (with Router as placeholder for stability_pool)
    LIQUIDATION_ENGINE_HASH=$(deploy_contract "LiquidationEngine" "LiquidationEngine.wasm" \
        "registry:key='$REGISTRY_HASH'" \
        "router:key='$ROUTER_HASH'" \
        "stability_pool:key='$ROUTER_HASH'" \
        "oracle:key='$ORACLE_HASH'")

    # 13. StabilityPool
    STABILITY_POOL_HASH=$(deploy_contract "StabilityPool" "StabilityPool.wasm" \
        "registry:key='$REGISTRY_HASH'" \
        "router:key='$ROUTER_HASH'" \
        "stablecoin:key='$STABLECOIN_HASH'" \
        "liquidation_engine:key='$LIQUIDATION_ENGINE_HASH'")

    # 14. RedemptionEngine
    REDEMPTION_ENGINE_HASH=$(deploy_contract "RedemptionEngine" "RedemptionEngine.wasm" \
        "registry:key='$REGISTRY_HASH'" \
        "router:key='$ROUTER_HASH'" \
        "stablecoin:key='$STABLECOIN_HASH'" \
        "treasury:key='$TREASURY_HASH'" \
        "oracle:key='$ORACLE_HASH'")

    # =========================================================================
    # Phase 5: Cross-contract Configuration
    # =========================================================================
    echo ""
    log_info "=== Phase 5: Cross-contract Configuration ==="

    # Fix circular dependency
    log_info "Configuring LiquidationEngine -> StabilityPool"
    call_contract "$LIQUIDATION_ENGINE_HASH" "set_stability_pool" \
        "stability_pool:key='$STABILITY_POOL_HASH'"

    log_info "Configuring StabilityPool -> LiquidationEngine"
    call_contract "$STABILITY_POOL_HASH" "set_liquidation_engine" \
        "liquidation_engine:key='$LIQUIDATION_ENGINE_HASH'"

    # Configure Registry
    log_info "Configuring Registry..."

    call_contract "$REGISTRY_HASH" "set_router" \
        "router:key='$ROUTER_HASH'"

    call_contract "$REGISTRY_HASH" "set_stablecoin" \
        "stablecoin:key='$STABLECOIN_HASH'"

    call_contract "$REGISTRY_HASH" "set_treasury" \
        "treasury:key='$TREASURY_HASH'"

    call_contract "$REGISTRY_HASH" "set_oracle" \
        "oracle:key='$ORACLE_HASH'"

    call_contract "$REGISTRY_HASH" "set_stability_pool" \
        "stability_pool:key='$STABILITY_POOL_HASH'"

    call_contract "$REGISTRY_HASH" "set_liquidation_engine" \
        "liquidation_engine:key='$LIQUIDATION_ENGINE_HASH'"

    # Register branches
    log_info "Registering branches..."

    call_contract "$REGISTRY_HASH" "register_branch_cspr" \
        "branch:key='$BRANCH_CSPR_HASH'" \
        "decimals:u8='$CSPR_DECIMALS'" \
        "mcr_bps:u32='$MCR_BPS'"

    call_contract "$REGISTRY_HASH" "register_branch_scspr" \
        "branch:key='$BRANCH_SCSPR_HASH'" \
        "token_address:key='$SCSPR_YBTOKEN_HASH'" \
        "decimals:u8='$SCSPR_DECIMALS'" \
        "mcr_bps:u32='$MCR_BPS'"

    # Configure ScsprYbToken
    log_info "Configuring ScsprYbToken -> WithdrawQueue"
    call_contract "$SCSPR_YBTOKEN_HASH" "set_withdraw_queue" \
        "queue_address:key='$WITHDRAW_QUEUE_HASH'"

    # Configure OracleAdapter
    log_info "Configuring OracleAdapter -> YbToken"
    call_contract "$ORACLE_HASH" "set_scspr_ybtoken" \
        "ybtoken:key='$SCSPR_YBTOKEN_HASH'"

    # =========================================================================
    # Finalize
    # =========================================================================

    # Mark deployment as complete
    jq '.status = "deployed"' "$DEPLOY_STATE" > "$DEPLOY_STATE.tmp"
    mv "$DEPLOY_STATE.tmp" "$DEPLOY_STATE"

    echo ""
    echo "============================================================"
    echo "  Contract Deployment Complete!"
    echo "============================================================"
    echo ""
    echo "Contract Addresses:"
    echo "  AccessControl:      $ACCESS_CONTROL_HASH"
    echo "  Registry:           $REGISTRY_HASH"
    echo "  Router:             $ROUTER_HASH"
    echo "  CsprUsd:            $STABLECOIN_HASH"
    echo "  Treasury:           $TREASURY_HASH"
    echo "  OracleAdapter:      $ORACLE_HASH"
    echo "  BranchCspr:         $BRANCH_CSPR_HASH"
    echo "  BranchSCSPR:        $BRANCH_SCSPR_HASH"
    echo "  LiquidationEngine:  $LIQUIDATION_ENGINE_HASH"
    echo "  StabilityPool:      $STABILITY_POOL_HASH"
    echo "  RedemptionEngine:   $REDEMPTION_ENGINE_HASH"
    echo "  TokenAdapter:       $TOKEN_ADAPTER_HASH"
    echo "  ScsprYbToken:       $SCSPR_YBTOKEN_HASH"
    echo "  WithdrawQueue:      $WITHDRAW_QUEUE_HASH"
    echo ""
    echo "Deployment state: $DEPLOY_STATE"

    # =========================================================================
    # Phase 6: Frontend Binding
    # =========================================================================
    echo ""
    log_info "=== Phase 6: Frontend Binding ==="

    bind_frontend

    echo ""
    echo "============================================================"
    echo "  All Done!"
    echo "============================================================"
    echo ""
    echo "Frontend is ready. To start:"
    echo "  cd frontend && npm run dev"
    echo ""
    echo "Smoke test:"
    echo "  cd casper && ./scripts/smoke-test.sh testnet"
    echo ""
}

# Run main function
main "$@"
