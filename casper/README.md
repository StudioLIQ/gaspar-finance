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
| Router | Collateral type dispatch | Scaffolded (cross-contract wiring WIP) |
| BranchCSPR | CSPR vault logic | Scaffolded (CSPR transfers WIP) |
| BranchSCSPR | stCSPR vault logic | Scaffolded (CEP-18 transfers WIP) |
| gUSD | Stablecoin (mint/burn) | Scaffolded (registry/admin gating WIP) |
| Treasury | Fee collection | Scaffolded (token transfers WIP) |
| OracleAdapter | Styks/Odra pricing | Scaffolded (external feed + router wiring WIP) |
| StabilityPool | Bad debt absorption | Scaffolded (token transfers + liquidation wiring WIP) |
| LiquidationEngine | Vault liquidation | Scaffolded (oracle/branch wiring WIP) |
| RedemptionEngine | gUSD redemption | Scaffolded (vault iteration + transfers WIP) |
| TokenAdapter | CEP-18 adapter | Scaffolded (cross-contract calls WIP) |
| AccessControl | Role management | Implemented (governance module scaffold included) |
| scsprYbToken | LST ybToken | Implemented (testnet preview) |
| WithdrawQueue | LST withdraw queue | Implemented (testnet preview) |

## Safe Mode (Circuit Breaker)

When oracle status is not OK, the protocol enters safe_mode (ADR-001):

**Allowed operations:**
- Repay debt (`adjustVault(vaultId, debtDelta <= 0)`)
- Add collateral (`adjustVault(vaultId, collateralDelta >= 0)`)
- Stability Pool deposit

**Blocked operations:**
- Open vault / borrow (debt increase)
- Withdraw collateral / close vault (`adjustVault(vaultId, withdraw)` / `closeVault(vaultId)`)
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

## CDP CLI (multi-vault)

`vault_id` is part of the vault identity (one owner can have multiple vaults per collateral branch).

```bash
# List vaults for an owner (defaults to .deployer from latest deployment record)
./scripts/casper/cdp-vaults.sh testnet

# Open a vault (collateral + borrow amounts are token units, 9 decimals max; borrow is scaled to 18 on-chain)
./scripts/casper/cdp-open-vault.sh testnet "" /path/to/secret_key.pem cspr 10 100 300

# Adjust a vault (add/withdraw collateral, borrow/repay debt)
./scripts/casper/cdp-adjust-vault.sh testnet "" /path/to/secret_key.pem cspr 1 2 add 10 borrow

# Close a vault
./scripts/casper/cdp-close-vault.sh testnet "" /path/to/secret_key.pem cspr 1
```
