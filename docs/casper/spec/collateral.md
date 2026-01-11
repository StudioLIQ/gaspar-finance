# Collateral Spec: CSPR (Native) & stCSPR (Token)

## Goals

- Support two collateral types (**CSPR**, **stCSPR**) with **equivalent protocol semantics**.
- Abstract “form differences (native vs token)” behind an adapter layer (concept spec) to minimize impact on core logic.
- Do not hard-code ambiguous values (decimals/addresses/token standard details); use the confirmation procedure.

## Collateral Type Definitions

- `CSPR_NATIVE`: Casper native token CSPR
- `SCSPR_TOKEN`: stCSPR token (likely CEP-18; final standard confirmed via procedure)

### Scope of “Equivalent Semantics” (Required)

The following rules must hold regardless of collateral type:

- Collateral valuation uses the same MCR/liquidation conditions
- Borrow/repay/fees/interest (if any) follow the same rules
- Liquidation distribution (pool/penalty/fees) is the same
- Redemption rules are the same
- System safety policies (oracle staleness/circuit breaker, etc.) are the same

## Adapter Abstraction (Concept Spec)

In Casper mode, collateral transfer/balance semantics differ by type, so core logic depends only on a **conceptual interface**.

Required capabilities (spec):

- `kind`: collateral type (`CSPR_NATIVE` or `SCSPR_TOKEN`)
- `decimals`: collateral decimals (confirmed via procedure)
- `transfer_in(from, amount_external)` / `transfer_out(to, amount_external)` (implementation choice)
- `balance_external(owner)` (optional: UX/verification)

**Note**: `amount_external` (chain-native/token units) and `amount_accounted` (internal accounting units) may differ. Conversion rules are confirmed via `docs/casper/decision/parameter-confirmation.md`.

## CSPR (Native) Collateral Semantics

- Deposit: user sends native CSPR with the transaction; it is accounted as collateral
- Withdraw: protocol transfers native CSPR to the user

Required checks:

- [ ] Define smallest unit name and decimals (e.g., motes)
- [ ] Define transfer failure/gas/revert policy
- [ ] Define re-entrancy/recursion defense policy (especially if callbacks/hooks exist)

## stCSPR (Token) Collateral Semantics

### Token Standard

- Whether stCSPR is CEP-18 and its exact interface are **confirmed via procedure**.

### Deposit/Withdraw

- Deposit: user transfers stCSPR to the protocol (recommended: `transfer_from` with approval)
- Withdraw: protocol transfers stCSPR to the user

Required checks:

- [ ] Confirm `decimals`, `symbol`, `name`, `contract_hash` (or address)
- [ ] Define fee-on-transfer handling policy (if applicable)
- [ ] Verify whether the token has hooks/callbacks or non-standard behavior

## Internal Accounting — Requirements

### Units/Scale

- Internal accounting is **integer fixed-point**.
- The scale (e.g., 1e18) is confirmed via the procedure.

### Rounding/Error Policy

Policies that must be documented:

- [ ] External → internal rounding: choose `floor` / `round` / `ceil` (must be consistent)
- [ ] Internal → external rounding policy
- [ ] Tolerance for price/rate composition (bps or absolute)

Test vectors must follow `docs/casper/test-vectors/collateral-accounting.v1.json`.
