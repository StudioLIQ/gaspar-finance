# CSPR-CDP Contract Makefile
#
# Usage:
#   make build      - Build all contracts in release mode
#   make test       - Run all tests
#   make wasm       - Build WASM artifacts
#   make clean      - Clean build artifacts
#   make fmt        - Format code
#   make lint       - Run clippy linter

.PHONY: build test wasm clean fmt lint check all

CARGO = cargo
WASM_DIR = wasm
TARGET_DIR = target

# Default target
all: fmt lint test build

# Build all crates
build:
	$(CARGO) build --release

# Build WASM artifacts for deployment
wasm:
	$(CARGO) build --release --target wasm32-unknown-unknown -p cspr-cdp-contracts
	@mkdir -p $(WASM_DIR)
	@cp $(TARGET_DIR)/wasm32-unknown-unknown/release/*.wasm $(WASM_DIR)/ 2>/dev/null || true
	@echo "WASM artifacts copied to $(WASM_DIR)/"
	@ls -la $(WASM_DIR)/*.wasm 2>/dev/null || echo "No WASM files found"

# Run tests
test:
	$(CARGO) test --workspace

# Run tests with output
test-verbose:
	$(CARGO) test --workspace -- --nocapture

# Clean build artifacts
clean:
	$(CARGO) clean
	rm -rf $(WASM_DIR)/*.wasm

# Format code
fmt:
	$(CARGO) fmt --all

# Check formatting
fmt-check:
	$(CARGO) fmt --all -- --check

# Run clippy linter
lint:
	$(CARGO) clippy --workspace --all-targets -- -D warnings

# Check compilation without producing artifacts
check:
	$(CARGO) check --workspace

# Generate documentation
doc:
	$(CARGO) doc --workspace --no-deps --open

# Install required toolchain and targets
setup:
	rustup target add wasm32-unknown-unknown
	rustup component add clippy rustfmt
	@echo "Setup complete. Run 'make build' to compile contracts."

# Help
help:
	@echo "CSPR-CDP Contract Build System"
	@echo ""
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  build       - Build all contracts in release mode"
	@echo "  wasm        - Build WASM artifacts for deployment"
	@echo "  test        - Run all tests"
	@echo "  test-verbose- Run tests with output"
	@echo "  clean       - Clean build artifacts"
	@echo "  fmt         - Format code"
	@echo "  fmt-check   - Check code formatting"
	@echo "  lint        - Run clippy linter"
	@echo "  check       - Check compilation"
	@echo "  doc         - Generate documentation"
	@echo "  setup       - Install required toolchain and targets"
	@echo "  help        - Show this help message"
