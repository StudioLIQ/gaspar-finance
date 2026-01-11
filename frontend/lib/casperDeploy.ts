// Casper Deploy Builder
//
// Provides utilities for building and signing Casper deploys.
// Used for interacting with LST contracts (stake, unstake, claim).

import { getNetworkConfig } from './config';

// ===== Constants =====

// Default payment amount in motes (0.5 CSPR - adjust as needed)
const DEFAULT_PAYMENT_MOTES = '500000000';
// Higher payment for proxy calls (5 CSPR for WASM execution)
const PROXY_PAYMENT_MOTES = '5000000000';
// TTL for deploys (30 minutes)
const DEPLOY_TTL_MS = 30 * 60 * 1000;

// Proxy caller WASM paths
const PROXY_CALLER_WASM_PATH = '/odra/proxy_caller.wasm';

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
 * Returns the WASM bytes as a base64 string for the deploy session
 */
export async function loadProxyCallerWasm(): Promise<string> {
  // Return cached if available
  if (proxyCallerWasmCache) {
    return uint8ArrayToBase64(proxyCallerWasmCache);
  }

  // Fetch the WASM file
  const response = await fetch(PROXY_CALLER_WASM_PATH);
  if (!response.ok) {
    throw new Error(`Failed to load proxy_caller.wasm: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  proxyCallerWasmCache = new Uint8Array(arrayBuffer);

  return uint8ArrayToBase64(proxyCallerWasmCache);
}

/**
 * Convert Uint8Array to base64 string
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
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
 * Format argument for RuntimeArgs serialization
 */
function formatArg(arg: DeployArg): [string, { cl_type: string; bytes: string; parsed: unknown }] {
  // Note: In a real implementation, you'd properly serialize CLValues.
  // For browser compatibility, we'll create a simplified format that
  // matches what the Casper Wallet expects.
  return [
    arg.name,
    {
      cl_type: arg.clType,
      bytes: '', // Will be filled by Casper SDK/Wallet
      parsed: arg.value,
    },
  ];
}

/**
 * Create a standard contract call deploy (without attached CSPR)
 */
export function buildContractCallDeploy(
  senderPublicKey: string,
  params: DeployParams
): object {
  const network = getNetworkConfig();
  const now = Date.now();

  // Normalize contract hash format
  const contractHashClean = params.contractHash.replace(/^hash-/, '');

  return {
    deploy: {
      hash: '', // Will be computed by SDK
      header: {
        account: senderPublicKey,
        timestamp: new Date(now).toISOString(),
        ttl: `${DEPLOY_TTL_MS}ms`,
        gas_price: 1,
        body_hash: '', // Will be computed by SDK
        dependencies: [],
        chain_name: network.chainName,
      },
      payment: {
        ModuleBytes: {
          module_bytes: '',
          args: [
            [
              'amount',
              {
                cl_type: 'U512',
                bytes: '',
                parsed: params.paymentMotes || DEFAULT_PAYMENT_MOTES,
              },
            ],
          ],
        },
      },
      session: {
        StoredContractByHash: {
          hash: contractHashClean,
          entry_point: params.entryPoint,
          args: params.args.map(formatArg),
        },
      },
      approvals: [],
    },
  };
}

/**
 * Create a proxy caller deploy (for payable entry points with attached CSPR)
 *
 * Uses proxy_caller.wasm to call a contract with attached motes.
 * The WASM bytes must be loaded separately using loadProxyCallerWasm().
 *
 * @param senderPublicKey - The sender's public key
 * @param params - Deploy parameters including target contract and attached value
 * @param wasmBase64 - Base64-encoded proxy_caller.wasm bytes
 */
export function buildProxyCallerDeploy(
  senderPublicKey: string,
  params: ProxyDeployParams,
  wasmBase64: string
): object {
  const network = getNetworkConfig();
  const now = Date.now();

  // Normalize contract package hash format (remove known prefixes if present)
  const packageHashClean = params.contractPackageHash.replace(/^(hash-|contract-package-)/, '');

  // Odra proxy_caller expects these session args:
  // - contract_package_hash: AccountHash/ContractPackageHash (32 bytes)
  // - entry_point: String
  // - args: RuntimeArgs (serialized)
  // - attached_value: U512 (amount to attach)
  return {
    deploy: {
      hash: '',
      header: {
        account: senderPublicKey,
        timestamp: new Date(now).toISOString(),
        ttl: `${DEPLOY_TTL_MS}ms`,
        gas_price: 1,
        body_hash: '',
        dependencies: [],
        chain_name: network.chainName,
      },
      payment: {
        ModuleBytes: {
          module_bytes: '',
          args: [
            [
              'amount',
              {
                cl_type: 'U512',
                bytes: '',
                parsed: params.paymentMotes || PROXY_PAYMENT_MOTES,
              },
            ],
          ],
        },
      },
      session: {
        ModuleBytes: {
          // Base64-encoded WASM bytes
          module_bytes: wasmBase64,
          args: [
            [
              'contract_package_hash',
              {
                cl_type: { ByteArray: 32 },
                bytes: '',
                parsed: packageHashClean,
              },
            ],
            [
              'entry_point',
              {
                cl_type: 'String',
                bytes: '',
                parsed: params.entryPoint,
              },
            ],
            [
              'args',
              {
                cl_type: 'Any',
                bytes: '',
                parsed: params.args.length > 0 ? params.args.map(formatArg) : [],
              },
            ],
            [
              'attached_value',
              {
                cl_type: 'U512',
                bytes: '',
                parsed: params.attachedMotes,
              },
            ],
          ],
        },
      },
      approvals: [],
    },
  };
}

/**
 * Build a deposit deploy for stCSPR ybToken using proxy caller
 *
 * This is a convenience function for the common stake operation.
 * @param senderPublicKey - The sender's public key
 * @param ybTokenPackageHash - The ybToken contract package hash
 * @param csprMotes - Amount of CSPR to deposit (in motes)
 * @param wasmBase64 - Base64-encoded proxy_caller.wasm bytes
 */
export function buildDepositDeploy(
  senderPublicKey: string,
  ybTokenPackageHash: string,
  csprMotes: string,
  wasmBase64: string
): object {
  return buildProxyCallerDeploy(
    senderPublicKey,
    {
      contractPackageHash: ybTokenPackageHash,
      entryPoint: 'deposit',
      args: [], // deposit() takes no explicit args, only attached value
      attachedMotes: csprMotes,
    },
    wasmBase64
  );
}

// ===== Deploy Submission =====

/**
 * Submit a signed deploy to the Casper node
 */
export async function submitDeploy(signedDeployJson: unknown): Promise<string> {
  const network = getNetworkConfig();

  const response = await fetch(network.rpcUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'account_put_deploy',
      params: [signedDeployJson],
    }),
  });

  if (!response.ok) {
    throw new Error(`Deploy submission failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`Deploy submission error: ${data.error.message}`);
  }

  // Return the deploy hash
  return data.result?.deploy_hash || (signedDeployJson as any)?.deploy?.hash || '';
}

/**
 * Check deploy status
 */
export async function getDeployStatus(
  deployHash: string
): Promise<'pending' | 'success' | 'error'> {
  const network = getNetworkConfig();

  try {
    const response = await fetch(network.rpcUrl, {
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
