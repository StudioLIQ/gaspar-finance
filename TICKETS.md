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

## Recommended Build Order (E2E: Stability Pool + Redemption + Frontend)

1. **Token movement primitives**: `TICKET-04` (gUSD usable transfers/burn) + `TICKET-09` (CEP-18 adapter for stCSPR)
2. **Stability Pool “no-stubs” wiring**: `TICKET-25` (gUSD/stCSPR transfers; remove placeholders)
3. **Liquidations wiring**: `TICKET-28` (branch + SP offset + collateral movement)
4. **Redemption “no-stubs” wiring**: `TICKET-26` (oracle price + vault iteration + gUSD burn/fee routing)
5. **Branch APIs**: `TICKET-27` (sorted vaults + redemption/liquidation mutation entrypoints)
6. **Frontend shipping (real reads, no mocks)**: `TICKET-29` (SP/Redemption read + write UX)
7. **Hardening**: `TICKET-31` (smoke scripts + runbook) + `TICKET-14` (tests) + `TICKET-15` (docs)

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

**Context / Current State**
- Contract skeleton exists, but core liquidation flow is not wired end-to-end (oracle + branch updates + StabilityPool offset + collateral transfers).
- See TODOs in `casper/contracts/src/liquidation_engine.rs`.

**Requirements**
- Single and batch liquidation
- Penalty/fee distribution per spec
- Works for both collaterals

**Implementation Requirements (E2E)**
- Pull real prices via oracle adapter (no placeholder pricing).
- Read vault state from branch (or router → branch) and apply liquidation math against actual vault storage.
- Support “offset” against Stability Pool (when configured) and “redistribution” / fallback path when SP is empty (as per chosen spec).
- Move assets:
  - Burn/redistribute gUSD debt as needed (stablecoin calls).
  - Transfer seized collateral to pool/receivers (native CSPR + CEP-18 stCSPR).
- Enforce authorization (e.g., liquidator role) and safe_mode semantics consistently.

**Deliverables**
- LiquidationEngine contract
- Liquidation tests and scenarios

---

## TICKET-07 — Stability Pool

**Goal:** Implement Stability Pool for absorbing bad debt and distributing collateral gains.

**Context / Current State**
- Product/sum accounting is present, and `deposit/withdraw` entrypoints exist.
- Missing the critical “money movement” and wiring:
  - No `gUSD transfer_from` on deposit, no `gUSD transfer` on withdraw.
  - No collateral gain transfer to depositors.
  - No authorized liquidator check for offset/updates.
  - Admin access control is TODO.
- See TODOs in `casper/contracts/src/stability_pool.rs` (e.g., transfer TODOs around deposit/withdraw and liquidator checks).

**Requirements**
- Deposits/withdrawals of gUSD
- Gain distribution by collateral type
- Safe_mode restrictions applied

**Implementation Requirements (E2E)**
- Stablecoin integration:
  - On `deposit(amount)`: transfer `amount` gUSD from caller → pool contract.
  - On `withdraw(amount)`: transfer `amount` gUSD from pool contract → caller.
  - On “offset” during liquidation: reduce pool deposits and account absorbed debt (stablecoin burn/settlement semantics must be defined and tested).
- Collateral gains:
  - Track gains per collateral type and support claiming (either auto-claim on deposit/withdraw or explicit `claim()`).
  - Transfer CSPR gains (native) and stCSPR gains (CEP-18) to depositor.
- Liquidation wiring:
  - Add an entrypoint callable by LiquidationEngine to apply an offset: `(debt_absorbed, collateral_added, collateral_id)`.
  - Enforce “only liquidation engine” (or liquidator role) for the liquidation entrypoint.
- Safety + permissions:
  - Deposits allowed in safe_mode; withdrawals/claims blocked in safe_mode (as documented).
  - Admin-only setters (e.g., set liquidation engine, set registry/stablecoin references if applicable).

**Acceptance Criteria**
- Deposit reduces user gUSD balance and increases pool total deposits (observable via queries).
- Withdraw increases user gUSD balance and reduces pool total deposits; blocked when safe_mode is active.
- Liquidation offset reduces deposits and increases claimable collateral gains; only authorized caller can invoke.
- Gains can be claimed and actually transferred to user (CSPR and stCSPR paths).

**Deliverables**
- StabilityPool contract
- Tests for deposit/withdraw/gains

---

## TICKET-08 — Redemption Engine

**Goal:** Implement redemption of gUSD for collateral, respecting interest rates and ordering rules.

**Context / Current State**
- Redemption math scaffolding exists (`redeem`, fee model, slippage guard), but core mechanics are stubbed:
  - Oracle price fetch is a placeholder (returns 1.0).
  - Vault iteration is not implemented (simulated count), and sorted vault retrieval is empty.
  - No transfers: gUSD is not transferred/burned; collateral + fee are not sent.
- See TODOs in `casper/contracts/src/redemption_engine.rs` (oracle, vault iteration, transfers).

**Requirements**
- Redeem gUSD by collateralId
- Ordering based on interest rate (low APR first)
- Fee computation + treasury routing
- Optional cap/slippage protection

**Implementation Requirements (E2E)**
- Pricing:
  - Fetch real price for `collateral_id` via oracle adapter (and enforce freshness / last-good logic as per oracle policy).
- Ordering + iteration:
  - Implement deterministic vault iteration in ascending interest-rate order (source of truth: Branch storage / sorted set; do not rely on off-chain hints for correctness).
  - Support partial redemption across multiple vaults with a bounded `max_iterations` parameter.
- State transitions:
  - For each touched vault: reduce debt, reduce collateral, handle full close if redeemed completely.
  - Keep protocol-wide accounting consistent (totals, fees, events/logging as appropriate).
- Asset transfers:
  - Transfer gUSD from redeemer and burn it (or burn from redeemer allowance) for the redeemed amount.
  - Transfer redeemed collateral (minus fee) to redeemer.
  - Transfer fee portion to treasury.
- Safety + permissions:
  - Redemptions blocked in safe_mode; enforced at the top-level entrypoint.

**Acceptance Criteria**
- Redemption consumes gUSD and pays out collateral at oracle price minus fee.
- Vault ordering follows “lowest interest rate first” and is reproducible without hints.
- `redeem_with_protection` reverts when `min_collateral_out` is not met.
- Fee is routed to treasury and reflected in accounting.

**Deliverables**
- Redemption module
- Tests for redemption ordering/fees

---

## TICKET-09 — Casper Token Integrations (stCSPR)

**Goal:** Implement CEP-18 token interactions for stCSPR.

**Context / Current State**
- `token_adapter` exists but has multiple TODOs for real cross-contract calls and access control.
- Branch and protocol flows that depend on CEP-18 (stCSPR collateral, pool gains, redemptions) cannot be end-to-end without this.

**Requirements**
- Approve/transfer_from flow
- Handle fee-on-transfer (net received accounting)
- Explicit handling of non-standard callbacks

**Implementation Requirements (E2E)**
- Implement actual CEP-18 cross-contract calls for:
  - `approve`, `allowance`, `balance_of`, `transfer`, `transfer_from`
- Add “net received” accounting for fee-on-transfer tokens (store expected vs received amounts).
- Define a consistent error mapping for token call failures/reverts.
- Enforce admin/registry-based configuration and restrict setters (no public mutation on production paths).

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

## TICKET-23 — Frontend: Stability Pool (Deposit/Withdraw/Claim)

**Goal:** Ship a Stability Pool UX that matches the on-chain StabilityPool E2E behavior (deposit, withdraw, gains), with clear safe_mode handling.

**Dependencies**
- `TICKET-07` (StabilityPool E2E)
- `TICKET-04` (gUSD transfers/burn semantics usable on-chain)
- `TICKET-09` (CEP-18 adapter for stCSPR gains) for the stCSPR gain path
- Frontend binding provides hashes: `NEXT_PUBLIC_STABILITY_POOL_HASH`, `NEXT_PUBLIC_STABLECOIN_HASH`

**UX Requirements**
- Show:
  - User deposit (compounded)
  - Pending gains (CSPR + stCSPR)
  - Pool stats (total deposits, total debt absorbed, collateral totals)
  - Current safe_mode state and what actions are blocked
- Actions:
  - Deposit gUSD (requires approve → deposit; show allowance state)
  - Withdraw gUSD (blocked in safe_mode)
  - Claim gains (if implemented as explicit call; blocked in safe_mode)
- Transaction UX:
  - Casper Wallet signing, explorer link, pending/success/fail states
  - Guardrails for missing contract hashes / disconnected wallet / insufficient balance

**Frontend Implementation**
- Routes/UI
  - Add a CDP area that includes a “Stability Pool” section (page or tab).
- Read-only queries (RPC)
  - Read pool Vars via named_keys (totals, safe_mode) and depositor snapshot via dictionary (if feasible).
  - If Address-keyed mapping dictionary keys are not stable for FE, switch to contract getter entrypoints and use a signed “proxy read” fallback only if needed.
- Write deploy builders (Wallet)
  - CEP-18 `approve(stability_pool_package_hash, amount)` (gUSD)
  - StabilityPool `deposit(amount)` / `withdraw(amount)` / `claim()` (if exists)
  - Public entrypoints called by the wallet should use **primitive CLTypes** only (e.g., `U256`, `U64`, `U8`, `Key`, `String`). If any getter currently requires Odra-specific types, add deploy-friendly aliases.

**Deliverables**
- New hook: `frontend/hooks/useStabilityPool.ts`
- New components/cards under `frontend/components/` (stats + actions)
- Contract read helpers added to `frontend/lib/casperRpc.ts` (or a new module) for SP state
- Deploy builders added to `frontend/lib/casperDeploy.ts` as needed

---

## TICKET-24 — Frontend: Redemption (Redeem gUSD → Collateral)

**Goal:** Ship a Redemption UX that lets users redeem gUSD for CSPR/stCSPR with fee/price visibility and slippage protection.

**Dependencies**
- `TICKET-08` (RedemptionEngine E2E)
- `TICKET-05` (oracle adapter must return real price; last-good + freshness policy)
- Frontend binding provides hashes: `NEXT_PUBLIC_REDEMPTION_ENGINE_HASH`, collateral branch hashes, token hashes

**UX Requirements**
- Inputs:
  - Collateral selection (CSPR vs stCSPR)
  - Redeem amount (gUSD)
  - Slippage protection (min collateral out) and max fee bps cap
- Display:
  - Current redemption fee bps (and a clear “max fee” control)
  - Oracle price used and estimated collateral out
  - Summary of what happens (burn gUSD, receive collateral, fee to treasury)
- Actions:
  - Approve gUSD spending (if redemption pulls via transfer_from) or send gUSD (if burn-from-caller pattern is used)
  - Redeem (blocked in safe_mode)

**Frontend Implementation**
- Routes/UI
  - Add a “Redemption” section under CDP area (page or tab).
- Read-only queries (RPC)
  - Fee parameters + current fee, safe_mode, and oracle price (source: oracle adapter / engine vars).
  - Prefer an on-chain `preview_redeem(...)` getter if available; otherwise do a best-effort estimate in FE and clearly label as estimate.
- Write deploy builders (Wallet)
  - RedemptionEngine `redeem_with_protection(collateral_id, csprusd_amount, min_collateral_out, max_fee_bps, hint?)`
  - Optional: a lightweight “hint” builder if the contract accepts hints, but correctness must not depend on it.
  - Public entrypoints called by the wallet should use **primitive CLTypes** only. In particular, do not require the frontend to encode Odra enums; prefer `collateral_id_u8` (0 = CSPR, 1 = stCSPR) on the external ABI if needed.

**Deliverables**
- New hook: `frontend/hooks/useRedemption.ts`
- New components/cards under `frontend/components/` (inputs + quote + submit)
- Contract read helpers added to `frontend/lib/casperRpc.ts` (or a new module) for redemption state/quote
- Deploy builders added to `frontend/lib/casperDeploy.ts` as needed

---

## TICKET-25 — Contracts: Stability Pool Real Transfers (gUSD + stCSPR)

**Goal:** Remove all placeholder logic from StabilityPool related to gUSD and stCSPR movement so that deposit/withdraw/claim/offset work on-chain.

**Context / Current State**
- `StabilityPool` compiles and has the right entrypoints, but core token movements are still TODO/placeholder:
  - `deposit`: gUSD transfer_from is not executed.
  - `withdraw`: gUSD transfer is not executed.
  - `transfer_gains_internal`: stCSPR transfer is not executed.

**Requirements**
- Use Odra `#[odra::external_contract]` refs to call:
  - gUSD: `transfer_from`, `transfer`
  - stCSPR: `transfer` (and optionally `balance_of` for sanity)
- Ensure failures revert (do not “assume success”).
- Keep safe_mode restrictions: deposits allowed; withdraw/claim blocked.

**Acceptance Criteria**
- After `deposit(amount)`, depositor gUSD decreases and pool gUSD balance increases by `amount`.
- After `withdraw(amount)`, depositor gUSD increases and pool gUSD balance decreases by `amount` (blocked in safe_mode).
- After `claim_gains()`, depositor receives CSPR transfer and/or stCSPR transfer; pool collateral balances decrease accordingly.

**Deliverables**
- Updated `casper/contracts/src/stability_pool.rs` (no placeholder transfer comments on the critical path)

---

## TICKET-26 — Contracts: Redemption Real Oracle + Vault Iteration + Transfers

**Goal:** Remove all placeholder logic from RedemptionEngine so redeeming gUSD actually burns gUSD, iterates vaults deterministically, and transfers collateral + fees.

**Context / Current State**
- `get_price` returns a placeholder value.
- `process_redemption` is a placeholder (returns a constant).
- gUSD burn/settlement is placeholder.
- stCSPR transfers are placeholder.

**Requirements**
- Oracle:
  - Fetch real collateral price via oracle adapter (no hard-coded `$1.00`).
- Vault iteration:
  - Deterministically traverse “lowest interest rate first” via Branch APIs (see `TICKET-27`).
  - Support bounded iteration (`max_iterations`).
- Token flows:
  - Pull gUSD from redeemer using allowance (`transfer_from`), then burn from RedemptionEngine’s own balance (`burn`), OR another documented pattern that is consistent and tested.
  - Transfer collateral to redeemer and fee to treasury (CSPR + stCSPR paths).
- Safe mode:
  - Redemptions blocked in safe_mode.

**Acceptance Criteria**
- `redeem_u8(0|1, amount, ...)` changes balances: redeemer gUSD decreases; redeemer collateral increases; treasury receives fee.
- Price used is sourced from oracle adapter (not a constant).
- Vault touch count reflects real iteration order.

**Deliverables**
- Updated `casper/contracts/src/redemption_engine.rs` (no placeholder price/iteration/transfer logic)
- Any required small ABI additions to support FE (`*_u8` entrypoints are preferred)

---

## TICKET-27 — Contracts: Branch APIs for Redemption/Liquidation (SSOT)

**Goal:** Provide the missing Branch entrypoints so RedemptionEngine/LiquidationEngine can operate without off-chain correctness dependencies.

**Requirements**
- Read APIs:
  - Get vaults in ascending interest rate order (or iterator-style pagination).
  - Get per-vault debt/collateral/rate for a given owner.
- Write APIs:
  - Reduce vault debt/collateral during redemption (partial + full close).
  - Seize collateral and close vaults during liquidation paths.
- FE-friendly ABI:
  - Use primitive args/returns where possible; avoid requiring FE to encode Odra enums.

**Acceptance Criteria**
- RedemptionEngine can redeem across multiple vaults without placeholder logic.
- LiquidationEngine can seize/close with real branch calls.

**Deliverables**
- Updates in `casper/contracts/src/branch_cspr.rs` and `casper/contracts/src/branch_scspr.rs`
- Any shared interface updates in `casper/contracts/src/interfaces.rs`

---

## TICKET-28 — Contracts: Liquidation Engine Wiring (Branch + SP Offset + Transfers)

**Goal:** Remove placeholders in LiquidationEngine and wire real interactions with Branch, StabilityPool offset, and collateral movement.

**Context / Current State**
- Core flow still contains TODOs for cross-contract calls (branch queries, oracle, SP, stCSPR transfers, vault close).

**Requirements**
- Use oracle adapter for prices (no placeholders).
- Use Branch APIs (see `TICKET-27`) to read vault status and apply liquidation.
- If offsetting via StabilityPool:
  - Call `stability_pool.offset_u8(...)` and reflect absorbed debt/collateral.
- Move collateral:
  - CSPR via attached value or native transfer as per chosen flow.
  - stCSPR via CEP-18 transfer (no placeholder).

**Acceptance Criteria**
- Liquidation of an undercollateralized vault produces observable on-chain state changes and transfers.

**Deliverables**
- Updated `casper/contracts/src/liquidation_engine.rs` (no placeholder calls on the critical path)

---

## TICKET-29 — Frontend: Replace SP/Redemption Mocks with On-Chain Reads

**Goal:** Remove mock balances/stats from `useStabilityPool` and `useRedemption` and replace with real RPC reads and accurate UI states.

**Context / Current State**
- `frontend/hooks/useStabilityPool.ts` and `frontend/hooks/useRedemption.ts` currently populate stats/balances with mock values.

**Requirements**
- Implement read-only RPC queries in `frontend/lib/casperRpc.ts` for:
  - gUSD balance (stablecoin `balances` dictionary, or add a contract getter if dictionary keying is not feasible).
  - StabilityPool totals (`total_deposits`, `total_*_collateral`, `total_debt_absorbed`) via named_keys.
  - Redemption stats (`base_fee_bps`, `total_redeemed`, safe_mode flag) via named_keys.
  - Safe mode state for each module (do not hardcode false).
- If Address-keyed dictionary access is unreliable:
  - Add deploy-friendly on-chain getter(s) and use a “signed read” fallback explicitly labeled (do not silently fabricate numbers).
- Keep write UX intact (approve → call).

**Acceptance Criteria**
- UI shows 0/real values based on chain state; no hard-coded “1M gUSD” or “10k gUSD” demos.
- Safe mode UI reflects on-chain safe_mode state.

**Deliverables**
- Updated `frontend/hooks/useStabilityPool.ts` and `frontend/hooks/useRedemption.ts`
- Updated `frontend/lib/casperRpc.ts` (new query helpers)

---

## TICKET-30 — Contracts: Frontend-Friendly State Access (User Deposit/Gains)

**Goal:** Ensure the frontend can read user-specific StabilityPool/Redemption state without depending on undocumented dictionary key derivation.

**Requirements**
- Provide one of:
  - A dictionary keyed by `account-hash-...` string for user deposit + gains, OR
  - Explicit view entrypoints returning user snapshot/gains that can be queried via a supported read pattern.
- Keep storage SSOT in one place; avoid double-accounting drift.

**Deliverables**
- Contract changes in `casper/contracts/src/stability_pool.rs` (and any shared helpers)
- Frontend adjustments as needed (`TICKET-29`)

---

## TICKET-31 — E2E Smoke: Testnet Runbook + Minimal Scripts (SP + Redemption)

**Goal:** Provide a human-runnable, testnet-focused smoke checklist for StabilityPool + Redemption flows.

**Requirements**
- Update or add a runbook under `docs/casper/ops/` describing:
  - Deploy → bind frontend → fund accounts → approve → deposit → (simulate liquidation) → claim → redeem
- Add/extend a minimal script under `scripts/casper/` or `casper/scripts/` that can:
  - Print current deployment config and key contract hashes
  - Query and display SP totals and redemption stats from chain (best-effort)

**Deliverables**
- New/updated docs under `docs/casper/ops/`
- One small script for sanity queries (no secrets)

---

## TICKET-32 — Contracts: Access Control Cleanup (No Open Admin Surfaces)

**Goal:** Close remaining “TODO admin check” gaps so production surfaces are not accidentally left open.

**Scope**
- `gUSD (stablecoin)`:
  - Enforce registry-admin checks for `add_minter`, `remove_minter`, `set_supply_cap`.
- `TokenAdapter`:
  - Enforce admin checks for token registration and caller authorization (`register_token`, `unregister_token`, `add_caller`, `remove_caller`, `set_token_has_fee`).
- Any wiring setters on protocol modules that should not be publicly callable post-deploy.

**Acceptance Criteria**
- Non-admin callers cannot modify protocol-critical configuration.
- Unit tests cover at least one negative case per contract (revert on unauthorized call).

**Deliverables**
- Updated contract modules with enforced access control and tests

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
