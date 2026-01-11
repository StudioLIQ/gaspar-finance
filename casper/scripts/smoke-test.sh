#!/bin/bash
# CSPR-CDP Smoke Test Script
#
# Runs basic verification tests against a deployed protocol.
# Usage: ./smoke-test.sh [network] [deployment-file]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_DIR="$ROOT_DIR/../deployments/casper"

NETWORK="${1:-testnet}"
DEPLOY_FILE="${2:-}"

echo "=== CSPR-CDP Smoke Test ==="
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

NODE_ADDRESS=$(jq -r '.nodeAddress' "$DEPLOY_FILE")
CHAIN_NAME=$(jq -r '.chainName' "$DEPLOY_FILE")
STATUS=$(jq -r '.status' "$DEPLOY_FILE")

echo "Node: $NODE_ADDRESS"
echo "Chain: $CHAIN_NAME"
echo "Status: $STATUS"
echo ""

if [ "$STATUS" != "deployed" ]; then
    echo "⚠ Deployment status is not 'deployed'. Skipping contract tests."
    echo "Complete deployment first."
    exit 0
fi

echo "=== Running Smoke Tests ==="
echo ""

# Test 1: Check Registry
echo "[Test 1] Registry Contract"
REGISTRY_HASH=$(jq -r '.contracts.registry.hash' "$DEPLOY_FILE")
if [ "$REGISTRY_HASH" = "null" ]; then
    echo "  ✗ Registry not deployed"
else
    echo "  ✓ Registry: $REGISTRY_HASH"
fi

# Test 2: Check Router
echo "[Test 2] Router Contract"
ROUTER_HASH=$(jq -r '.contracts.router.hash' "$DEPLOY_FILE")
if [ "$ROUTER_HASH" = "null" ]; then
    echo "  ✗ Router not deployed"
else
    echo "  ✓ Router: $ROUTER_HASH"
fi

# Test 3: Check Stablecoin
echo "[Test 3] Stablecoin Contract"
STABLECOIN_HASH=$(jq -r '.contracts.stablecoin.hash' "$DEPLOY_FILE")
if [ "$STABLECOIN_HASH" = "null" ]; then
    echo "  ✗ Stablecoin not deployed"
else
    echo "  ✓ Stablecoin: $STABLECOIN_HASH"
fi

# Test 4: Check Oracle Adapter
echo "[Test 4] Oracle Adapter"
ORACLE_HASH=$(jq -r '.contracts.oracleAdapter.hash' "$DEPLOY_FILE")
if [ "$ORACLE_HASH" = "null" ]; then
    echo "  ✗ Oracle Adapter not deployed"
else
    echo "  ✓ Oracle Adapter: $ORACLE_HASH"
fi

# Test 5: Check Branches
echo "[Test 5] Branch Contracts"
BRANCH_CSPR=$(jq -r '.contracts.branchCspr.hash' "$DEPLOY_FILE")
BRANCH_SCSPR=$(jq -r '.contracts.branchSCSPR.hash' "$DEPLOY_FILE")
if [ "$BRANCH_CSPR" = "null" ]; then
    echo "  ✗ Branch CSPR not deployed"
else
    echo "  ✓ Branch CSPR: $BRANCH_CSPR"
fi
if [ "$BRANCH_SCSPR" = "null" ]; then
    echo "  ✗ Branch stCSPR not deployed"
else
    echo "  ✓ Branch stCSPR: $BRANCH_SCSPR"
fi

# Test 6: Check Supporting Contracts
echo "[Test 6] Supporting Contracts"
for contract in treasury stabilityPool liquidationEngine redemptionEngine accessControl governance; do
    HASH=$(jq -r ".contracts.${contract}.hash" "$DEPLOY_FILE")
    if [ "$HASH" = "null" ]; then
        echo "  ✗ $contract not deployed"
    else
        echo "  ✓ $contract: $HASH"
    fi
done

# Test 7: Check LST Contracts (stCSPR ybToken)
echo "[Test 7] LST Contracts"
YBTOKEN_HASH=$(jq -r '.contracts.scsprYbToken.hash // "null"' "$DEPLOY_FILE")
WITHDRAW_QUEUE_HASH=$(jq -r '.contracts.withdrawQueue.hash // "null"' "$DEPLOY_FILE")
if [ "$YBTOKEN_HASH" = "null" ]; then
    echo "  ⚠ stCSPR ybToken not deployed (optional for MVP)"
else
    echo "  ✓ stCSPR ybToken: $YBTOKEN_HASH"
fi
if [ "$WITHDRAW_QUEUE_HASH" = "null" ]; then
    echo "  ⚠ Withdraw Queue not deployed (optional for MVP)"
else
    echo "  ✓ Withdraw Queue: $WITHDRAW_QUEUE_HASH"
fi

# Test 8: Oracle-LST Rate Sync Configuration
echo "[Test 8] Oracle-LST Rate Sync"
if [ "$ORACLE_HASH" != "null" ] && [ "$YBTOKEN_HASH" != "null" ]; then
    echo "  ✓ Oracle Adapter deployed: $ORACLE_HASH"
    echo "  ✓ stCSPR ybToken deployed: $YBTOKEN_HASH"
    echo "  → Rate sync can be configured with:"
    echo "    oracle.set_scspr_ybtoken(ybtoken_address)"
    echo "    oracle.sync_rate_from_ybtoken(ybtoken.get_exchange_rate())"
elif [ "$ORACLE_HASH" != "null" ]; then
    echo "  ✓ Oracle Adapter ready for rate sync"
    echo "  ⚠ stCSPR ybToken not yet deployed"
    echo "  → Deploy ybToken first, then configure with set_scspr_ybtoken()"
else
    echo "  ✗ Oracle Adapter not deployed"
fi

# Test 9: Rate Sync Manual Test (if casper-client available)
echo "[Test 9] Rate Sync Manual Verification"
if command -v casper-client &> /dev/null; then
    echo "  casper-client is available."
    echo "  To verify rate sync manually:"
    echo ""
    echo "  # 1. Get current state root hash"
    echo "  STATE_ROOT=\$(casper-client get-state-root-hash --node-address $NODE_ADDRESS | jq -r '.result.state_root_hash')"
    echo ""
    echo "  # 2. Query Oracle exchange rate (if deployed)"
    if [ "$ORACLE_HASH" != "null" ]; then
        echo "  casper-client query-global-state \\"
        echo "    --node-address $NODE_ADDRESS \\"
        echo "    --state-root-hash \$STATE_ROOT \\"
        echo "    --key $ORACLE_HASH \\"
        echo "    -q 'last_good_exchange_rate'"
    fi
    echo ""
    echo "  # 3. Query ybToken exchange rate (if deployed)"
    if [ "$YBTOKEN_HASH" != "null" ]; then
        echo "  # Call ybToken.get_exchange_rate() or ybToken.cspr_per_scspr()"
        echo "  casper-client query-global-state \\"
        echo "    --node-address $NODE_ADDRESS \\"
        echo "    --state-root-hash \$STATE_ROOT \\"
        echo "    --key $YBTOKEN_HASH"
    fi
else
    echo "  ⚠ casper-client not found. Install for manual verification."
fi

echo ""
echo "=== Smoke Test Complete ==="
echo ""

# Summary
echo "=== Rate Sync Checklist ==="
echo ""
echo "For production rate sync, ensure:"
echo "  1. stCSPR ybToken deployed and initialized"
echo "  2. OracleAdapter.set_scspr_ybtoken(ybtoken_address) called"
echo "  3. Keeper/operator periodically calls:"
echo "     rate = ybToken.get_exchange_rate()"
echo "     oracle.sync_rate_from_ybtoken(rate)"
echo "  4. Max staleness: 1 hour (config.max_price_age_seconds)"
echo ""
echo "For detailed contract state queries, use casper-client:"
echo "  casper-client query-global-state \\"
echo "    --node-address $NODE_ADDRESS \\"
echo "    --state-root-hash <STATE_ROOT> \\"
echo "    --key <CONTRACT_HASH>"
