# Casper Test Vectors Guide

Vectors in this directory do **not** hard-code network-confirmed values. Instead, decimals/scale/rounding are included as **test parameters** to verify that implementations follow the same rules.

## Files

- Oracle composite vectors: `docs/casper/test-vectors/oracle-composite.v1.json`
- Collateral accounting vectors: `docs/casper/test-vectors/collateral-accounting.v1.json`

## Oracle Composite Vectors (`oracle-composite.v1.json`) Rules

### Inputs

- `csprUsd`: CSPR/USD price and timestamp
- `rate`: stCSPR exchange rate and timestamp
- `composition.mode`:
  - `COMPOSITE`: compute `P(stCSPR/USD)` via composite formula
  - `DIRECT`: for direct-feed validation (same schema; implementation uses direct path)
- `rounding.targetPriceDecimals`: final comparison decimals

### Freshness Judgment

Fix the “current time” in the test harness using one of the following (choose one and keep consistent for all tests):

- Option A (recommended): `nowSec = max(csprUsd.timestampSec, rate.timestampSec)`  
  - Easier to express relative staleness
- Option B: fixed `nowSec` injected at test runtime

Judgment:

- `csprUsdFresh = (nowSec - csprUsd.timestampSec) <= maxAgeSec`
- `rateFresh = (nowSec - rate.timestampSec) <= maxAgeSec`
- `effectiveFresh = csprUsdFresh && rateFresh`

### Composite Calculation (Concept)

- Normalize `P_cspr` and `R` to the same scale before calculation.
- Decision (protocol): R1 (`CSPR_PER_SCSPR`) — multiplication
- R2 (`SCSPR_PER_CSPR`) — division *(reference only; not adopted)*
- Rescale to `targetPriceDecimals` and round using `rounding.mode`.

Allowed tolerance is `expected.tolerance`.

## Collateral Accounting Vectors (`collateral-accounting.v1.json`) Rules

### Purpose

Verify consistent conversion between external units (native/token decimals) and internal accounting units (`internalDecimals`).

### Base Conversion (Concept)

- `scale = internalDecimals - externalDecimals`
- `amountInternal = amountExternal * 10^scale` (scale > 0)
- `amountInternal = amountExternal / 10^(-scale)` (scale < 0, apply rounding)
- Round-trip check: `amountExternalRoundTrip` is obtained by converting `amountInternal` back to external units

## Linking Network-Confirmed Values (Optional)

Network-confirmed decimals/feed IDs/thresholds are tracked in `docs/casper/decision/parameter-confirmation.md`. Tests can “specialize” vectors by injecting those values via environment/profile (e.g., in CI).
