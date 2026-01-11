// CSPR-CDP Frontend Configuration
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

// Current network selection
export const CURRENT_NETWORK = process.env.NEXT_PUBLIC_CASPER_NETWORK || 'testnet';

export const getNetworkConfig = () => {
  return CURRENT_NETWORK === 'mainnet' ? CASPER_MAINNET : CASPER_TESTNET;
};

// Wallet Configuration
export const SUPPORTED_WALLET = 'Casper Wallet' as const;

// Contract Addresses (populated after deployment)
export const CONTRACTS = {
  registry: process.env.NEXT_PUBLIC_REGISTRY_HASH || null,
  router: process.env.NEXT_PUBLIC_ROUTER_HASH || null,
  stablecoin: process.env.NEXT_PUBLIC_STABLECOIN_HASH || null,
  oracleAdapter: process.env.NEXT_PUBLIC_ORACLE_ADAPTER_HASH || null,
  stabilityPool: process.env.NEXT_PUBLIC_STABILITY_POOL_HASH || null,
  branchCspr: process.env.NEXT_PUBLIC_BRANCH_CSPR_HASH || null,
  branchSCSPR:
    process.env.NEXT_PUBLIC_BRANCH_SCSPR_HASH ||
    process.env.NEXT_PUBLIC_BRANCH_STCSPR_HASH ||
    null,
  treasury: process.env.NEXT_PUBLIC_TREASURY_HASH || null,
  liquidationEngine: process.env.NEXT_PUBLIC_LIQUIDATION_ENGINE_HASH || null,
  redemptionEngine: process.env.NEXT_PUBLIC_REDEMPTION_ENGINE_HASH || null,
  // LST (stCSPR ybToken + withdraw queue)
  scsprYbtoken: process.env.NEXT_PUBLIC_SCSPR_YBTOKEN_HASH || null,
  scsprYbtokenPackage: process.env.NEXT_PUBLIC_SCSPR_YBTOKEN_PACKAGE_HASH || null,
  withdrawQueue: process.env.NEXT_PUBLIC_WITHDRAW_QUEUE_HASH || null,
} as const;

// Check if contracts are deployed
export const isContractsDeployed = () => {
  return CONTRACTS.router !== null && CONTRACTS.router !== 'null';
};

export const isLSTDeployed = () => {
  return CONTRACTS.scsprYbtoken !== null && CONTRACTS.scsprYbtoken !== 'null';
};

// Protocol Parameters
export const PROTOCOL_PARAMS = {
  // Collateralization Ratios (in basis points)
  MCR_BPS: 11000, // 110% Minimum Collateralization Ratio
  CCR_BPS: 15000, // 150% Critical Collateralization Ratio

  // Minimum Debt (in gUSD, with 18 decimals)
  MIN_DEBT: '2000000000000000000000', // 2000 gUSD

  // Fee Configuration (in basis points)
  LIQUIDATION_PENALTY_BPS: 1000, // 10%
  REDEMPTION_BASE_FEE_BPS: 50, // 0.5%

  // Interest Rate Bounds (in basis points)
  MIN_INTEREST_RATE_BPS: 0,
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

export const getExplorerUrl = (hash: string, type: 'deploy' | 'account' | 'contract' = 'deploy') => {
  const network = getNetworkConfig();
  return `${network.explorerUrl}/${type}/${hash}`;
};
