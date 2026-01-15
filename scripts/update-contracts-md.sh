#!/bin/bash
# Update CONTRACT.md from the latest deployment record.
# Usage: ./scripts/update-contracts-md.sh [testnet|mainnet] [deployment-file]

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$ROOT_DIR/deployments/casper"
CONTRACT_MD="$ROOT_DIR/CONTRACT.md"

NETWORK="${1:-testnet}"
DEPLOY_FILE="${2:-}"

if ! command -v jq &> /dev/null; then
  echo "ERROR: jq is required. Install with: brew install jq"
  exit 1
fi

if [ -z "$DEPLOY_FILE" ]; then
  DEPLOY_FILE=$(ls -t "$DEPLOY_DIR/${NETWORK}-"*.json 2>/dev/null | head -n1 || true)
fi

if [ -z "$DEPLOY_FILE" ] || [ ! -f "$DEPLOY_FILE" ]; then
  echo "ERROR: deployment record not found for network: $NETWORK"
  exit 1
fi

if [ ! -f "$CONTRACT_MD" ]; then
  echo "ERROR: CONTRACT.md not found at $CONTRACT_MD"
  exit 1
fi

NETWORK_TITLE="Testnet"
NETWORK_NAME="casper-test"
NODE_URL="https://rpc.testnet.casperlabs.io"
if [ "$NETWORK" = "mainnet" ]; then
  NETWORK_TITLE="Mainnet"
  NETWORK_NAME="casper"
  NODE_URL="https://rpc.mainnet.casperlabs.io"
fi

get_hash() {
  jq -r "$1 // \"TBD\"" "$DEPLOY_FILE"
}

REGISTRY_HASH=$(get_hash '.contracts.registry.hash')
ROUTER_HASH=$(get_hash '.contracts.router.hash')
BRANCH_CSPR_HASH=$(get_hash '.contracts.branchCspr.hash')
BRANCH_SCSPR_HASH=$(get_hash '.contracts.branchSCSPR.hash')
STABLECOIN_HASH=$(get_hash '.contracts.stablecoin.hash')
TREASURY_HASH=$(get_hash '.contracts.treasury.hash')
ORACLE_HASH=$(get_hash '.contracts.oracleAdapter.hash')
STABILITY_POOL_HASH=$(get_hash '.contracts.stabilityPool.hash')
LIQUIDATION_HASH=$(get_hash '.contracts.liquidationEngine.hash')
REDEMPTION_HASH=$(get_hash '.contracts.redemptionEngine.hash')
TOKEN_ADAPTER_HASH=$(get_hash '.contracts.tokenAdapter.hash')
SCSPR_ADAPTER_HASH=$(get_hash '.contracts.scsprAdapter.hash')
ACCESS_CONTROL_HASH=$(get_hash '.contracts.accessControl.hash')
GOVERNANCE_HASH=$(get_hash '.contracts.governance.hash')
SCSPR_YBTOKEN_HASH=$(get_hash '.contracts.scsprYbToken.hash')
WITHDRAW_QUEUE_HASH=$(get_hash '.contracts.withdrawQueue.hash')

REGISTRY_PKG=$(get_hash '.contracts.registry.package_hash')
ROUTER_PKG=$(get_hash '.contracts.router.package_hash')
BRANCH_CSPR_PKG=$(get_hash '.contracts.branchCspr.package_hash')
BRANCH_SCSPR_PKG=$(get_hash '.contracts.branchSCSPR.package_hash')
STABLECOIN_PKG=$(get_hash '.contracts.stablecoin.package_hash')
TREASURY_PKG=$(get_hash '.contracts.treasury.package_hash')
ORACLE_PKG=$(get_hash '.contracts.oracleAdapter.package_hash')
STABILITY_POOL_PKG=$(get_hash '.contracts.stabilityPool.package_hash')
LIQUIDATION_PKG=$(get_hash '.contracts.liquidationEngine.package_hash')
REDEMPTION_PKG=$(get_hash '.contracts.redemptionEngine.package_hash')
TOKEN_ADAPTER_PKG=$(get_hash '.contracts.tokenAdapter.package_hash')
SCSPR_ADAPTER_PKG=$(get_hash '.contracts.scsprAdapter.package_hash')
ACCESS_CONTROL_PKG=$(get_hash '.contracts.accessControl.package_hash')
GOVERNANCE_PKG=$(get_hash '.contracts.governance.package_hash')
SCSPR_YBTOKEN_PKG=$(get_hash '.contracts.scsprYbToken.package_hash')
WITHDRAW_QUEUE_PKG=$(get_hash '.contracts.withdrawQueue.package_hash')

SECTION=$(cat <<SEC
## $NETWORK_TITLE

**Network**: Casper $NETWORK_TITLE ($NETWORK_NAME)  
**Node**: $NODE_URL  
**Deployment Record**: $DEPLOY_FILE

| Contract | Contract Hash | Package Hash | Notes |
|---|---|---|---|
| Registry | $REGISTRY_HASH | $REGISTRY_PKG | |
| Router | $ROUTER_HASH | $ROUTER_PKG | |
| BranchCSPR | $BRANCH_CSPR_HASH | $BRANCH_CSPR_PKG | |
| BranchSCSPR | $BRANCH_SCSPR_HASH | $BRANCH_SCSPR_PKG | |
| Stablecoin (gUSD) | $STABLECOIN_HASH | $STABLECOIN_PKG | |
| Treasury | $TREASURY_HASH | $TREASURY_PKG | |
| OracleAdapter | $ORACLE_HASH | $ORACLE_PKG | |
| StabilityPool | $STABILITY_POOL_HASH | $STABILITY_POOL_PKG | |
| LiquidationEngine | $LIQUIDATION_HASH | $LIQUIDATION_PKG | |
| RedemptionEngine | $REDEMPTION_HASH | $REDEMPTION_PKG | |
| TokenAdapter | $TOKEN_ADAPTER_HASH | $TOKEN_ADAPTER_PKG | |
| SCSPRAdapter | $SCSPR_ADAPTER_HASH | $SCSPR_ADAPTER_PKG | |
| AccessControl | $ACCESS_CONTROL_HASH | $ACCESS_CONTROL_PKG | |
| Governance | $GOVERNANCE_HASH | $GOVERNANCE_PKG | |
| ScsprYbToken | $SCSPR_YBTOKEN_HASH | $SCSPR_YBTOKEN_PKG | |
| WithdrawQueue | $WITHDRAW_QUEUE_HASH | $WITHDRAW_QUEUE_PKG | |
SEC
)

python3 - <<PY
import re
from pathlib import Path

path = Path("$CONTRACT_MD")
content = path.read_text()
section_title = "## $NETWORK_TITLE"
pattern = re.compile(rf"{section_title}.*?(?=^## |\Z)", re.S | re.M)
replacement = """$SECTION""".rstrip() + "\n\n"

if not pattern.search(content):
    raise SystemExit(f"Section not found for {section_title}")

content = pattern.sub(replacement, content)
path.write_text(content)
PY

echo "✓ Updated CONTRACT.md for $NETWORK using $DEPLOY_FILE"
