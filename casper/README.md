# CSPR-CDP Casper Contracts

Casper-native LiquityV2-style CDP protocol implementation using the Odra framework.

## Architecture

```
casper/
├── contracts/          # Smart contract source code
│   └── src/
│       ├── lib.rs      # Module entry point
│       ├── types.rs    # Common types (CollateralId, OracleStatus, etc.)
│       └── errors.rs   # Protocol error definitions
├── tests/              # Integration tests
├── session/            # Session code for deployment
├── wasm/               # Built WASM artifacts (gitignored)
├── Cargo.toml          # Workspace configuration
├── Makefile            # Build automation
└── README.md           # This file
```

## Prerequisites

1. **Rust toolchain** (stable)
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

2. **WASM target**
   ```bash
   rustup target add wasm32-unknown-unknown
   ```

3. **Development tools**
   ```bash
   rustup component add clippy rustfmt
   ```

Or run the setup command:
```bash
cd casper && make setup
```

## Build

### Using Make (recommended)

```bash
cd casper

# Build all crates
make build

# Build WASM artifacts for deployment
make wasm

# Run all checks (format, lint, test, build)
make all
```

### Using scripts

```bash
# Build contracts
./scripts/casper/build.sh

# Build with WASM artifacts
./scripts/casper/build.sh --wasm
```

## Test

```bash
cd casper

# Run tests
make test

# Run tests with output
make test-verbose
```

Or using the script:

```bash
./scripts/casper/test.sh
./scripts/casper/test.sh --verbose
./scripts/casper/test.sh --filter vault
```

## Deploy

Deployment requires:
- Built WASM artifacts
- Casper client installed
- Deploy account keys

```bash
# Dry run (validate only)
./scripts/casper/deploy.sh --network testnet --dry-run

# Deploy to testnet
export CSPR_CDP_DEPLOY_KEY=/path/to/secret_key.pem
./scripts/casper/deploy.sh --network testnet

# Deploy to mainnet
./scripts/casper/deploy.sh --network mainnet
```

Deployment records are saved to `deployments/casper/<network>-<date>.json`.

## Contract Modules

| Module | Description | Status |
|--------|-------------|--------|
| Router | Collateral type dispatch | Pending |
| BranchCSPR | CSPR vault logic | Pending |
| BranchSCSPR | stCSPR vault logic | Pending |
| gUSD | Stablecoin (mint/burn) | Pending |
| Treasury | Fee collection | Pending |
| OracleAdapter | Styks/Odra pricing | Pending |
| StabilityPool | Bad debt absorption | Pending |
| LiquidationEngine | Vault liquidation | Pending |
| RedemptionEngine | gUSD redemption | Pending |
| AccessControl | Role management | Pending |

## Safe Mode (Circuit Breaker)

When oracle status is not OK, the protocol enters safe_mode (ADR-001):

**Allowed operations:**
- Repay debt (adjustVault with debtDelta <= 0)
- Add collateral (adjustVault with collateralDelta >= 0)
- Stability Pool deposit

**Blocked operations:**
- Open vault / borrow (debt increase)
- Withdraw collateral / close vault
- Liquidation / redemption
- Stability Pool withdraw / claim

## Configuration

Protocol parameters are defined in:
- `docs/casper/decision/parameter-confirmation.md` - Network-specific values
- `config/oracle.styks.*.json` - Oracle configuration

Do not hard-code ambiguous network values. All values must be confirmed via the parameter confirmation procedure.

## Documentation

- [ADR-001: Oracle Policy](../docs/adr/ADR-001-styks-oracle.md)
- [Oracle Spec](../docs/casper/spec/oracle.md)
- [Collateral Spec](../docs/casper/spec/collateral.md)
- [Ops Runbook](../docs/casper/ops/)
