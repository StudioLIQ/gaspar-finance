# ADR-001: Adopt Styks (Odra) Oracle + stCSPR Pricing/Failure Policy

## Status

- Status: **Approved**
- Date: 2026-01-10
- Scope: Casper-only.

---

## Background / Problem

The Casper oracle must satisfy the following requirements:

- CSPR collateral price is read from Styks (Odra) **CSPR/USD**.
- stCSPR collateral price is derived from either:
  - (A) Styks **direct stCSPR/USD feed**, or
  - (B) **composite price** (CSPR/USD × stCSPR↔CSPR rate).
- Oracle failures (None/Stale/Deviation) directly impact economic safety, so **failure policy must be fixed**.
- Decimals/scale/feed IDs/rate sources can vary by network/implementation, so they must be confirmed via the **confirmation procedure** and not hard-coded.

Related specs:
- `docs/casper/spec/oracle.md`
- `docs/casper/decision/parameter-confirmation.md`

---

## Decision (Conclusion)

### 1) PriceOracle Abstraction

In Casper mode, pricing logic is abstracted as a conceptual `PriceOracle`.

- Input: `collateralId = CSPR | stCSPR`
- Output (concept): `{ priceInt, priceDecimals, timestampSec, status }`
- `status` is standardized (implementation mapping is separate):
  - `OK`
  - `UNAVAILABLE` (None)
  - `STALE`
  - `DEVIATION` (spike/variance)
  - `INVALID_RATE` (rate = 0 / abnormal)
  - `DECIMALS_MISMATCH`

Principles:
- **Reads are query-only** and must not mutate state.
- If a write (deploy) path needs pricing, it uses PriceOracle and decides allow/deny/block accordingly.

### 2) stCSPR Pricing: **Composite (B) is Canonical**

stCSPR/USD uses composite (B) as the canonical price.

- Rate direction is fixed to **R1 (`CSPR_PER_SCSPR`)**.
- Rate source is fixed to **ONCHAIN_LST_STATE** (on-chain LST metrics; per-network refs/keys/decimals are confirmed via procedure).
- `PRICE_UNIT` is fixed to **P1 (USD per 1 external-unit)**.

Handling of direct feed (A):
- Even if a direct feed exists, in the initial release:
  - The direct feed is **monitoring/cross-check only**.
  - Promoting direct feed to canonical requires a new ADR.

### 3) Failure Policy: **Circuit Breaker (safe_mode latch)**

When oracle status is not `OK` (UNAVAILABLE/STALE/DEVIATION/INVALID_RATE/DECIMALS_MISMATCH), the protocol triggers a circuit breaker.

- Trigger conditions (summary):
  - None: no price/rate available → `UNAVAILABLE`
  - Stale: `age > MAX_PRICE_AGE_SECONDS` → `STALE`
  - Deviation: baseline deviation `> MAX_DEVIATION_BPS` → `DEVIATION`
  - Rate invalid: `R=0` or direction/scale mismatch → `INVALID_RATE` / `DECIMALS_MISMATCH`
- Behavior (summary):
  - `safe_mode = ON` is **latched** (no auto-clear)
  - Block **risk-increasing write** actions
  - safe_mode clear is **explicit** by operator after root-cause analysis

Allowed/blocked actions in safe_mode (decision-locked):

- **Allowed (risk reducing / not price-dependent)**
  - Repay only: `adjustVault(vaultId, debtDelta <= 0)`
  - Add collateral: `adjustVault(vaultId, collateralDelta >= 0)`
  - StabilityPool deposit (system buffer increase)
- **Blocked (risk increasing / price-sensitive)**
  - New vault (open), debt increase (borrow)
  - Collateral withdraw, close-with-withdraw
  - Liquidation (liquidate/batchLiquidate), redemption
  - StabilityPool withdraw/claim (buffer decrease or price-sensitive)

Deviation baseline (decision-locked):

- `MAX_DEVIATION_BPS` is evaluated against **`last_good_price`** (most recent `OK` price).
- `last_good_price` and `safe_mode` are **updated only in deploy/write paths** (queries must not mutate state).
  - Bootstrap: after initial config, run an “oracle refresh (admin deploy)” to set `last_good_price`.
  - Recommended ops: a dedicated `oracle_refresh` deploy updates last_good_price/safe_mode, separate from core business actions.

---

## Rationale

### Why composite (B)

- Direct feed (A) may not exist; composite (B) keeps spec/ops stable.
- Composite (B) allows splitting inputs (P_cspr vs R) to diagnose issues.

### Why circuit breaker

- “Hard fail” is safe but can halt all operations during oracle downtime.
- “Cache + max_age” increases availability but weakens safety if cache is stale or manipulated.
- Circuit breaker allows **fast risk stop** plus **operator-controlled recovery**.

---

## Alternatives

### A1) Strict deny on any failure

- Pros: simpler and safer
- Cons: downtime blocks all user actions, including exits/repay

### A2) Cache + max_age

- Pros: higher availability
- Cons: additional trust model, update authority, audit overhead

### A3) Direct feed only for stCSPR

- Pros: simpler
- Cons: direct feed may not exist; loses rate-based validation

---

## Risks / Mitigations

- **Decimals/scale misunderstanding** → `DECIMALS_MISMATCH` with strict rejection + confirmation procedure
- **Rate source manipulation/errors** → input freshness validation + deviation-based circuit breaker
- **Deviation baseline ambiguity**
  - Candidates:
    - `last_good_price` (updated on deploy only)
    - cross-check vs direct feed (if available)
  - Bootstrap step required if baseline is missing (document in ops runbook)
- **Circuit breaker false positives/abuse** → explicit clear procedure (2-person approval) + logging/observability

---

## Test Plan (Summary)

> Vector-based, data-driven testing.

Required scenarios:
- None: `ORACLE_UNAVAILABLE` → safe_mode trigger and risk actions blocked
- Stale: `ORACLE_STALE` → same
- Deviation: `DEVIATION` → same
- Rate anomalies: `INVALID_RATE`/`DECIMALS_MISMATCH` → same
- Composite vs direct (if available): monitor discrepancy

Docs/Vectors:
- `docs/casper/test-vectors/README.md`

---

## Config / Ops Artifacts

- Design/Procedure: `docs/casper/oracle-styks.md`
- PR checklist: `docs/checklists/oracle-styks-pr-checklist.md`
- Ops runbook: `docs/runbooks/oracle-styks-ops.md`
- Config templates: `config/oracle.styks.testnet.json`, `config/oracle.styks.mainnet.json`
