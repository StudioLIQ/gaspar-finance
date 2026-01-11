# Run Order (ORDER) — Casper CDP + LST (stCSPR) Testnet

> Baseline: run from the repo root (`/path/to/cspr-cdp`)  
> Rule: **do not guess** network values (decimals / hashes / feeds, etc.). Confirm them via `docs/casper/decision/parameter-confirmation.md` before proceeding.

---

## 0) Prerequisites

- Key file: `/path/to/secret_key.pem` (and `public_key.pem` in the same directory)
- Required tools: `cargo`, `make`, `casper-client`, `jq`

---

## 1) Confirm network parameters (required)

- Follow this procedure and collect confirmed values:
  - `docs/casper/decision/parameter-confirmation.md`

---

## 2) Set environment variables (testnet example)

```bash
export CSPR_DECIMALS=9
export SCSPR_DECIMALS=9

# External dependency contracts (must use confirmed "hash-..." values)
export SCSPR_TOKEN_HASH=hash-<your-stcspr-cep18-token-hash>
export SCSPR_LST_HASH=hash-<your-stcspr-lst-adapter-hash>

# (Optional) Whether to deploy LST (stCSPR ybToken + WithdrawQueue) as well (default: true)
export DEPLOY_LST=true
```

---

## 3) Build WASM

```bash
cd /path/to/cspr-cdp
cd casper && make wasm
```

---

## 4) Run deployment (recommended: wrapper)

```bash
cd /path/to/cspr-cdp
./scripts/casper/deploy.sh testnet /path/to/secret_key.pem
```

Outputs:
- Deployment record: `deployments/casper/testnet-YYYYMMDD-HHMMSS.json`

---

## 5) Update `CONTRACT.md`

```bash
cd /path/to/cspr-cdp
./scripts/update-contracts-md.sh testnet
```

---

## 6) Bind frontend (important)

```bash
cd /path/to/cspr-cdp
./scripts/casper/bind-frontend.sh testnet
```

Creates/updates:
- `config/casper-testnet.json`
- `frontend/.env.local.example`
- `frontend/.env.local` (created only if missing; never overwritten)

**Stake (CSPR → stCSPR) requirements**
- `frontend/public/odra/proxy_caller.wasm` exists
- `frontend/.env.local` contains:
  - `NEXT_PUBLIC_SCSPR_YBTOKEN_PACKAGE_HASH=hash-...`
    - If missing, rerun step 6 or fill it manually.

---

## 7) Smoke test

```bash
cd /path/to/cspr-cdp
./scripts/casper/smoke-test.sh testnet
```

---

## 7.5) (Recommended) Verify LST read paths

Verify the frontend read logic matches on-chain `named_keys` / storage layout.

```bash
cd /path/to/cspr-cdp
./scripts/casper/verify-lst-read.sh testnet deployments/casper/testnet-YYYYMMDD-HHMMSS.json
```

Confirm the output includes:
- `ybToken.assets`, `ybToken.total_shares`
- `WithdrawQueue.config` (includes `unbonding_period`)

---

## 8) Run the frontend and verify

```bash
cd /path/to/cspr-cdp/frontend
npm install
npm run dev
```

Minimum browser checks:
- `/lst`
  - Stake (CSPR → stCSPR): sign in Casper Wallet → submit → confirm execution success in the explorer
  - Unstake/Claim: create a request, see status updates, and verify claim behavior

---

## 9) (LST ops) Run oracle rate sync periodically

After deployment, you must periodically push the `stCSPR` exchange rate `R` to the oracle.

```bash
cd /path/to/cspr-cdp
./scripts/casper/sync-rate.sh testnet /path/to/keeper_secret_key.pem
```

If `sync-rate.sh` cannot read the rate from ybToken storage (it fails intentionally for safety):
```bash
export OVERRIDE_YBTOKEN_RATE=<u256_rate_scaled_by_1e18>
./scripts/casper/sync-rate.sh testnet /path/to/keeper_secret_key.pem
```

---

## 10) Remaining work (ticket summary)

- LST ops/validation (runbook/monitoring/incident response): `TICKETS.md` → TICKET-22
- CDP core feature completion (gUSD mint/burn, stCSPR token flow, liquidation/redemption/stability pool implementation): `TICKETS.md` → TICKET-02/04/06/07/08/09
