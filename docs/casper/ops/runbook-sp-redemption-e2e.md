# StabilityPool + Redemption E2E Runbook

This runbook covers the end-to-end testing flow for Stability Pool deposits/withdrawals and Redemption operations.

## Prerequisites

1. **Deployed Contracts**: Run `deploy.sh` and ensure all contracts are deployed:
   - Registry, Router, Treasury
   - StabilityPool, RedemptionEngine, LiquidationEngine
   - BranchCSPR, BranchSCSPR
   - OracleAdapter
   - Stablecoin (gUSD)

2. **Frontend Bound**: Run `bind-frontend.sh` to configure contract hashes.

3. **Funded Accounts**: Test accounts with CSPR and gUSD balances.

4. **Oracle Price**: Ensure OracleAdapter has a valid price feed.

---

## Flow 1: Stability Pool Deposit

### Step 1.1: Check gUSD Balance
```bash
# Query user's gUSD balance via RPC
casper-client query-global-state \
  --node-address $NODE_ADDRESS \
  --state-root-hash $STATE_ROOT \
  --key hash-$STABLECOIN_HASH \
  -q balances/$ACCOUNT_HASH
```

### Step 1.2: Approve gUSD Spending
```bash
# Approve StabilityPool to spend gUSD
casper-client put-deploy \
  --node-address $NODE_ADDRESS \
  --chain-name $CHAIN_NAME \
  --secret-key $SECRET_KEY \
  --payment-amount 2000000000 \
  --session-hash hash-$STABLECOIN_HASH \
  --session-entry-point "approve" \
  --session-arg "spender:key='hash-$STABILITY_POOL_HASH'" \
  --session-arg "amount:u256='$AMOUNT'"
```

### Step 1.3: Deposit to Stability Pool
```bash
# Call deposit on StabilityPool
casper-client put-deploy \
  --node-address $NODE_ADDRESS \
  --chain-name $CHAIN_NAME \
  --secret-key $SECRET_KEY \
  --payment-amount 3000000000 \
  --session-hash hash-$STABILITY_POOL_HASH \
  --session-entry-point "deposit" \
  --session-arg "amount:u256='$AMOUNT'"
```

### Step 1.4: Verify Deposit
```bash
# Query pool total deposits
casper-client query-global-state \
  --node-address $NODE_ADDRESS \
  --state-root-hash $STATE_ROOT \
  --key hash-$STABILITY_POOL_HASH \
  -q total_deposits
```

---

## Flow 2: Stability Pool Withdrawal

### Step 2.1: Check Safe Mode
```bash
# Query safe_mode state (must be false for withdrawals)
casper-client query-global-state \
  --node-address $NODE_ADDRESS \
  --state-root-hash $STATE_ROOT \
  --key hash-$STABILITY_POOL_HASH \
  -q safe_mode
```

### Step 2.2: Withdraw gUSD
```bash
# Call withdraw on StabilityPool
casper-client put-deploy \
  --node-address $NODE_ADDRESS \
  --chain-name $CHAIN_NAME \
  --secret-key $SECRET_KEY \
  --payment-amount 3000000000 \
  --session-hash hash-$STABILITY_POOL_HASH \
  --session-entry-point "withdraw" \
  --session-arg "amount:u256='$AMOUNT'"
```

---

## Flow 3: Claim Gains

### Step 3.1: Check Pending Gains
```bash
# Query user's depositor snapshot (check gains)
casper-client query-global-state \
  --node-address $NODE_ADDRESS \
  --state-root-hash $STATE_ROOT \
  --key hash-$STABILITY_POOL_HASH \
  -q deposits/$ACCOUNT_HASH
```

### Step 3.2: Claim Gains
```bash
# Call claim_gains on StabilityPool
casper-client put-deploy \
  --node-address $NODE_ADDRESS \
  --chain-name $CHAIN_NAME \
  --secret-key $SECRET_KEY \
  --payment-amount 3000000000 \
  --session-hash hash-$STABILITY_POOL_HASH \
  --session-entry-point "claim_gains"
```

---

## Flow 4: Redemption

### Step 4.1: Check Redemption Status
```bash
# Query redemption safe_mode and fees
casper-client query-global-state \
  --node-address $NODE_ADDRESS \
  --state-root-hash $STATE_ROOT \
  --key hash-$REDEMPTION_ENGINE_HASH \
  -q base_fee_bps

casper-client query-global-state \
  --node-address $NODE_ADDRESS \
  --state-root-hash $STATE_ROOT \
  --key hash-$REDEMPTION_ENGINE_HASH \
  -q safe_mode
```

### Step 4.2: Approve gUSD for Redemption
```bash
# Approve RedemptionEngine to spend gUSD
casper-client put-deploy \
  --node-address $NODE_ADDRESS \
  --chain-name $CHAIN_NAME \
  --secret-key $SECRET_KEY \
  --payment-amount 2000000000 \
  --session-hash hash-$STABLECOIN_HASH \
  --session-entry-point "approve" \
  --session-arg "spender:key='hash-$REDEMPTION_ENGINE_HASH'" \
  --session-arg "amount:u256='$GUSD_AMOUNT'"
```

### Step 4.3: Execute Redemption
```bash
# Call redeem_u8 on RedemptionEngine
# collateral_id: 0 = CSPR, 1 = stCSPR
casper-client put-deploy \
  --node-address $NODE_ADDRESS \
  --chain-name $CHAIN_NAME \
  --secret-key $SECRET_KEY \
  --payment-amount 5000000000 \
  --session-hash hash-$REDEMPTION_ENGINE_HASH \
  --session-entry-point "redeem_u8" \
  --session-arg "collateral_id:u8='0'" \
  --session-arg "csprusd_amount:u256='$GUSD_AMOUNT'" \
  --session-arg "max_fee_bps:u32='500'" \
  --session-arg "max_iterations:u32='10'"
```

### Step 4.4: Verify Redemption
```bash
# Check total redeemed amount
casper-client query-global-state \
  --node-address $NODE_ADDRESS \
  --state-root-hash $STATE_ROOT \
  --key hash-$REDEMPTION_ENGINE_HASH \
  -q total_redeemed
```

---

## Troubleshooting

### Safe Mode Active
If withdrawals/redemptions fail due to safe mode:
1. Check oracle freshness
2. Wait for safe mode timeout or call clear_safe_mode (admin only)

### Insufficient Balance
1. Verify gUSD balance before operations
2. Check allowance was set correctly

### Transaction Reverts
1. Check deploy status for error message
2. Verify contract hashes are correct
3. Ensure oracle price is fresh

---

## Frontend Smoke Test

After binding frontend, verify:

1. **Wallet Connection**: Connect Casper Wallet
2. **Balance Display**: Check gUSD balance shows correctly
3. **SP Deposit**: Deposit gUSD to Stability Pool
4. **SP Stats**: Verify pool stats update
5. **Redemption Quote**: Get quote for redemption
6. **Redemption Execute**: Redeem gUSD for collateral

---

## Contract State Queries

### Query StabilityPool Stats
```bash
STATE_ROOT=$(casper-client get-state-root-hash --node-address $NODE_ADDRESS | jq -r '.result.state_root_hash')

# Total deposits
casper-client query-global-state \
  --node-address $NODE_ADDRESS \
  --state-root-hash $STATE_ROOT \
  --key hash-$STABILITY_POOL_HASH \
  -q total_deposits

# Total CSPR collateral
casper-client query-global-state \
  --node-address $NODE_ADDRESS \
  --state-root-hash $STATE_ROOT \
  --key hash-$STABILITY_POOL_HASH \
  -q total_cspr_collateral

# Total debt absorbed
casper-client query-global-state \
  --node-address $NODE_ADDRESS \
  --state-root-hash $STATE_ROOT \
  --key hash-$STABILITY_POOL_HASH \
  -q total_debt_absorbed
```

### Query Redemption Stats
```bash
# Total redeemed
casper-client query-global-state \
  --node-address $NODE_ADDRESS \
  --state-root-hash $STATE_ROOT \
  --key hash-$REDEMPTION_ENGINE_HASH \
  -q total_redeemed

# Total fees collected
casper-client query-global-state \
  --node-address $NODE_ADDRESS \
  --state-root-hash $STATE_ROOT \
  --key hash-$REDEMPTION_ENGINE_HASH \
  -q total_fees_collected
```
