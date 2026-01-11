# Casper CDP Deployment Guide (Beginner-Friendly Step-by-Step)

This guide walks you through building and deploying the Casper CDP contracts, wiring them into the frontend, and recording addresses in `CONTRACT.md`—written so you can follow along even if you are not familiar with the codebase.

> Source of truth (deployment script): `casper/scripts/deploy.sh`  
> Wrapper: `scripts/casper/deploy.sh` (invokes the source-of-truth script)

---

## 0) Prerequisites

### Account / keys
- Casper account key to deploy with (`secret_key.pem`)
- Sufficient CSPR balance on the target network
  - For testnet, use a faucet to obtain testnet CSPR.

### Required programs (one-time install)
- Rust toolchain (for WASM builds)
- Casper client (`casper-client`)
- `jq` (JSON processing)

---

## 1) Install tools (macOS)

Copy/paste the following into your terminal:

```bash
# 1) Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 2) Reload shell environment
source "$HOME/.cargo/env"

# 3) Add WASM target
rustup target add wasm32-unknown-unknown

# 4) Install Casper client
cargo install casper-client-rs

# 5) Install jq
brew install jq
```

---

## 2) Prepare Casper keys (new or existing)

You need the following two files:

- `secret_key.pem`
- `public_key.pem`

Example paths:
```
/Users/you/keys/secret_key.pem
/Users/you/keys/public_key.pem
```

> **Important**: `secret_key.pem` and `public_key.pem` must be in the same directory.

### 2-1) (Optional) Generate new keys

If you already have keys, skip this step.

```bash
mkdir -p ~/casper-keys
cd ~/casper-keys

# Requires casper-client to be installed.
casper-client keygen .
```

Generated files:
- `secret_key.pem`
- `public_key.pem`

---

## 3) Confirm network parameters

Do **not** guess. Confirm the values using:

```
docs/casper/decision/parameter-confirmation.md
```

You must also have oracle config files ready:

```
config/oracle.styks.testnet.json
config/oracle.styks.mainnet.json
```

---

## 4) Set deployment environment variables

Only use values that have been confirmed via the procedure above.  
(See `docs/casper/decision/parameter-confirmation.md`.)  
Do **not** fill in ambiguous values by guessing.

```bash
# Confirmed network values (testnet example)
export CSPR_DECIMALS=9  # 1 CSPR = 1,000,000,000 motes
export SCSPR_DECIMALS=9

# External dependency contracts (must use confirmed hashes)
export SCSPR_TOKEN_HASH=hash-<your-scspr-cep18-token-hash>
export SCSPR_LST_HASH=hash-<your-scspr-lst-adapter-hash>

# (Optional) Whether to deploy LST (ybToken + WithdrawQueue) as well (default: true)
export DEPLOY_LST=true
```

> **Note**: `SCSPR_TOKEN_HASH` and `SCSPR_LST_HASH` must include the `hash-` prefix.

---

## 5) Build contracts (generate WASM)

```bash
cd /path/to/cspr-cdp
cd casper && make wasm
```

On success, `.wasm` files are produced under `casper/wasm/`.

---

## 6) Run automated deployment

```bash
cd /path/to/cspr-cdp

# Recommended: wrapper (invokes the source-of-truth script)
./scripts/casper/deploy.sh testnet /path/to/secret_key.pem

# (Direct) Source-of-truth script
# ./casper/scripts/deploy.sh testnet /path/to/secret_key.pem
```

After deployment completes, a deployment record file is created:

```
deployments/casper/testnet-YYYYMMDD-HHMMSS.json
```

> The deployment script installs contracts and wires up registries/dependencies automatically.

---

## 7) (Optional) Capture screenshots

For deployment evidence, it can be useful to capture the following:

**Suggested captures**
1. Deployment command output (terminal)
2. The generated deployment record file path
3. The updated `CONTRACT.md`
4. The running frontend UI

**macOS screenshot shortcuts**
- Full screen: `Shift + Command + 3`
- Select region: `Shift + Command + 4`

**Where screenshots are saved**
- Default: Desktop
- Optionally store under `artifacts/` or `docs/` in this repo.

> If you want to include screenshots in docs, add them under:
> - `docs/ops/` or `docs/casper/ops/` (optional)

---

## 8) Auto-update `CONTRACT.md`

Record deployed contract addresses into `CONTRACT.md`:

```bash
cd /path/to/cspr-cdp
./scripts/update-contracts-md.sh testnet
```

---

## 9) Bind the frontend

Generate frontend configuration files:

```bash
cd /path/to/cspr-cdp

# Recommended: wrapper (invokes the source-of-truth script)
./scripts/casper/bind-frontend.sh testnet

# (Direct) Source-of-truth script
# ./casper/scripts/bind-frontend.sh testnet
```

This step creates:
- `config/casper-testnet.json`
- `frontend/.env.local.example`
- `frontend/.env.local` (created only if missing; never overwritten)

> Note: To make `Stake (CSPR → stCSPR)` work in the browser, the **ybToken package hash** is required.  
> `bind-frontend.sh` also writes `NEXT_PUBLIC_SCSPR_YBTOKEN_PACKAGE_HASH`.

> Note: RPC endpoints used by Casper Wallet/browsers are often `.../rpc`.  
> `bind-frontend.sh` reads `nodeAddress` from the deployment record and automatically appends `/rpc` when needed before writing `frontend/.env.local`.

---

## 10) Run the frontend

```bash
cd /path/to/cspr-cdp/frontend
npm install
npm run dev
```

Open the displayed URL in your browser and connect Casper Wallet.

> Note: The current `Stake (CSPR → stCSPR)` flow is a payable call (attaches CSPR), so it uses `proxy_caller.wasm`.  
> Both must be true:
> 1) `frontend/public/odra/proxy_caller.wasm` exists  
> 2) `frontend/.env.local` contains `NEXT_PUBLIC_SCSPR_YBTOKEN_PACKAGE_HASH=hash-...` (if missing, rerun `bind-frontend.sh`)

---

## 11) Final checklist

- [ ] WASM build succeeded
- [ ] Deployment record file created
- [ ] `CONTRACT.md` updated successfully
- [ ] Frontend env files created
- [ ] Frontend runs and wallet connects
- [ ] (If deploying LST) Ready to operate oracle rate sync via `scripts/casper/sync-rate.sh`

---

## 12) Common issues

### 1) Casper Wallet is not detected
- Refresh the page
- Confirm the browser extension is installed and enabled

### 2) EMFILE error (“too many open files”)
- Delete the root `node_modules`
- Or run `WATCHPACK_POLLING=true npm run dev`

### 3) Deployment failure / entrypoint errors
- Verify the entrypoint names referenced in `deploy.sh` match the actual contract entrypoints
- If needed, override entrypoints via environment variables

Example:
```bash
export REGISTRY_INIT_ENTRYPOINT=init_simple
export ROUTER_INIT_ENTRYPOINT=init
./scripts/casper/deploy.sh testnet /path/to/secret_key.pem
```

### 4) `sync-rate.sh` cannot read the ybToken rate
- `sync-rate.sh` currently **computes the rate from storage (`assets/total_shares`)**.
- If it cannot read storage, it **fails by design instead of guessing** (for safety).

Workaround (temporary):
```bash
export OVERRIDE_YBTOKEN_RATE=<u256_rate_scaled_by_1e18>
./scripts/casper/sync-rate.sh testnet /path/to/keeper_secret_key.pem
```

---

## 13) Mainnet deployment (important warnings)

Mainnet uses **real assets**. Confirm all of the following before proceeding:

1) All parameters are confirmed (`docs/casper/decision/parameter-confirmation.md`)
2) Smoke tests completed
3) Team sign-off / checklist passed

Mainnet deployment command:

```bash
cd /path/to/cspr-cdp
./scripts/casper/deploy.sh mainnet /path/to/secret_key.pem
```

Also **reset environment variables** for mainnet:
```bash
export CSPR_DECIMALS=9  # 1 CSPR = 1,000,000,000 motes
export SCSPR_DECIMALS=TBD
export SCSPR_TOKEN_HASH=TBD
export SCSPR_LST_HASH=TBD
```

---

## 14) Reference files

- Deployment records: `deployments/casper/*.json`
- Contract address registry: `CONTRACT.md`
- Frontend env config: `frontend/.env.local`

---

## 15) Remaining work (summary)

These are the major items needed to reach “post-deploy production readiness” (ticket-based):

- **LST operations/validation**: rate sync cadence, monitoring, and incident runbook hardening (TICKET-22)
- **CDP core completion**: gUSD mint/burn, stCSPR token flows (approve/transfer_from), liquidation/redemption/stability pool implementation (TICKET-02/04/06/07/08/09)
- **Production quality**: mainnet parameter confirmation + smoke/checklists + observability/alerts (TICKET-15, docs/*)
