# Ops Runbook: Styks (Odra) Oracle Operations (Casper)

> Scope: Casper-only (two collateral types: CSPR/stCSPR).  
> Policy: Follow the **circuit breaker** decision in `docs/adr/ADR-001-styks-oracle.md`.  
> Principle: Do not hard-code decimals/scale/rate sources/feed IDs. Confirm via `docs/casper/decision/parameter-confirmation.md`.

## 0) Roles/Responsibilities

- On-call (Ops): monitoring/incident response/communications
- Protocol Admin: safe_mode ON/OFF, approve/execute parameter changes
- Data Provider: verify external price/rate sources (if needed)

## 1) Pre-Operations (Required)

- [ ] `config/oracle.styks.<network>.json` is filled via the confirmation procedure (no TBD)
- [ ] `PRICE_UNIT=P1`, `RATE_DIRECTION=CSPR_PER_SCSPR`, `RATE_SOURCE=ONCHAIN_LST_STATE` are documented/configured and agreed by the team
- [ ] stCSPR direct feed existence is confirmed, and canonical policy is composite (B)
- [ ] safe_mode trigger/clear authority and approval process (recommended: 2-person approval) are defined
- [ ] Monitoring/alert channels are connected

References:

- Design/verification: `docs/casper/oracle-styks.md`
- Existing Casper runbook (supplemental): `docs/casper/ops/runbook-styks-oracle.md`

## 2) Normal Operations (Routine)

### 2.1 Required Monitoring Metrics

Freshness:

- [ ] `age(P_cspr)` seconds
- [ ] `age(R)` seconds (if composite)
- [ ] `effective_age = max(age(P_cspr), age(R))`

Anomaly:

- [ ] `deviation_bps` vs baseline (baseline per ADR, e.g., last_good_price)
- [ ] If direct feed exists: `|P_direct - P_composite|` in bps

Liveness:

- [ ] Styks query/update failure rate
- [ ] Casper node/RPC latency and error rate

### 2.2 Recommended Ops Cadence

- [ ] Hourly: review freshness/latency alerts
- [ ] Weekly: postmortem on deviation/stale events and propose threshold tuning

## 3) Incident Response Playbook

### A) Oracle Stale

Detection:

- [ ] `age(P_cspr)` or `age(R)` exceeds `MAX_PRICE_AGE_SECONDS`

Actions:

- [ ] Identify source: data provider outage / network congestion / permissions / ops error
- [ ] Retry update (alternate node/path)
- [ ] Decide whether to enable safe_mode per policy
- [ ] User notice if behavior changes (repay allowed, borrow blocked)

### B) Price Anomaly (Spike/Deviation)

Detection:

- [ ] `deviation_bps > MAX_DEVIATION_BPS`

Actions:

- [ ] Validate source data (multi-source compare)
- [ ] Separate composite components (P_cspr vs R)
- [ ] Hold updates temporarily (if policy allows)
- [ ] Trigger circuit breaker if risk remains

### C) Rate Source (R) Failure

Detection:

- [ ] R missing/stale/invalid

Actions:

- [ ] Check fallback to direct stCSPR/USD feed
- [ ] If no fallback: restrict new positions/withdrawals/borrowing for stCSPR

## 4) Recovery / Safe Mode Clear

- [ ] Root cause identified and mitigated
- [ ] Data freshness restored and verified
- [ ] Execute explicit safe_mode clear (admin deploy)
- [ ] Document decision and evidence in ops log

## 5) Post-Incident

- [ ] Record timeline and impact
- [ ] Update thresholds/runbooks if needed
- [ ] Add tests or monitoring for recurrence prevention
