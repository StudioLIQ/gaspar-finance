#!/usr/bin/env bash
#
# Build CSPR-CDP Casper contracts
#
# Usage:
#   ./scripts/casper/build.sh [--wasm] [--release]
#
# Options:
#   --wasm     Build WASM artifacts for deployment
#   --release  Build in release mode (default)
#   --debug    Build in debug mode

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CASPER_DIR="${REPO_ROOT}/casper"

# Parse arguments
BUILD_WASM=false
BUILD_MODE="release"

while [[ $# -gt 0 ]]; do
    case $1 in
        --wasm)
            BUILD_WASM=true
            shift
            ;;
        --release)
            BUILD_MODE="release"
            shift
            ;;
        --debug)
            BUILD_MODE="debug"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

echo "=== CSPR-CDP Contract Build ==="
echo "Build mode: ${BUILD_MODE}"
echo "Build WASM: ${BUILD_WASM}"
echo ""

cd "${CASPER_DIR}"

# Format and lint first
echo ">>> Formatting code..."
cargo fmt --all

echo ">>> Running clippy..."
cargo clippy --workspace --all-targets -- -D warnings

# Build
if [[ "${BUILD_MODE}" == "release" ]]; then
    echo ">>> Building contracts (release)..."
    cargo build --release
else
    echo ">>> Building contracts (debug)..."
    cargo build
fi

# Build WASM if requested
if [[ "${BUILD_WASM}" == "true" ]]; then
    echo ">>> Building WASM artifacts..."
    make wasm
fi

echo ""
echo "=== Build Complete ==="
