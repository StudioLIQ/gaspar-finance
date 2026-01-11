// Casper JSON-RPC Client
//
// Provides a browser-compatible wrapper for Casper node RPC calls.
// Uses named_keys + URef pattern for reading contract state.
// Supports dictionary item queries for indexed data (balances, requests).

import { getNetworkConfig, CONTRACTS, getCurrentNetwork } from './config';

// RPC Response Types
interface RpcResponse<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface StateRootHashResult {
  api_version: string;
  state_root_hash: string;
}

interface QueryGlobalStateResult {
  api_version: string;
  block_header: unknown;
  stored_value: StoredValue;
  merkle_proof: string;
}

interface StoredValue {
  CLValue?: {
    cl_type: unknown;
    bytes: string;
    parsed: unknown;
  };
  Contract?: {
    contract_package_hash: string;
    contract_wasm_hash: string;
    named_keys: NamedKey[];
    entry_points: unknown[];
    protocol_version: string;
  };
  ContractPackage?: unknown;
  Account?: {
    account_hash: string;
    main_purse: string;
    named_keys: NamedKey[];
    associated_keys: unknown[];
    action_thresholds: unknown;
  };
}

interface NamedKey {
  name: string;
  key: string;
}

interface GetBalanceResult {
  api_version: string;
  balance_value: string;
  merkle_proof: string;
}

interface DictionaryItemResult {
  api_version: string;
  dictionary_key: string;
  stored_value: StoredValue;
  merkle_proof: string;
}

interface AccountInfoResult {
  api_version: string;
  account: {
    account_hash: string;
    main_purse: string;
    named_keys: NamedKey[];
    associated_keys: unknown[];
    action_thresholds: unknown;
  };
}

// LST-specific types
export interface LstExchangeRate {
  rate: bigint; // 1e18 scale
  rateFormatted: string; // human readable
  timestamp: number;
}

export interface LstBalance {
  scsprBalance: bigint;
  scsprFormatted: string;
  csprEquivalent: bigint;
  csprEquivalentFormatted: string;
}

export interface WithdrawRequest {
  id: number;
  user: string;
  shareAmount: bigint;
  quotedCsprAmount: bigint;
  quotedRate: bigint;
  requestedAt: number;
  claimableAt: number;
  status: 'pending' | 'claimable' | 'claimed';
}

export interface LstProtocolStats {
  totalAssets: bigint;
  totalShares: bigint;
  exchangeRate: bigint;
  idleCspr: bigint;
  delegatedCspr: bigint;
  undelegatingCspr: bigint;
  claimableCspr: bigint;
}

// Scale constants (matching contract)
const RATE_SCALE = BigInt('1000000000000000000'); // 1e18
const CSPR_DECIMALS = 9;

// Fallback unbonding period in seconds (should be overridden by on-chain QueueConfig.unbonding_period)
// Testnet: 7 hours (25200 seconds), Mainnet: 7 days (604800 seconds)
const UNBONDING_PERIOD_TESTNET = 25200;
const UNBONDING_PERIOD_MAINNET = 604800;
let unbondingPeriodOverrideSec: number | null = null;

export function getUnbondingPeriod(): number {
  if (unbondingPeriodOverrideSec && unbondingPeriodOverrideSec > 0) return unbondingPeriodOverrideSec;
  return getCurrentNetwork() === 'mainnet'
    ? UNBONDING_PERIOD_MAINNET
    : UNBONDING_PERIOD_TESTNET;
}

export function getUnbondingPeriodDisplay(): string {
  const period = getUnbondingPeriod();
  if (period >= 86400) {
    const days = Math.floor(period / 86400);
    return `${days} day${days > 1 ? 's' : ''}`;
  }
  const hours = Math.floor(period / 3600);
  return `${hours} hour${hours > 1 ? 's' : ''}`;
}

// RPC Client
let requestId = 1;

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const network = getNetworkConfig();
  const response = await fetch(network.rpcUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestId++,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`RPC request failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as RpcResponse<T>;

  if (data.error) {
    throw new Error(`RPC error: ${data.error.message} (code: ${data.error.code})`);
  }

  if (data.result === undefined) {
    throw new Error('RPC response missing result');
  }

  return data.result;
}

// Get latest state root hash
export async function getStateRootHash(): Promise<string> {
  const result = await rpcCall<StateRootHashResult>('chain_get_state_root_hash', []);
  return result.state_root_hash;
}

// Query global state by key (URef, Hash, etc.)
export async function queryGlobalState(key: string): Promise<StoredValue | null> {
  const stateRootHash = await getStateRootHash();

  try {
    const result = await rpcCall<QueryGlobalStateResult>('query_global_state', [
      { StateRootHash: stateRootHash },
      key,
      [],
    ]);
    return result.stored_value;
  } catch {
    return null;
  }
}

// Get contract's named_keys
export async function getContractNamedKeys(
  contractHash: string
): Promise<Map<string, string> | null> {
  const normalizedHash = contractHash.startsWith('hash-')
    ? contractHash
    : `hash-${contractHash}`;

  const stored = await queryGlobalState(normalizedHash);
  if (!stored?.Contract?.named_keys) {
    return null;
  }

  const namedKeys = new Map<string, string>();
  for (const nk of stored.Contract.named_keys) {
    namedKeys.set(nk.name, nk.key);
  }
  return namedKeys;
}

// Query a value by named_key name from a contract
export async function queryContractNamedKey(
  contractHash: string,
  keyName: string
): Promise<unknown> {
  const namedKeys = await getContractNamedKeys(contractHash);
  if (!namedKeys) {
    throw new Error(`Failed to get named_keys for contract ${contractHash}`);
  }

  const uref = namedKeys.get(keyName);
  if (!uref) {
    throw new Error(`Named key '${keyName}' not found in contract`);
  }

  const stored = await queryGlobalState(uref);
  if (!stored?.CLValue) {
    throw new Error(`Failed to read value from ${keyName}`);
  }

  return stored.CLValue.parsed;
}

// Query dictionary item by seed URef and key
export async function queryDictionaryItem(
  seedURef: string,
  dictionaryKey: string
): Promise<unknown> {
  const stateRootHash = await getStateRootHash();

  try {
    const result = await rpcCall<DictionaryItemResult>('state_get_dictionary_item', [
      stateRootHash,
      {
        URef: {
          seed_uref: seedURef,
          dictionary_item_key: dictionaryKey,
        },
      },
    ]);

    if (result.stored_value.CLValue) {
      return result.stored_value.CLValue.parsed;
    }
    return null;
  } catch {
    return null;
  }
}

// Query dictionary item by contract hash and dictionary name + key
export async function queryContractDictionary(
  contractHash: string,
  dictionaryName: string,
  itemKey: string
): Promise<unknown> {
  const namedKeys = await getContractNamedKeys(contractHash);
  if (!namedKeys) {
    return null;
  }

  const seedURef = namedKeys.get(dictionaryName);
  if (!seedURef) {
    return null;
  }

  return queryDictionaryItem(seedURef, itemKey);
}

// Get account info including main_purse
export async function getAccountInfo(
  publicKeyHex: string
): Promise<AccountInfoResult['account'] | null> {
  try {
    const result = await rpcCall<AccountInfoResult>('state_get_account_info', [
      { PublicKey: publicKeyHex },
      null, // latest block
    ]);
    return result.account;
  } catch {
    return null;
  }
}

// Query CSPR balance via account's main_purse URef
export async function getAccountCsprBalance(publicKeyHex: string): Promise<bigint> {
  const accountInfo = await getAccountInfo(publicKeyHex);
  if (!accountInfo?.main_purse) {
    return BigInt(0);
  }

  const stateRootHash = await getStateRootHash();

  try {
    const result = await rpcCall<GetBalanceResult>('state_get_balance', [
      stateRootHash,
      accountInfo.main_purse,
    ]);
    return BigInt(result.balance_value);
  } catch {
    return BigInt(0);
  }
}

export async function getAccountHash(publicKeyHex: string): Promise<string | null> {
  const accountInfo = await getAccountInfo(publicKeyHex);
  return accountInfo?.account_hash ?? null;
}

// Legacy compatibility wrapper (deprecated - use queryContractNamedKey instead)
export async function queryContractState(
  contractHash: string,
  keyPath: string[]
): Promise<unknown> {
  // For simple single-key paths, try named_key lookup
  if (keyPath.length === 1) {
    try {
      return await queryContractNamedKey(contractHash, keyPath[0]);
    } catch {
      return null;
    }
  }
  // Multi-level paths are not directly supported; return null
  return null;
}

// Legacy compatibility - use getAccountCsprBalance instead
export async function getAccountBalance(publicKey: string): Promise<bigint> {
  return getAccountCsprBalance(publicKey);
}

// LST-specific queries

// Get stCSPR exchange rate from ybToken contract
export async function getLstExchangeRate(): Promise<LstExchangeRate | null> {
  const ybTokenHash = CONTRACTS.scsprYbtoken;
  if (!ybTokenHash || ybTokenHash === 'null') {
    return null;
  }

  try {
    const stats = await getLstProtocolStats();
    const rateNum = stats?.exchangeRate ?? RATE_SCALE;
    return { rate: rateNum, rateFormatted: formatRate(rateNum), timestamp: Date.now() };
  } catch (error) {
    console.error('Failed to get LST exchange rate:', error);
    return null;
  }
}

// Get user's stCSPR balance from CEP-18 dictionary
export async function getLstBalance(publicKey: string): Promise<LstBalance | null> {
  const ybTokenHash = CONTRACTS.scsprYbtoken;
  if (!ybTokenHash || ybTokenHash === 'null') {
    return null;
  }

  try {
    let balanceNum = BigInt(0);

    try {
      const accountHash = await getAccountHash(publicKey);
      if (!accountHash) {
        throw new Error('Failed to resolve account-hash from public key');
      }
      const balance = await queryContractDictionary(ybTokenHash, 'balances', accountHash);
      if (balance !== null) {
        balanceNum = BigInt(String(balance));
      }
    } catch {
      console.warn('Balance lookup via dictionary failed (mapping key may differ); returning 0.');
    }

    // Get exchange rate to calculate CSPR equivalent
    const rateData = await getLstExchangeRate();
    const rate = rateData?.rate ?? RATE_SCALE;

    const csprEquivalent = (balanceNum * rate) / RATE_SCALE;

    return {
      scsprBalance: balanceNum,
      scsprFormatted: formatCsprAmount(balanceNum),
      csprEquivalent,
      csprEquivalentFormatted: formatCsprAmount(csprEquivalent),
    };
  } catch (error) {
    console.error('Failed to get LST balance:', error);
    return null;
  }
}

type QueueConfigParsed = {
  unbonding_period?: number | string;
};

export async function refreshUnbondingPeriodFromChain(): Promise<number | null> {
  const queueHash = CONTRACTS.withdrawQueue;
  if (!queueHash || queueHash === 'null') return null;

  try {
    const config = (await queryContractNamedKey(queueHash, 'config')) as QueueConfigParsed | null;
    if (!config) return null;

    const raw = config.unbonding_period;
    const parsed = typeof raw === 'string' ? Number(raw) : Number(raw ?? 0);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;

    unbondingPeriodOverrideSec = parsed;
    return parsed;
  } catch {
    return null;
  }
}

// Get user's withdraw requests from queue
export async function getUserWithdrawRequests(publicKey: string): Promise<WithdrawRequest[]> {
  const queueHash = CONTRACTS.withdrawQueue;
  if (!queueHash || queueHash === 'null') {
    return [];
  }

  try {
    const accountHash = await getAccountHash(publicKey);
    if (!accountHash) return [];

    // Best-effort: keep UI in sync with on-chain unbonding period.
    await refreshUnbondingPeriodFromChain();
    const unbondingPeriod = getUnbondingPeriod();

    // Read next_request_id and scan recent request IDs, filtering by owner.
    const nextIdRaw = await queryContractNamedKey(queueHash, 'next_request_id');
    const nextId = Number(nextIdRaw || 1);
    if (!Number.isFinite(nextId) || nextId <= 1) return [];

    const SCAN_LIMIT = 200;
    const startId = Math.max(1, nextId - SCAN_LIMIT);
    const endId = nextId - 1;

    const now = Math.floor(Date.now() / 1000);
    const requests: WithdrawRequest[] = [];

    for (let requestId = startId; requestId <= endId; requestId++) {
      const requestData = await queryContractDictionary(queueHash, 'requests', String(requestId));
      if (!requestData || typeof requestData !== 'object') continue;

      const req = requestData as Record<string, unknown>;
      const owner = req.owner ?? req.user;
      const ownerStr = typeof owner === 'string' ? owner : JSON.stringify(owner);
      if (!ownerStr.includes(accountHash)) continue;

      const requestedAt = Number(req.request_timestamp ?? req.requested_at ?? req.timestamp ?? 0);
      const claimableAtOnchain = Number(req.claimable_at ?? 0);
      const claimableAt = claimableAtOnchain > 0 ? claimableAtOnchain : requestedAt + unbondingPeriod;

      let status: 'pending' | 'claimable' | 'claimed' = 'pending';
      const contractStatus = req.status as unknown;
      const statusStr = typeof contractStatus === 'string' ? contractStatus : JSON.stringify(contractStatus);
      if (statusStr.includes('Claimed') || statusStr === '2') status = 'claimed';
      else if (statusStr.includes('Claimable') || statusStr === '1' || now >= claimableAt) status = 'claimable';

      requests.push({
        id: requestId,
        user: ownerStr,
        shareAmount: BigInt(String(req.shares_locked ?? req.share_amount ?? '0')),
        quotedCsprAmount: BigInt(String(req.quoted_assets ?? req.quoted_cspr_amount ?? '0')),
        quotedRate: BigInt(String(req.quoted_rate ?? RATE_SCALE)),
        requestedAt,
        claimableAt,
        status,
      });
    }

    return requests.filter((r) => r.status !== 'claimed');
  } catch (error) {
    console.error('Failed to get withdraw requests:', error);
    return [];
  }
}

// Get LST protocol statistics
export async function getLstProtocolStats(): Promise<LstProtocolStats | null> {
  const ybTokenHash = CONTRACTS.scsprYbtoken;
  if (!ybTokenHash || ybTokenHash === 'null') {
    return null;
  }

  try {
    const totalSharesRaw = await queryContractNamedKey(ybTokenHash, 'total_shares');
    const totalShares = BigInt(String(totalSharesRaw || '0'));

    const assetsRaw = await queryContractNamedKey(ybTokenHash, 'assets');
    const assets = (assetsRaw ?? {}) as Record<string, unknown>;

    const idleCspr = BigInt(String(assets.idle_cspr ?? '0'));
    const delegatedCspr = BigInt(String(assets.delegated_cspr ?? '0'));
    const undelegatingCspr = BigInt(String(assets.undelegating_cspr ?? '0'));
    const claimableCspr = BigInt(String(assets.claimable_cspr ?? '0'));
    const protocolFees = BigInt(String(assets.protocol_fees ?? '0'));
    const realizedLosses = BigInt(String(assets.realized_losses ?? '0'));

    const gross = idleCspr + delegatedCspr + undelegatingCspr + claimableCspr;
    const deductions = protocolFees + realizedLosses;
    const totalAssets = gross > deductions ? gross - deductions : BigInt(0);

    // Calculate exchange rate: R = total_assets * SCALE / total_shares
    const exchangeRate =
      totalShares > BigInt(0) ? (totalAssets * RATE_SCALE) / totalShares : RATE_SCALE;

    return {
      totalAssets,
      totalShares,
      exchangeRate,
      idleCspr,
      delegatedCspr,
      undelegatingCspr,
      claimableCspr,
    };
  } catch (error) {
    console.error('Failed to get LST protocol stats:', error);
    return null;
  }
}

// Formatting helpers

export function formatCsprAmount(motes: bigint, decimals: number = 4): string {
  const divisor = BigInt(10 ** CSPR_DECIMALS);
  const wholePart = motes / divisor;
  const fractionalPart = motes % divisor;

  // Format fractional part with leading zeros
  const fractionalStr = fractionalPart.toString().padStart(CSPR_DECIMALS, '0');
  const truncatedFractional = fractionalStr.slice(0, decimals);

  if (decimals === 0 || truncatedFractional === '0'.repeat(decimals)) {
    return wholePart.toLocaleString();
  }

  // Remove trailing zeros
  const trimmedFractional = truncatedFractional.replace(/0+$/, '');
  return `${wholePart.toLocaleString()}.${trimmedFractional || '0'}`;
}

export function formatRate(rate: bigint): string {
  // Rate is in 1e18 scale, convert to decimal
  const rateNum = Number(rate) / 1e18;
  return rateNum.toFixed(6);
}

export function parseCsprInput(input: string): bigint | null {
  try {
    const trimmed = input.trim();
    if (!trimmed || trimmed === '') return null;

    // Handle decimal input
    const parts = trimmed.split('.');
    if (parts.length > 2) return null;

    const wholePart = parts[0] || '0';
    let fractionalPart = parts[1] || '';

    // Pad or truncate fractional part to CSPR_DECIMALS
    if (fractionalPart.length > CSPR_DECIMALS) {
      fractionalPart = fractionalPart.slice(0, CSPR_DECIMALS);
    } else {
      fractionalPart = fractionalPart.padEnd(CSPR_DECIMALS, '0');
    }

    const combined = wholePart + fractionalPart;
    const result = BigInt(combined);

    if (result < BigInt(0)) return null;
    return result;
  } catch {
    return null;
  }
}

// Calculate stCSPR shares from CSPR amount
export function convertCsprToShares(csprMotes: bigint, rate: bigint): bigint {
  if (rate === BigInt(0)) return BigInt(0);
  return (csprMotes * RATE_SCALE) / rate;
}

// Calculate CSPR amount from stCSPR shares
export function convertSharesToCspr(shares: bigint, rate: bigint): bigint {
  return (shares * rate) / RATE_SCALE;
}

// ========== StabilityPool Queries ==========

export interface StabilityPoolUserState {
  deposit: bigint;
  depositFormatted: string;
  csprGains: bigint;
  csprGainsFormatted: string;
  scsprGains: bigint;
  scsprGainsFormatted: string;
}

export interface StabilityPoolProtocolStats {
  totalDeposits: bigint;
  totalDepositsFormatted: string;
  totalCsprCollateral: bigint;
  totalScsprCollateral: bigint;
  totalDebtAbsorbed: bigint;
  depositorCount: number;
  isSafeModeActive: boolean;
}

// Get user's stability pool state (deposit + gains)
export async function getStabilityPoolUserState(
  publicKey: string
): Promise<StabilityPoolUserState | null> {
  const spHash = CONTRACTS.stabilityPool;
  if (!spHash || spHash === 'null') {
    return null;
  }

  try {
    const accountHash = await getAccountHash(publicKey);
    if (!accountHash) {
      return null;
    }

    // Query user deposit from dictionary
    const depositData = await queryContractDictionary(spHash, 'deposits', accountHash);

    let deposit = BigInt(0);
    let csprGains = BigInt(0);
    let scsprGains = BigInt(0);

    if (depositData && typeof depositData === 'object') {
      const snapshot = depositData as Record<string, unknown>;
      deposit = BigInt(String(snapshot.deposit ?? '0'));
      // Note: Gains require product-sum calculation which is complex
      // For now, we read from the snapshot but the actual gains require on-chain computation
      // The contract has get_user_cspr_gains and get_user_scspr_gains entrypoints
    }

    return {
      deposit,
      depositFormatted: formatGusdAmount(deposit),
      csprGains,
      csprGainsFormatted: formatCsprAmount(csprGains),
      scsprGains,
      scsprGainsFormatted: formatCsprAmount(scsprGains),
    };
  } catch (error) {
    console.error('Failed to get StabilityPool user state:', error);
    return null;
  }
}

// Get stability pool protocol stats
export async function getStabilityPoolStats(): Promise<StabilityPoolProtocolStats | null> {
  const spHash = CONTRACTS.stabilityPool;
  if (!spHash || spHash === 'null') {
    return null;
  }

  try {
    const totalDepositsRaw = await queryContractNamedKey(spHash, 'total_deposits');
    const totalDeposits = BigInt(String(totalDepositsRaw ?? '0'));

    const totalCsprRaw = await queryContractNamedKey(spHash, 'total_cspr_collateral');
    const totalCsprCollateral = BigInt(String(totalCsprRaw ?? '0'));

    const totalScsprRaw = await queryContractNamedKey(spHash, 'total_scspr_collateral');
    const totalScsprCollateral = BigInt(String(totalScsprRaw ?? '0'));

    const totalDebtRaw = await queryContractNamedKey(spHash, 'total_debt_absorbed');
    const totalDebtAbsorbed = BigInt(String(totalDebtRaw ?? '0'));

    const countRaw = await queryContractNamedKey(spHash, 'depositor_count');
    const depositorCount = Number(countRaw ?? 0);

    const safeModeRaw = await queryContractNamedKey(spHash, 'safe_mode');
    let isSafeModeActive = false;
    if (safeModeRaw && typeof safeModeRaw === 'object') {
      const sm = safeModeRaw as Record<string, unknown>;
      isSafeModeActive = Boolean(sm.is_active);
    }

    return {
      totalDeposits,
      totalDepositsFormatted: formatGusdAmount(totalDeposits),
      totalCsprCollateral,
      totalScsprCollateral,
      totalDebtAbsorbed,
      depositorCount,
      isSafeModeActive,
    };
  } catch (error) {
    console.error('Failed to get StabilityPool stats:', error);
    return null;
  }
}

// ========== Redemption Queries ==========

export interface RedemptionProtocolStats {
  totalRedeemed: bigint;
  totalRedeemedFormatted: string;
  totalCollateralDistributed: bigint;
  totalFeesCollected: bigint;
  baseFee: number;
  maxFee: number;
  currentFee: number;
  isSafeModeActive: boolean;
}

// Get redemption protocol stats
export async function getRedemptionStats(): Promise<RedemptionProtocolStats | null> {
  const reHash = CONTRACTS.redemptionEngine;
  if (!reHash || reHash === 'null') {
    return null;
  }

  try {
    const totalRedeemedRaw = await queryContractNamedKey(reHash, 'total_redeemed');
    const totalRedeemed = BigInt(String(totalRedeemedRaw ?? '0'));

    const totalDistributedRaw = await queryContractNamedKey(reHash, 'total_collateral_distributed');
    const totalCollateralDistributed = BigInt(String(totalDistributedRaw ?? '0'));

    const totalFeesRaw = await queryContractNamedKey(reHash, 'total_fees_collected');
    const totalFeesCollected = BigInt(String(totalFeesRaw ?? '0'));

    const baseFeeRaw = await queryContractNamedKey(reHash, 'base_fee_bps');
    const baseFee = Number(baseFeeRaw ?? 50);

    const maxFeeRaw = await queryContractNamedKey(reHash, 'max_fee_bps');
    const maxFee = Number(maxFeeRaw ?? 500);

    // Current fee is dynamic but starts at base fee
    const currentFee = baseFee;

    const safeModeRaw = await queryContractNamedKey(reHash, 'safe_mode');
    let isSafeModeActive = false;
    if (safeModeRaw && typeof safeModeRaw === 'object') {
      const sm = safeModeRaw as Record<string, unknown>;
      isSafeModeActive = Boolean(sm.is_active);
    }

    return {
      totalRedeemed,
      totalRedeemedFormatted: formatGusdAmount(totalRedeemed),
      totalCollateralDistributed,
      totalFeesCollected,
      baseFee,
      maxFee,
      currentFee,
      isSafeModeActive,
    };
  } catch (error) {
    console.error('Failed to get Redemption stats:', error);
    return null;
  }
}

// ========== gUSD Balance Query ==========

// Get user's gUSD balance from stablecoin contract
export async function getGusdBalance(publicKey: string): Promise<bigint> {
  const gusdHash = CONTRACTS.stablecoin;
  if (!gusdHash || gusdHash === 'null') {
    return BigInt(0);
  }

  try {
    const accountHash = await getAccountHash(publicKey);
    if (!accountHash) {
      return BigInt(0);
    }

    const balance = await queryContractDictionary(gusdHash, 'balances', accountHash);
    if (balance !== null) {
      return BigInt(String(balance));
    }
    return BigInt(0);
  } catch (error) {
    console.error('Failed to get gUSD balance:', error);
    return BigInt(0);
  }
}

// Format gUSD amount (18 decimals)
export function formatGusdAmount(amount: bigint, decimals: number = 2): string {
  const divisor = BigInt(10 ** 18);
  const wholePart = amount / divisor;
  const fractionalPart = amount % divisor;

  const fractionalStr = fractionalPart.toString().padStart(18, '0');
  const truncatedFractional = fractionalStr.slice(0, decimals);

  if (decimals === 0 || truncatedFractional === '0'.repeat(decimals)) {
    return wholePart.toLocaleString();
  }

  const trimmedFractional = truncatedFractional.replace(/0+$/, '');
  return `${wholePart.toLocaleString()}.${trimmedFractional || '0'}`;
}

// ========== CDP Vault Queries ==========

// Collateral type enum
export type CollateralType = 'cspr' | 'scspr';

// Vault data structure
export interface VaultData {
  owner: string;
  collateralId: CollateralType;
  collateral: bigint;
  debt: bigint;
  interestRateBps: number;
  lastAccrualTimestamp: number;
}

// Vault info with computed values
export interface VaultInfo {
  vault: VaultData;
  icrBps: number; // Individual Collateralization Ratio in basis points
  collateralValueUsd: bigint;
}

// Branch status
export interface BranchStatus {
  collateralId: CollateralType;
  totalCollateral: bigint;
  totalDebt: bigint;
  vaultCount: number;
  isSafeModeActive: boolean;
}

// Get user's vault for a specific collateral type
export async function getUserVault(
  publicKey: string,
  collateralType: CollateralType
): Promise<VaultInfo | null> {
  const branchHash = collateralType === 'cspr'
    ? CONTRACTS.branchCspr
    : CONTRACTS.branchSCSPR;

  if (!branchHash || branchHash === 'null') {
    return null;
  }

  try {
    const accountHash = await getAccountHash(publicKey);
    if (!accountHash) {
      return null;
    }

    // Query vault from the vaults dictionary
    const vaultRaw = await queryContractDictionary(branchHash, 'vaults', accountHash);
    if (!vaultRaw) {
      return null;
    }

    // Parse vault data
    const vault = vaultRaw as Record<string, unknown>;
    const vaultData: VaultData = {
      owner: String(vault.owner || ''),
      collateralId: collateralType,
      collateral: BigInt(String(vault.collateral || '0')),
      debt: BigInt(String(vault.debt || '0')),
      interestRateBps: Number(vault.interest_rate_bps || 0),
      lastAccrualTimestamp: Number(vault.last_accrual_timestamp || 0),
    };

    // Get current price for ICR calculation
    const price = await getCollateralPrice(collateralType);
    const collateralValueUsd = calculateCollateralValue(vaultData.collateral, price, collateralType);
    const icrBps = calculateIcr(collateralValueUsd, vaultData.debt);

    return {
      vault: vaultData,
      icrBps,
      collateralValueUsd,
    };
  } catch (error) {
    console.error(`Failed to get vault for ${collateralType}:`, error);
    return null;
  }
}

// Get branch status for a collateral type
export async function getBranchStatus(collateralType: CollateralType): Promise<BranchStatus | null> {
  const branchHash = collateralType === 'cspr'
    ? CONTRACTS.branchCspr
    : CONTRACTS.branchSCSPR;

  if (!branchHash || branchHash === 'null') {
    return null;
  }

  try {
    const [totalCollateralRaw, totalDebtRaw, vaultCountRaw] = await Promise.all([
      queryContractNamedKey(branchHash, 'total_collateral'),
      queryContractNamedKey(branchHash, 'total_debt'),
      queryContractNamedKey(branchHash, 'vault_count'),
    ]);

    return {
      collateralId: collateralType,
      totalCollateral: BigInt(String(totalCollateralRaw || '0')),
      totalDebt: BigInt(String(totalDebtRaw || '0')),
      vaultCount: Number(vaultCountRaw || 0),
      isSafeModeActive: false, // TODO: query from router
    };
  } catch (error) {
    console.error(`Failed to get branch status for ${collateralType}:`, error);
    return null;
  }
}

// Styks Oracle contract package hash (Casper Testnet)
const STYKS_PRICE_FEED = '2879d6e927289197aab0101cc033f532fe22e4ab4686e44b5743cb1333031acc';

// Get CSPR/USD price from Styks oracle
async function getStyksCsprPrice(): Promise<bigint | null> {
  try {
    const network = getNetworkConfig();
    const stateRootHash = await getStateRootHash();
    if (!stateRootHash) return null;

    // Query Styks price feed for CSPR/USD TWAP
    const response = await fetch(network.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'query_global_state',
        params: {
          state_identifier: { StateRootHash: stateRootHash },
          key: `hash-${STYKS_PRICE_FEED}`,
          path: ['twap_prices', 'CSPRUSD'],
        },
      }),
    });

    const data = await response.json();
    if (data.result?.stored_value?.CLValue?.parsed) {
      // Styks returns price data - extract the price value
      const priceData = data.result.stored_value.CLValue.parsed;
      // Handle different possible formats
      if (typeof priceData === 'string') {
        return BigInt(priceData);
      } else if (priceData.price) {
        return BigInt(priceData.price);
      } else if (priceData.value) {
        return BigInt(priceData.value);
      }
    }
    return null;
  } catch (error) {
    console.error('Failed to get Styks CSPR price:', error);
    return null;
  }
}

// Get collateral price (from Styks oracle, fallback to default)
export async function getCollateralPrice(collateralType: CollateralType): Promise<bigint> {
  // Default price: 1 CSPR = $0.02 (scaled to 18 decimals)
  const DEFAULT_PRICE = BigInt('20000000000000000'); // 0.02 * 1e18

  try {
    // Try to get CSPR price from Styks
    const csprPrice = await getStyksCsprPrice();

    if (csprPrice === null) {
      console.warn('Styks oracle unavailable, using default price');
      return DEFAULT_PRICE;
    }

    if (collateralType === 'cspr') {
      return csprPrice;
    } else {
      // stCSPR price = CSPR price * exchange rate
      // Get exchange rate from LST ybToken
      const lstHash = CONTRACTS.scsprYbtoken;
      if (!lstHash || lstHash === 'null') {
        return csprPrice; // Default rate = 1.0
      }

      try {
        const rateRaw = await queryContractNamedKey(lstHash, 'exchange_rate');
        const exchangeRate = BigInt(String(rateRaw || '1000000000000000000'));
        // stCSPR price = CSPR price * exchange rate / 1e18
        return (csprPrice * exchangeRate) / BigInt('1000000000000000000');
      } catch {
        return csprPrice; // Fallback to CSPR price if rate unavailable
      }
    }
  } catch (error) {
    console.error('Failed to get collateral price:', error);
    return DEFAULT_PRICE;
  }
}

// Calculate collateral value in USD (scaled to 18 decimals)
export function calculateCollateralValue(
  collateralAmount: bigint,
  priceUsd: bigint,
  collateralType: CollateralType
): bigint {
  // CSPR/stCSPR use 9 decimals, price uses 18 decimals
  // collateralValue = collateral * price / 1e9
  const decimals = collateralType === 'cspr' ? 9 : 9;
  return (collateralAmount * priceUsd) / BigInt(10 ** decimals);
}

// Calculate Individual Collateralization Ratio in basis points
export function calculateIcr(collateralValueUsd: bigint, debt: bigint): number {
  if (debt === BigInt(0)) {
    return 100000; // 1000% if no debt
  }
  // ICR = (collateralValue / debt) * 10000
  return Number((collateralValueUsd * BigInt(10000)) / debt);
}

// Protocol constants
export const CDP_CONSTANTS = {
  MCR_BPS: 11000, // 110% minimum collateralization ratio
  CCR_BPS: 15000, // 150% critical collateralization ratio
  MIN_DEBT: BigInt('2000000000000000000000'), // 2000 gUSD (18 decimals)
  LIQUIDATION_PENALTY_BPS: 1000, // 10%
  BORROWING_FEE_BPS: 50, // 0.5%
  MIN_INTEREST_RATE_BPS: 0,
  MAX_INTEREST_RATE_BPS: 4000, // 40%
};

// Calculate max borrowable gUSD for given collateral
export function calculateMaxBorrow(
  collateralAmount: bigint,
  priceUsd: bigint,
  collateralType: CollateralType,
  targetCrBps: number = CDP_CONSTANTS.MCR_BPS
): bigint {
  const collateralValue = calculateCollateralValue(collateralAmount, priceUsd, collateralType);
  // maxBorrow = collateralValue * 10000 / targetCR
  return (collateralValue * BigInt(10000)) / BigInt(targetCrBps);
}

// Calculate required collateral for given debt
export function calculateRequiredCollateral(
  debtAmount: bigint,
  priceUsd: bigint,
  collateralType: CollateralType,
  targetCrBps: number = CDP_CONSTANTS.MCR_BPS
): bigint {
  // requiredCollateralValue = debt * targetCR / 10000
  const requiredValue = (debtAmount * BigInt(targetCrBps)) / BigInt(10000);
  // requiredCollateral = requiredValue * 1e9 / price
  const decimals = collateralType === 'cspr' ? 9 : 9;
  return (requiredValue * BigInt(10 ** decimals)) / priceUsd;
}

// Calculate liquidation price for a vault
export function calculateLiquidationPrice(
  collateralAmount: bigint,
  debt: bigint,
  collateralType: CollateralType
): bigint {
  if (collateralAmount === BigInt(0)) {
    return BigInt(0);
  }
  // liquidationPrice = (debt * MCR / 10000) * 1e9 / collateral
  const decimals = collateralType === 'cspr' ? 9 : 9;
  const requiredValue = (debt * BigInt(CDP_CONSTANTS.MCR_BPS)) / BigInt(10000);
  return (requiredValue * BigInt(10 ** decimals)) / collateralAmount;
}
