# PR Checklist: Styks (Odra) Oracle (Casper)

> Purpose: Verify that Styks oracle changes satisfy safety/observability/operability requirements.  
> Scope: Casper-only.

---

## 1) Change Scope / Invariants

- [ ] Casper Rust/Cargo projects are not included in the default Node tasks/workspace (separate folder/commands).
- [ ] The two-collateral “equivalent semantics” assumption (CSPR/stCSPR) remains intact (especially on stale/failure behavior).

---

## 2) ADR Compliance (Decision Lock)

- [ ] No mismatch with `docs/adr/ADR-001-styks-oracle.md` conclusions.
  - [ ] PriceOracle abstraction (including status codes) is preserved.
  - [ ] stCSPR canonical price remains composite (B); direct feed is monitoring-only.
  - [ ] Failure policy is implemented/operated as a circuit breaker.
- [ ] Allowed/blocked actions in safe_mode are consistent across docs/config/runbooks.

---

## 3) Parameter/Scale Confirmation (No Hard-Coding)

- [ ] Ambiguous values (feed ID/decimals/rate sources/direction) are not hard-coded in docs.
- [ ] Confirmation follows `docs/casper/decision/parameter-confirmation.md`.
- [ ] Evidence for confirmed values exists (queries/tx/chain data).
- [ ] `PRICE_UNIT=P1`, `RATE_DIRECTION=CSPR_PER_SCSPR`, `RATE_SOURCE=ONCHAIN_LST_STATE` are documented and agreed.

---

## 4) Config Templates / Profiles

- [ ] `config/oracle.styks.testnet.json` and `config/oracle.styks.mainnet.json` templates exist.
- [ ] Templates explicitly state that `TBD` fields must be filled via the confirmation procedure.
- [ ] Defensive parameters are included (`MAX_PRICE_AGE_SECONDS`, `MAX_DEVIATION_BPS`, etc.).

---

## 5) Observability

- [ ] Docs specify how to observe the following via query only:
  - [ ] Current oracle status (OK/UNAVAILABLE/STALE/DEVIATION/INVALID_RATE/DECIMALS_MISMATCH)
  - [ ] Freshness of composite inputs (P_cspr, R) and `effective_age`
  - [ ] safe_mode status and last trigger reason (if available)
- [ ] (Optional) If changelog/indexing exists, record schemas are stable.

---

## 6) Tests (Vectors/Scenarios)

- [ ] Vector-based test plan matches `docs/casper/test-vectors/README.md`.
- [ ] Minimum failure cases are included:
  - [ ] None (no price)
  - [ ] Stale
  - [ ] Spike/Deviation
  - [ ] Rate anomalies (R=0 or direction/decimals mismatch)
- [ ] Smoke test procedure exists in `docs/casper/oracle-styks.md`.

---

## 7) Ops Readiness

- [ ] `docs/runbooks/oracle-styks-ops.md` is current and incident response follows the decided policy.
- [ ] Monitoring/alert items (freshness/anomaly/liveness) are defined.
- [ ] safe_mode clear procedure (approval/evidence/rollback) is clear.
