# Styks (Odra) Oracle Design & Ops Guide (Casper)

> Scope: Casper-only. This document defines **configuration/verification procedures, failure policy, and smoke tests**, not implementation.  
> Principle: Do not hard-code ambiguous values (decimals/scale/feed IDs/rate sources). Use `docs/casper/decision/parameter-confirmation.md`.

## 1) Oracle Goals

- Safely provide the direct CSPR/USD feed.
- Provide stCSPR/USD via direct feed or composite pricing.
- Apply protocol policies consistently for stale/deviation/none cases.

## 2) Inputs & Definitions

### 2.1 CSPR/USD (direct)

- Use the Styks (Odra) CSPR/USD feed.
- `priceDecimals` can vary by network and must be confirmed via `docs/casper/decision/parameter-confirmation.md`.

### 2.2 stCSPR/USD (direct or composite)

- Check whether a direct feed exists.
- If there is no direct feed or it is not canonical, use composite pricing.

Composite formula:

- `P(stCSPR/USD) = P(CSPR/USD) × R(stCSPR↔CSPR)`
- Rate direction is fixed to `CSPR_PER_SCSPR`.

## 3) Stale/Deviation Policy

- Staleness and deviation thresholds are confirmed via `docs/casper/decision/parameter-confirmation.md`.
- When stale or deviation is detected, the safe_mode policy applies.

## 4) Smoke Tests

### 4.1 CSPR Smoke (QUERY)

- [ ] Read CSPR/USD via query.
- [ ] Verify timestamp/decimals.

### 4.2 stCSPR Smoke (QUERY)

- [ ] Check if a direct feed exists.
- [ ] Read composite inputs (P_cspr, R) via query.
- [ ] `effective_age = max(age(P_cspr), age(R))` passes thresholds.

### 4.3 Failure Scenarios

> Procedures only (implementation/tooling may vary).

- None scenario:
  - [ ] Intentionally blank feed ref/ID (test env) yields `ORACLE_UNAVAILABLE`
- Stale scenario:
  - [ ] Old timestamp data yields `ORACLE_STALE`
- Deviation scenario:
  - [ ] Data that exceeds `MAX_DEVIATION_BPS` vs baseline yields "deviation"

For each failure scenario:
- [ ] The ADR-defined policy (deny/restrict/circuit breaker) is reproduced consistently in ops/tests.

---

## 5) Related Docs

- Spec (composite/stale/rates): `docs/casper/spec/oracle.md`
- Confirmation procedure: `docs/casper/decision/parameter-confirmation.md`
- Ops runbook: `docs/casper/ops/runbook-styks-oracle.md`
- Test vectors: `docs/casper/test-vectors/README.md`
