# Pitch Deck (Casper Hackathon) — csprUSD

## Slide 1 — Title
- Project: **csprUSD** (Casper-native stablecoin rail + credit primitive)
- Tagline: **Unlock staked CSPR liquidity and bootstrap a Casper-native unit of account: gUSD.**
- Status: **Testnet-first, WIP, not deployed (yet), not audited**
- Contact: **Inch Yang (StudioLIQ)** — **inchyangv@gmail.com**

## Slide 2 — Problem: Casper Needs “Money Legos”
- Casper users can’t unlock liquidity from staked CSPR without selling/unstaking.
- Casper apps don’t share a Casper-native, composable stable unit (pricing, LP pairs, credit, payments).
- Even when LSTs exist, the ecosystem needs a **standardized on-chain exchange rate** (`R = CSPR_PER_SCSPR`) to safely use LST collateral across protocols.

## Slide 3 — Current Alternatives (and why they fail)
- Bridge in USDC/USDT or rely on CEX/off-chain credit: adds trust, fragmentation, and poor composability on Casper.
- Use non-staked collateral only: forces users to give up staking yield and still doesn’t create a Casper-native stablecoin rail.
- Use an LST without a standardized, queryable on-chain rate: makes oracle composition and risk management brittle.

## Slide 4 — Solution: Casper-Native gUSD (Backed by CSPR + stCSPR)
- **csprUSD issues gUSD**: a Casper-native stablecoin designed to be composable by the whole ecosystem.
- Users can collateralize with:
  - **CSPR** (native)
  - **stCSPR** (LST / CEP-18), using **on-chain `R`** for safe accounting and oracle composition
- Design intent:
  - A clean, predictable borrowing primitive (Liquity-inspired)
  - Safety-first oracle policy and circuit-breaker semantics (Safe Mode)

## Slide 5 — What This Brings to the Network (Ecosystem Impact)
- **A stable unit of account** for Casper apps: pricing, LP pairs, yield strategies, treasury accounting.
- **Liquidity without selling CSPR**: users keep exposure while accessing spendable/usable liquidity (via gUSD).
- **A composable credit layer** other teams can integrate instead of reinventing: “borrow against CSPR/stCSPR” becomes a shared primitive.
- **A flywheel for Casper DeFi**: more gUSD liquidity → better UX for apps → more demand for gUSD → more collateral → more liquidity.

## Slide 6 — Integration Surface (How Others Benefit)
- **DEXs**: deep gUSD pairs (gUSD/CSPR, gUSD/stCSPR) to make Casper trading/LP more “stable-first”.
- **Wallets**: predictable “borrow” UX (collateral → gUSD) and stable balances users actually hold.
- **Staking / LST providers**: stCSPR becomes productive collateral; higher velocity and utility.
- **Apps**: stable-denominated flows (subscriptions, payments, in-app balances) without bridging dependence.

## Slide 7 — Product Demo (What We Can Show Live)
- Web UI (Next.js, Casper testnet, Casper Wallet):
  - Connect wallet → view network + protocol parameters
  - See configured contract slots and “deployed vs not deployed” status
  - LST page (when deployed + bound): read `R`, stake CSPR → receive stCSPR, request withdraw, and claim
- Repo: https://github.com/StudioLIQ/csprUSD

## Slide 8 — Why Us (We’ll Keep Shipping After the Hackathon)
- We’re building this as a **long-running ecosystem primitive**, not a one-off demo.
- We ship end-to-end: contracts, ops, and a usable frontend for Casper-native UX.
- We’re structured for continuation: testnet-first milestones, clear integration targets, and an audit path.

## Slide 9 — Market & Business Model
- Users:
  - Casper stakers who want liquidity without unstaking/selling
  - Casper DeFi apps that need a stablecoin rail + borrowing primitive
- Value capture (protocol-native):
  - Protocol fees (borrowing + risk events) routed to treasury and ecosystem incentives
  - Optional LST fee policy (phase 2 hardening)
- Distribution:
  - Integrations with Casper wallets, DEXs, and staking/LST providers
  - Casper ecosystem partnerships to make stCSPR a de-facto standard collateral

## Slide 10 — Roadmap (Continuation Plan)
- **Milestone 1 (Testnet Alpha):** gUSD mint/repay flows with robust pricing + safety controls enforced
- **Milestone 2 (Incentivized Testnet):** liquidity bootstrapping on gUSD pairs + integration kit for partner dApps
- **Milestone 3 (Mainnet Readiness):** adversarial testing, external review/audit, mainnet launch checklist + phased rollout

## Slide 11 — What We Need (To Maximize Network Impact)
- **Partner intros**: DEXs, wallets, and staking/LST teams to align on gUSD + stCSPR integration.
- **Oracle / data support**: best-practice guidance for robust feeds and monitoring on Casper.
- **Testnet validation**: coordinated testing with ecosystem teams (UX + failure cases).
- **Grant/audit path**: support for security review and production hardening.

## Slide 12 — Team & Ask
- Team:
  - **StudioLIQ** — protocol engineering, Casper smart contracts (Odra), ops + tooling, frontend integration
- Ask:
  - Help us turn gUSD into a **shared Casper stablecoin rail** (partners + early integrators)
  - Support the continuation plan (testnet validation → incentives → audit → mainnet)
