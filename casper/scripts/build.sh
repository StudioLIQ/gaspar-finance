#!/bin/bash
# CSPR-CDP Build Script
#
# Builds all Casper smart contracts as WASM artifacts.
# Usage: ./build.sh [--release|--debug]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTRACTS_DIR="$ROOT_DIR/contracts"

BUILD_MODE="${1:---release}"

echo "=== CSPR-CDP Contract Build ==="
echo "Build mode: $BUILD_MODE"
echo ""

# Ensure Rust toolchain
echo "=== Checking Rust toolchain ==="
rustup show

# Check for wasm32 target
if ! rustup target list --installed | grep -q "wasm32-unknown-unknown"; then
    echo "Installing wasm32-unknown-unknown target..."
    rustup target add wasm32-unknown-unknown
fi

echo ""
echo "=== Building Contracts ==="
cd "$CONTRACTS_DIR"

if [ "$BUILD_MODE" = "--release" ]; then
    cargo build --release --target wasm32-unknown-unknown --lib
    WASM_DIR="$ROOT_DIR/target/wasm32-unknown-unknown/release"
else
    cargo build --target wasm32-unknown-unknown --lib
    WASM_DIR="$ROOT_DIR/target/wasm32-unknown-unknown/debug"
fi

echo ""
echo "=== Build Summary ==="

# List WASM files
find "$WASM_DIR" -name "*.wasm" -type f 2>/dev/null | while read -r wasm; do
    SIZE=$(du -h "$wasm" | cut -f1)
    echo "  $(basename "$wasm"): $SIZE"
done

echo ""
echo "WASM artifacts: $WASM_DIR"
echo "Build complete!"
