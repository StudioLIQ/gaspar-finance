# Casper CDP + LST (stCSPR)

Casper-native **LiquityV2-style** CDP protocol workspace, scoped to **Casper** with a testnet-first deployment flow and **Casper Wallet** integration. The protocol supports two collateral types: **CSPR (native)** and **stCSPR (LST / CEP-18)**.

This repo also contains an optional **in-repo stCSPR LST implementation** (ybToken + WithdrawQueue) and the operational tooling needed to keep the oracle exchange rate in sync.

> Status: WIP / research & implementation in progress. Do not treat this as production-ready or audited code.

## What This Repo Implements (High Level)

- **Two collaterals** with equivalent semantics: **CSPR** and **stCSPR**
- **Router + Branch** architecture (per-collateral vault logic behind a shared interface)
- **Protocol stablecoin**: `gUSD` (mint/burn controlled by the protocol)
- **Oracle adapter**: Styks (Odra), with **composite pricing** for stCSPR via `P(stCSPR) = P(CSPR) * R`
- **Safe mode** circuit breaker when oracle status is not OK

## Repository Map

- Smart contracts (Rust/Odra): `casper/`
- Frontend (Casper testnet + Casper Wallet only): `frontend/`
- Casper docs (specs, test vectors, ops): `docs/casper/`
- Deployment records & schemas: `deployments/casper/`, `artifacts/`
- Ops / automation scripts (wrappers): `scripts/casper/`
- Deployment walkthroughs: `DEPLOY.md`, `ORDER.md`
- stCSPR LST design draft: `LST.md`

## Quickstart (Casper Testnet)

Prerequisites:
- Rust + `wasm32-unknown-unknown` target, `make`
- `casper-client`, `jq`
- Node.js 18+

1) **Confirm network parameters** (do not guess):
   - `docs/casper/decision/parameter-confirmation.md`

2) **Set required environment variables** (example only):
```bash
export CSPR_DECIMALS=9
export SCSPR_DECIMALS=9

# External stCSPR dependencies (required unless using the in-repo LST as stCSPR)
export SCSPR_TOKEN_HASH=hash-<your-stcspr-cep18-token-hash>
export SCSPR_LST_HASH=hash-<your-stcspr-lst-adapter-hash>

# Optional: deploy the in-repo LST contracts (default: true)
export DEPLOY_LST=true

# Optional: use the deployed ybToken as stCSPR (skips the external hashes above)
export USE_DEPLOYED_LST_AS_SCSPR=false
```

You can also copy `.env.example` into a local `.env` for convenience (never commit it).

3) **Build WASM**:
```bash
cd casper && make wasm
```

4) **Deploy** (recommended wrapper):
```bash
./scripts/casper/deploy.sh testnet /path/to/secret_key.pem
```

5) **Update `CONTRACT.md`** from the latest deployment record:
```bash
./scripts/update-contracts-md.sh testnet
```

6) **Bind the frontend** (writes `config/casper-testnet.json` and `frontend/.env.local`):
```bash
./scripts/casper/bind-frontend.sh testnet
```

7) **Run the frontend**:
```bash
cd frontend
npm install
npm run dev
```

For a more explicit, step-by-step runbook (including smoke tests and LST validation), follow `ORDER.md` or `DEPLOY.md`.

## LST (stCSPR)

- `stCSPR` is treated as a **yield-bearing share token** (ybToken model) with an on-chain exchange rate `R = CSPR_PER_SCSPR`.
- The oracle can compute **composite stCSPR/USD pricing**: `P(stCSPR) = P(CSPR) * R`.
- The repo includes:
  - LST design draft: `LST.md`
  - LST contracts (ybToken + WithdrawQueue): `casper/contracts/`
  - Optional LST deployment via `DEPLOY_LST=true`
  - Post-deploy rate operations: `./scripts/casper/sync-rate.sh`

## Documentation

- Casper docs entry: `docs/casper/README.md`
- Contract workspace docs: `casper/README.md`
- Frontend docs: `frontend/README.md`
