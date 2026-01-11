# Casper Ops Docs Index

Casper mode operations (runbook) documents.

## Contract Development

The Casper smart contracts are located in `casper/` directory.

### Quick Start

```bash
# Build contracts
cd casper && make build

# Run tests
make test

# Build WASM artifacts for deployment
make wasm
```

### Scripts

| Script | Description |
|--------|-------------|
| `casper/scripts/deploy.sh` | Deploy contracts to testnet/mainnet (SSOT) |
| `casper/scripts/bind-frontend.sh` | Bind deployed addresses to frontend |
| `casper/scripts/sync-rate.sh` | LST rate sync keeper script |
| `casper/scripts/smoke-test.sh` | Post-deployment verification |
| `scripts/casper/deploy.sh` | Wrapper that delegates to casper/scripts/deploy.sh |

### Deployment

See [Deployment Runbook](./runbook-deployment.md) for full instructions.

Quick reference:

```bash
# 1. Build WASM artifacts
cd casper && make wasm

# 2. Set required environment variables
export CSPR_DECIMALS=9
export SCSPR_DECIMALS=9
export SCSPR_TOKEN_HASH=hash-...
export SCSPR_LST_HASH=hash-...

# 3. Deploy (includes LST by default)
./casper/scripts/deploy.sh testnet /path/to/secret_key.pem

# 4. Bind frontend
./casper/scripts/bind-frontend.sh testnet
```

Deployment records are saved to `deployments/casper/<network>-<timestamp>.json`.

## Runbooks

- [Deployment](./runbook-deployment.md) - Full deployment procedure
- [LST Rate Sync](./runbook-styks-oracle.md) - Oracle and rate keeper operations
- [Collateral Onboarding](./runbook-collateral-onboarding.md) - Adding new collateral types
- [SP + Redemption E2E](./runbook-sp-redemption-e2e.md) - StabilityPool and Redemption testing

## Related Documentation

- Contract README: `casper/README.md`
- ADR-001 (Oracle Policy): `docs/adr/ADR-001-styks-oracle.md`
- Parameter Confirmation: `docs/casper/decision/parameter-confirmation.md`
