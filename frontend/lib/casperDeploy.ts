// Casper Deploy Builder
//
// Provides utilities for building and signing Casper deploys.
// Used for interacting with LST contracts (stake, unstake, claim).
// Uses casper-js-sdk v2.x for proper deploy construction.

import { getNetworkConfig } from './config';
import {
  CLValueBuilder,
  CLPublicKey,
  DeployUtil,
  RuntimeArgs,
} from 'casper-js-sdk';

// ===== Constants =====

// Default payment amount in motes (5 CSPR for standard contract calls)
const DEFAULT_PAYMENT_MOTES = '5000000000';
// Higher payment for proxy calls (50 CSPR for WASM execution with value transfer)
const PROXY_PAYMENT_MOTES = '50000000000';
// TTL for deploys (30 minutes)
const DEPLOY_TTL_MS = 30 * 60 * 1000;

// Proxy caller WASM paths
// Use proxy_caller_with_return.wasm for proper return value handling (matching magni-cspr repo)
const PROXY_CALLER_WASM_PATH = '/odra/proxy_caller_with_return.wasm';

// WASM cache to avoid repeated fetches
let proxyCallerWasmCache: Uint8Array | null = null;

// ===== Types =====

export interface DeployArg {
  name: string;
  clType: string;
  value: unknown;
}

export interface DeployParams {
  contractHash: string;
  entryPoint: string;
  args: DeployArg[];
  paymentMotes?: string;
}

export interface ProxyDeployParams {
  contractPackageHash: string;
  entryPoint: string;
  args: DeployArg[];
  attachedMotes: string;
  paymentMotes?: string;
}

export interface DeployJson {
  deploy: {
    hash: string;
    header: {
      account: string;
      timestamp: string;
      ttl: string;
      gas_price: number;
      body_hash: string;
      dependencies: string[];
      chain_name: string;
    };
    payment: {
      ModuleBytes: {
        module_bytes: string;
        args: unknown[];
      };
    };
    session: unknown;
    approvals: Array<{
      signer: string;
      signature: string;
    }>;
  };
}

export interface SignedDeploy {
  deployJson: DeployJson;
  deployHash: string;
}

// ===== WASM Loading =====

/**
 * Load proxy_caller.wasm from public directory
 * Returns the WASM bytes as Uint8Array
 */
export async function loadProxyCallerWasmBytes(): Promise<Uint8Array> {
  // Return cached if available
  if (proxyCallerWasmCache) {
    return proxyCallerWasmCache;
  }

  // Fetch the WASM file
  const response = await fetch(PROXY_CALLER_WASM_PATH);
  if (!response.ok) {
    throw new Error(`Failed to load proxy_caller.wasm: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  proxyCallerWasmCache = new Uint8Array(arrayBuffer);

  return proxyCallerWasmCache;
}

/**
 * Load proxy_caller.wasm from public directory
 * Returns the WASM bytes as a hex string for the deploy session
 * @deprecated Use loadProxyCallerWasmBytes() instead
 */
export async function loadProxyCallerWasm(): Promise<string> {
  const bytes = await loadProxyCallerWasmBytes();
  return uint8ArrayToHex(bytes);
}

/**
 * Convert Uint8Array to hex string
 */
function uint8ArrayToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Convert hex string to Uint8Array
 */
function hexToUint8Array(hex: string): Uint8Array {
  const cleanHex = hex.replace(/^0x/, '');
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Check if proxy caller WASM is available
 */
export async function isProxyCallerAvailable(): Promise<boolean> {
  try {
    const response = await fetch(PROXY_CALLER_WASM_PATH, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

// ===== Deploy Building Helpers =====

/**
 * Convert DeployArg to CLValue using SDK v2.x
 */
function argToCLValue(arg: DeployArg) {
  const { clType, value } = arg;

  switch (clType) {
    case 'U8':
      return CLValueBuilder.u8(Number(value));
    case 'U32':
      return CLValueBuilder.u32(Number(value));
    case 'U64':
      return CLValueBuilder.u64(String(value));
    case 'U256':
      return CLValueBuilder.u256(String(value));
    case 'U512':
      return CLValueBuilder.u512(String(value));
    case 'String':
      return CLValueBuilder.string(String(value));
    case 'Bool':
      return CLValueBuilder.bool(Boolean(value));
    case 'Key': {
      // Key can be hash-xxx or account-hash-xxx, etc.
      const keyStr = String(value);
      return CLValueBuilder.key(CLValueBuilder.byteArray(hexToUint8Array(keyStr.replace(/^hash-/, ''))));
    }
    case 'ByteArray': {
      const bytes = hexToUint8Array(String(value));
      return CLValueBuilder.byteArray(bytes);
    }
    default:
      throw new Error(`Unsupported CLType: ${clType}`);
  }
}

/**
 * Build RuntimeArgs from DeployArg array using SDK v2.x
 */
function buildRuntimeArgs(args: DeployArg[]): RuntimeArgs {
  const runtimeArgs = RuntimeArgs.fromMap({});
  for (const arg of args) {
    runtimeArgs.insert(arg.name, argToCLValue(arg));
  }
  return runtimeArgs;
}

/**
 * Create a standard contract call deploy using SDK v2.x (without attached CSPR)
 * Uses StoredVersionContractByHash for proper contract versioning
 */
export function buildContractCallDeploy(
  senderPublicKey: string,
  params: DeployParams
): object {
  const network = getNetworkConfig();

  // Parse sender public key
  const senderPubKey = CLPublicKey.fromHex(senderPublicKey);

  // Normalize contract hash format
  const contractHashClean = params.contractHash.replace(/^hash-/, '');
  const contractHashBytes = hexToUint8Array(contractHashClean);

  // Build runtime args using SDK
  const sessionArgs = buildRuntimeArgs(params.args);

  // Create payment (standard payment)
  const paymentAmount = params.paymentMotes || DEFAULT_PAYMENT_MOTES;

  // Create deploy using DeployUtil
  const deploy = DeployUtil.makeDeploy(
    new DeployUtil.DeployParams(
      senderPubKey,
      network.chainName,
      1,
      DEPLOY_TTL_MS
    ),
    DeployUtil.ExecutableDeployItem.newStoredVersionContractByHash(
      contractHashBytes,
      null, // use latest version
      params.entryPoint,
      sessionArgs
    ),
    DeployUtil.standardPayment(paymentAmount)
  );

  // Convert to JSON format for wallet signing
  return DeployUtil.deployToJson(deploy);
}

/**
 * Create a proxy caller deploy using casper-js-sdk v2.x
 *
 * Uses proxy_caller.wasm to call a contract with attached motes.
 * Uses the SDK to properly construct and serialize the deploy.
 *
 * @param senderPublicKey - The sender's public key hex string
 * @param params - Deploy parameters including target contract and attached value
 * @param wasmBytes - proxy_caller.wasm bytes as Uint8Array
 */
export function buildProxyCallerDeployWithSdk(
  senderPublicKey: string,
  params: ProxyDeployParams,
  wasmBytes: Uint8Array
): object {
  const network = getNetworkConfig();

  // Parse sender public key
  const senderPubKey = CLPublicKey.fromHex(senderPublicKey);

  // Normalize contract package hash format (remove known prefixes if present)
  const packageHashClean = params.contractPackageHash.replace(/^(hash-|contract-package-)/, '');
  const packageHashBytes = hexToUint8Array(packageHashClean);

  // Build runtime args for the target contract call
  const targetArgs = buildRuntimeArgs(params.args);

  // Serialize the runtime args to bytes using SDK
  // This is the format that proxy_caller expects
  const argsBytes = targetArgs.toBytes().unwrap();

  // Create session args for proxy_caller
  // Parameter names must match exactly: package_hash, entry_point, args, attached_value, amount
  const sessionArgs = RuntimeArgs.fromMap({
    package_hash: CLValueBuilder.byteArray(packageHashBytes),
    entry_point: CLValueBuilder.string(params.entryPoint),
    args: CLValueBuilder.list(Array.from(argsBytes).map(b => CLValueBuilder.u8(b))),
    attached_value: CLValueBuilder.u512(params.attachedMotes),
    amount: CLValueBuilder.u512(params.attachedMotes),
  });

  // Create payment (standard payment)
  const paymentAmount = params.paymentMotes || PROXY_PAYMENT_MOTES;

  // Create deploy using DeployUtil with module bytes
  const deploy = DeployUtil.makeDeploy(
    new DeployUtil.DeployParams(
      senderPubKey,
      network.chainName,
      1,
      DEPLOY_TTL_MS
    ),
    DeployUtil.ExecutableDeployItem.newModuleBytes(wasmBytes, sessionArgs),
    DeployUtil.standardPayment(paymentAmount)
  );

  // Convert to JSON format for wallet signing
  return DeployUtil.deployToJson(deploy);
}

/**
 * Create a proxy caller deploy (for payable entry points with attached CSPR)
 *
 * Uses proxy_caller.wasm to call a contract with attached motes.
 * This is a legacy wrapper that accepts hex string WASM.
 *
 * @param senderPublicKey - The sender's public key
 * @param params - Deploy parameters including target contract and attached value
 * @param wasmHex - Hex-encoded proxy_caller.wasm bytes
 */
export function buildProxyCallerDeploy(
  senderPublicKey: string,
  params: ProxyDeployParams,
  wasmHex: string
): object {
  const wasmBytes = hexToUint8Array(wasmHex);
  return buildProxyCallerDeployWithSdk(senderPublicKey, params, wasmBytes);
}

/**
 * Build a deposit deploy for stCSPR ybToken using proxy caller
 *
 * This is a convenience function for the common stake operation.
 * @param senderPublicKey - The sender's public key
 * @param ybTokenPackageHash - The ybToken contract package hash
 * @param csprMotes - Amount of CSPR to deposit (in motes)
 * @param wasmHex - Hex-encoded proxy_caller.wasm bytes
 */
export function buildDepositDeploy(
  senderPublicKey: string,
  ybTokenPackageHash: string,
  csprMotes: string,
  wasmHex: string
): object {
  return buildProxyCallerDeploy(
    senderPublicKey,
    {
      contractPackageHash: ybTokenPackageHash,
      entryPoint: 'deposit',
      args: [], // deposit() takes no explicit args, only attached value
      attachedMotes: csprMotes,
    },
    wasmHex
  );
}

// ===== RPC Endpoint Helper =====

/**
 * Get the RPC endpoint - uses /api/rpc proxy in browser to avoid CORS
 */
function getRpcEndpoint(): string {
  if (typeof window !== 'undefined') {
    return '/api/rpc';
  }
  const network = getNetworkConfig();
  return network.rpcUrl;
}

// ===== Deploy Submission =====

/**
 * Submit a signed deploy to the Casper node
 */
export async function submitDeploy(signedDeployJson: unknown): Promise<string> {
  const rpcUrl = getRpcEndpoint();

  // Extract the deploy object - wallet may return { deploy: {...}, cancelled: false, ... }
  // We need to extract just the deploy and remove wallet-specific fields like 'cancelled'
  let rawDeploy: unknown;
  if (
    signedDeployJson &&
    typeof signedDeployJson === 'object' &&
    'deploy' in signedDeployJson
  ) {
    rawDeploy = (signedDeployJson as { deploy: unknown }).deploy;
  } else {
    rawDeploy = signedDeployJson;
  }

  // Clean the deploy object - only keep valid deploy fields
  let deployObject: unknown;
  if (
    rawDeploy &&
    typeof rawDeploy === 'object' &&
    'hash' in rawDeploy &&
    'header' in rawDeploy
  ) {
    const rd = rawDeploy as Record<string, unknown>;
    deployObject = {
      hash: rd.hash,
      header: rd.header,
      payment: rd.payment,
      session: rd.session,
      approvals: rd.approvals,
    };
  } else {
    deployObject = rawDeploy;
  }

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'account_put_deploy',
      params: {
        deploy: deployObject,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Deploy submission failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (data.error) {
    // Log full error details for debugging
    console.error('[submitDeploy] RPC error:', JSON.stringify(data.error, null, 2));
    console.error('[submitDeploy] Deploy sent:', JSON.stringify(deployObject, null, 2));
    const errorDetail = data.error.data ? `: ${JSON.stringify(data.error.data)}` : '';
    throw new Error(`Deploy submission error: ${data.error.message}${errorDetail}`);
  }

  // Return the deploy hash
  return data.result?.deploy_hash || (deployObject as Record<string, unknown>)?.hash as string || '';
}

/**
 * Check deploy status
 * Supports both Casper 1.x (info_get_deploy) and 2.0 (info_get_transaction) formats
 */
export async function getDeployStatus(
  deployHash: string
): Promise<'pending' | 'success' | 'error'> {
  const rpcUrl = getRpcEndpoint();

  try {
    // Try Casper 2.0 format first (info_get_transaction)
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'info_get_transaction',
        params: {
          transaction_hash: {
            Deploy: deployHash,
          },
        },
      }),
    });

    if (!response.ok) {
      return 'pending';
    }

    const data = await response.json();

    if (data.error) {
      // If info_get_transaction fails, try legacy info_get_deploy
      return await getDeployStatusLegacy(deployHash);
    }

    // Casper 2.0 format: check execution_info.execution_result
    const executionInfo = data.result?.execution_info;
    if (!executionInfo || !executionInfo.execution_result) {
      return 'pending';
    }

    const execResult = executionInfo.execution_result;

    // Version2 format
    if (execResult.Version2) {
      const v2Result = execResult.Version2;
      // If error_message is null or undefined, it's a success
      if (v2Result.error_message === null || v2Result.error_message === undefined) {
        return 'success';
      } else {
        return 'error';
      }
    }

    // Version1 format (in case node returns this)
    if (execResult.Version1) {
      const v1Result = execResult.Version1;
      if (v1Result.Success) {
        return 'success';
      } else if (v1Result.Failure) {
        return 'error';
      }
    }

    return 'pending';
  } catch {
    return 'pending';
  }
}

/**
 * Legacy deploy status check for Casper 1.x
 */
async function getDeployStatusLegacy(
  deployHash: string
): Promise<'pending' | 'success' | 'error'> {
  const rpcUrl = getRpcEndpoint();

  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'info_get_deploy',
        params: [deployHash],
      }),
    });

    if (!response.ok) {
      return 'pending';
    }

    const data = await response.json();

    if (data.error) {
      return 'pending';
    }

    const executionResults = data.result?.execution_results;
    if (!executionResults || executionResults.length === 0) {
      return 'pending';
    }

    const result = executionResults[0].result;
    if (result?.Success) {
      return 'success';
    } else if (result?.Failure) {
      return 'error';
    }

    return 'pending';
  } catch {
    return 'pending';
  }
}

// ===== Explorer URL Helpers =====

/**
 * Get explorer URL for a deploy
 */
export function getDeployExplorerUrl(deployHash: string): string {
  const network = getNetworkConfig();
  return `${network.explorerUrl}/deploy/${deployHash}`;
}

/**
 * Get explorer URL for an account
 */
export function getAccountExplorerUrl(publicKey: string): string {
  const network = getNetworkConfig();
  return `${network.explorerUrl}/account/${publicKey}`;
}
