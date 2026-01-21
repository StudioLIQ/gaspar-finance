#!/bin/bash
# CSPR-CDP Frontend Binding Script
#
# Updates frontend configuration with deployed contract addresses.
# Usage: ./bind-frontend.sh [network] [deployment-file]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/../frontend"
DEPLOY_DIR="$ROOT_DIR/../deployments/casper"
CONFIG_DIR="$ROOT_DIR/../config"
PUBLIC_CONFIG_DIR="$FRONTEND_DIR/public/config"

NETWORK="${1:-testnet}"
DEPLOY_FILE="${2:-}"

echo "=== CSPR-CDP Frontend Binding ==="
echo "Network: $NETWORK"
echo ""

# Find latest deployment file if not specified
if [ -z "$DEPLOY_FILE" ]; then
    DEPLOY_FILE=$(ls -t "$DEPLOY_DIR/${NETWORK}-"*.json 2>/dev/null | head -n1)
    if [ -z "$DEPLOY_FILE" ]; then
        echo "ERROR: No deployment file found for network: $NETWORK"
        echo "Run deploy.sh first or specify deployment file."
        exit 1
    fi
fi

echo "Deployment file: $DEPLOY_FILE"
echo ""

# Parse deployment file
if ! command -v jq &> /dev/null; then
    echo "ERROR: jq is required. Install with: brew install jq"
    exit 1
fi

if ! command -v curl &> /dev/null; then
    echo "ERROR: curl is required. Install curl or ensure it's on PATH."
    exit 1
fi

NODE_ADDRESS=$(jq -r '.nodeAddress' "$DEPLOY_FILE")
CHAIN_NAME=$(jq -r '.chainName' "$DEPLOY_FILE")

# Frontend expects the JSON-RPC endpoint (typically ends with /rpc).
FRONTEND_NODE_ADDRESS="$NODE_ADDRESS"
if [[ "$FRONTEND_NODE_ADDRESS" != */rpc ]]; then
    FRONTEND_NODE_ADDRESS="${FRONTEND_NODE_ADDRESS%/}/rpc"
fi

resolve_package_hash() {
    local contract_hash="$1"
    local current_pkg_hash="$2"
    local label="$3"

    if [[ -n "$current_pkg_hash" && "$current_pkg_hash" != "null" ]]; then
        echo "$current_pkg_hash"
        return 0
    fi

    if [[ -z "$contract_hash" || "$contract_hash" == "null" ]]; then
        echo "null"
        return 0
    fi

    echo "ℹ Resolving ${label} package hash from chain..." 1>&2

    # query_global_state supports both Casper 1.x (Contract) and Casper 2.0 (AddressableEntity) formats.
    # We keep failures non-fatal and fall back to "null".
    local body
    body=$(jq -n --arg key "$contract_hash" '{jsonrpc:"2.0",id:1,method:"query_global_state",params:{key:$key,state_identifier:null,path:[]}}')
    local pkg
    pkg=$(
        curl -s -X POST -H 'Content-Type: application/json' --data "$body" "$FRONTEND_NODE_ADDRESS" \
        | jq -r '.result.stored_value.Contract.contract_package_hash // .result.stored_value.AddressableEntity.package_hash // empty' \
        || true
    )

    if [[ -z "$pkg" || "$pkg" == "null" ]]; then
        echo "null"
        return 0
    fi

    echo "$pkg"
    return 0
}

# Extract contract hashes
REGISTRY_HASH=$(jq -r '.contracts.registry.hash // "null"' "$DEPLOY_FILE")
ROUTER_HASH=$(jq -r '.contracts.router.hash // "null"' "$DEPLOY_FILE")
ROUTER_PKG_HASH=$(jq -r '.contracts.router.package_hash // "null"' "$DEPLOY_FILE")
STABLECOIN_HASH=$(jq -r '.contracts.stablecoin.hash // "null"' "$DEPLOY_FILE")
ORACLE_HASH=$(jq -r '.contracts.oracleAdapter.hash // "null"' "$DEPLOY_FILE")
STABILITY_POOL_HASH=$(jq -r '.contracts.stabilityPool.hash // "null"' "$DEPLOY_FILE")
STABILITY_POOL_PKG_HASH=$(jq -r '.contracts.stabilityPool.package_hash // "null"' "$DEPLOY_FILE")
LIQUIDATION_ENGINE_HASH=$(jq -r '.contracts.liquidationEngine.hash // "null"' "$DEPLOY_FILE")
REDEMPTION_ENGINE_HASH=$(jq -r '.contracts.redemptionEngine.hash // "null"' "$DEPLOY_FILE")
TREASURY_HASH=$(jq -r '.contracts.treasury.hash // "null"' "$DEPLOY_FILE")
BRANCH_CSPR_HASH=$(jq -r '.contracts.branchCspr.hash // "null"' "$DEPLOY_FILE")
BRANCH_SCSPR_HASH=$(jq -r '.contracts.branchSCSPR.hash // "null"' "$DEPLOY_FILE")
SCSPR_YBTOKEN_HASH=$(jq -r '.contracts.scsprYbToken.hash // "null"' "$DEPLOY_FILE")
SCSPR_YBTOKEN_PKG_HASH=$(jq -r '.contracts.scsprYbToken.package_hash // "null"' "$DEPLOY_FILE")
WITHDRAW_QUEUE_HASH=$(jq -r '.contracts.withdrawQueue.hash // "null"' "$DEPLOY_FILE")

# Some deployment records may omit package hashes. Resolve them from chain so the frontend can
# perform payable calls via proxy_caller.wasm (router/ybToken) and other package-based calls.
ROUTER_PKG_HASH=$(resolve_package_hash "$ROUTER_HASH" "$ROUTER_PKG_HASH" "Router")
STABILITY_POOL_PKG_HASH=$(resolve_package_hash "$STABILITY_POOL_HASH" "$STABILITY_POOL_PKG_HASH" "StabilityPool")
SCSPR_YBTOKEN_PKG_HASH=$(resolve_package_hash "$SCSPR_YBTOKEN_HASH" "$SCSPR_YBTOKEN_PKG_HASH" "ScsprYbToken")

# Create frontend config
mkdir -p "$CONFIG_DIR"
mkdir -p "$PUBLIC_CONFIG_DIR"

cat > "$CONFIG_DIR/casper-${NETWORK}.json" << EOF
{
  "network": "$NETWORK",
  "chainName": "$CHAIN_NAME",
  "nodeAddress": "$FRONTEND_NODE_ADDRESS",
  "contracts": {
    "registry": "$REGISTRY_HASH",
    "router": "$ROUTER_HASH",
    "routerPackage": "$ROUTER_PKG_HASH",
    "stablecoin": "$STABLECOIN_HASH",
    "oracleAdapter": "$ORACLE_HASH",
    "stabilityPool": "$STABILITY_POOL_HASH",
    "stabilityPoolPackage": "$STABILITY_POOL_PKG_HASH",
    "liquidationEngine": "$LIQUIDATION_ENGINE_HASH",
    "redemptionEngine": "$REDEMPTION_ENGINE_HASH",
    "treasury": "$TREASURY_HASH",
    "branchCspr": "$BRANCH_CSPR_HASH",
    "branchSCSPR": "$BRANCH_SCSPR_HASH",
    "scsprYbToken": "$SCSPR_YBTOKEN_HASH",
    "scsprYbTokenPackage": "$SCSPR_YBTOKEN_PKG_HASH",
    "withdrawQueue": "$WITHDRAW_QUEUE_HASH"
  },
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo "✓ Created config: $CONFIG_DIR/casper-${NETWORK}.json"

# Mirror config into frontend/public for Vercel (no env vars required)
cp "$CONFIG_DIR/casper-${NETWORK}.json" "$PUBLIC_CONFIG_DIR/casper-${NETWORK}.json"
echo "✓ Updated public config: $PUBLIC_CONFIG_DIR/casper-${NETWORK}.json"

# Update frontend .env.local
ENV_FILE="$FRONTEND_DIR/.env.local"
ENV_EXAMPLE="$FRONTEND_DIR/.env.local.example"

# Create example env file
cat > "$ENV_EXAMPLE" << EOF
# CSPR-CDP Frontend Configuration
# Auto-generated by bind-frontend.sh

# Network Configuration
NEXT_PUBLIC_CASPER_NETWORK=$NETWORK
NEXT_PUBLIC_CASPER_NODE_ADDRESS=$FRONTEND_NODE_ADDRESS
NEXT_PUBLIC_CASPER_CHAIN_NAME=$CHAIN_NAME

# Contract Addresses
NEXT_PUBLIC_REGISTRY_HASH=$REGISTRY_HASH
NEXT_PUBLIC_ROUTER_HASH=$ROUTER_HASH
NEXT_PUBLIC_ROUTER_PACKAGE_HASH=$ROUTER_PKG_HASH
NEXT_PUBLIC_STABLECOIN_HASH=$STABLECOIN_HASH
NEXT_PUBLIC_ORACLE_ADAPTER_HASH=$ORACLE_HASH
NEXT_PUBLIC_STABILITY_POOL_HASH=$STABILITY_POOL_HASH
NEXT_PUBLIC_STABILITY_POOL_PACKAGE_HASH=$STABILITY_POOL_PKG_HASH
NEXT_PUBLIC_LIQUIDATION_ENGINE_HASH=$LIQUIDATION_ENGINE_HASH
NEXT_PUBLIC_REDEMPTION_ENGINE_HASH=$REDEMPTION_ENGINE_HASH
NEXT_PUBLIC_TREASURY_HASH=$TREASURY_HASH
NEXT_PUBLIC_BRANCH_CSPR_HASH=$BRANCH_CSPR_HASH
NEXT_PUBLIC_BRANCH_SCSPR_HASH=$BRANCH_SCSPR_HASH
NEXT_PUBLIC_SCSPR_YBTOKEN_HASH=$SCSPR_YBTOKEN_HASH
NEXT_PUBLIC_SCSPR_YBTOKEN_PACKAGE_HASH=$SCSPR_YBTOKEN_PKG_HASH
NEXT_PUBLIC_WITHDRAW_QUEUE_HASH=$WITHDRAW_QUEUE_HASH

# Wallet Configuration
# Uncomment and set your preferred wallet
# NEXT_PUBLIC_DEFAULT_WALLET=casper-wallet

# API Configuration (optional)
# NEXT_PUBLIC_API_BASE_URL=https://api.cspr-cdp.io

EOF

echo "✓ Created env example: $ENV_EXAMPLE"

# Check if we should update .env.local
if [ -f "$ENV_FILE" ]; then
    echo ""
    echo "⚠ .env.local already exists at $ENV_FILE"
    echo "  Review $ENV_EXAMPLE and update manually if needed."
else
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    echo "✓ Created .env.local: $ENV_FILE"
fi

echo ""
echo "=== Frontend Binding Complete ==="
echo ""
echo "Files updated:"
echo "  - $CONFIG_DIR/casper-${NETWORK}.json"
echo "  - $PUBLIC_CONFIG_DIR/casper-${NETWORK}.json"
echo "  - $ENV_EXAMPLE"
echo ""
echo "Next steps:"
echo "  1. Review frontend .env.local"
echo "  2. Start frontend: cd frontend && npm run dev"
echo "  3. Connect wallet and test"
