# Runbook: Collateral Onboarding (CSPR / stCSPR) (Casper Mode Only)

## Onboarding Steps (Checklist)

### 1) Asset Identification

- [ ] Confirm native unit/decimals
- [ ] Confirm token standard (CEP-18 or not)
- [ ] Confirm contract hash/address (per network)
- [ ] Confirm `name/symbol/decimals`

### 2) Transfer/Accounting Risk Review

- [ ] Fee-on-transfer presence (if any, impacts accounting/liquidation/redemption)
- [ ] Token hooks/callbacks/reentrancy possibility
- [ ] Token upgradeability/admin control/proxy risk

### 3) Pricing Path Confirmation

- [ ] CSPR/USD: confirm Styks feed
- [ ] If a direct feed exists: confirm availability
- [ ] If no direct feed: confirm rate source (DECIDED: ONCHAIN_LST_STATE) + composite formula (DECIDED: R1=CSPR_PER_SCSPR)

### 4) Simulation/Verification (Document-Based)

The implementation must satisfy the following checks (no code required in this document).

- [ ] Collateral deposit/withdraw internal accounting matches test vectors  
  - Vector: `docs/casper/test-vectors/collateral-accounting.v1.json`
- [ ] Oracle direct/composite calculation matches test vectors  
  - Vector: `docs/casper/test-vectors/oracle-composite.v1.json`
- [ ] Stale policy behaves as documented (S1/S2/S3 policy to be confirmed)

### 5) Ops Readiness

- [ ] Monitoring: collateral balance/TVL/anomalous transfer detection
- [ ] Oracle: freshness/anomaly alerts
- [ ] Comms templates: user notices for stale/circuit breaker events

## Rollback Plan (Required)

If issues are found after onboarding, minimize impact in this order (policy confirmation required):

- [ ] Pause new positions/borrowing (collateral-specific as needed)
- [ ] Restrict withdrawals vs allow repay-only (S2 policy)
- [ ] Hold oracle updates / switch to backup source
- [ ] Postmortem: root cause/impact/prevention
