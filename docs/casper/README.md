# Casper Docs

This documentation set defines CDP protocol semantics for Casper, including **specs, test vectors, and operations runbooks**.

## Priority Constraints

1. Two-collateral equivalent semantics: **CSPR (native)** and **stCSPR (token; possibly CEP-18)**
2. Oracle is **Styks (Odra)**: CSPR/USD direct feed, and stCSPR uses **composite pricing** if no direct feed exists
3. Ambiguous values (decimals/scale/rate sources/addresses) must **not** be hard-coded and are documented only via the **confirmation procedure**

## Documentation Map

- Spec index: `docs/casper/spec/README.md`
- Collateral semantics (2 types): `docs/casper/spec/collateral.md`
- Oracle/composite pricing: `docs/casper/spec/oracle.md`
- Parameter confirmation procedure: `docs/casper/decision/parameter-confirmation.md`
- Ops index: `docs/casper/ops/README.md`
- Ops runbook (oracle): `docs/casper/ops/runbook-styks-oracle.md`
- Ops runbook (collateral onboarding): `docs/casper/ops/runbook-collateral-onboarding.md`
- Test vectors:
  - Schemas: `docs/casper/schemas/oracle-composite-vector.schema.json`, `docs/casper/schemas/collateral-accounting-vector.schema.json`
  - Guide: `docs/casper/test-vectors/README.md`
  - Vectors: `docs/casper/test-vectors/oracle-composite.v1.json`, `docs/casper/test-vectors/collateral-accounting.v1.json`

## Terms (Used Only in These Docs)

- **Casper mode**: Equivalent protocol semantics implemented for the Casper runtime (native CSPR + CEP-18 tokens, etc.).
- **Equivalent semantics**: Protocol rules (MCR, liquidation, redemption, fees, pool rewards distribution, etc.) must hold regardless of collateral type.
