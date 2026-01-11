# Casper CDP (Casper): Deploy + Test Checklist

This is the minimal runbook to deploy Casper contracts, verify deployment, and wire the frontend.

## 0) One-time setup (per machine)

Required tools:
- Rust toolchain + `wasm32-unknown-unknown` target (+ `make`)
- `casper-client`
- `jq`
- Node.js 18+ (frontend)

Quick setup (Rust side):
```bash
cd casper && make setup
```

## 1) Inputs you must have (before deploy)

### 1-1) Keys
- `secret_key.pem` (deployer)
- `public_key.pem` must be next to `secret_key.pem` **or** set `PUBLIC_KEY=/path/to/public_key.pem`

### 1-2) Confirm network parameters (do not guess)
Follow:
- `docs/casper/decision/parameter-confirmation.md`

### 1-3) Required environment variables
Required for deployment (unless `USE_DEPLOYED_LST_AS_SCSPR=true`):
- `CSPR_DECIMALS`
- `SCSPR_DECIMALS`
- `SCSPR_TOKEN_HASH` (must include the `hash-` prefix)
- `SCSPR_LST_HASH` (must include the `hash-` prefix)

Optional:
- `DEPLOY_LST` (`true`/`false`, default: `true`)
- `USE_DEPLOYED_LST_AS_SCSPR` (`true`/`false`, default: `false`)
- `CSPR_NODE_ADDRESS`, `CSPR_CHAIN_NAME` (override network defaults)

Tip: copy `.env.example` to `.env` (never commit it) and load it:
```bash
cp .env.example .env
set -a && source .env && set +a
```

## 2) Pre-deploy checks (recommended)

Contracts (format/lint/test):
```bash
cd casper
make fmt-check lint test
```

Frontend (lint/type-check/build):
```bash
cd frontend
npm ci
npm run lint
npm run type-check
npm run build
```

## 3) Deploy contracts

From repo root:
```bash
NETWORK=testnet
./scripts/casper/deploy.sh "$NETWORK" /path/to/secret_key.pem
```

Outputs:
- Deployment record: `deployments/casper/${NETWORK}-YYYYMMDD-HHMMSS.json`

Verify status:
```bash
DEPLOY_FILE="$(ls -t "deployments/casper/${NETWORK}-"*.json | head -n1)"
jq -r '.status' "$DEPLOY_FILE"  # expect: deployed
```

## 4) Smoke test (post-deploy)

```bash
./scripts/casper/smoke-test.sh "$NETWORK" "$DEPLOY_FILE"
```

If you omit `"$DEPLOY_FILE"`, it auto-picks the latest record for that network.

## 5) Update `CONTRACT.md` + bind frontend

Update `CONTRACT.md` from the deployment record:
```bash
./scripts/update-contracts-md.sh "$NETWORK" "$DEPLOY_FILE"
```

Generate frontend config + env:
```bash
./scripts/casper/bind-frontend.sh "$NETWORK" "$DEPLOY_FILE"
```

Note: `bind-frontend.sh` does **not** overwrite `frontend/.env.local` if it already exists.

## 6) Manual UI check (post-bind)

```bash
cd frontend
npm run dev
```

Connect Casper Wallet and verify pages load and contracts are reachable.

## 7) LST-only checks (if `scsprYbToken` / `withdrawQueue` were deployed)

Verify on-chain read paths used by the frontend:
```bash
./scripts/casper/verify-lst-read.sh "$NETWORK" "$DEPLOY_FILE"
```

Oracle rate sync keeper:
```bash
DRY_RUN=true ./scripts/casper/sync-rate.sh "$NETWORK"
./scripts/casper/sync-rate.sh "$NETWORK" /path/to/keeper_secret_key.pem
```

If rate reading fails (by design), you can override:
```bash
OVERRIDE_YBTOKEN_RATE=<u256_scaled_by_1e18> ./scripts/casper/sync-rate.sh "$NETWORK" /path/to/keeper_secret_key.pem
```

## 8) Mainnet note

Mainnet uses real assets. Re-run `docs/casper/decision/parameter-confirmation.md`, deploy to testnet first, and do not proceed without explicit sign-off.
