# Casper Parameter Confirmation Procedure (No Hard-Coded Ambiguity)

This document defines how to confirm **ambiguous or network-dependent values** such as decimals/scale/rate sources/addresses (hashes)/feed IDs.

## Principles

- “Assumptions” may be recorded but **must not be promoted to confirmed spec values**.
- Every confirmed value must be recorded with **evidence (query results/transactions/docs/chain data)**.
- Do not hard-code unconfirmed values in code/ops (treat them as spec/config only).

## Confirmation Targets

## Global Decisions (Network-Agnostic, ADR required for changes)

- `PRICE_UNIT = USD per 1 external-unit` (P1)
- `RATE_DIRECTION = CSPR_PER_SCSPR` (R1)
- `RATE_SOURCE = ONCHAIN_LST_STATE` (on-chain LST state/metrics)
- stCSPR fee-on-transfer: **allowed**, account by net received
- Two-collateral redemption: **RDM1**, caller specifies `collateralId`

### A. Collateral Metadata

- CSPR:
  - [ ] Smallest-unit name and denomination (e.g., motes)
  - [ ] Decimals
- stCSPR (token):
  - [ ] Standard (including CEP-18)
  - [ ] `contract_hash` (or address) and network (mainnet/testnet)
  - [ ] `decimals`, `symbol`, `name`
  - [ ] Fee-on-transfer / non-standard behavior

### B. Oracle (Styks/Odra) Metadata

- [ ] CSPR/USD feed ID, decimals, update cadence/trust model
- [ ] Whether a direct stCSPR/USD feed exists
- [ ] `MAX_PRICE_AGE_SECONDS` (stale threshold)
- [ ] `MAX_DEVIATION_BPS` (deviation threshold)

### C. stCSPR Rate Source

- [ ] Confirm and document rate direction (R1 or R2)
- [ ] Confirm on-chain rate source (contract/entrypoint/key)
- [ ] Confirm freshness/staleness judgment for rate data

### D. Internal Scale/Precision

- [ ] Price scale standardization (`price_decimals`)
- [ ] Internal accounting scale (e.g., 1e18)
- [ ] Conversion rounding rules (floor/ceil/round)

## Confirmation Procedure (Checklist)

Repeat this for each item:

1) **Collect candidates**
- [ ] Check if it can be queried directly from chain/contracts
- [ ] Gather candidate values from official docs/README/spec/deployment logs

2) **Gather evidence**
- [ ] Record query result (hash/block/response)
- [ ] Verify reproducibility (at least 2 times)

3) **Risk assessment**
- [ ] Assess change risk (upgrade/admin rights/oracle model)
- [ ] Verify safety mechanisms for changes (stale/circuit breaker)

4) **Approval**
- [ ] Reviewed by at least two people (Dev + Ops recommended)
- [ ] Update the confirmation table

5) **Update test vectors**
- [ ] Add a network profile to `docs/casper/test-vectors/*`

## Confirmation Table Template (Copy & Use)

Fill this table per network (e.g., `Casper Mainnet`, `Testnet`).

| Item | Value | Confirmed Date | Evidence (block/tx/query) | Approver |
|---|---|---|---|---|
| CSPR decimals | TBD | TBD | TBD | TBD |
| stCSPR standard | TBD | TBD | TBD | TBD |
| stCSPR contract hash/address | TBD | TBD | TBD | TBD |
| stCSPR decimals | TBD | TBD | TBD | TBD |
| Styks CSPR/USD feed id | TBD | TBD | TBD | TBD |
| Styks CSPR/USD decimals | TBD | TBD | TBD | TBD |
| stCSPR/USD direct feed | TBD (Yes/No) | TBD | TBD | TBD |
| PRICE_UNIT | DECIDED: P1 (USD per 1 external-unit) | TBD | TBD | TBD |
| exchange rate direction (R1/R2) | DECIDED: R1 (CSPR_PER_SCSPR) | TBD | TBD | TBD |
| exchange rate source | DECIDED: ONCHAIN_LST_STATE | TBD | TBD | TBD |
| MAX_PRICE_AGE_SECONDS | TBD | TBD | TBD | TBD |
| MAX_DEVIATION_BPS | TBD | TBD | TBD | TBD |
| internal accounting scale | TBD | TBD | TBD | TBD |
| rounding rules | TBD | TBD | TBD | TBD |
