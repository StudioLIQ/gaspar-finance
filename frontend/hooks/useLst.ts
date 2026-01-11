'use client';

import { useCallback, useEffect, useState } from 'react';
import { useCasperWallet } from './useCasperWallet';
import {
  getLstExchangeRate,
  getLstBalance,
  getUserWithdrawRequests,
  getLstProtocolStats,
  getAccountCsprBalance,
  getContractPackageHash,
  refreshUnbondingPeriodFromChain,
  getUnbondingPeriod,
  getUnbondingPeriodDisplay,
  formatCsprAmount,
  formatRate,
  parseCsprInput,
  convertCsprToShares,
  convertSharesToCspr,
  type LstExchangeRate,
  type LstBalance,
  type WithdrawRequest,
  type LstProtocolStats,
} from '@/lib/casperRpc';
import { CONTRACTS, isLSTDeployed, getNetworkConfig } from '@/lib/config';
import {
  buildContractCallDeploy,
  buildDepositDeploy,
  loadProxyCallerWasm,
  submitDeploy,
  getDeployStatus,
  getDeployExplorerUrl,
  type DeployArg,
} from '@/lib/casperDeploy';

// Refresh interval for polling data
const REFRESH_INTERVAL_MS = 30_000; // 30 seconds

// Transaction status
export type TxStatus = 'idle' | 'signing' | 'pending' | 'success' | 'error';

export interface LstState {
  // Contract deployment status
  isDeployed: boolean;

  // Exchange rate
  exchangeRate: LstExchangeRate | null;

  // User balances
  userBalance: LstBalance | null;
  userCsprBalance: bigint | null;

  // Withdraw requests
  withdrawRequests: WithdrawRequest[];
  pendingRequestsCount: number;
  claimableRequestsCount: number;

  // Protocol stats
  protocolStats: LstProtocolStats | null;

  // Loading states
  isLoading: boolean;
  isRefreshing: boolean;

  // Transaction state
  txStatus: TxStatus;
  txError: string | null;
  txHash: string | null;
}

export interface LstActions {
  // Refresh data
  refresh: () => Promise<void>;

  // Stake CSPR -> stCSPR
  stake: (csprAmount: string) => Promise<boolean>;

  // Request unstake (approve + request)
  requestUnstake: (scsprAmount: string) => Promise<boolean>;

  // Claim matured withdraw request
  claimWithdraw: (requestId: number) => Promise<boolean>;

  // Helpers
  previewStake: (csprAmount: string) => { shares: bigint; formatted: string } | null;
  previewUnstake: (scsprAmount: string) => { cspr: bigint; formatted: string } | null;

  // Reset tx state
  resetTxState: () => void;
}

export function useLst(): LstState & LstActions {
  const { isConnected, publicKey, signDeploy } = useCasperWallet();

  // State
  const [isDeployed] = useState(isLSTDeployed());
  const [exchangeRate, setExchangeRate] = useState<LstExchangeRate | null>(null);
  const [userBalance, setUserBalance] = useState<LstBalance | null>(null);
  const [userCsprBalance, setUserCsprBalance] = useState<bigint | null>(null);
  const [withdrawRequests, setWithdrawRequests] = useState<WithdrawRequest[]>([]);
  const [protocolStats, setProtocolStats] = useState<LstProtocolStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [txStatus, setTxStatus] = useState<TxStatus>('idle');
  const [txError, setTxError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  // Computed values
  const pendingRequestsCount = withdrawRequests.filter((r) => r.status === 'pending').length;
  const claimableRequestsCount = withdrawRequests.filter((r) => r.status === 'claimable').length;

  // Refresh all data
  const refresh = useCallback(async () => {
    if (!isDeployed) {
      setIsLoading(false);
      return;
    }

    setIsRefreshing(true);

    try {
      // Fetch exchange rate and protocol stats (always)
      const [rateData, statsData] = await Promise.all([
        getLstExchangeRate(),
        getLstProtocolStats(),
      ]);

      setExchangeRate(rateData);
      setProtocolStats(statsData);

      // Best-effort: refresh unbonding period from chain so UI cooldown displays correctly.
      await refreshUnbondingPeriodFromChain();

      // Fetch user-specific data if connected
      if (isConnected && publicKey) {
        const [balanceData, requestsData, csprBalanceData] = await Promise.all([
          getLstBalance(publicKey),
          getUserWithdrawRequests(publicKey),
          getAccountCsprBalance(publicKey),
        ]);

        setUserBalance(balanceData);
        setWithdrawRequests(requestsData);
        setUserCsprBalance(csprBalanceData);
      } else {
        setUserBalance(null);
        setUserCsprBalance(null);
        setWithdrawRequests([]);
      }
    } catch (error) {
      console.error('Failed to refresh LST data:', error);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [isDeployed, isConnected, publicKey]);

  // Initial load and periodic refresh
  useEffect(() => {
    void refresh();

    const intervalId = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [refresh]);

  // Reset transaction state
  const resetTxState = useCallback(() => {
    setTxStatus('idle');
    setTxError(null);
    setTxHash(null);
  }, []);

  // Preview stake: CSPR -> stCSPR
  const previewStake = useCallback(
    (csprAmount: string): { shares: bigint; formatted: string } | null => {
      const csprMotes = parseCsprInput(csprAmount);
      if (csprMotes === null || csprMotes <= BigInt(0)) return null;

      const rate = exchangeRate?.rate ?? BigInt('1000000000000000000');
      const shares = convertCsprToShares(csprMotes, rate);

      return {
        shares,
        formatted: formatCsprAmount(shares),
      };
    },
    [exchangeRate]
  );

  // Preview unstake: stCSPR -> CSPR
  const previewUnstake = useCallback(
    (scsprAmount: string): { cspr: bigint; formatted: string } | null => {
      const shares = parseCsprInput(scsprAmount);
      if (shares === null || shares <= BigInt(0)) return null;

      const rate = exchangeRate?.rate ?? BigInt('1000000000000000000');
      const cspr = convertSharesToCspr(shares, rate);

      return {
        cspr,
        formatted: formatCsprAmount(cspr),
      };
    },
    [exchangeRate]
  );

  // Helper: Sign and submit a deploy, then poll for status
  const signAndSubmitDeploy = useCallback(
    async (deployJson: object): Promise<string | null> => {
      // Sign the deploy
      const signedDeploy = await signDeploy(deployJson);
      if (!signedDeploy) {
        return null;
      }

      setTxStatus('pending');

      // Submit the deploy
      const deployHash = await submitDeploy(signedDeploy);
      setTxHash(deployHash);

      // Poll for deploy status
      let attempts = 0;
      const maxAttempts = 60; // 5 minutes max
      while (attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 5000)); // 5 sec poll
        const status = await getDeployStatus(deployHash);

        if (status === 'success') {
          setTxStatus('success');
          return deployHash;
        } else if (status === 'error') {
          setTxStatus('error');
          setTxError('Deploy execution failed');
          return null;
        }

        attempts++;
      }

      // Timeout - deploy may still be pending
      setTxStatus('success'); // Assume success after timeout
      return deployHash;
    },
    []
  );

  // Stake CSPR -> stCSPR
  // Uses proxy_caller.wasm for payable calls (CSPR attachment)
  const stake = useCallback(
    async (csprAmount: string): Promise<boolean> => {
      if (!isConnected || !publicKey) {
        setTxError('Wallet not connected');
        return false;
      }

      const csprMotes = parseCsprInput(csprAmount);
      if (csprMotes === null || csprMotes <= BigInt(0)) {
        setTxError('Invalid CSPR amount');
        return false;
      }

      // Check user has enough CSPR (including some buffer for gas)
      if (userCsprBalance !== null) {
        const requiredWithBuffer = csprMotes + BigInt('6000000000'); // 6 CSPR buffer for gas
        if (userCsprBalance < requiredWithBuffer) {
          setTxError('Insufficient CSPR balance (need extra for gas)');
          return false;
        }
      }

      // Payable calls via proxy caller require the contract *package* hash.
      let ybTokenPackageHash = CONTRACTS.scsprYbtokenPackage;
      if (!ybTokenPackageHash || ybTokenPackageHash === 'null') {
        const ybTokenHash = CONTRACTS.scsprYbtoken;
        if (ybTokenHash && ybTokenHash !== 'null') {
          ybTokenPackageHash = await getContractPackageHash(ybTokenHash);
        }
      }
      if (!ybTokenPackageHash || ybTokenPackageHash === 'null') {
        setTxError(
          'Missing ybToken package hash (config and on-chain lookup). Re-run ./casper/scripts/bind-frontend.sh or set NEXT_PUBLIC_SCSPR_YBTOKEN_PACKAGE_HASH.'
        );
        return false;
      }

      setTxStatus('signing');
      setTxError(null);
      setTxHash(null);

      try {
        // Load the proxy_caller.wasm
        let wasmBase64: string;
        try {
          wasmBase64 = await loadProxyCallerWasm();
        } catch (wasmError) {
          setTxError(
            'Failed to load proxy_caller.wasm. Ensure the file exists at /odra/proxy_caller.wasm'
          );
          setTxStatus('error');
          return false;
        }

        // Build the deposit deploy using proxy caller
        const deployJson = buildDepositDeploy(
          publicKey,
          ybTokenPackageHash,
          csprMotes.toString(),
          wasmBase64
        );
        if (typeof window !== 'undefined') {
          (window as Window & { __LAST_DEPLOY_JSON__?: object }).__LAST_DEPLOY_JSON__ = deployJson;
          if (process.env.NEXT_PUBLIC_DEBUG_DEPLOYS === 'true') {
            // eslint-disable-next-line no-console
            console.log('[LST] deposit deploy', deployJson);
          }
        }

        // Sign the deploy
        const signedDeploy = await signDeploy(deployJson);
        if (!signedDeploy) {
          setTxError('Signing cancelled');
          setTxStatus('error');
          return false;
        }

        setTxStatus('pending');

        // Submit the deploy
        const deployHash = await submitDeploy(signedDeploy);
        setTxHash(deployHash);

        // Poll for deploy status
        let attempts = 0;
        const maxAttempts = 60; // 5 minutes max
        while (attempts < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          const status = await getDeployStatus(deployHash);

          if (status === 'success') {
            setTxStatus('success');
            await refresh();
            return true;
          } else if (status === 'error') {
            setTxStatus('error');
            setTxError('Deposit transaction failed on-chain');
            return false;
          }

          attempts++;
        }

        // Timeout - assume success
        setTxStatus('success');
        await refresh();
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Transaction failed';
        setTxError(message);
        setTxStatus('error');
        return false;
      }
    },
    [isConnected, publicKey, userCsprBalance, signDeploy, refresh]
  );

  // Request unstake (approve + request_withdraw)
  // Step 1: approve(withdrawQueue, amount)
  // Step 2: request_withdraw(amount)
  const requestUnstake = useCallback(
    async (scsprAmount: string): Promise<boolean> => {
      if (!isConnected || !publicKey) {
        setTxError('Wallet not connected');
        return false;
      }

      const shares = parseCsprInput(scsprAmount);
      if (shares === null || shares <= BigInt(0)) {
        setTxError('Invalid stCSPR amount');
        return false;
      }

      if (userBalance && shares > userBalance.scsprBalance) {
        setTxError('Insufficient stCSPR balance');
        return false;
      }

      const ybTokenHash = CONTRACTS.scsprYbtoken;
      const queueHash = CONTRACTS.withdrawQueue;
      if (!ybTokenHash || ybTokenHash === 'null' || !queueHash || queueHash === 'null') {
        setTxError('LST contracts not deployed');
        return false;
      }

      setTxStatus('signing');
      setTxError(null);
      setTxHash(null);

      try {
        // Step 1: Build and sign approve deploy
        const approveArgs: DeployArg[] = [
          { name: 'spender', clType: 'Key', value: `hash-${queueHash.replace(/^hash-/, '')}` },
          { name: 'amount', clType: 'U256', value: shares.toString() },
        ];

        const approveDeploy = buildContractCallDeploy(publicKey, {
          contractHash: ybTokenHash,
          entryPoint: 'approve',
          args: approveArgs,
        });

        // Sign approve
        const signedApprove = await signDeploy(approveDeploy);
        if (!signedApprove) {
          setTxError('Approve signing cancelled');
          setTxStatus('error');
          return false;
        }

        setTxStatus('pending');
        const approveHash = await submitDeploy(signedApprove);
        setTxHash(approveHash);

        // Wait for approve to complete
        let approveStatus = 'pending';
        for (let i = 0; i < 24; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          approveStatus = await getDeployStatus(approveHash);
          if (approveStatus !== 'pending') break;
        }

        if (approveStatus === 'error') {
          setTxError('Approve transaction failed');
          setTxStatus('error');
          return false;
        }

        // Step 2: Build and sign request_withdraw deploy
        setTxStatus('signing');
        const requestArgs: DeployArg[] = [
          { name: 'shares', clType: 'U256', value: shares.toString() },
        ];

        const requestDeploy = buildContractCallDeploy(publicKey, {
          contractHash: queueHash,
          entryPoint: 'request_withdraw',
          args: requestArgs,
        });

        const signedRequest = await signDeploy(requestDeploy);
        if (!signedRequest) {
          setTxError('Request signing cancelled');
          setTxStatus('error');
          return false;
        }

        setTxStatus('pending');
        const requestHash = await submitDeploy(signedRequest);
        setTxHash(requestHash);

        // Wait for request_withdraw to complete
        let requestStatus = 'pending';
        for (let i = 0; i < 24; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          requestStatus = await getDeployStatus(requestHash);
          if (requestStatus !== 'pending') break;
        }

        if (requestStatus === 'error') {
          setTxError('Request withdraw transaction failed');
          setTxStatus('error');
          return false;
        }

        setTxStatus('success');
        await refresh();
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Transaction failed';
        setTxError(message);
        setTxStatus('error');
        return false;
      }
    },
    [isConnected, publicKey, userBalance, refresh]
  );

  // Claim matured withdraw request
  const claimWithdraw = useCallback(
    async (requestId: number): Promise<boolean> => {
      if (!isConnected || !publicKey) {
        setTxError('Wallet not connected');
        return false;
      }

      const request = withdrawRequests.find((r) => r.id === requestId);
      if (!request) {
        setTxError('Withdraw request not found');
        return false;
      }

      if (request.status !== 'claimable') {
        setTxError('Request is not yet claimable');
        return false;
      }

      const queueHash = CONTRACTS.withdrawQueue;
      if (!queueHash || queueHash === 'null') {
        setTxError('Withdraw queue contract not deployed');
        return false;
      }

      setTxStatus('signing');
      setTxError(null);
      setTxHash(null);

      try {
        // Build claim deploy
        const claimArgs: DeployArg[] = [
          { name: 'request_id', clType: 'U64', value: requestId.toString() },
        ];

        const claimDeploy = buildContractCallDeploy(publicKey, {
          contractHash: queueHash,
          entryPoint: 'claim',
          args: claimArgs,
        });

        // Sign and submit
        const signedClaim = await signDeploy(claimDeploy);
        if (!signedClaim) {
          setTxError('Claim signing cancelled');
          setTxStatus('error');
          return false;
        }

        setTxStatus('pending');
        const claimHash = await submitDeploy(signedClaim);
        setTxHash(claimHash);

        // Wait for claim to complete
        let claimStatus = 'pending';
        for (let i = 0; i < 24; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          claimStatus = await getDeployStatus(claimHash);
          if (claimStatus !== 'pending') break;
        }

        if (claimStatus === 'error') {
          setTxError('Claim transaction failed');
          setTxStatus('error');
          return false;
        }

        setTxStatus('success');
        await refresh();
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Transaction failed';
        setTxError(message);
        setTxStatus('error');
        return false;
      }
    },
    [isConnected, publicKey, withdrawRequests, refresh]
  );

  return {
    // State
    isDeployed,
    exchangeRate,
    userBalance,
    userCsprBalance,
    withdrawRequests,
    pendingRequestsCount,
    claimableRequestsCount,
    protocolStats,
    isLoading,
    isRefreshing,
    txStatus,
    txError,
    txHash,

    // Actions
    refresh,
    stake,
    requestUnstake,
    claimWithdraw,
    previewStake,
    previewUnstake,
    resetTxState,
  };
}

// Re-export types and helpers for convenience
export type { LstExchangeRate, LstBalance, WithdrawRequest, LstProtocolStats };
export { formatCsprAmount, formatRate, parseCsprInput, getUnbondingPeriod, getUnbondingPeriodDisplay };
