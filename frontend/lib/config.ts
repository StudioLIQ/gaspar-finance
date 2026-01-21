// GasparFinance Frontend Configuration
//
// Network and contract configuration for Casper integration.
// Values are loaded from environment variables set by bind-frontend.sh

// Network Configuration
export const CASPER_TESTNET = {
  name: 'Casper Testnet',
  network: 'testnet',
  chainName: process.env.NEXT_PUBLIC_CASPER_CHAIN_NAME || 'casper-test',
  rpcUrl:
    process.env.NEXT_PUBLIC_CASPER_NODE_ADDRESS ||
    process.env.NEXT_PUBLIC_CASPER_RPC_URL ||
    'https://node.testnet.casper.network/rpc',
  explorerUrl: process.env.NEXT_PUBLIC_CASPER_EXPLORER_URL || 'https://testnet.cspr.live',
} as const;

export const CASPER_MAINNET = {
  name: 'Casper Mainnet',
  network: 'mainnet',
  chainName: 'casper',
  rpcUrl: 'https://rpc.mainnet.casperlabs.io/rpc',
  explorerUrl: 'https://cspr.live',
} as const;

type RuntimeContracts = {
  registry?: string;
  router?: string;
  routerPackage?: string;
  stablecoin?: string;
  oracleAdapter?: string;
  stabilityPool?: string;
  stabilityPoolPackage?: string;
  branchCspr?: string;
  branchSCSPR?: string;
  treasury?: string;
  liquidationEngine?: string;
  redemptionEngine?: string;
  scsprYbToken?: string;
  scsprYbTokenPackage?: string;
  withdrawQueue?: string;
};

export type RuntimeConfig = {
  network?: string;
  chainName?: string;
  nodeAddress?: string;
  contracts?: RuntimeContracts;
  generatedAt?: string;
};

const getRuntimeConfig = (): RuntimeConfig | null => {
  if (typeof window !== 'undefined') {
    return (window as Window & { __CSPR_CDP_CONFIG__?: RuntimeConfig }).__CSPR_CDP_CONFIG__ || null;
  }
  return (globalThis as typeof globalThis & { __CSPR_CDP_CONFIG__?: RuntimeConfig })
    .__CSPR_CDP_CONFIG__ || null;
};

const normalizeHash = (value?: string | null): string | null => {
  if (!value || value === 'null') return null;
  return value;
};

export const getCurrentNetwork = () => {
  const runtime = getRuntimeConfig();
  return runtime?.network || process.env.NEXT_PUBLIC_CASPER_NETWORK || 'testnet';
};

export const getNetworkConfig = () => {
  const network = getCurrentNetwork();
  const base = network === 'mainnet' ? CASPER_MAINNET : CASPER_TESTNET;
  const runtime = getRuntimeConfig();
  return {
    ...base,
    network,
    chainName: runtime?.chainName || base.chainName,
    rpcUrl: runtime?.nodeAddress || base.rpcUrl,
  };
};

// Wallet Configuration
export const SUPPORTED_WALLET = 'Casper Wallet' as const;

// Contract Addresses (populated after deployment)
type Contracts = {
  registry: string | null;
  router: string | null;
  routerPackage: string | null;
  stablecoin: string | null;
  oracleAdapter: string | null;
  stabilityPool: string | null;
  stabilityPoolPackage: string | null;
  branchCspr: string | null;
  branchSCSPR: string | null;
  treasury: string | null;
  liquidationEngine: string | null;
  redemptionEngine: string | null;
  scsprYbtoken: string | null;
  scsprYbtokenPackage: string | null;
  withdrawQueue: string | null;
};

const buildContracts = (): Contracts => {
  const runtimeContracts = getRuntimeConfig()?.contracts || {};
  return {
    registry:
      normalizeHash(runtimeContracts.registry) ??
      normalizeHash(process.env.NEXT_PUBLIC_REGISTRY_HASH),
    router:
      normalizeHash(runtimeContracts.router) ??
      normalizeHash(process.env.NEXT_PUBLIC_ROUTER_HASH),
    routerPackage:
      normalizeHash(runtimeContracts.routerPackage) ??
      normalizeHash(process.env.NEXT_PUBLIC_ROUTER_PACKAGE_HASH),
    stablecoin:
      normalizeHash(runtimeContracts.stablecoin) ??
      normalizeHash(process.env.NEXT_PUBLIC_STABLECOIN_HASH),
    oracleAdapter:
      normalizeHash(runtimeContracts.oracleAdapter) ??
      normalizeHash(process.env.NEXT_PUBLIC_ORACLE_ADAPTER_HASH),
    stabilityPool:
      normalizeHash(runtimeContracts.stabilityPool) ??
      normalizeHash(process.env.NEXT_PUBLIC_STABILITY_POOL_HASH),
    stabilityPoolPackage:
      normalizeHash(runtimeContracts.stabilityPoolPackage) ??
      normalizeHash(process.env.NEXT_PUBLIC_STABILITY_POOL_PACKAGE_HASH),
    branchCspr:
      normalizeHash(runtimeContracts.branchCspr) ??
      normalizeHash(process.env.NEXT_PUBLIC_BRANCH_CSPR_HASH),
    branchSCSPR:
      normalizeHash(runtimeContracts.branchSCSPR) ??
      normalizeHash(process.env.NEXT_PUBLIC_BRANCH_SCSPR_HASH) ??
      normalizeHash(process.env.NEXT_PUBLIC_BRANCH_STCSPR_HASH),
    treasury:
      normalizeHash(runtimeContracts.treasury) ??
      normalizeHash(process.env.NEXT_PUBLIC_TREASURY_HASH),
    liquidationEngine:
      normalizeHash(runtimeContracts.liquidationEngine) ??
      normalizeHash(process.env.NEXT_PUBLIC_LIQUIDATION_ENGINE_HASH),
    redemptionEngine:
      normalizeHash(runtimeContracts.redemptionEngine) ??
      normalizeHash(process.env.NEXT_PUBLIC_REDEMPTION_ENGINE_HASH),
    scsprYbtoken:
      normalizeHash(runtimeContracts.scsprYbToken) ??
      normalizeHash(process.env.NEXT_PUBLIC_SCSPR_YBTOKEN_HASH),
    scsprYbtokenPackage:
      normalizeHash(runtimeContracts.scsprYbTokenPackage) ??
      normalizeHash(process.env.NEXT_PUBLIC_SCSPR_YBTOKEN_PACKAGE_HASH),
    withdrawQueue:
      normalizeHash(runtimeContracts.withdrawQueue) ??
      normalizeHash(process.env.NEXT_PUBLIC_WITHDRAW_QUEUE_HASH),
  };
};

export const CONTRACTS: Contracts = new Proxy({} as Contracts, {
  get(_target, prop: string) {
    const contracts = buildContracts();
    return (contracts as Record<string, string | null>)[prop];
  },
});

// Check if contracts are deployed
export const isContractsDeployed = () => {
  const { router } = buildContracts();
  return router !== null;
};

export const isLSTDeployed = () => {
  const { scsprYbtoken } = buildContracts();
  return scsprYbtoken !== null;
};

// Protocol Parameters
export const PROTOCOL_PARAMS = {
  // Collateralization Ratios (in basis points)
  MCR_BPS: 11000, // 110% Minimum Collateralization Ratio
  CCR_BPS: 15000, // 150% Critical Collateralization Ratio

  // Minimum Debt (in gUSD, with 18 decimals)
  MIN_DEBT: '1000000000000000000', // 1 gUSD

  // Fee Configuration (in basis points)
  LIQUIDATION_PENALTY_BPS: 1000, // 10%
  REDEMPTION_BASE_FEE_BPS: 50, // 0.5%

  // Interest Rate Bounds (in basis points)
  MIN_INTEREST_RATE_BPS: 200, // 2%
  MAX_INTEREST_RATE_BPS: 4000, // 40%
} as const;

// Collateral Types
export const COLLATERAL_TYPES = {
  CSPR: {
    id: 0,
    symbol: 'CSPR',
    name: 'Casper',
    decimals: 9,
    isNative: true,
  },
  SCSPR: {
    id: 1,
    symbol: 'stCSPR',
    name: 'stCSPR',
    decimals: 9,
    isNative: false,
  },
} as const;

// Utility functions
export const formatContractHash = (hash: string | null): string => {
  if (!hash || hash === 'null') return 'Not deployed';
  if (hash.length > 20) {
    return `${hash.slice(0, 10)}...${hash.slice(-8)}`;
  }
  return hash;
};

declare global {
  interface Window {
    __CSPR_CDP_CONFIG__?: RuntimeConfig;
  }
  // eslint-disable-next-line no-var
  var __CSPR_CDP_CONFIG__: RuntimeConfig | undefined;
}

export {};

export const getExplorerUrl = (hash: string, type: 'deploy' | 'account' | 'contract' = 'deploy') => {
  const network = getNetworkConfig();
  return `${network.explorerUrl}/${type}/${hash}`;
};
