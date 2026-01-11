#!/usr/bin/env bash
#
# Run CSPR-CDP Casper contract tests
#
# Usage:
#   ./scripts/casper/test.sh [--verbose] [--filter <pattern>]
#
# Options:
#   --verbose    Show test output
#   --filter     Filter tests by pattern

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CASPER_DIR="${REPO_ROOT}/casper"

# Parse arguments
VERBOSE=false
FILTER=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --verbose|-v)
            VERBOSE=true
            shift
            ;;
        --filter|-f)
            FILTER="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

echo "=== CSPR-CDP Contract Tests ==="
echo ""

cd "${CASPER_DIR}"

# Build test arguments
TEST_ARGS="--workspace"
if [[ "${VERBOSE}" == "true" ]]; then
    TEST_ARGS="${TEST_ARGS} -- --nocapture"
fi
if [[ -n "${FILTER}" ]]; then
    if [[ "${VERBOSE}" == "true" ]]; then
        TEST_ARGS="${TEST_ARGS} ${FILTER}"
    else
        TEST_ARGS="${TEST_ARGS} -- ${FILTER}"
    fi
fi

echo ">>> Running tests..."
cargo test ${TEST_ARGS}

echo ""
echo "=== Tests Complete ==="
