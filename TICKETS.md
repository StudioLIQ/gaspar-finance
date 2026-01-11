# Casper CDP (LiquityV2-Style) — Implementation Tickets

Scope: Casper-native CDP protocol implementing LiquityV2-equivalent functionality **without leverage features**. Supports **CSPR** and **stCSPR** collateral, uses **Styks (Odra) oracle**, per-vault interest rate selection, redemptions, stability pool, liquidations, and full deployment + frontend integration.

---

## Global Constraints & Decisions

- Collateral: **CSPR (native)** and **stCSPR (token, likely CEP-18)**.
- Oracle: **Styks (Odra)** with composite pricing for stCSPR when no direct feed exists (canonical composite).
- Interest: Liquity-style per-vault interest rate selection; no leverage flow.
- Redemption: Supported, with fee and ordering semantics comparable to LiquityV2.
- Safety: Circuit breaker safe_mode (ADR-001) must be enforced consistently.
- Do not hard-code ambiguous network values; use `docs/casper/decision/parameter-confirmation.md`.

---

## TICKET-00 — Repo Scaffold & Casper Contract Workspace

**Goal:** Introduce a Casper smart contract workspace (Rust/Odra or Casper SDK) isolated from frontend and default Node tasks.

**Requirements**
- Create a new directory (e.g., `casper/`) for contract code.
- Add build/test scripts under `scripts/casper/` or `casper/Makefile`.
- Ensure no Rust/Cargo tools run during default frontend or root Node tasks.
- Document the structure in `docs/casper/ops/README.md`.

**Deliverables**
- `casper/` project with `contracts/`, `tests/`, `session/` (if needed), `scripts/`.
- `scripts/casper/build.sh`, `scripts/casper/test.sh`, `scripts/casper/deploy.sh` (or equivalent).
- README describing how to build/test/deploy.

---

## TICKET-01 — Core Protocol Architecture (Router + Branches)

**Goal:** Implement a Router/Branch architecture for two collateral types (CSPR/stCSPR) with shared semantics.

**Requirements**
- Router dispatches by `collateralId` to BranchCSPR or BranchSCSPR.
- Branches implement identical vault logic and share core interfaces.
- Maintain a registry for branches and collateral metadata.

**Deliverables**
- Router contract
- BranchCSPR contract
- BranchSCSPR contract
- Registry/Config contract(s)
- Interface definitions + shared types

---

## TICKET-02 — Vault System (Open/Adjust/Close)

**Goal:** Implement vault lifecycle for both collateral types.

**Requirements**
- openVault(collateralId, collateralAmount, debtAmount, interestRateBps)
- adjustVault (collateral up/down, debt up/down)
- closeVault (repay all debt, withdraw collateral)
- Enforce MCR, min debt, fee rules
- Enforce safe_mode restrictions (allow repay/add only)

**Deliverables**
- Vault storage & indexing
- Sorted vaults by interest rate (and/or risk ordering)
- Query methods for vault status, ICR, collateral, debt

---

## TICKET-03 — Interest Rate Model (Per-Vault)

**Goal:** Enable per-vault interest rate selection akin to LiquityV2.

**Requirements**
- Interest accrual for vault debt
- Rate bounded by protocol limits (e.g., 0–40% or configurable)
- Proper accounting in redemptions and liquidations

**Deliverables**
- Interest accrual module
- Rate configuration parameters
- Tests for accrual correctness

---

## TICKET-04 — Stablecoin (gUSD) + Treasury

**Goal:** Implement protocol stablecoin with mint/burn controlled by the protocol and fee distribution.

**Requirements**
- Mint on borrow, burn on repay/redemption
- Fees routed to treasury
- Access control for protocol contracts

**Deliverables**
- Stablecoin contract (`gUSD`)
- Treasury contract
- Access control policies

---

## TICKET-05 — Oracle Adapter (Styks/Odra)

**Goal:** Implement oracle adapter with composite pricing for stCSPR and safe_mode policy enforcement.

**Requirements**
- Direct CSPR/USD feed
- stCSPR/USD direct feed optional; composite is canonical
- Composite formula: P(stCSPR) = P(CSPR) * R
- Freshness rules + deviation thresholds
- last_good_price logic updated only on deploy/write

**Deliverables**
- OracleAdapter contract
- Composite calculation utilities
- Safe_mode latch/clear routines
- Tests for stale/deviation cases

---

## TICKET-06 — Liquidation Engine

**Goal:** Implement liquidations for under-collateralized vaults.

**Requirements**
- Single and batch liquidation
- Penalty/fee distribution per spec
- Works for both collaterals

**Deliverables**
- LiquidationEngine contract
- Liquidation tests and scenarios

---

## TICKET-07 — Stability Pool

**Goal:** Implement Stability Pool for absorbing bad debt and distributing collateral gains.

**Requirements**
- Deposits/withdrawals of gUSD
- Gain distribution by collateral type
- Safe_mode restrictions applied

**Deliverables**
- StabilityPool contract
- Tests for deposit/withdraw/gains

---

## TICKET-08 — Redemption Engine

**Goal:** Implement redemption of gUSD for collateral, respecting interest rates and ordering rules.

**Requirements**
- Redeem gUSD by collateralId
- Ordering based on interest rate (low APR first)
- Fee computation + treasury routing
- Optional cap/slippage protection

**Deliverables**
- Redemption module
- Tests for redemption ordering/fees

---

## TICKET-09 — Casper Token Integrations (stCSPR)

**Goal:** Implement CEP-18 token interactions for stCSPR.

**Requirements**
- Approve/transfer_from flow
- Handle fee-on-transfer (net received accounting)
- Explicit handling of non-standard callbacks

**Deliverables**
- Token adapter
- Tests for fee-on-transfer and edge cases

---

## TICKET-10 — Access Control & Governance

**Goal:** Define roles for admin functions, safe_mode control, and upgrades.

**Requirements**
- Admin role for oracle refresh and config updates
- Role separation for treasury
- Clear upgrade path (if proxy/upgradable contracts are used)

**Deliverables**
- Access control module
- Admin entrypoints

---

## TICKET-11 — Casper Deployment Tooling

**Goal:** Implement deployment scripts and record generation for Casper networks.

**Requirements**
- Build WASM artifacts
- Deploy Router, Branches, Stablecoin, OracleAdapter, StabilityPool, LiquidationEngine, Treasury
- Initialize config + register branches
- Generate deployment record file in `deployments/casper/<network>-<date>.json`

**Deliverables**
- `scripts/casper/deploy.sh` (or equivalent)
- Deployment record generator
- Optional smoke script

---

## TICKET-12 — Post-Deployment Binding to Frontend

**Goal:** Update frontend to use deployed Casper contract hashes/addresses and query endpoints.

**Requirements**
- Environment file `.env.local` with Casper RPC + contract refs
- UI surfaces network config and wallet state
- Minimal read-only protocol status until full integration

**Deliverables**
- Frontend config changes
- Environment template updates

---

## TICKET-13 — Frontend Casper Integration (Full)

**Goal:** Implement full Casper wallet + protocol interactions in the frontend.

**Requirements**
- Wallet connect + public key display
- Query: vault status, oracle price, stability pool status
- Deploy: open/adjust/close vault, deposit/withdraw SP, redemption
- Transaction status feedback

**Deliverables**
- Casper client SDK wrapper (browser)
- Hooks for query/deploy actions
- Updated UI components

---

## TICKET-16 — Frontend LST (stCSPR ybToken + Withdraw Queue)

**Goal:** Add LST (stCSPR) UX and contract interfaces to the frontend (Casper testnet + Casper Wallet only).

**Context**
- LST spec (ybToken model, request-time quote/lock, single-validator testnet): `LST.md`
- Oracle composite convention for stCSPR requires: `R = CSPR_PER_SCSPR` (`docs/casper/spec/oracle.md`)

**Requirements**
- Navigation/IA
  - Add a top-level **tab/route split**: `CDP` vs `LST` (recommended) to avoid mixing mental models.
  - The LST UI should have at least 2 sub-tabs (or sections):
    - **Stake**: CSPR → stCSPR (deposit/mint)
    - **Unstake**: stCSPR → CSPR (request/claim; show withdraw queue status)
- Contract refs/config
  - Add env vars + config mapping for LST contracts:
    - `NEXT_PUBLIC_SCSPR_YBTOKEN_HASH`
    - `NEXT_PUBLIC_WITHDRAW_QUEUE_HASH`
  - Display “not deployed” state gracefully (read-only placeholders).
- Read interfaces (query)
  - Exchange rate display: `R = CSPR_PER_SCSPR` from on-chain `cspr_per_scspr()` (or `exchange_rate()`)
  - `total_assets()`, `total_shares()` (optional but recommended for transparency)
  - User balances: CSPR balance, stCSPR balance
  - Withdraw queue:
    - List user requests (requires on-chain query endpoints; otherwise define an off-chain indexing fallback)
    - Request detail: quoted shares/assets/rate, status (pending/claimable/claimed), timestamps/ETA if available
- Write interfaces (deploy)
  - Stake (deposit): send native CSPR and mint stCSPR
  - Unstake (request): lock stCSPR in `withdraw_queue` with **request-time quote** stored on-chain
    - If queue uses `transfer_from`, implement an **approve → request_withdraw** UX
  - Claim: claim by `request_id` (and settle/burn locked shares as per LST design)
- UX requirements
  - Show a clear quote preview before request (expected CSPR out at request-time rate)
  - Transaction status feedback (pending/success/fail) + explorer link
  - Prevent obvious footguns: missing approvals, missing contract hashes, disconnected wallet

**Deliverables**
- New Next.js routes or tabbed UI components (`frontend/app/*`, `frontend/components/*`)
- New hooks for LST queries/writes (`frontend/hooks/*`)
- Config/env template updates (`frontend/.env.local.example`, `frontend/lib/config.ts`)

---

## TICKET-17 — LST Contracts (stCSPR ybToken + Withdraw Queue)

**Goal:** Implement Casper testnet LST contracts that produce stCSPR as a **ybToken (appreciating exchange rate, non-rebasing)** and support a **request-time quote + lock** withdraw flow.

**Spec**
- LST plan: `LST.md`
- Oracle composite expects: `R = CSPR_PER_SCSPR` (`docs/casper/spec/oracle.md`)
- Ambiguous values must follow confirmation procedure: `docs/casper/decision/parameter-confirmation.md`

**Requirements**
- Contracts
  - `scspr_ybtoken`:
    - Native CSPR deposit → mint stCSPR shares (no rebase)
    - Read endpoints: `total_assets`, `total_shares`, `cspr_per_scspr`, `convert_to_assets`, `convert_to_shares`
    - Testnet delegation policy: **single validator** with fixed key from `LST.md`
  - `withdraw_queue`:
    - `request_withdraw(shares)` locks stCSPR via `transfer_from` (approve flow) and stores **request-time quote**
    - `claim(request_id)` pays CSPR and settles by burning (or equivalent) locked shares
    - Query endpoints to support frontend:
      - `get_request(request_id)`
      - `get_user_pending_requests(user)`
      - `get_user_request_count(user)` + `get_user_request_at(user, index)` (pagination-friendly)
- Accounting decisions (MVP)
  - `total_assets` is conservative NAV; `pending_rewards` excluded until realized/compounded
  - Rounding policy is fixed and tested (e.g., floor on mint/quote conversions)
- Tests
  - Unit/integration tests for mint/convert consistency, lock+quote persistence, claim settlement

**Deliverables**
- Contract modules under `casper/contracts/src/*` + export in `casper/contracts/src/lib.rs`
- Minimal tests under `casper/tests/*`
- Deployment integration update (either extend existing deploy script or add a dedicated LST deploy step) and record fields for LST contracts

---

## TICKET-18 — WithdrawQueue Cross-Contract Integration (ybToken)

**Goal:** Make `withdraw_queue` actually lock shares, quote real rate, burn locked shares, and transfer CSPR on claim (no stubs).

**Context / Current State**
- `withdraw_queue` currently contains stubbed internal functions and a placeholder 1:1 rate:
  - `get_current_rate`, `lock_shares_from_user`, `burn_locked_shares`, `transfer_cspr_to_user`
  - See `casper/contracts/src/withdraw_queue.rs` (TODO markers).
- `scspr_ybtoken` already exposes the queue integration entrypoints:
  - `transfer_from(owner, recipient, amount)` (CEP-18)
  - `get_exchange_rate() -> U256` (scaled 1e18)
  - `burn_from_queue(owner, amount)` (queue-only)
  - `transfer_cspr_to_user(recipient, amount)` (queue-only)
  - See `casper/contracts/src/scspr_ybtoken.rs`.
- Deployment script already wires the link:
  - `ybtoken.set_withdraw_queue(queue)` is called in `casper/scripts/deploy.sh`

**Requirements**
- Replace all stubs in `withdraw_queue` with real cross-contract calls to `scspr_ybtoken`.
  - Quote rate at request-time using `ybtoken.get_exchange_rate()` (CSPR_PER_SCSPR, 1e18 scale).
  - Lock shares by calling `ybtoken.transfer_from(owner, queue_address, shares)`.
  - On claim:
    - Burn shares from the queue’s own balance (shares are held by the queue after lock).
    - Transfer CSPR to the request owner via `ybtoken.transfer_cspr_to_user(owner, quoted_assets)`.
- Ensure all checks remain correct:
  - request-time quote is preserved even if rate later changes
  - claim cooldown uses configured `unbonding_period`
  - status transitions are consistent (Pending → Claimable/Claimed)
- Add or update integration tests that deploy both contracts and execute:
  - deposit → approve → request_withdraw → (advance time) → claim
  - Use `odra-casper-test-vm` under `casper/tests/*`

**Deliverables**
- Updated `casper/contracts/src/withdraw_queue.rs` with no stubbed cross-contract paths
- Updated/added tests under `casper/tests/*` proving end-to-end behavior

---

## TICKET-19 — LST Frontend: Real Deploy Signing + Submit (Stake/Approve/Request/Claim)

**Goal:** Replace placeholder “not implemented” LST actions with real Casper Wallet signed deploys and node submission.

**Context / Current State**
- LST UI and route exist: `frontend/app/lst/page.tsx`
- LST hook has placeholder tx flows:
  - stake: `frontend/hooks/useLst.ts` (currently sets a “not implemented” error)
  - requestUnstake / claimWithdraw similarly placeholder
- Payable deposit requires proxy-caller WASM (already vendored):
  - `frontend/public/odra/proxy_caller.wasm`
  - `frontend/public/odra/proxy_caller_with_return.wasm`

**Requirements**
- Implement Casper deploy building + signing + submission:
  - Stake: build a deploy using `proxy_caller.wasm` to call `ybtoken.deposit` with attached CSPR
  - Unstake: 2-step UX and deploys:
    - `ybtoken.approve(spender=withdraw_queue, amount=shares)`
    - `withdraw_queue.request_withdraw(shares)`
  - Claim: `withdraw_queue.claim(request_id)`
- Wallet integration:
  - Extend wallet helper detection to support deploy signing (Casper Wallet API variants differ).
  - Provide clear errors if required wallet signing methods are missing.
- UX requirements:
  - tx status: signing → pending → success/error, and store deploy hash
  - explorer links for deploy hash (testnet)
  - disable buttons for missing contract hashes / disconnected wallet / invalid input
- Keep dependencies minimal, but if needed add Casper SDK dependency to correctly construct deploys and runtime args.

**Deliverables**
- Working implementations in:
  - `frontend/hooks/useLst.ts` (actions)
  - `frontend/lib/*` (deploy builder + submit helper)
- Update `LstStubWarning` messaging based on actual contract state (after TICKET-18 stubs removed).

---

## TICKET-20 — LST Frontend: Read-Only RPC Queries (Vars + Dictionaries) + Cooldown Accuracy

**Goal:** Make LST dashboard data accurate using Casper JSON-RPC, without relying on made-up key paths.

**Context / Current State**
- Current RPC helpers use incorrect assumptions like:
  - `queryContractState(ybTokenHash, ['cspr_per_scspr'])`
  - `balances_${publicKey}` and `user_requests_${publicKey}`
  - See `frontend/lib/casperRpc.ts`
- UI currently claims a “7-day cooldown”, but contract default is **7 hours (25200 seconds)** unless configured:
  - See `casper/contracts/src/withdraw_queue.rs` (`DEFAULT_UNBONDING_PERIOD`)
  - See UI copy in `frontend/components/LstUnstakeCard.tsx`

**Requirements**
- Implement proper read-only state queries:
  - Fetch contract `named_keys` via `query_global_state` on the contract hash
  - Read `Var` values by querying URef from `named_keys` (e.g., total_shares, assets breakdown, last_sync_timestamp)
  - Read `Mapping`/dictionary items using `state_get_dictionary_item` (ContractNamedKey + dictionary_item_key)
- Ensure the UI’s cooldown display comes from on-chain config:
  - `withdraw_queue.get_config().unbonding_period` (or equivalent stored config var)
  - Replace hard-coded “7-day” copy with derived values
- Fix account CSPR balance query:
  - Use `state_get_account_info` to get `main_purse` URef, then `state_get_balance` using purse URef
- If dictionary key derivation proves too difficult for some mappings:
  - Provide a “Read via on-chain proxy call” fallback button using `proxy_caller_with_return.wasm` (user-signed) for specific getters
  - Keep the main UI functional with graceful degradation

**Deliverables**
- Updated `frontend/lib/casperRpc.ts` (or new modules) with correct RPC query patterns
- Update LST components to use the improved data (rate, totals, balances, requests, cooldown)

---

## TICKET-21 — Deployment Tooling: Single Source of Truth + FE Binding E2E (Including LST)

**Goal:** Remove confusion between multiple deploy scripts and ensure the deployment record + frontend binding fully cover LST.

**Context / Current State**
- There are two deployment scripts:
  - `scripts/casper/deploy.sh` (placeholder style)
  - `casper/scripts/deploy.sh` (automated full deploy; includes LST section)
- Binding script now supports LST env vars:
  - `casper/scripts/bind-frontend.sh` writes `NEXT_PUBLIC_SCSPR_YBTOKEN_HASH` / `NEXT_PUBLIC_WITHDRAW_QUEUE_HASH`

**Requirements**
- Decide and document the one true deployment path (recommend: `casper/scripts/deploy.sh`).
  - Either update `scripts/casper/deploy.sh` to delegate to it, or clearly deprecate/remove the placeholder path.
- Ensure deployment record schema includes and is populated with:
  - `contracts.scsprYbToken.*`, `contracts.withdrawQueue.*`
- Ensure frontend binding is “drop-in”:
  - `nodeAddress` written to env ends with `/rpc` (Casper JSON-RPC endpoint)
  - contract hashes are wired into `.env.local.example` and `config/casper-<network>.json`
- Add a short runbook section (or update existing) showing:
  1) deploy
  2) bind frontend
  3) open /lst and interact

**Deliverables**
- Updated scripts and docs:
  - `casper/scripts/deploy.sh`, `scripts/casper/deploy.sh` (as decided)
  - `casper/scripts/bind-frontend.sh`
  - `docs/casper/ops/*` (runbook note)

---

## TICKET-22 — LST Ops: Operator/Keeper Workflows (Asset Sync + Oracle Rate Sync)

**Goal:** Provide operational scripts/runbooks for keeping `total_assets` and oracle exchange rate in sync over time.

**Context**
- ybToken is MVP “operator-based staking sync”:
  - `scspr_ybtoken.sync_assets(delegated, undelegating, claimable)`
  - `scspr_ybtoken.withdraw_idle_for_delegation(amount)` / `deposit_from_operator()`
  - See `casper/contracts/src/scspr_ybtoken.rs`
- Oracle adapter expects periodic `sync_rate_from_ybtoken(rate)` and stores `last_good_exchange_rate`:
  - See `casper/contracts/src/oracle_adapter.rs`

**Requirements**
- Provide an operator script (CLI) that can:
  - Read current ybToken asset breakdown + rate
  - Submit `sync_assets` updates
  - (Optional) Move idle → delegated accounting when delegating off-chain
- Provide a keeper script (CLI) that can:
  - Read ybToken rate (`get_exchange_rate`)
  - Call `oracle.sync_rate_from_ybtoken(rate)` on schedule
- Update runbooks to explain:
  - frequency, failure modes, safe_mode implications, and verification steps

**Deliverables**
- One or more scripts under `casper/scripts/` (or `scripts/`) + minimal docs under `docs/casper/ops/`

---

## TICKET-14 — Test Suite

**Goal:** Add unit + integration tests for all core flows.

**Requirements**
- Vault lifecycle tests (CSPR/stCSPR)
- Oracle stale/deviation tests
- Liquidation tests
- Redemption ordering tests
- Stability pool tests

**Deliverables**
- Casper test runner integration
- Test vectors usage (from docs)

---

## TICKET-15 — Documentation Updates

**Goal:** Keep docs in sync with implementation.

**Requirements**
- Update runbooks and ADR references
- Add deployment instructions to `docs/casper/ops`
- Add frontend binding notes

**Deliverables**
- Updated markdown files

---
