#!/usr/bin/env bash
# Build per-contract Odra WASM artifacts into casper/wasm/
#
# Why:
# - Casper deploy scripts expect module-specific WASM files like `wasm/ScsprYbToken.wasm`.
# - These are produced by building the `cspr_cdp_build_contract` binary with `ODRA_MODULE=<ModuleName>`.
#
# Usage:
#   ./casper/scripts/build-wasm-modules.sh [--release]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WASM_DIR="$ROOT_DIR/wasm"
TARGET_WASM="$ROOT_DIR/target/wasm32-unknown-unknown/release/cspr_cdp_build_contract.wasm"

MODE="${1:---release}"

require_cmd() {
  if ! command -v "$1" &> /dev/null; then
    echo "ERROR: missing dependency: $1"
    exit 1
  fi
}

require_cmd cargo

if [ "$MODE" != "--release" ]; then
  echo "ERROR: only --release is supported right now (deployment expects release WASM)."
  exit 1
fi

mkdir -p "$WASM_DIR"

MODULES=(
  Registry
  Router
  AccessControl
  CsprUsd
  Treasury
  TokenAdapter
  OracleAdapter
  BranchCspr
  BranchScspr
  LiquidationEngine
  StabilityPool
  RedemptionEngine
  ScsprYbToken
  WithdrawQueue
)

echo "=== Build Odra module WASM (release) ==="
echo "Output: $WASM_DIR"
echo ""

for module in "${MODULES[@]}"; do
  echo "--- Building: $module ---"
  ODRA_MODULE="$module" cargo build --release --target wasm32-unknown-unknown --bin cspr_cdp_build_contract
  if [ ! -f "$TARGET_WASM" ]; then
    echo "ERROR: expected wasm not found: $TARGET_WASM"
    exit 1
  fi
  cp "$TARGET_WASM" "$WASM_DIR/${module}.wasm"
done

echo ""
echo "✓ Done. Generated:"
ls -la "$WASM_DIR"/*.wasm 2>/dev/null || true

