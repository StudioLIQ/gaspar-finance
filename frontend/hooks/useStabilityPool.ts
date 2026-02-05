'use client';

import { useCallback, useEffect, useState } from 'react';
import { useCasperWallet } from './useCasperWallet';
import { CONTRACTS, getNetworkConfig } from '@/lib/config';
import {
  buildContractCallDeploy,
  submitDeploy,
  getDeployStatus,
  type DeployArg,
} from '@/lib/casperDeploy';
import {
  APPROVAL_POLL_MAX_ATTEMPTS,
  DATA_REFRESH_INTERVAL_MS,
  DEPLOY_POLL_INTERVAL_MS,
  TX_TIMEOUT_MESSAGES,
} from '@/lib/constants';
import {
  formatCsprAmount,
  parseCsprInput,
  getStabilityPoolStats,
  getStabilityPoolUserState,
  getGusdBalance,
  formatGusdAmount,
} from '@/lib/casperRpc';

// Transaction status
export type TxStatus = 'idle' | 'signing' | 'approving' | 'pending' | 'success' | 'error';

// User deposit in stability pool
export interface StabilityPoolDeposit {
  // gUSD deposited (scaled by 1e18)
  depositedAmount: bigint;
  depositedFormatted: string;
  // Pending CSPR gains (scaled by 1e9)
  pendingCsprGains: bigint;
  csprGainsFormatted: string;
  // Pending stCSPR gains (scaled by 1e9)
  pendingScsprGains: bigint;
  scsprGainsFormatted: string;
}

// Protocol-level stats
export interface StabilityPoolStats {
  // Total gUSD in pool (scaled by 1e18)
  totalDeposits: bigint;
  totalDepositsFormatted: string;
  // Total CSPR gains distributed (cumulative)
  totalCsprGains: bigint;
  // Total stCSPR gains distributed (cumulative)
  totalScsprGains: bigint;
  // Estimated APR (in basis points, e.g., 500 = 5%)
  estimatedAprBps: number;
  // Safe mode status
  isSafeModeActive: boolean;
  safeModeTriggeredAt: number | null;
  safeModeReason: number | null;
}

export interface StabilityPoolState {
  // Contract deployment status
  isDeployed: boolean;

  // User deposit data
  userDeposit: StabilityPoolDeposit | null;

  // User gUSD balance (for deposit max)
  userGusdBalance: bigint | null;
  userGusdBalanceFormatted: string | null;

  // Protocol stats
  poolStats: StabilityPoolStats | null;

  // Loading states
  isLoading: boolean;
  isRefreshing: boolean;

  // Transaction state
  txStatus: TxStatus;
  txError: string | null;
  txHash: string | null;
}

export interface StabilityPoolActions {
  // Refresh data
  refresh: () => Promise<void>;

  // Deposit gUSD to pool (requires approval)
  deposit: (gusdAmount: string) => Promise<boolean>;

  // Withdraw gUSD from pool
  withdraw: (gusdAmount: string) => Promise<boolean>;

  // Claim accumulated gains (CSPR + stCSPR)
  claimGains: () => Promise<boolean>;

  // Reset tx state
  resetTxState: () => void;
}

// Check if stability pool is deployed
function isStabilityPoolDeployed(): boolean {
  return CONTRACTS.stabilityPool !== null && CONTRACTS.stabilityPool !== 'null';
}

export function useStabilityPool(): StabilityPoolState & StabilityPoolActions {
  const { isConnected, publicKey, signDeploy } = useCasperWallet();

  // State
  const [isDeployed] = useState(isStabilityPoolDeployed());
  const [userDeposit, setUserDeposit] = useState<StabilityPoolDeposit | null>(null);
  const [userGusdBalance, setUserGusdBalance] = useState<bigint | null>(null);
  const [poolStats, setPoolStats] = useState<StabilityPoolStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [txStatus, setTxStatus] = useState<TxStatus>('idle');
  const [txError, setTxError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  // Computed
  const userGusdBalanceFormatted = userGusdBalance !== null ? formatGusdAmount(userGusdBalance) : null;

  // Refresh all data
  const refresh = useCallback(async () => {
    if (!isDeployed) {
      setIsLoading(false);
      return;
    }

    setIsRefreshing(true);

    try {
      // Fetch protocol stats from chain
      const stats = await getStabilityPoolStats();
      if (stats) {
        const poolStatsData: StabilityPoolStats = {
          totalDeposits: stats.totalDeposits,
          totalDepositsFormatted: stats.totalDepositsFormatted,
          totalCsprGains: stats.totalCsprCollateral,
          totalScsprGains: stats.totalScsprCollateral,
          estimatedAprBps: 0, // APR calculation would require historical data
          isSafeModeActive: stats.isSafeModeActive,
          safeModeTriggeredAt: stats.safeModeTriggeredAt,
          safeModeReason: stats.safeModeReason,
        };
        setPoolStats(poolStatsData);
      } else {
        // Fallback to zero stats if query fails
        setPoolStats({
          totalDeposits: BigInt(0),
          totalDepositsFormatted: '0',
          totalCsprGains: BigInt(0),
          totalScsprGains: BigInt(0),
          estimatedAprBps: 0,
          isSafeModeActive: false,
          safeModeTriggeredAt: null,
          safeModeReason: null,
        });
      }

      // Fetch user-specific data if connected
      if (isConnected && publicKey) {
        // Query user's deposit and gains from contract
        const userState = await getStabilityPoolUserState(publicKey);
        if (userState) {
          const deposit: StabilityPoolDeposit = {
            depositedAmount: userState.deposit,
            depositedFormatted: userState.depositFormatted,
            pendingCsprGains: userState.csprGains,
            csprGainsFormatted: userState.csprGainsFormatted,
            pendingScsprGains: userState.scsprGains,
            scsprGainsFormatted: userState.scsprGainsFormatted,
          };
          setUserDeposit(deposit);
        } else {
          // User has no deposit
          setUserDeposit({
            depositedAmount: BigInt(0),
            depositedFormatted: '0.00',
            pendingCsprGains: BigInt(0),
            csprGainsFormatted: '0.00',
            pendingScsprGains: BigInt(0),
            scsprGainsFormatted: '0.00',
          });
        }

        // Query user's gUSD balance
        const gusdBal = await getGusdBalance(publicKey);
        setUserGusdBalance(gusdBal);
      } else {
        setUserDeposit(null);
        setUserGusdBalance(null);
      }
    } catch (error) {
      console.error('Failed to refresh Stability Pool data:', error);
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
    }, DATA_REFRESH_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [refresh]);

  // Reset transaction state
  const resetTxState = useCallback(() => {
    setTxStatus('idle');
    setTxError(null);
    setTxHash(null);
  }, []);

  // Deposit gUSD to Stability Pool
  // Requires 2 steps: approve gUSD, then deposit
  const deposit = useCallback(
    async (gusdAmount: string): Promise<boolean> => {
      if (!isConnected || !publicKey) {
        setTxError('Wallet not connected');
        return false;
      }

      const amount = parseCsprInput(gusdAmount); // Parse as 1e9, but gUSD is 1e18
      if (amount === null || amount <= BigInt(0)) {
        setTxError('Invalid gUSD amount');
        return false;
      }

      // Convert to 1e18 scale for gUSD
      const gusdMotes = amount * BigInt('1000000000'); // 1e9 * 1e9 = 1e18

      if (userGusdBalance !== null && gusdMotes > userGusdBalance) {
        setTxError('Insufficient gUSD balance');
        return false;
      }

      const spHash = CONTRACTS.stabilityPool;
      const spPackageHash = CONTRACTS.stabilityPoolPackage;
      const gusdHash = CONTRACTS.stablecoin;
      if (!spHash || spHash === 'null' || !gusdHash || gusdHash === 'null') {
        setTxError('Contracts not deployed');
        return false;
      }
      if (!spPackageHash || spPackageHash === 'null') {
        setTxError('Stability Pool package hash not configured');
        return false;
      }

      setTxStatus('signing');
      setTxError(null);
      setTxHash(null);

      try {
        // Step 1: Approve gUSD spend by Stability Pool
        // NOTE: Must use package hash as spender because Odra cross-contract calls
        // use the caller's package hash, not contract hash
        const spenderHash = spPackageHash.replace(/^(hash-|contract-package-)/, '');
        const approveArgs: DeployArg[] = [
          { name: 'spender', clType: 'Key', value: spenderHash },
          { name: 'amount', clType: 'U256', value: gusdMotes.toString() },
        ];

        const approveDeploy = buildContractCallDeploy(publicKey, {
          contractHash: gusdHash,
          entryPoint: 'approve',
          args: approveArgs,
        });

        const signedApprove = await signDeploy(approveDeploy);
        if (!signedApprove) {
          setTxError('Approval cancelled');
          setTxStatus('error');
          return false;
        }

        setTxStatus('approving');
        const approveHash = await submitDeploy(signedApprove);
        setTxHash(approveHash);

        // Wait for approve
        let approveStatus = 'pending';
        for (let i = 0; i < APPROVAL_POLL_MAX_ATTEMPTS; i++) {
          await new Promise((r) => setTimeout(r, DEPLOY_POLL_INTERVAL_MS));
          approveStatus = await getDeployStatus(approveHash);
          if (approveStatus !== 'pending') break;
        }

        if (approveStatus === 'error') {
          setTxError('Approval transaction failed');
          setTxStatus('error');
          return false;
        }
        if (approveStatus === 'pending') {
          setTxError(TX_TIMEOUT_MESSAGES.approval);
          setTxStatus('error');
          return false;
        }

        // Step 2: Call deposit on Stability Pool
        setTxStatus('signing');
        const depositArgs: DeployArg[] = [
          { name: 'amount', clType: 'U256', value: gusdMotes.toString() },
        ];

        const depositDeploy = buildContractCallDeploy(publicKey, {
          contractHash: spHash,
          entryPoint: 'deposit',
          args: depositArgs,
        });

        const signedDeposit = await signDeploy(depositDeploy);
        if (!signedDeposit) {
          setTxError('Deposit cancelled');
          setTxStatus('error');
          return false;
        }

        setTxStatus('pending');
        const depositHash = await submitDeploy(signedDeposit);
        setTxHash(depositHash);

        // Wait for deposit
        let depositStatus = 'pending';
        for (let i = 0; i < APPROVAL_POLL_MAX_ATTEMPTS; i++) {
          await new Promise((r) => setTimeout(r, DEPLOY_POLL_INTERVAL_MS));
          depositStatus = await getDeployStatus(depositHash);
          if (depositStatus !== 'pending') break;
        }

        if (depositStatus === 'error') {
          setTxError('Deposit transaction failed');
          setTxStatus('error');
          return false;
        }
        if (depositStatus === 'pending') {
          setTxError(TX_TIMEOUT_MESSAGES.transaction);
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
    [isConnected, publicKey, userGusdBalance, signDeploy, refresh]
  );

  // Withdraw gUSD from Stability Pool
  const withdraw = useCallback(
    async (gusdAmount: string): Promise<boolean> => {
      if (!isConnected || !publicKey) {
        setTxError('Wallet not connected');
        return false;
      }

      if (poolStats?.isSafeModeActive) {
        setTxError('Withdrawals are currently paused (Safe Mode active)');
        return false;
      }

      const amount = parseCsprInput(gusdAmount);
      if (amount === null || amount <= BigInt(0)) {
        setTxError('Invalid gUSD amount');
        return false;
      }

      // Convert to 1e18 scale
      const gusdMotes = amount * BigInt('1000000000');

      if (userDeposit && gusdMotes > userDeposit.depositedAmount) {
        setTxError('Insufficient deposit balance');
        return false;
      }

      const spHash = CONTRACTS.stabilityPool;
      if (!spHash || spHash === 'null') {
        setTxError('Stability Pool not deployed');
        return false;
      }

      setTxStatus('signing');
      setTxError(null);
      setTxHash(null);

      try {
        const withdrawArgs: DeployArg[] = [
          { name: 'amount', clType: 'U256', value: gusdMotes.toString() },
        ];

        const withdrawDeploy = buildContractCallDeploy(publicKey, {
          contractHash: spHash,
          entryPoint: 'withdraw',
          args: withdrawArgs,
        });

        const signedWithdraw = await signDeploy(withdrawDeploy);
        if (!signedWithdraw) {
          setTxError('Withdrawal cancelled');
          setTxStatus('error');
          return false;
        }

        setTxStatus('pending');
        const withdrawHash = await submitDeploy(signedWithdraw);
        setTxHash(withdrawHash);

        // Wait for withdraw
        let withdrawStatus = 'pending';
        for (let i = 0; i < APPROVAL_POLL_MAX_ATTEMPTS; i++) {
          await new Promise((r) => setTimeout(r, DEPLOY_POLL_INTERVAL_MS));
          withdrawStatus = await getDeployStatus(withdrawHash);
          if (withdrawStatus !== 'pending') break;
        }

        if (withdrawStatus === 'error') {
          setTxError('Withdrawal transaction failed');
          setTxStatus('error');
          return false;
        }
        if (withdrawStatus === 'pending') {
          setTxError(TX_TIMEOUT_MESSAGES.transaction);
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
    [isConnected, publicKey, userDeposit, poolStats, signDeploy, refresh]
  );

  // Claim accumulated gains (CSPR + stCSPR)
  const claimGains = useCallback(async (): Promise<boolean> => {
    if (!isConnected || !publicKey) {
      setTxError('Wallet not connected');
      return false;
    }

    if (poolStats?.isSafeModeActive) {
      setTxError('Claims are currently paused (Safe Mode active)');
      return false;
    }

    if (!userDeposit || (userDeposit.pendingCsprGains === BigInt(0) && userDeposit.pendingScsprGains === BigInt(0))) {
      setTxError('No gains to claim');
      return false;
    }

    const spHash = CONTRACTS.stabilityPool;
    if (!spHash || spHash === 'null') {
      setTxError('Stability Pool not deployed');
      return false;
    }

    setTxStatus('signing');
    setTxError(null);
    setTxHash(null);

    try {
      // Claim gains (CSPR + stCSPR) in a single call.
      const claimArgs: DeployArg[] = [];
      const claimDeploy = buildContractCallDeploy(publicKey, {
        contractHash: spHash,
        entryPoint: 'claim_gains',
        args: claimArgs,
      });

      const signedClaim = await signDeploy(claimDeploy);
      if (!signedClaim) {
        setTxError('Claim cancelled');
        setTxStatus('error');
        return false;
      }

      setTxStatus('pending');
      const claimHash = await submitDeploy(signedClaim);
      setTxHash(claimHash);

      // Wait for claim
      let claimStatus = 'pending';
      for (let i = 0; i < APPROVAL_POLL_MAX_ATTEMPTS; i++) {
        await new Promise((r) => setTimeout(r, DEPLOY_POLL_INTERVAL_MS));
        claimStatus = await getDeployStatus(claimHash);
        if (claimStatus !== 'pending') break;
      }

      if (claimStatus === 'error') {
        setTxError('Claim transaction failed');
        setTxStatus('error');
        return false;
      }
      if (claimStatus === 'pending') {
        setTxError(TX_TIMEOUT_MESSAGES.transaction);
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
  }, [isConnected, publicKey, userDeposit, poolStats, signDeploy, refresh]);

  return {
    // State
    isDeployed,
    userDeposit,
    userGusdBalance,
    userGusdBalanceFormatted,
    poolStats,
    isLoading,
    isRefreshing,
    txStatus,
    txError,
    txHash,

    // Actions
    refresh,
    deposit,
    withdraw,
    claimGains,
    resetTxState,
  };
}
