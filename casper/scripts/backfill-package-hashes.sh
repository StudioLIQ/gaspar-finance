#!/bin/bash
# Backfill missing package_hash values in deployment records
#
# Usage:
#   ./backfill-package-hashes.sh [network] [deployment-file]
#
# If deployment-file is not specified, uses the latest deployment file for the network.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_DIR="$ROOT_DIR/../deployments/casper"

NETWORK="${1:-testnet}"
DEPLOY_FILE="${2:-}"

case $NETWORK in
  testnet)
    NODE_ADDRESS="${CSPR_NODE_ADDRESS:-https://node.testnet.casper.network/rpc}"
    ;;
  mainnet)
    NODE_ADDRESS="${CSPR_NODE_ADDRESS:-https://node.mainnet.casper.network/rpc}"
    ;;
  local)
    NODE_ADDRESS="${CSPR_NODE_ADDRESS:-http://localhost:11101/rpc}"
    ;;
  *)
    echo "Unknown network: $NETWORK"
    exit 1
    ;;
esac

# Find latest deployment file if not specified
if [ -z "$DEPLOY_FILE" ]; then
    DEPLOY_FILE=$(ls -t "$DEPLOY_DIR/${NETWORK}-"*.json 2>/dev/null | head -n1)
    if [ -z "$DEPLOY_FILE" ]; then
        echo "ERROR: No deployment file found for network: $NETWORK"
        exit 1
    fi
fi

echo "=== Backfill Package Hashes ==="
echo "Network: $NETWORK"
echo "Node: $NODE_ADDRESS"
echo "Deployment file: $DEPLOY_FILE"
echo ""

require_cmd() {
  if ! command -v "$1" &> /dev/null; then
    echo "ERROR: missing dependency: $1"
    exit 1
  fi
}

require_cmd jq
require_cmd casper-client

json_only() {
  printf '%s\n' "$1" | sed -n '/^[[:space:]]*[{[]/,$p'
}

# Extract package_hash from deploy result transforms
extract_package_hash_from_deploy() {
  local deploy_hash="$1"
  local result
  result=$(casper-client get-deploy --node-address "$NODE_ADDRESS" "$deploy_hash" 2>/dev/null || true)
  result=$(json_only "$result")

  if [ -z "$result" ]; then
    echo ""
    return
  fi

  local pkg_hash

  # Try Casper 1.x format (WriteContractPackage)
  pkg_hash=$(echo "$result" | jq -r '.result.execution_results[0].result.Success.effect.transforms[] | select(.transform.WriteContractPackage != null) | .key' 2>/dev/null | head -n 1)
  if [ -n "$pkg_hash" ] && [ "$pkg_hash" != "null" ]; then
    echo "$pkg_hash"
    return
  fi

  # Try Casper 2.0 format (WritePackage)
  pkg_hash=$(echo "$result" | jq -r '.result.execution_results[0].result.Success.effect.transforms[] | select(.transform.WritePackage != null) | .key' 2>/dev/null | head -n 1)
  if [ -n "$pkg_hash" ] && [ "$pkg_hash" != "null" ]; then
    echo "$pkg_hash"
    return
  fi

  # Try looking for package- or contract-package- keys
  pkg_hash=$(echo "$result" | jq -r '.result.execution_results[0].result.Success.effect.transforms[] | .key | select(startswith("contract-package-") or startswith("package-"))' 2>/dev/null | head -n 1)
  if [ -n "$pkg_hash" ] && [ "$pkg_hash" != "null" ]; then
    echo "$pkg_hash"
    return
  fi

  # Casper 2.0: Look for Identity transform with package pattern
  pkg_hash=$(echo "$result" | jq -r '.result.execution_results[0].result.Success.effect.transforms[] | select(.transform == "Identity") | .key | select(startswith("package-"))' 2>/dev/null | head -n 1)
  if [ -n "$pkg_hash" ] && [ "$pkg_hash" != "null" ]; then
    echo "$pkg_hash"
    return
  fi

  echo ""
}

# Query contract using casper-client to get package_hash
lookup_package_hash_from_contract() {
  local contract_hash="$1"

  # Get state root hash first
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

  # Casper 1.x format
  pkg_hash=$(echo "$result" | jq -r '.result.stored_value.Contract.contract_package_hash // empty' 2>/dev/null)
  if [ -n "$pkg_hash" ] && [ "$pkg_hash" != "null" ]; then
    echo "$pkg_hash"
    return
  fi

  # Casper 2.0 format (AddressableEntity)
  pkg_hash=$(echo "$result" | jq -r '.result.stored_value.AddressableEntity.package_hash // empty' 2>/dev/null)
  if [ -n "$pkg_hash" ] && [ "$pkg_hash" != "null" ]; then
    echo "$pkg_hash"
    return
  fi

  echo ""
}

# Get list of contracts from deployment file
contracts=$(jq -r '.contracts | keys[]' "$DEPLOY_FILE")

updated=0
failed=0

for contract_name in $contracts; do
  contract_hash=$(jq -r ".contracts[\"$contract_name\"].hash // empty" "$DEPLOY_FILE")
  deploy_hash=$(jq -r ".contracts[\"$contract_name\"].deploy_hash // empty" "$DEPLOY_FILE")
  existing_pkg=$(jq -r ".contracts[\"$contract_name\"].package_hash // empty" "$DEPLOY_FILE")

  if [ -z "$contract_hash" ] || [ "$contract_hash" = "null" ]; then
    echo "⏭ $contract_name: no contract hash, skipping"
    continue
  fi

  if [ -n "$existing_pkg" ] && [ "$existing_pkg" != "null" ]; then
    echo "✓ $contract_name: already has package_hash ($existing_pkg)"
    continue
  fi

  echo -n "→ $contract_name: "

  pkg_hash=""

  # Method 1: Extract from deploy transforms (most reliable)
  if [ -n "$deploy_hash" ] && [ "$deploy_hash" != "null" ]; then
    echo -n "checking deploy... "
    pkg_hash=$(extract_package_hash_from_deploy "$deploy_hash")
  fi

  # Method 2: Query contract directly
  if [ -z "$pkg_hash" ] || [ "$pkg_hash" = "null" ]; then
    echo -n "querying contract... "
    pkg_hash=$(lookup_package_hash_from_contract "$contract_hash")
  fi

  if [ -n "$pkg_hash" ] && [ "$pkg_hash" != "null" ]; then
    # Update the deployment file
    jq --arg name "$contract_name" --arg pkg "$pkg_hash" \
      '.contracts[$name].package_hash = $pkg' \
      "$DEPLOY_FILE" > "$DEPLOY_FILE.tmp" && mv "$DEPLOY_FILE.tmp" "$DEPLOY_FILE"
    echo "✓ $pkg_hash"
    updated=$((updated + 1))
  else
    echo "✗ not found"
    failed=$((failed + 1))
  fi
done

echo ""
echo "=== Summary ==="
echo "Updated: $updated"
echo "Failed: $failed"
echo ""

if [ $updated -gt 0 ]; then
  echo "Deployment file updated: $DEPLOY_FILE"
  echo ""
  echo "Next steps:"
  echo "  1. Re-run bind-frontend.sh to update frontend config:"
  echo "     ./casper/scripts/bind-frontend.sh $NETWORK $DEPLOY_FILE"
fi
