'use client';

import { useCallback, useEffect, useState } from 'react';
import { useCasperWallet } from './useCasperWallet';
import { CONTRACTS, PROTOCOL_PARAMS } from '@/lib/config';
import {
  buildContractCallDeploy,
  submitDeploy,
  getDeployStatus,
  type DeployArg,
} from '@/lib/casperDeploy';
import {
  formatCsprAmount,
  parseCsprInput,
  getRedemptionStats,
  getGusdBalance,
  formatGusdAmount,
} from '@/lib/casperRpc';

// Refresh interval for polling data
const REFRESH_INTERVAL_MS = 30_000; // 30 seconds

// Transaction status
export type TxStatus = 'idle' | 'signing' | 'pending' | 'success' | 'error';

// Collateral type for redemption
export type CollateralType = 'CSPR' | 'stCSPR';

// Redemption quote result
export interface RedemptionQuote {
  // gUSD amount to redeem
  gusdAmount: bigint;
  gusdFormatted: string;
  // Collateral to receive (after fee)
  collateralAmount: bigint;
  collateralFormatted: string;
  // Fee amount
  feeAmount: bigint;
  feeFormatted: string;
  // Fee in basis points
  feeBps: number;
  // Exchange rate used
  exchangeRate: bigint;
}

// Redemption stats
export interface RedemptionStats {
  // Current base fee in basis points
  baseFeeBps: number;
  // Total gUSD redeemed (all time)
  totalRedeemed: bigint;
  totalRedeemedFormatted: string;
  // Total collateral distributed (all time)
  totalCollateralDistributed: bigint;
  // Whether safe mode is active (redemptions blocked)
  isSafeModeActive: boolean;
}

export interface RedemptionState {
  // Contract deployment status
  isDeployed: boolean;

  // User gUSD balance
  userGusdBalance: bigint | null;
  userGusdBalanceFormatted: string | null;

  // Redemption stats
  stats: RedemptionStats | null;

  // Current quote (updated on input change)
  currentQuote: RedemptionQuote | null;

  // Loading states
  isLoading: boolean;
  isRefreshing: boolean;

  // Transaction state
  txStatus: TxStatus;
  txError: string | null;
  txHash: string | null;
}

export interface RedemptionActions {
  // Refresh data
  refresh: () => Promise<void>;

  // Get redemption quote
  getQuote: (gusdAmount: string, collateralType: CollateralType) => RedemptionQuote | null;

  // Execute redemption
  redeem: (gusdAmount: string, collateralType: CollateralType, maxFeeBps: number) => Promise<boolean>;

  // Reset tx state
  resetTxState: () => void;
}

// Check if redemption engine is deployed
function isRedemptionEngineDeployed(): boolean {
  return CONTRACTS.redemptionEngine !== null && CONTRACTS.redemptionEngine !== 'null';
}

export function useRedemption(): RedemptionState & RedemptionActions {
  const { isConnected, publicKey, signDeploy } = useCasperWallet();

  // State
  const [isDeployed] = useState(isRedemptionEngineDeployed());
  const [userGusdBalance, setUserGusdBalance] = useState<bigint | null>(null);
  const [stats, setStats] = useState<RedemptionStats | null>(null);
  const [currentQuote, setCurrentQuote] = useState<RedemptionQuote | null>(null);
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
      // Fetch redemption stats from chain
      const chainStats = await getRedemptionStats();
      if (chainStats) {
        const statsData: RedemptionStats = {
          baseFeeBps: chainStats.baseFee,
          totalRedeemed: chainStats.totalRedeemed,
          totalRedeemedFormatted: chainStats.totalRedeemedFormatted,
          totalCollateralDistributed: chainStats.totalCollateralDistributed,
          isSafeModeActive: chainStats.isSafeModeActive,
        };
        setStats(statsData);
      } else {
        // Fallback to defaults if query fails
        setStats({
          baseFeeBps: PROTOCOL_PARAMS.REDEMPTION_BASE_FEE_BPS,
          totalRedeemed: BigInt(0),
          totalRedeemedFormatted: '0',
          totalCollateralDistributed: BigInt(0),
          isSafeModeActive: false,
        });
      }

      // Fetch user gUSD balance if connected
      if (isConnected && publicKey) {
        const gusdBal = await getGusdBalance(publicKey);
        setUserGusdBalance(gusdBal);
      } else {
        setUserGusdBalance(null);
      }
    } catch (error) {
      console.error('Failed to refresh Redemption data:', error);
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

  // Get redemption quote
  const getQuote = useCallback(
    (gusdAmount: string, collateralType: CollateralType): RedemptionQuote | null => {
      const amount = parseCsprInput(gusdAmount);
      if (amount === null || amount <= BigInt(0)) return null;

      // Convert to 1e18 scale for gUSD
      const gusdMotes = amount * BigInt('1000000000'); // 1e9 * 1e9 = 1e18

      // Get current fee
      const feeBps = stats?.baseFeeBps ?? PROTOCOL_PARAMS.REDEMPTION_BASE_FEE_BPS;

      // Placeholder: Assume 1:1 exchange rate for simplicity
      // In production, query oracle for actual price
      const exchangeRate = BigInt('1000000000000000000'); // 1e18 = $1.00

      // Calculate collateral before fee
      // collateral = gusd * 1e18 / price
      // For CSPR (9 decimals), we need to convert from 1e18 gUSD to 1e9 CSPR
      const scale = BigInt('1000000000'); // 1e9
      const collateralBeforeFee = (gusdMotes * scale) / exchangeRate;

      // Calculate fee
      const feeAmount = (collateralBeforeFee * BigInt(feeBps)) / BigInt(10000);
      const collateralAfterFee = collateralBeforeFee - feeAmount;

      return {
        gusdAmount: gusdMotes,
        gusdFormatted: formatGusdAmount(gusdMotes),
        collateralAmount: collateralAfterFee,
        collateralFormatted: formatCsprAmount(collateralAfterFee),
        feeAmount,
        feeFormatted: formatCsprAmount(feeAmount),
        feeBps,
        exchangeRate,
      };
    },
    [stats]
  );

  // Execute redemption
  const redeem = useCallback(
    async (
      gusdAmount: string,
      collateralType: CollateralType,
      maxFeeBps: number
    ): Promise<boolean> => {
      if (!isConnected || !publicKey) {
        setTxError('Wallet not connected');
        return false;
      }

      const quote = getQuote(gusdAmount, collateralType);
      if (!quote) {
        setTxError('Invalid redemption amount');
        return false;
      }

      if (stats?.isSafeModeActive) {
        setTxError('Redemptions are currently paused (Safe Mode active)');
        return false;
      }

      if (userGusdBalance !== null && quote.gusdAmount > userGusdBalance) {
        setTxError('Insufficient gUSD balance');
        return false;
      }

      const redemptionHash = CONTRACTS.redemptionEngine;
      const gusdHash = CONTRACTS.stablecoin;
      if (!redemptionHash || redemptionHash === 'null' || !gusdHash || gusdHash === 'null') {
        setTxError('Contracts not deployed');
        return false;
      }

      setTxStatus('signing');
      setTxError(null);
      setTxHash(null);

      try {
        // Step 1: Approve gUSD spend by Redemption Engine
        const approveArgs: DeployArg[] = [
          { name: 'spender', clType: 'Key', value: `hash-${redemptionHash.replace(/^hash-/, '')}` },
          { name: 'amount', clType: 'U256', value: quote.gusdAmount.toString() },
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

        setTxStatus('pending');
        const approveDeployHash = await submitDeploy(signedApprove);
        setTxHash(approveDeployHash);

        // Wait for approve
        let approveStatus = 'pending';
        for (let i = 0; i < 24; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          approveStatus = await getDeployStatus(approveDeployHash);
          if (approveStatus !== 'pending') break;
        }

        if (approveStatus === 'error') {
          setTxError('Approval transaction failed');
          setTxStatus('error');
          return false;
        }

        // Step 2: Call redeem_u8 on Redemption Engine
        setTxStatus('signing');
        const collateralId = collateralType === 'CSPR' ? 0 : 1;

        const redeemArgs: DeployArg[] = [
          { name: 'collateral_id', clType: 'U8', value: collateralId.toString() },
          { name: 'csprusd_amount', clType: 'U256', value: quote.gusdAmount.toString() },
          { name: 'max_fee_bps', clType: 'U32', value: maxFeeBps.toString() },
          { name: 'max_iterations', clType: 'U32', value: '10' },
        ];

        const redeemDeploy = buildContractCallDeploy(publicKey, {
          contractHash: redemptionHash,
          entryPoint: 'redeem_u8',
          args: redeemArgs,
        });

        const signedRedeem = await signDeploy(redeemDeploy);
        if (!signedRedeem) {
          setTxError('Redemption cancelled');
          setTxStatus('error');
          return false;
        }

        setTxStatus('pending');
        const redeemDeployHash = await submitDeploy(signedRedeem);
        setTxHash(redeemDeployHash);

        // Wait for redemption
        let redeemStatus = 'pending';
        for (let i = 0; i < 24; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          redeemStatus = await getDeployStatus(redeemDeployHash);
          if (redeemStatus !== 'pending') break;
        }

        if (redeemStatus === 'error') {
          setTxError('Redemption transaction failed');
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
    [isConnected, publicKey, userGusdBalance, stats, getQuote, signDeploy, refresh]
  );

  return {
    // State
    isDeployed,
    userGusdBalance,
    userGusdBalanceFormatted,
    stats,
    currentQuote,
    isLoading,
    isRefreshing,
    txStatus,
    txError,
    txHash,

    // Actions
    refresh,
    getQuote,
    redeem,
    resetTxState,
  };
}

