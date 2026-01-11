# Oracle Spec: Styks (Odra) + stCSPR Composite Pricing

## Goals

- **CSPR/USD**: Use a direct Styks (Odra) feed.
- **stCSPR/USD**:
  - Canonical price is **composite** (ADR-001).
  - If a direct feed exists, use it only for monitoring/cross-checking.
- Oracle None/Stale/Deviation policy is fixed to ADR-001 circuit breaker (safe_mode latch).
- Do not hard-code ambiguous values (decimals/scale/feed IDs/addresses); confirm via the procedure.

## Price Representation (Fixed-Point) — Spec Requirements

### Common Definitions

- `priceInt`: integer price value
- `priceDecimals`: decimal places for `priceInt`

**Important**: `priceDecimals` can vary per network/feed, so do not hard-code it. Use `docs/casper/decision/parameter-confirmation.md`.

### Unit Consistency (Required)

The core protocol requires a **fixed price unit**.

Decision (fixed):

- `PRICE_UNIT = P1 = USD per 1 external-unit`

If a feed uses different units, the implementation must convert to P1 before passing into core logic (conversion rules and evidence must be documented via the confirmation procedure).

## CSPR/USD (direct)

- Use Styks (Odra) CSPR/USD feed.
- Feed metadata (feed ID, decimals, update cadence, trust model) must be confirmed via the procedure.

Required verifications (testable):

- [ ] Latest value query works (including permissions/payment/gas requirements)
- [ ] `timestampSec` (or equivalent freshness indicator) is available
- [ ] Staleness judgment is possible (`MAX_PRICE_AGE_SECONDS` defined)

## stCSPR/USD (direct or composite)

### 1) If a direct feed exists

- Even if Styks provides a direct stCSPR/USD feed, **composite remains canonical** for initial releases (ADR-001).
- Direct feed is for monitoring/cross-checking only (manipulation/error detection).

### 2) If no direct feed exists: composite

#### Inputs

- `P_cspr = P(CSPR/USD)`
- `R = exchange_rate(stCSPR, CSPR)` (direction defined below)

#### Rate Direction (fixed)

Rate direction must be fixed and named (decision):

- `R = CSPR_PER_SCSPR` (how many CSPR per 1 stCSPR)

#### Composite Formula

- `P(stCSPR/USD) = P_cspr * R`

#### Rate Source (no hard-coding; confirm via procedure)

Rates must be derived from **verifiable sources**, not arbitrary off-chain constants (decision: on-chain LST state/metrics).  
Per-network `ref`/key/decimals are confirmed via `docs/casper/decision/parameter-confirmation.md`.

## Staleness / Safety Policy (Required, fixed)

### Freshness Judgment

- `MAX_PRICE_AGE_SECONDS`: max allowed age for price data
- For composite:
  - Both `P_cspr` and `R` must be fresh
  - `effective_age = max(age(P_cspr), age(R))` (recommended)

### Behavior on Oracle Abnormality (None/Stale/Deviation/Invalid Rate)

In Casper mode, failure policy is fixed to **circuit breaker (safe_mode latch)** (ADR-001).  
In safe_mode, allowed/blocked actions are fixed and do not auto-reset.

- Allowed: repay (debt decrease), add collateral, deposit to StabilityPool
- Blocked: open/borrow (debt increase), withdraw collateral/close-with-withdraw, liquidation/redemption, StabilityPool withdraw/claim

## Test Vectors

- Schema: `docs/casper/schemas/oracle-composite-vector.schema.json`
- Vectors: `docs/casper/test-vectors/oracle-composite.v1.json`
