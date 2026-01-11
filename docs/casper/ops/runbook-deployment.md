# Deployment Runbook

Complete procedure for deploying CSPR-CDP contracts to Casper network.

## Prerequisites

### Tools

- `cargo` - Rust toolchain (nightly recommended)
- `make` - Build automation
- `casper-client` - Casper CLI client
- `jq` - JSON processor

Verify installation:

```bash
cargo --version
make --version
casper-client --version
jq --version
```

### Account Keys

1. Generate or obtain a Casper account key pair:
   - `secret_key.pem` - Private key (KEEP SECRET)
   - `public_key.pem` - Public key

2. Fund the account:
   - Testnet: Use faucet at https://testnet.cspr.live/tools/faucet
   - Mainnet: Transfer CSPR from exchange or existing wallet

Required balance: ~500+ CSPR for full deployment.

### External Dependencies

The deployment requires pre-existing contracts:

| Variable | Description | Example |
|----------|-------------|---------|
| `SCSPR_TOKEN_HASH` | stCSPR CEP-18 token contract | `hash-abc123...` |
| `SCSPR_LST_HASH` | stCSPR LST adapter/staking contract | `hash-def456...` |
| `CSPR_DECIMALS` | CSPR token decimals | `9` |
| `SCSPR_DECIMALS` | stCSPR token decimals | `9` |

## Deployment Steps

### Step 1: Build WASM Artifacts

```bash
cd casper
make wasm
```

Verify WASM file exists:

```bash
ls -la wasm/cspr_cdp_contracts.wasm
```

### Step 2: Configure Environment

Create a deployment config file (optional but recommended):

```bash
cat > .deploy.env << 'EOF'
# Network config
export CSPR_DECIMALS=9
export SCSPR_DECIMALS=9

# External contract hashes (from stCSPR deployment)
export SCSPR_TOKEN_HASH=hash-<your-scspr-token-hash>
export SCSPR_LST_HASH=hash-<your-scspr-lst-hash>

# Protocol parameters (optional overrides)
export MCR_BPS=11000           # 110% minimum collateral ratio
export MIN_DEBT=2000000000000000000000  # 2000 gUSD minimum
export BORROWING_FEE_BPS=50    # 0.5% borrowing fee
export REDEMPTION_FEE_BPS=50   # 0.5% redemption fee
export LIQUIDATION_PENALTY_BPS=1000  # 10% liquidation penalty

# LST deployment (default: true)
export DEPLOY_LST=true

# Optional: LST operator (defaults to deployer)
# export LST_OPERATOR=account-hash-...
EOF
```

Load the config:

```bash
source .deploy.env
```

### Step 3: Deploy Contracts

**Testnet deployment:**

```bash
./casper/scripts/deploy.sh testnet /path/to/secret_key.pem
```

**Mainnet deployment:**

```bash
./casper/scripts/deploy.sh mainnet /path/to/secret_key.pem
```

The script will:

1. Build WASM (if needed)
2. Deploy all contracts in dependency order
3. Configure cross-contract references
4. Deploy LST contracts (ybToken, WithdrawQueue) if `DEPLOY_LST=true`
5. Save deployment record to `deployments/casper/<network>-<timestamp>.json`

### Step 4: Verify Deployment

Check the deployment record:

```bash
cat deployments/casper/testnet-*.json | jq '.status'
# Should output: "deployed"
```

Verify key contracts:

```bash
DEPLOY_FILE=$(ls -t deployments/casper/testnet-*.json | head -1)

# Check registry
casper-client query-global-state \
  --node-address https://node.testnet.casper.network \
  --state-root-hash $(casper-client get-state-root-hash --node-address https://node.testnet.casper.network | jq -r '.result.state_root_hash') \
  --key $(jq -r '.contracts.registry.hash' "$DEPLOY_FILE")
```

### Step 5: Bind Frontend

Update frontend configuration with deployed addresses:

```bash
./casper/scripts/bind-frontend.sh testnet
```

This creates:
- `config/casper-testnet.json` - Contract addresses
- `frontend/.env.local.example` - Environment template
- `frontend/.env.local` - Active config (if not exists)

### Step 6: Smoke Test

Run the smoke test to verify basic functionality:

```bash
./casper/scripts/smoke-test.sh testnet /path/to/secret_key.pem
```

## Deployment Record Schema

```json
{
  "network": "testnet",
  "chainName": "casper-test",
  "nodeAddress": "https://node.testnet.casper.network",
  "timestamp": "2025-01-10T12:00:00Z",
  "deployer": "account-hash-...",
  "contracts": {
    "registry": { "hash": "hash-...", "package_hash": "hash-...", "deployed": true },
    "router": { "hash": "hash-...", "package_hash": "hash-...", "deployed": true },
    "stablecoin": { "hash": "hash-...", "package_hash": "hash-...", "deployed": true },
    "scsprYbToken": { "hash": "hash-...", "package_hash": "hash-...", "deployed": true },
    "withdrawQueue": { "hash": "hash-...", "package_hash": "hash-...", "deployed": true }
  },
  "configuration": {
    "mcrBps": 11000,
    "minDebt": "2000000000000000000000",
    "borrowingFeeBps": 50
  },
  "status": "deployed"
}
```

## Contract Deployment Order

The deploy script follows this order to handle dependencies:

1. **Registry** - Core configuration and parameter storage
2. **Router** - Request routing and access control
3. **AccessControl** - Role-based permissions
4. **Stablecoin** - gUSD CEP-18 token
5. **Treasury** - Fee collection and distribution
6. **TokenAdapter** - Generic token operations
7. **ScsprAdapter** - stCSPR-specific operations
8. **OracleAdapter** - Price feed integration
9. **BranchCspr** - CSPR collateral vault
10. **BranchScspr** - stCSPR collateral vault
11. **LiquidationEngine** - Liquidation logic
12. **StabilityPool** - Stability pool for liquidations
13. **RedemptionEngine** - gUSD redemption
14. **Governance** - Protocol governance
15. **ScsprYbToken** - LST yield-bearing token (if DEPLOY_LST=true)
16. **WithdrawQueue** - LST unstaking queue (if DEPLOY_LST=true)

## LST Integration

When `DEPLOY_LST=true` (default), the script also:

1. Deploys `scsprYbToken` - Yield-bearing stCSPR wrapper
2. Deploys `withdrawQueue` - Unstaking queue with unbonding period
3. Links ybToken to WithdrawQueue
4. Configures Oracle to read exchange rate from ybToken
5. Syncs initial rate (R = 1.0)

Post-deployment, set up the rate sync keeper:
- See [LST Rate Sync Runbook](./runbook-styks-oracle.md)

## Troubleshooting

### Deploy Fails with "insufficient balance"

Ensure deployer account has enough CSPR:

```bash
casper-client get-balance \
  --node-address https://node.testnet.casper.network \
  --state-root-hash <state-root-hash> \
  --purse-uref <purse-uref>
```

### Deploy Times Out

Increase poll timeout or retry. Check node status:

```bash
casper-client get-node-status \
  --node-address https://node.testnet.casper.network
```

### Contract Hash Extraction Fails

The deploy result may have a different structure. Check:

```bash
casper-client get-deploy \
  --node-address https://node.testnet.casper.network \
  <deploy-hash> | jq '.result.execution_results[0]'
```

### Missing Environment Variables

All required variables must be set:

```bash
echo "CSPR_DECIMALS=$CSPR_DECIMALS"
echo "SCSPR_DECIMALS=$SCSPR_DECIMALS"
echo "SCSPR_TOKEN_HASH=$SCSPR_TOKEN_HASH"
echo "SCSPR_LST_HASH=$SCSPR_LST_HASH"
```

## Rollback

There is no automated rollback. For failed deployments:

1. Note the failure point in the deployment record
2. Fix the issue
3. Redeploy from scratch (contracts are immutable)

For mainnet, consider deploying to testnet first to validate.

## Security Considerations

1. **Never commit secret keys** - Use environment variables or secure key management
2. **Verify contract hashes** - Compare deployed hashes against expected values
3. **Test on testnet first** - Always validate deployment on testnet
4. **Backup deployment records** - Store `deployments/casper/*.json` securely
5. **Rotate keys after deployment** - Consider using separate deployment vs. admin keys
