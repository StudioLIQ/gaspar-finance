// Casper JSON-RPC Client
//
// Provides a browser-compatible wrapper for Casper node RPC calls.
// Uses named_keys + URef pattern for reading contract state.
// Supports dictionary item queries for indexed data (balances, requests).

import { getNetworkConfig, CONTRACTS, getCurrentNetwork } from './config';
import { blake2b } from 'blakejs';

// ========== Odra Dictionary Utilities ==========
// Odra stores all state in a single "state" dictionary with blake2b-hashed keys

function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof window !== 'undefined' && typeof window.btoa === 'function') {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }
  // Node.js fallback (Next.js server/runtime config)
  const buf = (globalThis as typeof globalThis & {
    Buffer?: { from: (data: Uint8Array) => { toString: (enc: string) => string } };
  }).Buffer?.from(bytes);
  return buf ? buf.toString('base64') : '';
}

/**
 * Compute Odra dictionary key for Mapping<Address, V>
 * Key = blake2b(field_index_u32_be + address_serialization)
 * Address = tag (0x00 for Account) + 32 bytes hash
 */
function computeOdraMappingKey(fieldIndex: number, accountHashHex: string): string {
  // Index as 4 bytes big endian
  const indexBytes = new Uint8Array(4);
  indexBytes[0] = (fieldIndex >> 24) & 0xff;
  indexBytes[1] = (fieldIndex >> 16) & 0xff;
  indexBytes[2] = (fieldIndex >> 8) & 0xff;
  indexBytes[3] = fieldIndex & 0xff;

  // Address serialization: tag (0 for AccountHash) + 32 bytes hash
  const addressTag = new Uint8Array([0x00]);
  const hashBytes = hexToBytes(accountHashHex);

  // Concatenate: index + tag + hash
  const keyData = new Uint8Array(4 + 1 + 32);
  keyData.set(indexBytes, 0);
  keyData.set(addressTag, 4);
  keyData.set(hashBytes, 5);

  // Blake2b hash (32 bytes)
  const hashedKey = blake2b(keyData, undefined, 32);
  return bytesToHex(hashedKey);
}

/**
 * Compute CEP-18 balance dictionary key (base64 of Key::Account bytes)
 */
function computeCep18BalanceKey(accountHashHex: string): string {
  const hashBytes = hexToBytes(accountHashHex);
  const keyBytes = new Uint8Array(1 + hashBytes.length);
  keyBytes[0] = 0x00; // Key::Account tag
  keyBytes.set(hashBytes, 1);
  return bytesToBase64(keyBytes);
}

/**
 * Compute account hash from public key hex
 * Casper account hash = blake2b256(algorithm_prefix + 0x00 + raw_public_key)
 * - Ed25519 (01 prefix): "ed25519" + 0x00 + 32 bytes
 * - Secp256k1 (02 prefix): "secp256k1" + 0x00 + 33 bytes
 */
function computeAccountHashFromPublicKey(publicKeyHex: string): string | null {
  try {
    const cleanHex = publicKeyHex.toLowerCase().replace(/^0x/, '');

    if (cleanHex.startsWith('account-hash-')) {
      return cleanHex.replace(/^account-hash-/, '');
    }

    // Determine algorithm from prefix
    let algorithmPrefix: Uint8Array;
    let rawKeyBytes: Uint8Array;

    if (cleanHex.startsWith('ed25519:')) {
      algorithmPrefix = new TextEncoder().encode('ed25519');
      rawKeyBytes = hexToBytes(cleanHex.slice('ed25519:'.length));
    } else if (cleanHex.startsWith('secp256k1:')) {
      algorithmPrefix = new TextEncoder().encode('secp256k1');
      rawKeyBytes = hexToBytes(cleanHex.slice('secp256k1:'.length));
    } else if (cleanHex.startsWith('01')) {
      // Ed25519: 01 + 64 hex chars (32 bytes)
      algorithmPrefix = new TextEncoder().encode('ed25519');
      rawKeyBytes = hexToBytes(cleanHex.slice(2)); // Remove 01 prefix
    } else if (cleanHex.startsWith('02')) {
      // Secp256k1: 02 + 66 hex chars (33 bytes)
      algorithmPrefix = new TextEncoder().encode('secp256k1');
      rawKeyBytes = hexToBytes(cleanHex.slice(2)); // Remove 02 prefix
    } else if (/^[0-9a-f]{64}$/.test(cleanHex)) {
      // Assume already an account-hash (32 bytes hex)
      return cleanHex;
    } else {
      console.error('[computeAccountHash] Unknown key prefix:', cleanHex.slice(0, 2));
      return null;
    }

    // Compute: blake2b256(algorithm_prefix + 0x00 + raw_key)
    const separator = new Uint8Array([0x00]);
    const data = new Uint8Array(algorithmPrefix.length + 1 + rawKeyBytes.length);
    data.set(algorithmPrefix, 0);
    data.set(separator, algorithmPrefix.length);
    data.set(rawKeyBytes, algorithmPrefix.length + 1);

    const hash = blake2b(data, undefined, 32);
    return bytesToHex(hash);
  } catch (err) {
    console.error('[computeAccountHash] Failed:', err);
    return null;
  }
}

/**
 * Parse U256 from raw bytes (little-endian, fixed width)
 */
function parseU256FromBytes(bytes: Uint8Array, offset: number = 0): bigint {
  let result = BigInt(0);
  for (let i = 0; i < 32 && offset + i < bytes.length; i++) {
    result += BigInt(bytes[offset + i]) << BigInt(i * 8);
  }
  return result;
}

/**
 * Parse U256 from CLValue serialization (variable length with length prefix)
 * CLValue U256 format: [length_byte] [data_bytes_little_endian]
 */
function parseU256FromCLValue(bytes: Uint8Array, offset: number = 0): bigint {
  if (offset >= bytes.length) return BigInt(0);

  const length = bytes[offset];
  if (length === 0) return BigInt(0);

  let result = BigInt(0);
  for (let i = 0; i < length && offset + 1 + i < bytes.length; i++) {
    result += BigInt(bytes[offset + 1 + i]) << BigInt(i * 8);
  }
  return result;
}

/**
 * Parse u64 from bytes (little-endian)
 */
function parseU64FromBytes(bytes: Uint8Array, offset: number = 0): bigint {
  let result = BigInt(0);
  for (let i = 0; i < 8 && offset + i < bytes.length; i++) {
    result += BigInt(bytes[offset + i]) << BigInt(i * 8);
  }
  return result;
}

/**
 * Compute Odra dictionary key for Var<T> (simple field access)
 * Key = blake2b(field_index_u32_be)
 */
function computeOdraVarKey(fieldIndex: number): string {
  // Index as 4 bytes big endian
  const indexBytes = new Uint8Array(4);
  indexBytes[0] = (fieldIndex >> 24) & 0xff;
  indexBytes[1] = (fieldIndex >> 16) & 0xff;
  indexBytes[2] = (fieldIndex >> 8) & 0xff;
  indexBytes[3] = fieldIndex & 0xff;

  // Blake2b hash (32 bytes)
  const hashedKey = blake2b(indexBytes, undefined, 32);
  return bytesToHex(hashedKey);
}

// Field indices for Odra contracts (1-indexed!)
const ODRA_FIELD_INDEX = {
  // ScsprYbToken: name(1), symbol(2), decimals(3), total_shares(4), balances(5), allowances(6), assets(7), ...
  SCSPR_TOTAL_SHARES: 4,
  SCSPR_BALANCES: 5,
  SCSPR_ASSETS: 7,  // AssetBreakdown struct
  SCSPR_LAST_SYNC: 8,

  // WithdrawQueue: ybtoken(1), admin(2), next_request_id(3), requests(4), user_requests(5), user_request_count(6), config(7), stats(8)
  QUEUE_CONFIG: 7,
  QUEUE_STATS: 8,

  // StabilityPool: registry(1), router(2), stablecoin(3), liquidation_engine(4), scspr_token(5),
  // total_deposits(6), total_cspr_collateral(7), total_scspr_collateral(8), total_debt_absorbed(9),
  // depositor_count(10), ps_state(11), ..., safe_mode(15)
  SP_TOTAL_DEPOSITS: 6,
  SP_TOTAL_CSPR_COLLATERAL: 7,
  SP_TOTAL_SCSPR_COLLATERAL: 8,
  SP_TOTAL_DEBT_ABSORBED: 9,
  SP_DEPOSITOR_COUNT: 10,
  SP_PS_STATE: 11,
  SP_EPOCH_SCALE_SUM_CSPR: 12,
  SP_EPOCH_SCALE_SUM_SCSPR: 13,
  SP_DEPOSITS: 14,  // Mapping<Address, DepositSnapshot>
  SP_SAFE_MODE: 15,

  // Branch (CSPR/SCSPR common prefix): registry(1), router(2), vaults(3), sorted_vaults(4), sorted_head(5), sorted_tail(6),
  // total_collateral(7), total_debt(8), vault_count(9), safe_mode(10), last_good_price(11), ...
  BRANCH_VAULTS: 3,  // Mapping<VaultKey(owner+id), VaultData>
  BRANCH_TOTAL_COLLATERAL: 7,
  BRANCH_TOTAL_DEBT: 8,
  BRANCH_VAULT_COUNT: 9,
  BRANCH_SAFE_MODE: 10,

  // BranchCspr tail fields (multi-vault)
  BRANCH_CSPR_USER_VAULT_COUNT: 15,
  BRANCH_CSPR_USER_VAULT_IDS: 16, // Mapping<UserVaultIndex(owner+index), u64 vault_id>

  // BranchScspr tail fields (multi-vault)
  BRANCH_SCSPR_USER_VAULT_COUNT: 17,
  BRANCH_SCSPR_USER_VAULT_IDS: 18, // Mapping<UserVaultIndex(owner+index), u64 vault_id>

  // RedemptionEngine: registry(1), router(2), stablecoin(3), treasury(4), styks_oracle(5),
  // scspr_ybtoken(6), branch_cspr(7), branch_scspr(8), scspr_token(9),
  // base_fee_bps(10), max_fee_bps(11), total_redeemed(12), total_collateral_distributed(13),
  // total_fees_collected(14), safe_mode(15)
  RE_BASE_FEE_BPS: 10,
  RE_MAX_FEE_BPS: 11,
  RE_TOTAL_REDEEMED: 12,
  RE_TOTAL_COLLATERAL_DISTRIBUTED: 13,
  RE_TOTAL_FEES_COLLECTED: 14,

  // CsprUsd: name(1), symbol(2), decimals(3), total_supply(4), balances(5), ...
  GUSD_BALANCES: 5,
} as const;

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
  // Casper 2.0 format
  AddressableEntity?: {
    package_hash: string;
    byte_code_hash: string;
    named_keys: NamedKey[];
    entry_points: unknown[];
    protocol_version: string;
    main_purse?: string;
    associated_keys?: unknown[];
    action_thresholds?: unknown;
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

// Casper 2.0 query_balance result
interface QueryBalanceResult {
  api_version: string;
  balance: string;
}

// Casper 2.0 state_get_entity result
interface StateGetEntityResult {
  api_version: string;
  entity: {
    Account?: {
      account_hash: string;
      main_purse: string;
      named_keys: NamedKey[];
      associated_keys: unknown[];
      action_thresholds: unknown;
    };
  };
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

// Get RPC endpoint - use local proxy in browser to avoid CORS
function getRpcEndpoint(): string {
  if (typeof window !== 'undefined') {
    // Browser: use local proxy
    return '/api/rpc';
  }
  // Server-side: direct connection
  const network = getNetworkConfig();
  return network.rpcUrl;
}

async function rpcCall<T>(method: string, params: unknown[] | Record<string, unknown>): Promise<T> {
  const rpcUrl = getRpcEndpoint();
  const reqId = requestId++;

  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: reqId,
        method,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(`RPC request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as RpcResponse<T>;

    if (data.error) {
      // state_get_dictionary_item returns error when key doesn't exist - this is expected
      if (method !== 'state_get_dictionary_item') {
        console.warn(`[RPC] ${method} error:`, data.error.message);
      }
      throw new Error(`RPC error: ${data.error.message} (code: ${data.error.code})`);
    }

    if (data.result === undefined) {
      throw new Error('RPC response missing result');
    }

    return data.result;
  } catch (error) {
    if (method !== 'state_get_dictionary_item') {
      console.error(`[RPC] ${method} failed:`, error);
    }
    throw error;
  }
}

// Get latest state root hash
export async function getStateRootHash(): Promise<string> {
  const result = await rpcCall<StateRootHashResult>('chain_get_state_root_hash', []);
  return result.state_root_hash;
}

// Query global state by key (URef, Hash, etc.) - Casper 2.0 format
export async function queryGlobalState(key: string, path: string[] = []): Promise<StoredValue | null> {
  try {
    const result = await rpcCall<QueryGlobalStateResult>('query_global_state', {
      key,
      state_identifier: null, // latest state
      path,
    });
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

// Get contract's package hash from contract hash
// Supports both Casper 1.x (Contract) and Casper 2.0 (AddressableEntity) formats
export async function getContractPackageHash(contractHash: string): Promise<string | null> {
  const normalizedHash = contractHash.startsWith('hash-')
    ? contractHash
    : `hash-${contractHash}`;

  console.debug('[getContractPackageHash] querying:', normalizedHash);

  const stored = await queryGlobalState(normalizedHash);
  if (!stored) {
    console.debug('[getContractPackageHash] no stored value returned');
    return null;
  }

  console.debug('[getContractPackageHash] stored value keys:', Object.keys(stored));

  // Casper 1.x format
  if (stored.Contract?.contract_package_hash) {
    console.debug('[getContractPackageHash] found Contract.contract_package_hash');
    return stored.Contract.contract_package_hash;
  }

  // Casper 2.0 format (AddressableEntity)
  if (stored.AddressableEntity?.package_hash) {
    console.debug('[getContractPackageHash] found AddressableEntity.package_hash');
    return stored.AddressableEntity.package_hash;
  }

  // Alternative field names
  const anyStored = stored as Record<string, unknown>;
  if (typeof anyStored.contract_package_hash === 'string') {
    return anyStored.contract_package_hash;
  }
  if (typeof anyStored.package_hash === 'string') {
    return anyStored.package_hash;
  }

  console.debug('[getContractPackageHash] package_hash not found in stored value:', JSON.stringify(stored).substring(0, 500));
  return null;
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

// Query dictionary item by seed URef and key - Casper 2.0 format
export async function queryDictionaryItem(
  seedURef: string,
  dictionaryKey: string
): Promise<unknown> {
  const stateRootHash = await getStateRootHash();

  try {
    const result = await rpcCall<DictionaryItemResult>('state_get_dictionary_item', {
      state_root_hash: stateRootHash,
      dictionary_identifier: {
        URef: {
          seed_uref: seedURef,
          dictionary_item_key: dictionaryKey,
        },
      },
    });

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

// Get account entity info using Casper 2.0 state_get_entity
export async function getAccountEntity(
  publicKeyHex: string
): Promise<StateGetEntityResult['entity']['Account'] | null> {
  try {
    const result = await rpcCall<StateGetEntityResult>('state_get_entity', {
      entity_identifier: { PublicKey: publicKeyHex },
    });
    return result.entity.Account ?? null;
  } catch {
    return null;
  }
}

// Legacy wrapper for getAccountInfo (uses Casper 2.0 state_get_entity)
export async function getAccountInfo(
  publicKeyHex: string
): Promise<AccountInfoResult['account'] | null> {
  const entity = await getAccountEntity(publicKeyHex);
  if (!entity) return null;

  return {
    account_hash: entity.account_hash,
    main_purse: entity.main_purse,
    named_keys: entity.named_keys,
    associated_keys: entity.associated_keys,
    action_thresholds: entity.action_thresholds,
  };
}

// Fallback: fetch CSPR balance from cspr.live API
async function fetchBalanceFromCsprLive(publicKeyHex: string): Promise<bigint | null> {
  try {
    const network = getCurrentNetwork();
    const baseUrl = network === 'mainnet'
      ? 'https://api.cspr.live'
      : 'https://api.testnet.cspr.live';

    const response = await fetch(`${baseUrl}/accounts/${publicKeyHex}`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.warn('[cspr.live] Account fetch failed:', response.status);
      return null;
    }

    const data = await response.json();
    const balance = data?.data?.balance;

    if (typeof balance === 'string' || typeof balance === 'number') {
      console.log('[cspr.live] CSPR balance:', balance);
      return BigInt(balance);
    }

    return null;
  } catch (error) {
    console.warn('[cspr.live] Fallback failed:', error);
    return null;
  }
}

// Query CSPR balance using Casper 2.0 query_balance with cspr.live fallback
export async function getAccountCsprBalance(publicKeyHex: string): Promise<bigint> {
  console.log('[CSPR Balance] Starting balance fetch for:', publicKeyHex);
  console.log('[CSPR Balance] Public key length:', publicKeyHex?.length);

  // Validate public key format
  if (!publicKeyHex || publicKeyHex.length < 64) {
    console.error('[CSPR Balance] INVALID public key format!');
    return BigInt(0);
  }

  // Try RPC first
  try {
    console.log('[CSPR Balance] Attempting RPC query_balance...');
    const result = await rpcCall<QueryBalanceResult>('query_balance', {
      purse_identifier: { main_purse_under_public_key: publicKeyHex },
    });
    console.log('[CSPR Balance] SUCCESS via RPC:', result.balance);
    return BigInt(result.balance);
  } catch (rpcError) {
    console.warn('[CSPR Balance] RPC failed:', rpcError instanceof Error ? rpcError.message : rpcError);
  }

  // Fallback to cspr.live API
  console.log('[CSPR Balance] Attempting cspr.live fallback...');
  const fallbackBalance = await fetchBalanceFromCsprLive(publicKeyHex);
  if (fallbackBalance !== null) {
    console.log('[CSPR Balance] SUCCESS via cspr.live:', fallbackBalance.toString());
    return fallbackBalance;
  }

  console.error('[CSPR Balance] ALL METHODS FAILED - returning 0');
  return BigInt(0);
}

export async function getAccountHash(publicKeyHex: string): Promise<string | null> {
  const entity = await getAccountEntity(publicKeyHex);
  if (!entity?.account_hash) return null;

  // Return just the hash part without 'account-hash-' prefix
  return entity.account_hash.replace(/^account-hash-/, '');
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

// ========== Odra Dictionary Query Functions ==========

/**
 * Get entity hash from contract hash (needed for dictionary queries in Casper 2.0)
 */
async function getEntityHashFromContractHash(contractHash: string): Promise<string | null> {
  const normalizedHash = contractHash.replace(/^hash-/, '');
  try {
    // Try to get Contract info and extract entity info
    const stored = await queryGlobalState(`hash-${normalizedHash}`);
    if (stored?.Contract) {
      // For Casper 2.0, the entity hash is the same as contract hash
      return normalizedHash;
    }
    return normalizedHash;
  } catch {
    return normalizedHash;
  }
}

/**
 * Query Odra dictionary item using state_get_dictionary_item
 */
async function queryOdraDictionaryItem(
  contractHashHex: string,
  dictionaryItemKey: string
): Promise<{ bytes?: string; parsed?: unknown } | null> {
  const stateRootHash = await getStateRootHash();
  const entityHashHex = contractHashHex.replace(/^hash-/, '');

  // Try ContractNamedKey first (Casper 1.x/2.0 compatible)
  try {
    const result = await rpcCall<{
      stored_value?: { CLValue?: { bytes?: string; parsed?: unknown } };
    }>('state_get_dictionary_item', {
      state_root_hash: stateRootHash,
      dictionary_identifier: {
        ContractNamedKey: {
          key: `hash-${entityHashHex}`,
          dictionary_name: 'state',
          dictionary_item_key: dictionaryItemKey,
        },
      },
    });

    if (result.stored_value?.CLValue) {
      return result.stored_value.CLValue;
    }
  } catch (e) {
    console.debug('[queryOdraDictionary] ContractNamedKey failed:', e);
  }

  // Try EntityNamedKey (Casper 2.0 style)
  try {
    const result = await rpcCall<{
      stored_value?: { CLValue?: { bytes?: string; parsed?: unknown } };
    }>('state_get_dictionary_item', {
      state_root_hash: stateRootHash,
      dictionary_identifier: {
        EntityNamedKey: {
          key: `entity-contract-${entityHashHex}`,
          dictionary_name: 'state',
          dictionary_item_key: dictionaryItemKey,
        },
      },
    });

    if (result.stored_value?.CLValue) {
      return result.stored_value.CLValue;
    }
  } catch (e) {
    console.debug('[queryOdraDictionary] EntityNamedKey failed:', e);
  }

  return null;
}

/**
 * Query Odra Var<T> field from contract state
 */
async function queryOdraVarField(
  contractHash: string,
  fieldIndex: number
): Promise<{ bytes?: string; parsed?: unknown } | null> {
  const dictionaryKey = computeOdraVarKey(fieldIndex);
  return queryOdraDictionaryItem(contractHash, dictionaryKey);
}

/**
 * Fetch U256 value from Odra Var field
 */
async function fetchOdraVarU256(contractHash: string, fieldIndex: number): Promise<bigint> {
  try {
    const result = await queryOdraVarField(contractHash, fieldIndex);
    if (!result) return BigInt(0);

    // Parse from CLValue
    const parsed = result.parsed;
    if (Array.isArray(parsed)) {
      const bytes = new Uint8Array(parsed);
      // Odra stores U256 as Vec<u8> containing CLValue-serialized U256
      return parseU256FromCLValue(bytes, 0);
    } else if (parsed !== undefined && parsed !== null) {
      return BigInt(String(parsed));
    }

    // Try parsing from bytes
    if (result.bytes) {
      const bytes = hexToBytes(result.bytes);
      // Skip 4-byte Vec<u8> length prefix, then parse CLValue U256
      return parseU256FromCLValue(bytes, 4);
    }

    return BigInt(0);
  } catch (err) {
    console.warn('[fetchOdraVarU256] Error:', err);
    return BigInt(0);
  }
}

/**
 * Fetch u64 value from Odra Var field
 */
async function fetchOdraVarU64(contractHash: string, fieldIndex: number): Promise<bigint> {
  try {
    const result = await queryOdraVarField(contractHash, fieldIndex);
    if (!result) return BigInt(0);

    const parsed = result.parsed;
    if (Array.isArray(parsed)) {
      const bytes = new Uint8Array(parsed);
      return parseU64FromBytes(bytes, 0);
    } else if (typeof parsed === 'number') {
      return BigInt(parsed);
    } else if (parsed !== undefined && parsed !== null) {
      return BigInt(String(parsed));
    }

    if (result.bytes) {
      const bytes = hexToBytes(result.bytes);
      return parseU64FromBytes(bytes, 4);
    }

    return BigInt(0);
  } catch (err) {
    console.warn('[fetchOdraVarU64] Error:', err);
    return BigInt(0);
  }
}

/**
 * Parse u32 from bytes (little-endian)
 */
function parseU32FromBytes(bytes: Uint8Array, offset: number = 0): number {
  let result = 0;
  for (let i = 0; i < 4 && offset + i < bytes.length; i++) {
    result += bytes[offset + i] << (i * 8);
  }
  return result >>> 0; // Ensure unsigned
}

/**
 * Fetch u32 value from Odra Var field
 */
async function fetchOdraVarU32(contractHash: string, fieldIndex: number): Promise<number> {
  try {
    const result = await queryOdraVarField(contractHash, fieldIndex);
    if (!result) return 0;

    const parsed = result.parsed;
    if (Array.isArray(parsed)) {
      const bytes = new Uint8Array(parsed);
      return parseU32FromBytes(bytes, 0);
    } else if (typeof parsed === 'number') {
      return parsed;
    } else if (parsed !== undefined && parsed !== null) {
      return Number(parsed);
    }

    if (result.bytes) {
      const bytes = hexToBytes(result.bytes);
      return parseU32FromBytes(bytes, 4);
    }

    return 0;
  } catch (err) {
    console.warn('[fetchOdraVarU32] Error:', err);
    return 0;
  }
}

/**
 * Compute Odra dictionary key for Mapping<Address, T>
 * Key = blake2b(field_index_u32_be || address_bytes)
 */
function computeOdraMappingKeyAddress(
  fieldIndex: number,
  addressBytes: Uint8Array,
  includeTag: boolean = true
): string {
  // Field index as 4 bytes big endian
  const indexBytes = new Uint8Array(4);
  indexBytes[0] = (fieldIndex >> 24) & 0xff;
  indexBytes[1] = (fieldIndex >> 16) & 0xff;
  indexBytes[2] = (fieldIndex >> 8) & 0xff;
  indexBytes[3] = fieldIndex & 0xff;

  // Ensure Address serialization includes the tag byte
  let address = addressBytes;
  if (includeTag && addressBytes.length === 32) {
    const tagged = new Uint8Array(33);
    tagged[0] = 0x00; // AccountHash tag
    tagged.set(addressBytes, 1);
    address = tagged;
  }

  // Concatenate index + address
  const combined = new Uint8Array(4 + address.length);
  combined.set(indexBytes, 0);
  combined.set(address, 4);

  // Blake2b hash (32 bytes)
  const hashedKey = blake2b(combined, undefined, 32);
  return bytesToHex(hashedKey);
}

/**
 * Convert u64 bigint to 8-byte little-endian bytes
 */
function u64ToBytesLE(value: bigint): Uint8Array {
  let v = value;
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & BigInt(0xff));
    v >>= BigInt(8);
  }
  return out;
}

/**
 * Compute Odra dictionary key for Mapping<(Address, u64), T>
 * Key = blake2b(field_index_u32_be || address_bytes || u64_le)
 */
function computeOdraMappingKeyAddressU64(
  fieldIndex: number,
  addressBytes: Uint8Array,
  u64Value: bigint,
  includeTag: boolean = true
): string {
  // Field index as 4 bytes big endian
  const indexBytes = new Uint8Array(4);
  indexBytes[0] = (fieldIndex >> 24) & 0xff;
  indexBytes[1] = (fieldIndex >> 16) & 0xff;
  indexBytes[2] = (fieldIndex >> 8) & 0xff;
  indexBytes[3] = fieldIndex & 0xff;

  // Ensure Address serialization includes the tag byte
  let address = addressBytes;
  if (includeTag && addressBytes.length === 32) {
    const tagged = new Uint8Array(33);
    tagged[0] = 0x00; // AccountHash tag
    tagged.set(addressBytes, 1);
    address = tagged;
  }

  const u64Bytes = u64ToBytesLE(u64Value);

  // Concatenate index + address + u64
  const combined = new Uint8Array(4 + address.length + u64Bytes.length);
  combined.set(indexBytes, 0);
  combined.set(address, 4);
  combined.set(u64Bytes, 4 + address.length);

  // Blake2b hash (32 bytes)
  const hashedKey = blake2b(combined, undefined, 32);
  return bytesToHex(hashedKey);
}

/**
 * Query Odra Mapping field where key is (Address, u64) (VaultKey/UserVaultIndex)
 */
async function queryOdraMappingFieldAddressU64Key(
  contractHash: string,
  fieldIndex: number,
  addressBytes: Uint8Array,
  u64Value: bigint
): Promise<{ bytes?: string; parsed?: unknown } | null> {
  const dictionaryKey = computeOdraMappingKeyAddressU64(fieldIndex, addressBytes, u64Value, true);
  const result = await queryOdraDictionaryItem(contractHash, dictionaryKey);
  if (result) return result;

  // Fallback for deployments that hash raw 32-byte account hashes without tag
  if (addressBytes.length === 32) {
    const rawKey = computeOdraMappingKeyAddressU64(fieldIndex, addressBytes, u64Value, false);
    return queryOdraDictionaryItem(contractHash, rawKey);
  }

  if (addressBytes.length === 33 && (addressBytes[0] === 0x00 || addressBytes[0] === 0x01)) {
    const rawKey = computeOdraMappingKeyAddressU64(fieldIndex, addressBytes.slice(1), u64Value, false);
    return queryOdraDictionaryItem(contractHash, rawKey);
  }

  return null;
}

/**
 * Query Odra Mapping field from contract state
 */
async function queryOdraMappingFieldAddress(
  contractHash: string,
  fieldIndex: number,
  addressBytes: Uint8Array
): Promise<{ bytes?: string; parsed?: unknown } | null> {
  const dictionaryKey = computeOdraMappingKeyAddress(fieldIndex, addressBytes, true);
  const result = await queryOdraDictionaryItem(contractHash, dictionaryKey);
  if (result) return result;

  // Fallback for deployments that hash raw 32-byte account hashes without tag
  if (addressBytes.length === 32) {
    const rawKey = computeOdraMappingKeyAddress(fieldIndex, addressBytes, false);
    return queryOdraDictionaryItem(contractHash, rawKey);
  }

  if (addressBytes.length === 33 && (addressBytes[0] === 0x00 || addressBytes[0] === 0x01)) {
    const rawKey = computeOdraMappingKeyAddress(fieldIndex, addressBytes.slice(1), false);
    return queryOdraDictionaryItem(contractHash, rawKey);
  }

  return null;
}

/**
 * Convert public key to account hash bytes for Odra Mapping queries
 */
function publicKeyToAccountHash(publicKeyHex: string): Uint8Array | null {
  const accountHashHex = computeAccountHashFromPublicKey(publicKeyHex);
  if (!accountHashHex) return null;
  return hexToBytes(accountHashHex);
}

/**
 * AssetBreakdown struct from ScsprYbToken
 * Fields: idle_cspr, delegated_cspr, undelegating_cspr, claimable_cspr, protocol_fees, realized_losses
 */
interface AssetBreakdown {
  idleCspr: bigint;
  delegatedCspr: bigint;
  undelegatingCspr: bigint;
  claimableCspr: bigint;
  protocolFees: bigint;
  realizedLosses: bigint;
}

/**
 * Parse AssetBreakdown struct from Odra bytes
 * Odra serializes U256 fields in CLValue format: [length_byte] [data_little_endian]
 * Fields are concatenated without padding
 */
function parseAssetBreakdown(bytes: Uint8Array): AssetBreakdown {
  let offset = 0;

  // Helper to read one CLValue U256 and advance offset
  const readU256 = (): bigint => {
    if (offset >= bytes.length) return BigInt(0);
    const len = bytes[offset];
    if (len === 0) {
      offset += 1;
      return BigInt(0);
    }
    let result = BigInt(0);
    for (let i = 0; i < len && offset + 1 + i < bytes.length; i++) {
      result += BigInt(bytes[offset + 1 + i]) << BigInt(i * 8);
    }
    offset += 1 + len;
    return result;
  };

  return {
    idleCspr: readU256(),
    delegatedCspr: readU256(),
    undelegatingCspr: readU256(),
    claimableCspr: readU256(),
    protocolFees: readU256(),
    realizedLosses: readU256(),
  };
}

/**
 * Fetch AssetBreakdown from ScsprYbToken contract
 */
async function fetchAssetBreakdown(contractHash: string): Promise<AssetBreakdown | null> {
  try {
    const result = await queryOdraVarField(contractHash, ODRA_FIELD_INDEX.SCSPR_ASSETS);
    if (!result) return null;

    const parsed = result.parsed;
    if (Array.isArray(parsed)) {
      const bytes = new Uint8Array(parsed);
      return parseAssetBreakdown(bytes);
    }

    if (result.bytes) {
      const bytes = hexToBytes(result.bytes);
      // Skip 4-byte length prefix
      return parseAssetBreakdown(bytes.slice(4));
    }

    return null;
  } catch (err) {
    console.warn('[fetchAssetBreakdown] Error:', err);
    return null;
  }
}

/**
 * Fetch token balance from Odra CEP-18 contract
 */
async function fetchOdraTokenBalance(
  contractHash: string,
  fieldIndex: number,
  publicKeyHex: string
): Promise<bigint> {
  try {
    // Compute account hash from public key
    const accountHashHex = computeAccountHashFromPublicKey(publicKeyHex);
    if (!accountHashHex) {
      console.warn('[fetchOdraTokenBalance] Failed to compute account hash');
      return BigInt(0);
    }

    // Compute Odra dictionary key
    const dictionaryKey = computeOdraMappingKey(fieldIndex, accountHashHex);
    console.log('[fetchOdraTokenBalance] Contract:', contractHash);
    console.log('[fetchOdraTokenBalance] Account hash:', accountHashHex);
    console.log('[fetchOdraTokenBalance] Dictionary key:', dictionaryKey);

    // Query dictionary
    const result = await queryOdraDictionaryItem(contractHash, dictionaryKey);

    if (result) {
      console.log('[fetchOdraTokenBalance] Result:', JSON.stringify(result));

      // Parse U256 from CLValue
      const parsed = result.parsed;

      // Odra stores values as Vec<u8> (List U8) containing CLValue-serialized U256
      // CLValue U256 format: [length_byte] [data_bytes_little_endian]
      if (Array.isArray(parsed)) {
        const bytes = new Uint8Array(parsed);
        // Use CLValue parser which handles length prefix
        const value = parseU256FromCLValue(bytes, 0);
        console.log('[fetchOdraTokenBalance] Balance from array:', value.toString());
        return value;
      } else if (parsed !== undefined && parsed !== null) {
        // Direct numeric value
        const value = BigInt(String(parsed));
        console.log('[fetchOdraTokenBalance] Balance:', value.toString());
        return value;
      }

      // Try parsing from bytes if parsed is not available
      const bytesHex = result.bytes;
      if (bytesHex) {
        const bytes = hexToBytes(bytesHex);
        // Skip 4-byte Vec<u8> length prefix, then parse CLValue U256
        const value = parseU256FromCLValue(bytes, 4);
        console.log('[fetchOdraTokenBalance] Balance from bytes:', value.toString());
        return value;
      }
    }

    console.log('[fetchOdraTokenBalance] No balance found (user may have 0 balance)');
    return BigInt(0);
  } catch (err) {
    console.warn('[fetchOdraTokenBalance] Error:', err);
    return BigInt(0);
  }
}

/**
 * Fetch balance from CEP-18 balances dictionary (base64 Key bytes)
 */
async function fetchCep18Balance(
  contractHash: string,
  publicKeyHex: string
): Promise<bigint | null> {
  const accountHashHex = computeAccountHashFromPublicKey(publicKeyHex);
  if (!accountHashHex) {
    console.warn('[fetchCep18Balance] Failed to compute account hash');
    return null;
  }

  const itemKey = computeCep18BalanceKey(accountHashHex);
  if (!itemKey) return null;

  try {
    const parsed = await queryContractDictionary(contractHash, 'balances', itemKey);
    if (parsed === null || parsed === undefined) return null;
    const value = BigInt(String(parsed));
    console.log('[fetchCep18Balance] Balance:', value.toString());
    return value;
  } catch (err) {
    console.warn('[fetchCep18Balance] Error:', err);
    return null;
  }
}

/**
 * Fetch CEP-18 total_supply named key
 */
async function fetchCep18TotalSupply(contractHash: string): Promise<bigint | null> {
  try {
    const parsed = await queryContractNamedKey(contractHash, 'total_supply');
    if (parsed === null || parsed === undefined) return null;
    return BigInt(String(parsed));
  } catch (err) {
    console.warn('[fetchCep18TotalSupply] Error:', err);
    return null;
  }
}

// NOTE: Kept for backward compatibility - Odra reading now works via dictionary queries
const ODRA_READ_LIMITATION_MSG =
  'Odra dictionary query';

// Get stCSPR exchange rate from ybToken contract
export async function getLstExchangeRate(): Promise<LstExchangeRate | null> {
  const ybTokenHash = CONTRACTS.scsprYbtoken;
  if (!ybTokenHash || ybTokenHash === 'null') {
    return null;
  }

  try {
    // Fetch total_shares and assets breakdown to calculate rate
    let totalShares = BigInt(0);
    const [odraShares, assetBreakdown] = await Promise.all([
      fetchOdraVarU256(ybTokenHash, ODRA_FIELD_INDEX.SCSPR_TOTAL_SHARES),
      fetchAssetBreakdown(ybTokenHash),
    ]);
    totalShares = odraShares;

    if (totalShares === BigInt(0)) {
      const cep18Supply = await fetchCep18TotalSupply(ybTokenHash);
      if (cep18Supply && cep18Supply > BigInt(0)) {
        totalShares = cep18Supply;
      }
    }

    console.log('[RPC] getLstExchangeRate: totalShares=', totalShares.toString());
    console.log('[RPC] getLstExchangeRate: assetBreakdown=', assetBreakdown);

    if (totalShares === BigInt(0)) {
      // No shares yet, return 1:1 rate
      return {
        rate: RATE_SCALE,
        rateFormatted: formatRate(RATE_SCALE),
        timestamp: Date.now(),
      };
    }

    // Calculate total assets from breakdown
    let totalAssets = BigInt(0);
    if (assetBreakdown) {
      const gross = assetBreakdown.idleCspr + assetBreakdown.delegatedCspr +
                    assetBreakdown.undelegatingCspr + assetBreakdown.claimableCspr;
      const deductions = assetBreakdown.protocolFees + assetBreakdown.realizedLosses;
      totalAssets = gross > deductions ? gross - deductions : BigInt(0);
    }

    if (totalAssets === BigInt(0)) {
      return {
        rate: RATE_SCALE,
        rateFormatted: formatRate(RATE_SCALE),
        timestamp: Date.now(),
      };
    }

    // Rate = total_assets * SCALE / total_shares (CSPR per stCSPR)
    const rate = (totalAssets * RATE_SCALE) / totalShares;

    console.log('[RPC] getLstExchangeRate: rate=', rate.toString());

    return {
      rate,
      rateFormatted: formatRate(rate),
      timestamp: Date.now(),
    };
  } catch (err) {
    console.warn('[RPC] getLstExchangeRate failed, using default:', err);
    return {
      rate: RATE_SCALE,
      rateFormatted: formatRate(RATE_SCALE),
      timestamp: Date.now(),
    };
  }
}

// Get user's stCSPR balance from CEP-18 dictionary using Odra key computation
export async function getLstBalance(publicKey: string): Promise<LstBalance | null> {
  const ybTokenHash = CONTRACTS.scsprYbtoken;
  if (!ybTokenHash || ybTokenHash === 'null') {
    console.debug('[RPC] stCSPR contract not configured');
    return null;
  }

  console.log('[RPC] getLstBalance: Querying Odra dictionary for stCSPR balance');

  try {
    let scsprBalance = await fetchOdraTokenBalance(
      ybTokenHash,
      ODRA_FIELD_INDEX.SCSPR_BALANCES,
      publicKey
    );

    if (scsprBalance === BigInt(0)) {
      const cep18Balance = await fetchCep18Balance(ybTokenHash, publicKey);
      if (cep18Balance && cep18Balance > BigInt(0)) {
        scsprBalance = cep18Balance;
      }
    }

    return {
      scsprBalance,
      scsprFormatted: formatCsprAmount(scsprBalance),
      csprEquivalent: scsprBalance, // 1:1 default rate
      csprEquivalentFormatted: formatCsprAmount(scsprBalance),
    };
  } catch (err) {
    console.warn('[RPC] getLstBalance failed:', err);
    return {
      scsprBalance: BigInt(0),
      scsprFormatted: '0',
      csprEquivalent: BigInt(0),
      csprEquivalentFormatted: '0',
    };
  }
}

// Refresh unbonding period from WithdrawQueue contract
export async function refreshUnbondingPeriodFromChain(): Promise<number | null> {
  const queueHash = CONTRACTS.withdrawQueue;
  if (!queueHash || queueHash === 'null') {
    return null;
  }

  try {
    // QueueConfig struct: unbonding_period(u64), min_withdrawal(U256), requests_paused(bool), claims_paused(bool)
    // First field is unbonding_period
    const result = await queryOdraVarField(queueHash, ODRA_FIELD_INDEX.QUEUE_CONFIG);
    if (!result) return null;

    const parsed = result.parsed;
    if (Array.isArray(parsed) && parsed.length >= 8) {
      // First 8 bytes are unbonding_period (u64)
      const bytes = new Uint8Array(parsed);
      const period = parseU64FromBytes(bytes, 0);
      const periodNum = Number(period);
      if (periodNum > 0) {
        unbondingPeriodOverrideSec = periodNum;
        console.log('[RPC] refreshUnbondingPeriodFromChain:', periodNum);
        return periodNum;
      }
    }

    if (result.bytes) {
      const bytes = hexToBytes(result.bytes);
      // Skip length prefix, then read u64
      const period = parseU64FromBytes(bytes, 4);
      const periodNum = Number(period);
      if (periodNum > 0) {
        unbondingPeriodOverrideSec = periodNum;
        console.log('[RPC] refreshUnbondingPeriodFromChain:', periodNum);
        return periodNum;
      }
    }

    return null;
  } catch (err) {
    console.warn('[RPC] refreshUnbondingPeriodFromChain failed:', err);
    return null;
  }
}

// Get user's withdraw requests from queue
// NOTE: Odra contracts can't be queried without entry point call
export async function getUserWithdrawRequests(publicKey: string): Promise<WithdrawRequest[]> {
  const queueHash = CONTRACTS.withdrawQueue;
  if (!queueHash || queueHash === 'null') {
    return [];
  }

  console.debug('[RPC] getUserWithdrawRequests:', ODRA_READ_LIMITATION_MSG);

  // Can't read withdraw requests without entry point call
  return [];
}

// Get LST protocol statistics
export async function getLstProtocolStats(): Promise<LstProtocolStats | null> {
  const ybTokenHash = CONTRACTS.scsprYbtoken;
  if (!ybTokenHash || ybTokenHash === 'null') {
    return null;
  }

  try {
    // Fetch total_shares and assets breakdown
    let totalShares = BigInt(0);
    const [odraShares, assetBreakdown] = await Promise.all([
      fetchOdraVarU256(ybTokenHash, ODRA_FIELD_INDEX.SCSPR_TOTAL_SHARES),
      fetchAssetBreakdown(ybTokenHash),
    ]);
    totalShares = odraShares;

    if (totalShares === BigInt(0)) {
      const cep18Supply = await fetchCep18TotalSupply(ybTokenHash);
      if (cep18Supply && cep18Supply > BigInt(0)) {
        totalShares = cep18Supply;
      }
    }

    console.log('[RPC] getLstProtocolStats: totalShares=', totalShares.toString());
    console.log('[RPC] getLstProtocolStats: assetBreakdown=', assetBreakdown);

    const idleCspr = assetBreakdown?.idleCspr ?? BigInt(0);
    const delegatedCspr = assetBreakdown?.delegatedCspr ?? BigInt(0);
    const undelegatingCspr = assetBreakdown?.undelegatingCspr ?? BigInt(0);
    const claimableCspr = assetBreakdown?.claimableCspr ?? BigInt(0);
    const protocolFees = assetBreakdown?.protocolFees ?? BigInt(0);
    const realizedLosses = assetBreakdown?.realizedLosses ?? BigInt(0);

    // Calculate total assets
    const gross = idleCspr + delegatedCspr + undelegatingCspr + claimableCspr;
    const deductions = protocolFees + realizedLosses;
    const totalAssets = gross > deductions ? gross - deductions : BigInt(0);

    // Calculate exchange rate
    let exchangeRate = RATE_SCALE;
    if (totalShares > BigInt(0) && totalAssets > BigInt(0)) {
      exchangeRate = (totalAssets * RATE_SCALE) / totalShares;
    }

    return {
      totalAssets,
      totalShares,
      exchangeRate,
      idleCspr,
      delegatedCspr,
      undelegatingCspr,
      claimableCspr,
    };
  } catch (err) {
    console.warn('[RPC] getLstProtocolStats failed:', err);
    return {
      totalAssets: BigInt(0),
      totalShares: BigInt(0),
      exchangeRate: RATE_SCALE,
      idleCspr: BigInt(0),
      delegatedCspr: BigInt(0),
      undelegatingCspr: BigInt(0),
      claimableCspr: BigInt(0),
    };
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

/**
 * DepositSnapshot struct from StabilityPool
 * Fields: deposit(U256), p(U256), s_cspr(U256), s_scspr(U256), epoch(u64), scale(u64)
 */
interface DepositSnapshot {
  deposit: bigint;
  p: bigint;
  sCspr: bigint;
  sScspr: bigint;
  epoch: bigint;
  scale: bigint;
}

/**
 * Parse DepositSnapshot from Odra bytes
 * Odra serializes U256 in CLValue format: [length_byte] [data_little_endian]
 * u64 is fixed 8 bytes little-endian
 */
function parseDepositSnapshot(bytes: Uint8Array): DepositSnapshot {
  let offset = 0;

  // Helper to read one CLValue U256 and advance offset
  const readU256 = (): bigint => {
    if (offset >= bytes.length) return BigInt(0);
    const len = bytes[offset];
    if (len === 0) {
      offset += 1;
      return BigInt(0);
    }
    let result = BigInt(0);
    for (let i = 0; i < len && offset + 1 + i < bytes.length; i++) {
      result += BigInt(bytes[offset + 1 + i]) << BigInt(i * 8);
    }
    offset += 1 + len;
    return result;
  };

  // Helper to read u64 (fixed 8 bytes)
  const readU64 = (): bigint => {
    let result = BigInt(0);
    for (let i = 0; i < 8 && offset + i < bytes.length; i++) {
      result += BigInt(bytes[offset + i]) << BigInt(i * 8);
    }
    offset += 8;
    return result;
  };

  return {
    deposit: readU256(),
    p: readU256(),
    sCspr: readU256(),
    sScspr: readU256(),
    epoch: readU64(),
    scale: readU64(),
  };
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
    // Get account hash from public key
    const accountHash = publicKeyToAccountHash(publicKey);
    if (!accountHash) {
      console.warn('[RPC] getStabilityPoolUserState: Failed to compute account hash');
      return null;
    }

    // Query deposits Mapping
    const result = await queryOdraMappingFieldAddress(
      spHash,
      ODRA_FIELD_INDEX.SP_DEPOSITS,
      accountHash
    );

    if (!result) {
      // No deposit found
      return {
        deposit: BigInt(0),
        depositFormatted: '0',
        csprGains: BigInt(0),
        csprGainsFormatted: '0',
        scsprGains: BigInt(0),
        scsprGainsFormatted: '0',
      };
    }

    const parsed = result.parsed;
    let snapshot: DepositSnapshot | null = null;

    if (Array.isArray(parsed)) {
      const bytes = new Uint8Array(parsed);
      snapshot = parseDepositSnapshot(bytes);
    } else if (result.bytes) {
      const bytes = hexToBytes(result.bytes);
      // Skip 4-byte length prefix
      snapshot = parseDepositSnapshot(bytes.slice(4));
    }

    if (!snapshot || snapshot.deposit === BigInt(0)) {
      return {
        deposit: BigInt(0),
        depositFormatted: '0',
        csprGains: BigInt(0),
        csprGainsFormatted: '0',
        scsprGains: BigInt(0),
        scsprGainsFormatted: '0',
      };
    }

    console.log('[RPC] getStabilityPoolUserState:', {
      deposit: snapshot.deposit.toString(),
      p: snapshot.p.toString(),
      sCspr: snapshot.sCspr.toString(),
      sScspr: snapshot.sScspr.toString(),
    });

    // TODO: Calculate compounded deposit and gains using product-sum algorithm
    // For now, return the snapshot deposit (gains calculation requires current P and S values)
    return {
      deposit: snapshot.deposit,
      depositFormatted: formatGusdAmount(snapshot.deposit),
      csprGains: BigInt(0), // Would need current P/S state to calculate
      csprGainsFormatted: '0',
      scsprGains: BigInt(0),
      scsprGainsFormatted: '0',
    };
  } catch (err) {
    console.warn('[RPC] getStabilityPoolUserState failed:', err);
    return {
      deposit: BigInt(0),
      depositFormatted: '0',
      csprGains: BigInt(0),
      csprGainsFormatted: '0',
      scsprGains: BigInt(0),
      scsprGainsFormatted: '0',
    };
  }
}

// Get stability pool protocol stats
export async function getStabilityPoolStats(): Promise<StabilityPoolProtocolStats | null> {
  const spHash = CONTRACTS.stabilityPool;
  if (!spHash || spHash === 'null') {
    return null;
  }

  try {
    // Fetch all stats in parallel
    const [
      totalDeposits,
      totalCsprCollateral,
      totalScsprCollateral,
      totalDebtAbsorbed,
      depositorCount,
    ] = await Promise.all([
      fetchOdraVarU256(spHash, ODRA_FIELD_INDEX.SP_TOTAL_DEPOSITS),
      fetchOdraVarU256(spHash, ODRA_FIELD_INDEX.SP_TOTAL_CSPR_COLLATERAL),
      fetchOdraVarU256(spHash, ODRA_FIELD_INDEX.SP_TOTAL_SCSPR_COLLATERAL),
      fetchOdraVarU256(spHash, ODRA_FIELD_INDEX.SP_TOTAL_DEBT_ABSORBED),
      fetchOdraVarU64(spHash, ODRA_FIELD_INDEX.SP_DEPOSITOR_COUNT),
    ]);

    console.log('[RPC] getStabilityPoolStats:', {
      totalDeposits: totalDeposits.toString(),
      totalCsprCollateral: totalCsprCollateral.toString(),
      totalScsprCollateral: totalScsprCollateral.toString(),
      totalDebtAbsorbed: totalDebtAbsorbed.toString(),
      depositorCount: depositorCount.toString(),
    });

    return {
      totalDeposits,
      totalDepositsFormatted: formatGusdAmount(totalDeposits),
      totalCsprCollateral,
      totalScsprCollateral,
      totalDebtAbsorbed,
      depositorCount: Number(depositorCount),
      isSafeModeActive: false, // TODO: Parse SafeModeState struct
    };
  } catch (err) {
    console.warn('[RPC] getStabilityPoolStats failed:', err);
    return {
      totalDeposits: BigInt(0),
      totalDepositsFormatted: '0',
      totalCsprCollateral: BigInt(0),
      totalScsprCollateral: BigInt(0),
      totalDebtAbsorbed: BigInt(0),
      depositorCount: 0,
      isSafeModeActive: false,
    };
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
    // Fetch all stats in parallel
    const [
      totalRedeemed,
      totalCollateralDistributed,
      totalFeesCollected,
      baseFee,
      maxFee,
    ] = await Promise.all([
      fetchOdraVarU256(reHash, ODRA_FIELD_INDEX.RE_TOTAL_REDEEMED),
      fetchOdraVarU256(reHash, ODRA_FIELD_INDEX.RE_TOTAL_COLLATERAL_DISTRIBUTED),
      fetchOdraVarU256(reHash, ODRA_FIELD_INDEX.RE_TOTAL_FEES_COLLECTED),
      fetchOdraVarU32(reHash, ODRA_FIELD_INDEX.RE_BASE_FEE_BPS),
      fetchOdraVarU32(reHash, ODRA_FIELD_INDEX.RE_MAX_FEE_BPS),
    ]);

    console.log('[RPC] getRedemptionStats:', {
      totalRedeemed: totalRedeemed.toString(),
      totalCollateralDistributed: totalCollateralDistributed.toString(),
      totalFeesCollected: totalFeesCollected.toString(),
      baseFee,
      maxFee,
    });

    // Use defaults if values are 0 (contract not initialized)
    const actualBaseFee = baseFee || 50;
    const actualMaxFee = maxFee || 500;

    return {
      totalRedeemed,
      totalRedeemedFormatted: formatGusdAmount(totalRedeemed),
      totalCollateralDistributed,
      totalFeesCollected,
      baseFee: actualBaseFee,
      maxFee: actualMaxFee,
      currentFee: actualBaseFee, // Current fee = base fee (dynamic calculation can be added)
      isSafeModeActive: false, // TODO: Parse SafeModeState struct
    };
  } catch (err) {
    console.warn('[RPC] getRedemptionStats failed:', err);
    return {
      totalRedeemed: BigInt(0),
      totalRedeemedFormatted: '0',
      totalCollateralDistributed: BigInt(0),
      totalFeesCollected: BigInt(0),
      baseFee: 50,
      maxFee: 500,
      currentFee: 50,
      isSafeModeActive: false,
    };
  }
}

// ========== gUSD Balance Query ==========

// Get user's gUSD balance from stablecoin contract using Odra dictionary query
export async function getGusdBalance(publicKey: string): Promise<bigint> {
  const gusdHash = CONTRACTS.stablecoin;
  if (!gusdHash || gusdHash === 'null') {
    console.debug('[RPC] gUSD contract not configured');
    return BigInt(0);
  }

  console.log('[RPC] getGusdBalance: Querying Odra dictionary for gUSD balance');

  try {
    const balance = await fetchOdraTokenBalance(
      gusdHash,
      ODRA_FIELD_INDEX.GUSD_BALANCES,
      publicKey
    );
    return balance;
  } catch (err) {
    console.warn('[RPC] getGusdBalance failed:', err);
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
  vaultId: bigint;
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

/**
 * Parse VaultData from Odra bytes
 * VaultData: owner(Address), collateral_id(enum), collateral(U256), debt(U256), interest_rate_bps(u32), last_accrual_timestamp(u64)
 */
function parseVaultData(bytes: Uint8Array, collateralType: CollateralType): VaultData | null {
  // Odra Address: tag (1 byte) + 32 bytes hash
  // CollateralId enum: 1 byte
  // U256: CLValue [length_byte][data_le]
  // u32: 4 bytes LE
  // u64: 8 bytes LE

  if (bytes.length < 44) {
    return null;
  }

  let offset = 0;

  // Skip Vec<u8> length prefix if present
  if (bytes.length >= 4) {
    const maybeLen = parseU32FromBytes(bytes, 0);
    if (maybeLen + 4 === bytes.length) {
      offset = 4;
    }
  }

  // Parse Address (tag + 32 bytes) or raw 32-byte hash fallback
  if (bytes.length - offset >= 33 && (bytes[offset] === 0x00 || bytes[offset] === 0x01)) {
    offset += 33;
  } else if (bytes.length - offset >= 32) {
    offset += 32;
  } else {
    return null;
  }

  if (offset >= bytes.length) return null;
  const collateralIdByte = bytes[offset];
  offset += 1;

  const readU256 = (): bigint => {
    if (offset >= bytes.length) return BigInt(0);
    const len = bytes[offset];
    offset += 1;
    if (len === 0) return BigInt(0);
    let result = BigInt(0);
    for (let i = 0; i < len && offset + i < bytes.length; i++) {
      result += BigInt(bytes[offset + i]) << BigInt(i * 8);
    }
    offset += len;
    return result;
  };

  const collateral = readU256();
  const debt = readU256();

  if (offset + 4 > bytes.length) return null;
  const interestRateBps = parseU32FromBytes(bytes, offset);
  offset += 4;

  if (offset + 8 > bytes.length) return null;
  const lastAccrualTimestamp = Number(parseU64FromBytes(bytes, offset));

  // If collateral and debt are both 0, vault doesn't exist
  if (collateral === BigInt(0) && debt === BigInt(0)) {
    return null;
  }

  const parsedCollateralType =
    collateralIdByte === 1 ? 'scspr' : collateralIdByte === 0 ? 'cspr' : collateralType;

  return {
    owner: '', // Will be filled by caller
    collateralId: parsedCollateralType,
    collateral,
    debt,
    interestRateBps,
    lastAccrualTimestamp,
  };
}

// Parse u64 from an Odra mapping query result
function parseOdraMappingU64(result: { bytes?: string; parsed?: unknown }): bigint {
  const parsed = result.parsed;
  if (Array.isArray(parsed)) {
    const bytes = new Uint8Array(parsed);
    return parseU64FromBytes(bytes, 0);
  }
  if (typeof parsed === 'number') {
    return BigInt(parsed);
  }
  if (parsed !== undefined && parsed !== null) {
    return BigInt(String(parsed));
  }
  if (result.bytes) {
    const bytes = hexToBytes(result.bytes);
    return parseU64FromBytes(bytes, 4);
  }
  return BigInt(0);
}

// Get user's vaults for a specific collateral type
export async function getUserVaults(
  publicKey: string,
  collateralType: CollateralType
): Promise<VaultInfo[]> {
  const branchHash = collateralType === 'cspr'
    ? CONTRACTS.branchCspr
    : CONTRACTS.branchSCSPR;

  if (!branchHash || branchHash === 'null') {
    return [];
  }

  const userVaultCountIndex =
    collateralType === 'cspr'
      ? ODRA_FIELD_INDEX.BRANCH_CSPR_USER_VAULT_COUNT
      : ODRA_FIELD_INDEX.BRANCH_SCSPR_USER_VAULT_COUNT;
  const userVaultIdsIndex =
    collateralType === 'cspr'
      ? ODRA_FIELD_INDEX.BRANCH_CSPR_USER_VAULT_IDS
      : ODRA_FIELD_INDEX.BRANCH_SCSPR_USER_VAULT_IDS;

  try {
    // Get account hash from public key
    const accountHash = publicKeyToAccountHash(publicKey);
    if (!accountHash) {
      console.warn('[RPC] getUserVaults: Failed to compute account hash');
      return [];
    }

    // Load per-user vault count
    const countResult = await queryOdraMappingFieldAddress(
      branchHash,
      userVaultCountIndex,
      accountHash
    );
    const userVaultCount = countResult ? parseOdraMappingU64(countResult) : BigInt(0);

    if (userVaultCount === BigInt(0)) {
      return [];
    }

    const price = await getCollateralPrice(collateralType);
    const maxToFetch = BigInt(50);
    const fetchCount = userVaultCount > maxToFetch ? maxToFetch : userVaultCount;

    const vaults: VaultInfo[] = [];

    for (let i = BigInt(0); i < fetchCount; i++) {
      const vaultIdResult = await queryOdraMappingFieldAddressU64Key(
        branchHash,
        userVaultIdsIndex,
        accountHash,
        i
      );
      if (!vaultIdResult) continue;
      const vaultId = parseOdraMappingU64(vaultIdResult);
      if (vaultId === BigInt(0)) continue;

      const vaultResult = await queryOdraMappingFieldAddressU64Key(
        branchHash,
        ODRA_FIELD_INDEX.BRANCH_VAULTS,
        accountHash,
        vaultId
      );
      if (!vaultResult) continue;

      const parsed = vaultResult.parsed;
      let vaultData: VaultData | null = null;

      if (Array.isArray(parsed)) {
        const bytes = new Uint8Array(parsed);
        vaultData = parseVaultData(bytes, collateralType);
      } else if (vaultResult.bytes) {
        const bytes = hexToBytes(vaultResult.bytes);
        // Skip 4-byte length prefix
        vaultData = parseVaultData(bytes.slice(4), collateralType);
      }

      if (!vaultData || (vaultData.collateral === BigInt(0) && vaultData.debt === BigInt(0))) {
        continue;
      }

      vaultData.owner = publicKey;

      // Calculate ICR (Individual Collateralization Ratio)
      // ICR = (collateral_value_usd * 10000) / debt
      let icrBps = 0;
      let collateralValueUsd = BigInt(0);

      if (price > BigInt(0)) {
        // collateral uses 9 decimals, price uses 18 decimals
        // collateralValueUsd = collateral * price / 1e9
        collateralValueUsd = (vaultData.collateral * price) / BigInt(10 ** 9);
        if (vaultData.debt > BigInt(0)) {
          icrBps = Number((collateralValueUsd * BigInt(10000)) / vaultData.debt);
        } else {
          icrBps = 999999; // Infinite ICR when no debt
        }
      }

      vaults.push({
        vaultId,
        vault: vaultData,
        icrBps,
        collateralValueUsd,
      });
    }

    vaults.sort((a, b) => (a.vaultId < b.vaultId ? -1 : a.vaultId > b.vaultId ? 1 : 0));
    return vaults;
  } catch (err) {
    console.warn(`[RPC] getUserVaults(${collateralType}) failed:`, err);
    return [];
  }
}

// Backward-compatible helper: returns the first vault (if any)
export async function getUserVault(
  publicKey: string,
  collateralType: CollateralType
): Promise<VaultInfo | null> {
  const vaults = await getUserVaults(publicKey, collateralType);
  return vaults[0] ?? null;
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
    // Fetch branch stats in parallel
    const [totalCollateral, totalDebt, vaultCount] = await Promise.all([
      fetchOdraVarU256(branchHash, ODRA_FIELD_INDEX.BRANCH_TOTAL_COLLATERAL),
      fetchOdraVarU256(branchHash, ODRA_FIELD_INDEX.BRANCH_TOTAL_DEBT),
      fetchOdraVarU64(branchHash, ODRA_FIELD_INDEX.BRANCH_VAULT_COUNT),
    ]);

    console.log(`[RPC] getBranchStatus(${collateralType}):`, {
      totalCollateral: totalCollateral.toString(),
      totalDebt: totalDebt.toString(),
      vaultCount: vaultCount.toString(),
    });

    return {
      collateralId: collateralType,
      totalCollateral,
      totalDebt,
      vaultCount: Number(vaultCount),
      isSafeModeActive: false, // TODO: Parse SafeModeState struct
    };
  } catch (err) {
    console.warn(`[RPC] getBranchStatus(${collateralType}) failed:`, err);
    return {
      collateralId: collateralType,
      totalCollateral: BigInt(0),
      totalDebt: BigInt(0),
      vaultCount: 0,
      isSafeModeActive: false,
    };
  }
}

// ========== Oracle Price Query ==========

// Default CSPR price: $0.005 (scaled to 18 decimals)
// This is a fallback when all APIs fail
const DEFAULT_CSPR_PRICE = BigInt('5000000000000000'); // 0.005 * 1e18

// Cached CSPR price with source tracking
let cachedCsprPrice: { price: bigint; timestamp: number; source: string } | null = null;
const PRICE_CACHE_TTL_MS = 5 * 60_000; // 5 minute cache to reduce API calls

// Price source fetch functions
// Using multiple sources for redundancy and rate limit avoidance

// CoinPaprika - stable, no API key required
async function fetchCoinPaprikaPrice(): Promise<number | null> {
  try {
    const response = await fetch(
      'https://api.coinpaprika.com/v1/tickers/cspr-casper-network',
      { signal: AbortSignal.timeout(5000) }
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data?.quotes?.USD?.price ?? null;
  } catch {
    return null;
  }
}

// CryptoCompare - stable, no API key for basic usage
async function fetchCryptoComparePrice(): Promise<number | null> {
  try {
    const response = await fetch(
      'https://min-api.cryptocompare.com/data/price?fsym=CSPR&tsyms=USD',
      { signal: AbortSignal.timeout(5000) }
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data?.USD ?? null;
  } catch {
    return null;
  }
}

// CoinGecko - popular but rate limited
async function fetchCoinGeckoPrice(): Promise<number | null> {
  try {
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=casper-network&vs_currencies=usd',
      { signal: AbortSignal.timeout(5000) }
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data?.['casper-network']?.usd ?? null;
  } catch {
    return null;
  }
}

// Multi-source price fetcher with fallback
async function fetchCsprPriceMultiSource(): Promise<bigint | null> {
  // Return cached price if still valid
  if (cachedCsprPrice && Date.now() - cachedCsprPrice.timestamp < PRICE_CACHE_TTL_MS) {
    return cachedCsprPrice.price;
  }

  // Try sources in order: CoinPaprika -> CryptoCompare -> CoinGecko
  const sources: Array<{ name: string; fetch: () => Promise<number | null> }> = [
    { name: 'CoinPaprika', fetch: fetchCoinPaprikaPrice },
    { name: 'CryptoCompare', fetch: fetchCryptoComparePrice },
    { name: 'CoinGecko', fetch: fetchCoinGeckoPrice },
  ];

  for (const source of sources) {
    const price = await source.fetch();
    if (typeof price === 'number' && price > 0) {
      const priceWei = BigInt(Math.floor(price * 1e18));
      cachedCsprPrice = { price: priceWei, timestamp: Date.now(), source: source.name };
      console.log(`[Oracle] CSPR price from ${source.name}: $${price.toFixed(6)}`);
      return priceWei;
    }
  }

  // All sources failed, return cached if exists (even if stale)
  if (cachedCsprPrice) {
    console.warn('[Oracle] All sources failed, using stale cache');
    return cachedCsprPrice.price;
  }

  console.warn('[Oracle] All price sources unavailable');
  return null;
}

// Get collateral price (multi-source with fallback)
export async function getCollateralPrice(collateralType: CollateralType): Promise<bigint> {
  const csprPrice = await fetchCsprPriceMultiSource();
  const price = csprPrice ?? DEFAULT_CSPR_PRICE;

  if (collateralType === 'cspr') {
    return price;
  } else {
    // stCSPR price = CSPR price * 1.0 (default exchange rate)
    // In production, multiply by exchange rate from ybToken
    return price;
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
  MIN_DEBT: BigInt('1000000000000000000'), // 1 gUSD (18 decimals)
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
