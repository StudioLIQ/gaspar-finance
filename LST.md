# Casper LST (stCSPR) — Design Draft

## Background / Problem Statement

- The Casper CDP protocol assumes **CSPR (native)** and **stCSPR (token)** as collateral. (`docs/casper/spec/collateral.md`)
- The oracle computes **stCSPR/USD as a composite price**, and it needs the exchange rate `R = CSPR_PER_SCSPR`, which must be derived from **on-chain LST state/metrics**. (`docs/casper/spec/oracle.md`, `docs/casper/decision/parameter-confirmation.md`)
- If the Casper ecosystem does not provide an LST that is close to a “standard” (or de-facto standard), or if existing options do not satisfy CDP requirements (on-chain rate, stable interface, operability/governance), then we must **design and implement the LST (stCSPR)** ourselves.

This document is a **draft product/protocol design for stCSPR (LST)**. Values that can vary by network or implementation (unbonding period, decimals, standard details, fees, etc.) are intentionally left unfinalized.

> Principle: do not hardcode ambiguous values. Finalization must follow `docs/casper/decision/parameter-confirmation.md`.

---

## Goals

- Provide a liquid token **stCSPR (= LST)** that reflects **CSPR staking yield**
- To be usable as CDP collateral, provide:
  - A **CEP-18 token interface** (minimum: `transfer`, `transfer_from`, `approve`, `balance_of`, `total_supply`)
  - A queryable **on-chain exchange rate `R = CSPR_PER_SCSPR`** required for oracle composition
  - Production operability features: pause/emergency controls, role separation, etc.
- Provide a safe unstaking UX: a **withdraw queue** / claim flow that accounts for unbonding delays

## Non-goals

- Advanced features (LST leverage, liquid restaking, complex derivatives)
- Requiring “instant redeem” as an MVP requirement (consider as a later phase)
- Forcing the rate via off-chain price decisions (the rate must be derived from on-chain state)

---

## Core Concepts

### 1) stCSPR value / exchange rate

- `R = CSPR_PER_SCSPR`: **the amount of CSPR represented by 1 stCSPR**
- As staking rewards accrue, `R` generally increases (each stCSPR represents more CSPR)
- Slashing/penalties/operational losses can cause `R` to decrease

### 1.1) Interpreting stCSPR as a ybToken (share token) model

stCSPR is assumed to behave like a **ybToken (= yield-bearing share token)**.

- `shares = stCSPR balance`
- `assets = CSPR`
- Exchange rate (recommended definition):
  - `R = total_assets / total_shares = CSPR_PER_SCSPR`

Yield is reflected **not by increasing user balances (rebasing)**, but by increasing `R`.

### 1.2) Meaning (definition) of `total_assets`

In the ybToken model, `total_assets` represents the **total underlying CSPR NAV** backing the entire stCSPR supply.

Recommended definition (accounting view, in CSPR units):

- `total_assets = idle_cspr + delegated_cspr + undelegating_cspr + claimable_cspr - protocol_fees - realized_losses`

Components that must be decided and documented explicitly:

- `pending_rewards` (rewards not yet claimed/compounded)
  - MVP recommendation: **exclude** (only include when realized) → `R` increases in “steps” at harvest/compound time
  - Extension: include if it can be derived on-chain in a reliable way (and design for double-counting, manipulation surface, and freshness)

The `R` used by the oracle/protocol is derived from `total_assets/total_shares`. What is included (especially rewards) and how frequently it is updated must be fixed as an operational/policy decision.

Important: in a “request-time quote + withdraw queue” model, it is recommended that **stCSPR locked in `withdraw_queue` remains included in `total_shares`** (i.e., burn at claim time). This prevents `R` from being artificially distorted as the queue grows.

### 2) Mint/burn (normalized accounting)

Simplest accounting (recommended):

- Deposit: user deposits `x` CSPR → mint `minted = x / R` stCSPR
- Withdraw: user burns `y` stCSPR → receive `out = y * R` CSPR

Precision/rounding must be fixed and tested (e.g., always `floor`) and must follow the same fixed-point rules as CDP/oracle logic.

---

## Architecture Proposal (MVP → Extensions)

### Contract layout (recommended separation)

1) `scspr_ybtoken` (CEP-18 + vault)
- The CEP-18 token (stCSPR) itself represents **shares**, while the contract also acts as a vault tracking `total_assets`
- Accepts native CSPR deposits, manages delegation/undelegation, and holds an idle buffer
- Exposes query entrypoints such as `cspr_per_scspr()` / `exchange_rate()` / `convert_to_assets()` for oracle/protocol reads

2) `withdraw_queue` (unbonding-based withdraw requests/claims)
- `request_withdraw(y_scspr)` → create a request ID
- After unbonding completes, `claim(request_id)` → receive CSPR
- On request, transfer stCSPR **into `withdraw_queue` and lock it**, and create a request record (including the quote)
- On claim, pay out and **burn the locked stCSPR** (or route it to a protocol vault) to settle the accounting

Receipts (recommended):

- MVP: track ownership/status via a `request_id` mapping
- Extension: issue non-transferable receipt tokens or represent requests as NFTs

### Testnet policy (MVP)

- **Single-validator delegation**: on testnet, concentrate all delegation into “one validator” (the top validator at deployment time)
- Conceptual parameters:
  - `PRIMARY_VALIDATOR_PUBLIC_KEY = 0106ca7c39cd272dbf21a86eeb3b36b7c26e2e9b94af64292419f7862936bca2ca`
  - `DELEGATION_MODE = SINGLE_VALIDATOR`
- Change authority:
  - Operationally, a validator change may be required. Allow updates via an admin role (with role separation), and require change events + runbook procedures.

Confirmation evidence (record):

- Confirmed date: 2026-01-10
- Evidence: `state_get_auction_info` (RPC: `https://node.testnet.casper.network`), `block_height=6501862`, `state_root_hash=5dbc95c649a9ea89b0204876c822f7a08113f7a4add0942af8c6480c1d68e32b`, top-weight validator at latest `era_id=20717`

### Validator management

- MVP: fixed single validator (or a small set) + manual operations (authorized operator) can be sufficient initially
- Extension: whitelisted validator set + automated distribution/rebalancing (consider fees/risk)

### Fee model (optional)

- Protocol fee (operating costs): take a cut of rewards or charge deposit/withdraw fees
- MVP can simplify with “no fees”, but keep a minimal structure (parameters + treasury address) to support long-term operation

---

## On-Chain Rate Design (Oracle/CDP integration core)

### Requirements

- The CDP oracle composite price is `P(stCSPR/USD) = P(CSPR/USD) * R`, and `R` must be **queryable on-chain**.
- The direction of `R` is fixed: `CSPR_PER_SCSPR` (documented decision)
- In the ybToken model, `R` is a **derived value**: `R = total_assets / total_shares`

### Proposed interface (example)

- `cspr_per_scspr() -> (rate_int, rate_decimals, last_updated_ts?)`
  - `rate_int / 10^rate_decimals = R`
  - Providing `last_updated_ts` makes freshness checks easier (otherwise design around block time/internal state)
  - Document which `total_assets` components are included in `R` (e.g., staked/idle/undelegating/rewards inclusion)

Additionally (recommended):

- `total_assets() -> (assets_int, assets_decimals)`
- `total_shares() -> u256`
- `convert_to_assets(shares) -> assets` / `convert_to_shares(assets) -> shares`

> Ambiguous values (precision/decimals/update strategy) must be finalized via the confirmation procedure.

---

## User Flows (MVP)

### Deposit (CSPR → stCSPR)

1) User deposits CSPR into `scspr_ybtoken`
2) `scspr_ybtoken` computes `minted` from the current `R`
3) `scspr_ybtoken` mints stCSPR to the user
4) `scspr_ybtoken` delegates the deposited CSPR to a validator (immediately or in batches)

### Withdraw (stCSPR → CSPR, unbonding-based)

1) User calls `withdraw_queue.request_withdraw(y)`
2) Transfer `y` stCSPR into `withdraw_queue`, lock it, and create a request record (**fix the quote at request time and compute the committed payout**)
3) `scspr_ybtoken` undelegates the required amount of CSPR
4) After unbonding completes, user calls `claim(request_id)` to receive CSPR, and the locked stCSPR is burned to settle the accounting

---

## Requirements as CDP collateral

- stCSPR must be transferable and depositable as collateral, so **transferable CEP-18** is the baseline
- Fee-on-transfer handling (if applicable): CDP already follows a net-received accounting policy
  - Keeping LST free of fee-on-transfer is simpler (recommended)
- Verify compatibility with CDP `TokenAdapter/BranchSCSPR` call patterns

---

## Security / Risk Considerations

- Slashing/penalties: reflected as a decrease in `R`; require user/protocol risk disclosures and monitoring
- In a request-time quote model, slashing/losses after a request can make the “queue claim amount” overstated; define an explicit haircut/reconciliation policy for loss events (leave as a policy item)
- Permissions/upgrades: validator set changes, pause, fee updates, etc. require role separation (ops/governance/security keys)
- Reentrancy/callbacks: consider CEP-18 hooks or non-standard behavior (especially in CDP interactions)
- Precision/rounding: consistent mint/burn policies (e.g., floor) + dust handling rules are required
- Liquidity: “instant withdraw” may not be possible during the unbonding period; design UX for waiting/ETA/status visibility

---

## Ops & Monitoring

- Track changes in `R` (daily/per-era), validator performance, unbonding queue size, and idle buffer levels
- Failure/anomaly signals: validator downtime, reward drops, sharp `R` decreases, undelegate failures
- Pause policy: explicitly define what deposit/withdraw/claim actions are blocked during emergencies

---

## Frontend / Indexing Requirements (MVP)

Since it is difficult to represent “per-user withdraw request lists” using Casper node RPC alone, `withdraw_queue` should expose enough state for the frontend to query minimally.

Recommended (on-chain):

- `get_request(request_id) -> { owner, shares_locked, quoted_rate, quoted_assets, status, timestamps... }`
- `get_request_ids_by_owner(owner, cursor, limit) -> [request_id...]` (pagination)

Alternative (off-chain):

- Reconstruct “my requests” via an event/log-based indexer (e.g., ingest request/claim events)

---

## Development Roadmap (proposal)

### Phase 0 — Research / confirmation (required)

- [x] Confirm Casper native staking/unbonding call patterns and constraints
  - **Decision**: contracts cannot directly delegate/undelegate → adopt an operator-based model
- [x] Choose CEP-18 standard/reference implementation
  - **Implementation**: Odra-based CEP-18 compatible token
- [x] Decide `R` derivation (total assets / total shares / whether to include unclaimed rewards)
  - **Decision**: `total_assets = idle + delegated + undelegating + claimable - fees - losses`
  - Exclude `pending_rewards` in MVP (increase `R` only when realized)
- [x] Finalize per-network parameters via the confirmation procedure
  - **Confirmed**: Testnet `PRIMARY_VALIDATOR` = `0106ca7c39cd272dbf21a86eeb3b36b7c26e2e9b94af64292419f7862936bca2ca`

### Phase 1 — MVP LST (before CDP integration)

- [x] Implement `scspr_ybtoken` + `withdraw_queue` (lock + quote on request, burn on claim)
  - `casper/contracts/src/scspr_ybtoken.rs` - CEP-18 share token + vault
  - `casper/contracts/src/withdraw_queue.rs` - withdraw request/claim management
- [x] Support single-validator delegate/undelegate + claim
  - **Implementation**: operator-based sync/compounding model (contract delegates via operator)
- [x] Provide rate query entrypoints + unit/precision test vectors
  - `cspr_per_scspr() -> (U256, u8)`: rate scaled by 1e18
  - `convert_to_assets(shares)`, `convert_to_shares(assets)`
  - `total_assets()`, `total_shares()`, `get_exchange_rate()`

### Phase 2 — Operational hardening

- [ ] Multi-validator distribution/rebalancing
- [ ] Role separation, pause, fee/treasury
- [ ] Monitoring/runbook documentation

### Phase 3 — CDP integration

- [ ] Wire `OracleAdapter` to read on-chain `R` reliably
- [ ] `BranchSCSPR` collateral flow E2E tests (deposit/borrow/liquidation/redemption)

---

## Open issues / decisions needed

- ~~stCSPR token naming/symbol/decimals~~ → **Decision: `name="stCSPR"`, `symbol="stCSPR"`, `decimals=9`**
- Unbonding period; whether partial withdraw/partial claim are supported
  - **MVP**: Testnet 7 hours (25200 seconds); no partial claim
- ~~Request-time fixed `R` (quote) vs claim-time `R` (policy/fairness/UX)~~ — **Decision: request-time quote**
- ~~Rewards inclusion strategy (auto/manual harvest) and how to expose `last_updated_ts`~~ → **Decision: operator calls `sync_assets()` to update manually**
- Validator set governance (admin / multisig / on-chain voting) — decide in Phase 2
