# Runbook: Styks (Odra) Oracle Ops (Casper Mode Only)

## Purpose

- Provide stable CSPR/USD and (if needed) stCSPR/USD pricing.
- If no direct feed exists, derive stCSPR via **composite pricing**.
- Minimize protocol risk when stale/anomalies occur.

## Preconditions (Confirmation Required)

- [ ] Feed ID/decimals/thresholds/rate source confirmed via `docs/casper/decision/parameter-confirmation.md`
- [ ] Ops keys/authority model (who updates/signs/deploys) confirmed
- [ ] Monitoring/alert channels confirmed (e.g., PagerDuty/Slack)

## LST Rate Sync Setup

### Overview

The OracleAdapter uses stCSPR ybToken exchange rate for composite pricing:
- `P_stcspr = P_cspr * R` where R is the stCSPR/CSPR exchange rate
- R is read from ybToken and synced to OracleAdapter

### Prerequisites

1. stCSPR ybToken deployed and configured
2. OracleAdapter.set_scspr_ybtoken(ybtoken_address) called during deployment
3. Keeper account with sufficient CSPR for gas

### Keeper Script

Use `casper/scripts/sync-rate.sh` to sync rates:

```bash
# Basic usage
./casper/scripts/sync-rate.sh testnet /path/to/keeper_key.pem

# Dry run (query only, no transaction)
DRY_RUN=true ./casper/scripts/sync-rate.sh testnet

# Custom node address
CSPR_NODE_ADDRESS=https://rpc.example.com ./casper/scripts/sync-rate.sh testnet /path/to/key.pem
```

### Cron Setup

Set up automated rate sync every 15 minutes:

```bash
# Edit crontab
crontab -e

# Add this line (adjust paths as needed):
*/15 * * * * /path/to/cspr-cdp/casper/scripts/sync-rate.sh testnet /path/to/keeper_key.pem >> /var/log/cspr-cdp-rate-sync.log 2>&1
```

For production (mainnet), consider:

```bash
# More frequent sync (every 10 minutes) with alerting
*/10 * * * * /path/to/cspr-cdp/casper/scripts/sync-rate.sh mainnet /path/to/keeper_key.pem >> /var/log/cspr-cdp-rate-sync.log 2>&1 || curl -X POST https://alerts.example.com/webhook
```

### Systemd Service (Alternative)

For more robust operation, use a systemd timer:

```ini
# /etc/systemd/system/cspr-cdp-rate-sync.service
[Unit]
Description=CSPR-CDP LST Rate Sync
After=network.target

[Service]
Type=oneshot
User=cspr-keeper
Environment=CSPR_NODE_ADDRESS=https://node.mainnet.casper.network
ExecStart=/opt/cspr-cdp/casper/scripts/sync-rate.sh mainnet /opt/cspr-cdp/keys/keeper_key.pem
StandardOutput=append:/var/log/cspr-cdp-rate-sync.log
StandardError=append:/var/log/cspr-cdp-rate-sync.log

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/cspr-cdp-rate-sync.timer
[Unit]
Description=CSPR-CDP Rate Sync Timer

[Timer]
OnCalendar=*:0/15
Persistent=true

[Install]
WantedBy=timers.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cspr-cdp-rate-sync.timer
```

## Manual Operations

### Query Current Rate

```bash
# Get state root hash
STATE_ROOT=$(casper-client get-state-root-hash \
  --node-address https://node.testnet.casper.network \
  | jq -r '.result.state_root_hash')

# Query OracleAdapter
ORACLE_HASH="hash-<your-oracle-hash>"
casper-client query-global-state \
  --node-address https://node.testnet.casper.network \
  --state-root-hash "$STATE_ROOT" \
  --key "$ORACLE_HASH"
```

### Manual Rate Sync

If automated sync fails, sync manually:

```bash
# Get rate from ybToken (external to sync)
RATE="1050000000000000000"  # 1.05 CSPR per stCSPR

# Sync to Oracle
casper-client put-deploy \
  --node-address https://node.testnet.casper.network \
  --chain-name casper-test \
  --secret-key /path/to/keeper_key.pem \
  --session-hash "$ORACLE_HASH" \
  --session-entry-point "sync_rate_from_ybtoken" \
  --session-arg "rate:u256='$RATE'" \
  --payment-amount 1000000000
```

### Check Rate Freshness

```bash
# Query last sync timestamp
casper-client query-global-state \
  --node-address https://node.testnet.casper.network \
  --state-root-hash "$STATE_ROOT" \
  --key "$ORACLE_HASH" \
  -q "last_rate_update_timestamp"
```

## Normal Operations

### 1) Update Cadence

- Update at least every `MAX_PRICE_AGE_SECONDS / 3` (e.g., if max age is 60 min, update ≤ 20 min).
- Consider external price source update cadence and Styks propagation delay.
- **Recommended: 10-15 minute sync interval**

### 2) Data Sources (Recommended)

- CSPR/USD:
  - Aggregate from multiple sources (≥2) and compute weighted/median (policy confirmed internally)
- stCSPR rate (R):
  - Prefer on-chain metrics (total assets/total supply from ybToken)
  - If direct feed exists, prefer direct; otherwise composite

### 3) Publish/Propagation

Operators confirm Styks updates succeeded:

- [ ] Transaction success (check deploy hash)
- [ ] Query result within expected range
- [ ] Timestamp/freshness moved forward (no rollback)

## Monitoring/Alerts (Required)

### Freshness Metrics

- [ ] `age(P_cspr)` seconds - CSPR/USD price age
- [ ] `age(R)` seconds - Exchange rate age
- **Alert threshold: > 45 minutes (3/4 of max age)**

### Anomaly Detection

- [ ] Price spikes (e.g., 1m/10m/1h change thresholds)
- [ ] Composite vs direct deviation (if direct exists), in bps
- **Alert threshold: > 5% change in 10 minutes**

### Liveness Metrics

- [ ] Rate sync failure rate
- [ ] RPC/node latency and error rate
- [ ] Keeper account balance (needs CSPR for gas)

### Example Monitoring Script

```bash
#!/bin/bash
# monitor-rate-sync.sh

NETWORK="$1"
DEPLOY_FILE="$2"
MAX_AGE_SECONDS=2700  # 45 minutes

ORACLE_HASH=$(jq -r '.contracts.oracleAdapter.hash' "$DEPLOY_FILE")
NODE_ADDRESS=$(jq -r '.nodeAddress' "$DEPLOY_FILE")

STATE_ROOT=$(casper-client get-state-root-hash --node-address "$NODE_ADDRESS" | jq -r '.result.state_root_hash')

# Query timestamp
LAST_UPDATE=$(casper-client query-global-state \
  --node-address "$NODE_ADDRESS" \
  --state-root-hash "$STATE_ROOT" \
  --key "$ORACLE_HASH" \
  -q "last_rate_update_timestamp" 2>/dev/null | jq -r '.result.stored_value.CLValue.parsed // 0')

CURRENT_TIME=$(date +%s)
AGE=$((CURRENT_TIME - LAST_UPDATE / 1000))  # Convert ms to seconds if needed

echo "Rate age: ${AGE}s (max: ${MAX_AGE_SECONDS}s)"

if [ "$AGE" -gt "$MAX_AGE_SECONDS" ]; then
    echo "ALERT: Rate is stale!"
    # Send alert via webhook, email, etc.
    exit 1
fi

echo "OK: Rate is fresh"
exit 0
```

## Incident Response (Checklist)

### Scenario A: Oracle Stale

- [ ] Identify cause: data source outage / network congestion / permissions / ops error
- [ ] Check keeper logs: `/var/log/cspr-cdp-rate-sync.log`
- [ ] Check keeper account balance
- [ ] Immediate actions (per policy):
  - [ ] Retry sync manually
  - [ ] Switch to backup node if primary is down
  - [ ] Decide whether to switch safe mode
  - [ ] User communication (if behavior changes: repay-only, borrow blocked)

### Scenario B: Price Anomaly (Spike)

- [ ] Validate source data (multi-source comparison)
- [ ] Separate composite components (P_cspr vs R)
- [ ] Temporary mitigation (per policy):
  - [ ] Pause/hold updates
  - [ ] Keep previous value vs reset-to-zero (avoid protocol risk)
  - [ ] Trigger circuit breaker

### Scenario C: Rate Source (R) Failure

- [ ] Check ybToken contract state
- [ ] Check fallback to direct stCSPR/USD feed
- [ ] If no fallback: restrict new positions/withdrawals/borrowing for stCSPR (S2/S3 policy)

### Scenario D: Keeper Key Compromise

- [ ] Immediately revoke operator permissions
- [ ] Deploy new keeper with fresh keys
- [ ] Audit recent rate syncs for anomalies
- [ ] Update cron/systemd with new key path

## Ops Review Cadence (Recommended)

- [ ] Weekly: feed accuracy/latency/outage review
- [ ] Monthly: re-evaluate rate source upgrade risk
- [ ] Quarterly: re-tune stale/deviation thresholds, rotate keeper keys

## Related Documentation

- [Deployment Runbook](./runbook-deployment.md) - Initial deployment procedure
- [ADR-001 Oracle Policy](../../adr/ADR-001-styks-oracle.md) - Oracle design decisions
- [Parameter Confirmation](../decision/parameter-confirmation.md) - Network parameters
