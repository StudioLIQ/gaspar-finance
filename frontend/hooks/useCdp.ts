'use client';

import { useCallback, useEffect, useState } from 'react';
import { useCasperWallet } from './useCasperWallet';
import {
  getUserVaults,
  getBranchStatus,
  getCollateralPrice,
  getAccountCsprBalance,
  getLstBalance,
  getGusdBalance,
  formatCsprAmount,
  formatGusdAmount,
  calculateMaxBorrow,
  calculateRequiredCollateral,
  calculateLiquidationPrice,
  calculateIcr,
  calculateCollateralValue,
  parseCsprInput,
  CDP_CONSTANTS,
  type VaultInfo,
  type BranchStatus,
  type CollateralType,
} from '@/lib/casperRpc';
import { CONTRACTS } from '@/lib/config';
import {
  buildContractCallDeploy,
  buildProxyCallerDeploy,
  loadProxyCallerWasm,
  submitDeploy,
  getDeployStatus,
  type DeployArg,
} from '@/lib/casperDeploy';
import {
  DATA_REFRESH_INTERVAL_MS,
  DEPLOY_POLL_INTERVAL_MS,
  DEPLOY_POLL_MAX_ATTEMPTS,
  APPROVAL_POLL_MAX_ATTEMPTS,
  TX_TIMEOUT_MESSAGES,
} from '@/lib/constants';

// Transaction status
export type TxStatus = 'idle' | 'signing' | 'approving' | 'pending' | 'success' | 'error';

// User balances
export interface UserBalances {
  cspr: bigint;
  scspr: bigint;
  gusd: bigint;
}

// CDP State
export interface CdpState {
  // Vaults
  csprVaults: VaultInfo[];
  scsprVaults: VaultInfo[];

  // Branch stats
  csprBranch: BranchStatus | null;
  scsprBranch: BranchStatus | null;

  // Prices
  csprPrice: bigint;
  scsprPrice: bigint;

  // User balances
  balances: UserBalances;

  // Loading
  isLoading: boolean;
  isRefreshing: boolean;

  // Transaction
  txStatus: TxStatus;
  txError: string | null;
  txHash: string | null;
}

export interface CdpActions {
  refresh: () => Promise<void>;

  // Open vault (deposit collateral + borrow gUSD)
  openVault: (
    collateralType: CollateralType,
    collateralAmount: string,
    borrowAmount: string,
    interestRateBps: number
  ) => Promise<boolean>;

  // Adjust vault
  adjustVault: (
    collateralType: CollateralType,
    vaultId: bigint,
    collateralDelta: string,
    isCollateralWithdraw: boolean,
    debtDelta: string,
    isDebtRepay: boolean
  ) => Promise<boolean>;

  // Adjust vault interest rate
  adjustInterestRate: (
    collateralType: CollateralType,
    vaultId: bigint,
    interestRateBps: number
  ) => Promise<boolean>;

  // Close vault
  closeVault: (collateralType: CollateralType, vaultId: bigint) => Promise<boolean>;

  // Helpers
  previewOpenVault: (
    collateralType: CollateralType,
    collateralAmount: string,
    borrowAmount: string
  ) => {
    collateralValue: bigint;
    icrBps: number;
    liquidationPrice: bigint;
    borrowingFee: bigint;
    isValid: boolean;
    error: string | null;
  } | null;

  resetTxState: () => void;
}

export function useCdp(): CdpState & CdpActions {
  const { isConnected, publicKey, signDeploy } = useCasperWallet();

  // State
  const [csprVaults, setCsprVaults] = useState<VaultInfo[]>([]);
  const [scsprVaults, setScsprVaults] = useState<VaultInfo[]>([]);
  const [csprBranch, setCsprBranch] = useState<BranchStatus | null>(null);
  const [scsprBranch, setScsprBranch] = useState<BranchStatus | null>(null);
  const [csprPrice, setCsprPrice] = useState<bigint>(BigInt('20000000000000000'));
  const [scsprPrice, setScsprPrice] = useState<bigint>(BigInt('20000000000000000'));
  const [balances, setBalances] = useState<UserBalances>({
    cspr: BigInt(0),
    scspr: BigInt(0),
    gusd: BigInt(0),
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [txStatus, setTxStatus] = useState<TxStatus>('idle');
  const [txError, setTxError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  // Refresh all data
  const refresh = useCallback(async () => {
    setIsRefreshing(true);

    try {
      // Fetch prices and branch stats
      const [csprPriceData, scsprPriceData, csprBranchData, scsprBranchData] = await Promise.all([
        getCollateralPrice('cspr'),
        getCollateralPrice('scspr'),
        getBranchStatus('cspr'),
        getBranchStatus('scspr'),
      ]);

      setCsprPrice(csprPriceData);
      setScsprPrice(scsprPriceData);
      setCsprBranch(csprBranchData);
      setScsprBranch(scsprBranchData);

      // Fetch user-specific data
      if (isConnected && publicKey) {
        console.log('[CDP] refresh - Fetching user data for:', publicKey);
        const [csprVaultsData, scsprVaultsData, csprBalance, lstBalance, gusdBalance] =
          await Promise.all([
            getUserVaults(publicKey, 'cspr'),
            getUserVaults(publicKey, 'scspr'),
            getAccountCsprBalance(publicKey),
            getLstBalance(publicKey),
            getGusdBalance(publicKey),
          ]);

        console.log('[CDP] refresh - User vault data:', {
          csprVaultCount: csprVaultsData.length,
          scsprVaultCount: scsprVaultsData.length,
          csprBranchVaultCount: csprBranchData?.vaultCount,
        });

        setCsprVaults(csprVaultsData);
        setScsprVaults(scsprVaultsData);
        setBalances({
          cspr: csprBalance,
          scspr: lstBalance?.scsprBalance ?? BigInt(0),
          gusd: gusdBalance,
        });
      } else {
        setCsprVaults([]);
        setScsprVaults([]);
        setBalances({ cspr: BigInt(0), scspr: BigInt(0), gusd: BigInt(0) });
      }
    } catch (error) {
      console.error('Failed to refresh CDP data:', error);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [isConnected, publicKey]);

  // Initial load and periodic refresh
  useEffect(() => {
    void refresh();
    const intervalId = setInterval(() => void refresh(), DATA_REFRESH_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [refresh]);

  // Reset transaction state
  const resetTxState = useCallback(() => {
    setTxStatus('idle');
    setTxError(null);
    setTxHash(null);
  }, []);

  // Preview open vault
  const previewOpenVault = useCallback(
    (
      collateralType: CollateralType,
      collateralAmount: string,
      borrowAmount: string
    ) => {
      const collateralMotes = parseCsprInput(collateralAmount);
      const borrowMotes = parseCsprInput(borrowAmount);

      if (!collateralMotes || collateralMotes <= BigInt(0)) return null;
      if (!borrowMotes || borrowMotes <= BigInt(0)) return null;

      const price = collateralType === 'cspr' ? csprPrice : scsprPrice;

      // Scale borrow amount to 18 decimals (gUSD)
      const debtAmount = borrowMotes * BigInt('1000000000'); // 9 -> 18 decimals

      const collateralValue = calculateCollateralValue(collateralMotes, price, collateralType);
      const icrBps = calculateIcr(collateralValue, debtAmount);
      const liquidationPrice = calculateLiquidationPrice(collateralMotes, debtAmount, collateralType);
      const borrowingFee = (debtAmount * BigInt(CDP_CONSTANTS.BORROWING_FEE_BPS)) / BigInt(10000);

      let isValid = true;
      let error: string | null = null;

      if (icrBps < CDP_CONSTANTS.MCR_BPS) {
        isValid = false;
        error = `CR must be at least ${CDP_CONSTANTS.MCR_BPS / 100}%`;
      }

      if (debtAmount < CDP_CONSTANTS.MIN_DEBT) {
        isValid = false;
        error = 'Minimum debt is 1 gUSD';
      }

      return {
        collateralValue,
        icrBps,
        liquidationPrice,
        borrowingFee,
        isValid,
        error,
      };
    },
    [csprPrice, scsprPrice]
  );

  // Open vault
  const openVault = useCallback(
    async (
      collateralType: CollateralType,
      collateralAmount: string,
      borrowAmount: string,
      interestRateBps: number
    ): Promise<boolean> => {
      if (!isConnected || !publicKey) {
        setTxError('Wallet not connected');
        return false;
      }

      const collateralMotes = parseCsprInput(collateralAmount);
      const borrowMotes = parseCsprInput(borrowAmount);

      if (!collateralMotes || collateralMotes <= BigInt(0)) {
        setTxError('Invalid collateral amount');
        return false;
      }

      if (!borrowMotes || borrowMotes <= BigInt(0)) {
        setTxError('Invalid borrow amount');
        return false;
      }

      // Validate
      const preview = previewOpenVault(collateralType, collateralAmount, borrowAmount);
      if (!preview || !preview.isValid) {
        setTxError(preview?.error || 'Invalid vault parameters');
        return false;
      }

      setTxStatus('signing');
      setTxError(null);
      setTxHash(null);

      try {
        const routerHash = CONTRACTS.router;
        const routerPackageHash = CONTRACTS.routerPackage;
        const branchCsprHash = CONTRACTS.branchCspr;

        // Debug logging for contract addresses
        console.log('[CDP] openVault - Contract addresses:', {
          routerHash,
          routerPackageHash,
          branchCsprHash,
          publicKey,
          collateralType,
          collateralMotes: collateralMotes.toString(),
          interestRateBps,
        });

        if (!routerHash || routerHash === 'null') {
          setTxError('Router contract not deployed');
          setTxStatus('error');
          return false;
        }

        // Scale debt to 18 decimals
        const debtAmount = borrowMotes * BigInt('1000000000');

        if (collateralType === 'cspr') {
          // For CSPR, need to use proxy_caller.wasm to attach value
          // Proxy caller requires package hash, not contract hash
          if (!routerPackageHash || routerPackageHash === 'null') {
            setTxError('Router package hash not configured');
            setTxStatus('error');
            return false;
          }

          let wasmBase64: string;
          try {
            wasmBase64 = await loadProxyCallerWasm();
          } catch {
            setTxError('Failed to load proxy_caller.wasm');
            setTxStatus('error');
            return false;
          }

          // Build open_vault deploy with attached CSPR
          const deployJson = buildProxyCallerDeploy(
            publicKey,
            {
              contractPackageHash: routerPackageHash,
              entryPoint: 'open_vault',
              args: [
                { name: 'collateral_id', clType: 'U8', value: '0' }, // CSPR = 0
                { name: 'collateral_amount', clType: 'U256', value: collateralMotes.toString() },
                { name: 'debt_amount', clType: 'U256', value: debtAmount.toString() },
                { name: 'interest_rate_bps', clType: 'U32', value: interestRateBps.toString() },
              ],
              attachedMotes: collateralMotes.toString(),
            },
            wasmBase64
          );

          const signedDeploy = await signDeploy(deployJson);
          if (!signedDeploy) {
            setTxError('Signing cancelled');
            setTxStatus('error');
            return false;
          }

          setTxStatus('pending');
          const deployHash = await submitDeploy(signedDeploy);
          setTxHash(deployHash);
          console.log('[CDP] openVault - Deploy submitted:', deployHash);

          // Poll for status
          for (let i = 0; i < DEPLOY_POLL_MAX_ATTEMPTS; i++) {
            await new Promise((r) => setTimeout(r, DEPLOY_POLL_INTERVAL_MS));
            const status = await getDeployStatus(deployHash);
            console.log(`[CDP] openVault - Poll ${i + 1}/${DEPLOY_POLL_MAX_ATTEMPTS}: ${status}`);
            if (status === 'success') {
              console.log('[CDP] openVault - Transaction succeeded, refreshing data...');
              setTxStatus('success');
              await refresh();
              console.log('[CDP] openVault - Refresh complete');
              return true;
            } else if (status === 'error') {
              console.error('[CDP] openVault - Transaction failed on-chain');
              setTxStatus('error');
              setTxError('Transaction failed on-chain. Check explorer for details.');
              return false;
            }
          }

          setTxStatus('error');
          setTxError(TX_TIMEOUT_MESSAGES.transaction);
          return false;
        } else {
          // For stCSPR, need to approve first then call open_vault
          const ybTokenHash = CONTRACTS.scsprYbtoken;
          if (!ybTokenHash || ybTokenHash === 'null') {
            setTxError('stCSPR token not deployed');
            setTxStatus('error');
            return false;
          }

          // Step 1: Approve
          const approveArgs: DeployArg[] = [
            { name: 'spender', clType: 'Key', value: `hash-${routerHash.replace(/^hash-/, '')}` },
            { name: 'amount', clType: 'U256', value: collateralMotes.toString() },
          ];

          const approveDeploy = buildContractCallDeploy(publicKey, {
            contractHash: ybTokenHash,
            entryPoint: 'approve',
            args: approveArgs,
          });

          const signedApprove = await signDeploy(approveDeploy);
          if (!signedApprove) {
            setTxError('Approve signing cancelled');
            setTxStatus('error');
            return false;
          }

          setTxStatus('approving');
          const approveHash = await submitDeploy(signedApprove);
          setTxHash(approveHash);

          // Wait for approve
          let approveStatus: 'pending' | 'success' | 'error' = 'pending';
          for (let i = 0; i < APPROVAL_POLL_MAX_ATTEMPTS; i++) {
            await new Promise((r) => setTimeout(r, DEPLOY_POLL_INTERVAL_MS));
            approveStatus = await getDeployStatus(approveHash);
            if (approveStatus === 'error') {
              setTxError('Approval transaction failed');
              setTxStatus('error');
              return false;
            }
            if (approveStatus !== 'pending') break;
          }

          if (approveStatus === 'pending') {
            setTxError(TX_TIMEOUT_MESSAGES.approval);
            setTxStatus('error');
            return false;
          }

          // Step 2: Open vault
          setTxStatus('signing');
          const openArgs: DeployArg[] = [
            { name: 'collateral_id', clType: 'U8', value: '1' }, // stCSPR = 1
            { name: 'collateral_amount', clType: 'U256', value: collateralMotes.toString() },
            { name: 'debt_amount', clType: 'U256', value: debtAmount.toString() },
            { name: 'interest_rate_bps', clType: 'U32', value: interestRateBps.toString() },
          ];

          const openDeploy = buildContractCallDeploy(publicKey, {
            contractHash: routerHash,
            entryPoint: 'open_vault',
            args: openArgs,
          });

          const signedOpen = await signDeploy(openDeploy);
          if (!signedOpen) {
            setTxError('Open vault signing cancelled');
            setTxStatus('error');
            return false;
          }

          setTxStatus('pending');
          const openHash = await submitDeploy(signedOpen);
          setTxHash(openHash);

          // Poll for status
          for (let i = 0; i < DEPLOY_POLL_MAX_ATTEMPTS; i++) {
            await new Promise((r) => setTimeout(r, DEPLOY_POLL_INTERVAL_MS));
            const status = await getDeployStatus(openHash);
            if (status === 'success') {
              setTxStatus('success');
              await refresh();
              return true;
            } else if (status === 'error') {
              setTxStatus('error');
              setTxError('Transaction failed on-chain');
              return false;
            }
          }

          setTxStatus('error');
          setTxError(TX_TIMEOUT_MESSAGES.transaction);
          return false;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Transaction failed';
        setTxError(message);
        setTxStatus('error');
        return false;
      }
    },
    [isConnected, publicKey, signDeploy, previewOpenVault, refresh]
  );

  // Adjust vault - supports adding/withdrawing collateral and borrowing/repaying debt
  // Requires approve for: gUSD repay, stCSPR collateral deposit
  const adjustVault = useCallback(
    async (
      collateralType: CollateralType,
      vaultId: bigint,
      collateralDelta: string,
      isCollateralWithdraw: boolean,
      debtDelta: string,
      isDebtRepay: boolean
    ): Promise<boolean> => {
      if (!isConnected || !publicKey) {
        setTxError('Wallet not connected');
        return false;
      }

      setTxStatus('signing');
      setTxError(null);
      setTxHash(null);

      try {
        const routerHash = CONTRACTS.router;
        if (!routerHash || routerHash === 'null') {
          setTxError('Router contract not deployed');
          setTxStatus('error');
          return false;
        }

        const collateralMotes = parseCsprInput(collateralDelta) || BigInt(0);
        const debtMotes = parseCsprInput(debtDelta) || BigInt(0);
        const debtAmount = debtMotes * BigInt('1000000000'); // Scale to 18 decimals

        // Step 1: Approve gUSD if repaying debt
        if (isDebtRepay && debtAmount > BigInt(0)) {
          const gusdHash = CONTRACTS.stablecoin;
          if (!gusdHash || gusdHash === 'null') {
            setTxError('gUSD contract not deployed');
            setTxStatus('error');
            return false;
          }

          const approveArgs: DeployArg[] = [
            { name: 'spender', clType: 'Key', value: `hash-${routerHash.replace(/^hash-/, '')}` },
            { name: 'amount', clType: 'U256', value: debtAmount.toString() },
          ];

          const approveDeploy = buildContractCallDeploy(publicKey, {
            contractHash: gusdHash,
            entryPoint: 'approve',
            args: approveArgs,
          });

          const signedApprove = await signDeploy(approveDeploy);
          if (!signedApprove) {
            setTxError('gUSD approval cancelled');
            setTxStatus('error');
            return false;
          }

          setTxStatus('approving');
          const approveHash = await submitDeploy(signedApprove);
          setTxHash(approveHash);

          // Wait for gUSD approve
          let approveStatus: 'pending' | 'success' | 'error' = 'pending';
          for (let i = 0; i < APPROVAL_POLL_MAX_ATTEMPTS; i++) {
            await new Promise((r) => setTimeout(r, DEPLOY_POLL_INTERVAL_MS));
            approveStatus = await getDeployStatus(approveHash);
            if (approveStatus === 'error') {
              setTxError('gUSD approval failed');
              setTxStatus('error');
              return false;
            }
            if (approveStatus !== 'pending') break;
          }

          if (approveStatus === 'pending') {
            setTxError(TX_TIMEOUT_MESSAGES.approval);
            setTxStatus('error');
            return false;
          }

          setTxStatus('signing');
        }

        // Step 2: Approve stCSPR if depositing collateral (not withdrawing)
        if (collateralType === 'scspr' && !isCollateralWithdraw && collateralMotes > BigInt(0)) {
          const ybTokenHash = CONTRACTS.scsprYbtoken;
          if (!ybTokenHash || ybTokenHash === 'null') {
            setTxError('stCSPR contract not deployed');
            setTxStatus('error');
            return false;
          }

          const approveArgs: DeployArg[] = [
            { name: 'spender', clType: 'Key', value: `hash-${routerHash.replace(/^hash-/, '')}` },
            { name: 'amount', clType: 'U256', value: collateralMotes.toString() },
          ];

          const approveDeploy = buildContractCallDeploy(publicKey, {
            contractHash: ybTokenHash,
            entryPoint: 'approve',
            args: approveArgs,
          });

          const signedApprove = await signDeploy(approveDeploy);
          if (!signedApprove) {
            setTxError('stCSPR approval cancelled');
            setTxStatus('error');
            return false;
          }

          setTxStatus('approving');
          const approveHash = await submitDeploy(signedApprove);
          setTxHash(approveHash);

          // Wait for stCSPR approve
          let approveStatus: 'pending' | 'success' | 'error' = 'pending';
          for (let i = 0; i < APPROVAL_POLL_MAX_ATTEMPTS; i++) {
            await new Promise((r) => setTimeout(r, DEPLOY_POLL_INTERVAL_MS));
            approveStatus = await getDeployStatus(approveHash);
            if (approveStatus === 'error') {
              setTxError('stCSPR approval failed');
              setTxStatus('error');
              return false;
            }
            if (approveStatus !== 'pending') break;
          }

          if (approveStatus === 'pending') {
            setTxError(TX_TIMEOUT_MESSAGES.approval);
            setTxStatus('error');
            return false;
          }

          setTxStatus('signing');
        }

        // Step 3: Call adjust_vault
        const args: DeployArg[] = [
          { name: 'collateral_id', clType: 'U8', value: collateralType === 'cspr' ? '0' : '1' },
          { name: 'vault_id', clType: 'U64', value: vaultId.toString() },
          { name: 'collateral_delta', clType: 'U256', value: collateralMotes.toString() },
          { name: 'collateral_is_withdraw', clType: 'Bool', value: isCollateralWithdraw.toString() },
          { name: 'debt_delta', clType: 'U256', value: debtAmount.toString() },
          { name: 'debt_is_repay', clType: 'Bool', value: isDebtRepay.toString() },
        ];

        const deployJson = buildContractCallDeploy(publicKey, {
          contractHash: routerHash,
          entryPoint: 'adjust_vault',
          args,
        });

        const signedDeploy = await signDeploy(deployJson);
        if (!signedDeploy) {
          setTxError('Signing cancelled');
          setTxStatus('error');
          return false;
        }

        setTxStatus('pending');
        const deployHash = await submitDeploy(signedDeploy);
        setTxHash(deployHash);

        // Poll for status
        for (let i = 0; i < DEPLOY_POLL_MAX_ATTEMPTS; i++) {
          await new Promise((r) => setTimeout(r, DEPLOY_POLL_INTERVAL_MS));
          const status = await getDeployStatus(deployHash);
          if (status === 'success') {
            setTxStatus('success');
            await refresh();
            return true;
          } else if (status === 'error') {
            setTxStatus('error');
            setTxError('Transaction failed on-chain');
            return false;
          }
        }

        setTxStatus('error');
        setTxError(TX_TIMEOUT_MESSAGES.transaction);
        return false;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Transaction failed';
        setTxError(message);
        setTxStatus('error');
        return false;
      }
    },
    [isConnected, publicKey, signDeploy, refresh]
  );

  // Adjust vault interest rate
  const adjustInterestRate = useCallback(
    async (collateralType: CollateralType, vaultId: bigint, interestRateBps: number): Promise<boolean> => {
      if (!isConnected || !publicKey) {
        setTxError('Wallet not connected');
        return false;
      }

      setTxStatus('signing');
      setTxError(null);
      setTxHash(null);

      try {
        const routerHash = CONTRACTS.router;
        if (!routerHash || routerHash === 'null') {
          setTxError('Router contract not deployed');
          setTxStatus('error');
          return false;
        }

        if (
          Number.isNaN(interestRateBps) ||
          interestRateBps < CDP_CONSTANTS.MIN_INTEREST_RATE_BPS ||
          interestRateBps > CDP_CONSTANTS.MAX_INTEREST_RATE_BPS
        ) {
          setTxError(
            `Interest rate must be between ${CDP_CONSTANTS.MIN_INTEREST_RATE_BPS / 100}% and ${
              CDP_CONSTANTS.MAX_INTEREST_RATE_BPS / 100
            }%`
          );
          setTxStatus('error');
          return false;
        }

        const args: DeployArg[] = [
          { name: 'collateral_id', clType: 'U8', value: collateralType === 'cspr' ? '0' : '1' },
          { name: 'vault_id', clType: 'U64', value: vaultId.toString() },
          { name: 'interest_rate_bps', clType: 'U32', value: interestRateBps.toString() },
        ];

        const deployJson = buildContractCallDeploy(publicKey, {
          contractHash: routerHash,
          entryPoint: 'adjust_interest_rate',
          args,
        });

        const signedDeploy = await signDeploy(deployJson);
        if (!signedDeploy) {
          setTxError('Signing cancelled');
          setTxStatus('error');
          return false;
        }

        setTxStatus('pending');
        const deployHash = await submitDeploy(signedDeploy);
        setTxHash(deployHash);

        // Poll for status
        for (let i = 0; i < DEPLOY_POLL_MAX_ATTEMPTS; i++) {
          await new Promise((r) => setTimeout(r, DEPLOY_POLL_INTERVAL_MS));
          const status = await getDeployStatus(deployHash);
          if (status === 'success') {
            setTxStatus('success');
            await refresh();
            return true;
          } else if (status === 'error') {
            setTxStatus('error');
            setTxError('Transaction failed on-chain');
            return false;
          }
        }

        setTxStatus('error');
        setTxError(TX_TIMEOUT_MESSAGES.transaction);
        return false;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Transaction failed';
        setTxError(message);
        setTxStatus('error');
        return false;
      }
    },
    [isConnected, publicKey, signDeploy, refresh]
  );

  // Close vault - requires gUSD approval to repay debt
  const closeVault = useCallback(
    async (collateralType: CollateralType, vaultId: bigint): Promise<boolean> => {
      if (!isConnected || !publicKey) {
        setTxError('Wallet not connected');
        return false;
      }

      // Get the vault to know how much debt to approve
      const vault =
        collateralType === 'cspr'
          ? csprVaults.find((v) => v.vaultId === vaultId)
          : scsprVaults.find((v) => v.vaultId === vaultId);
      if (!vault) {
        setTxError('No vault found');
        return false;
      }

      setTxStatus('signing');
      setTxError(null);
      setTxHash(null);

      try {
        const routerHash = CONTRACTS.router;
        if (!routerHash || routerHash === 'null') {
          setTxError('Router contract not deployed');
          setTxStatus('error');
          return false;
        }

        // Step 1: Approve gUSD for debt repayment
        const debtAmount = vault.vault.debt;
        if (debtAmount > BigInt(0)) {
          const gusdHash = CONTRACTS.stablecoin;
          if (!gusdHash || gusdHash === 'null') {
            setTxError('gUSD contract not deployed');
            setTxStatus('error');
            return false;
          }

          const approveArgs: DeployArg[] = [
            { name: 'spender', clType: 'Key', value: `hash-${routerHash.replace(/^hash-/, '')}` },
            { name: 'amount', clType: 'U256', value: debtAmount.toString() },
          ];

          const approveDeploy = buildContractCallDeploy(publicKey, {
            contractHash: gusdHash,
            entryPoint: 'approve',
            args: approveArgs,
          });

          const signedApprove = await signDeploy(approveDeploy);
          if (!signedApprove) {
            setTxError('gUSD approval cancelled');
            setTxStatus('error');
            return false;
          }

          setTxStatus('approving');
          const approveHash = await submitDeploy(signedApprove);
          setTxHash(approveHash);

          // Wait for gUSD approve
          let approveStatus: 'pending' | 'success' | 'error' = 'pending';
          for (let i = 0; i < APPROVAL_POLL_MAX_ATTEMPTS; i++) {
            await new Promise((r) => setTimeout(r, DEPLOY_POLL_INTERVAL_MS));
            approveStatus = await getDeployStatus(approveHash);
            if (approveStatus === 'error') {
              setTxError('gUSD approval failed');
              setTxStatus('error');
              return false;
            }
            if (approveStatus !== 'pending') break;
          }

          if (approveStatus === 'pending') {
            setTxError(TX_TIMEOUT_MESSAGES.approval);
            setTxStatus('error');
            return false;
          }

          setTxStatus('signing');
        }

        // Step 2: Close vault
        const args: DeployArg[] = [
          { name: 'collateral_id', clType: 'U8', value: collateralType === 'cspr' ? '0' : '1' },
          { name: 'vault_id', clType: 'U64', value: vaultId.toString() },
        ];

        const deployJson = buildContractCallDeploy(publicKey, {
          contractHash: routerHash,
          entryPoint: 'close_vault',
          args,
        });

        const signedDeploy = await signDeploy(deployJson);
        if (!signedDeploy) {
          setTxError('Signing cancelled');
          setTxStatus('error');
          return false;
        }

        setTxStatus('pending');
        const deployHash = await submitDeploy(signedDeploy);
        setTxHash(deployHash);

        // Poll for status
        for (let i = 0; i < DEPLOY_POLL_MAX_ATTEMPTS; i++) {
          await new Promise((r) => setTimeout(r, DEPLOY_POLL_INTERVAL_MS));
          const status = await getDeployStatus(deployHash);
          if (status === 'success') {
            setTxStatus('success');
            await refresh();
            return true;
          } else if (status === 'error') {
            setTxStatus('error');
            setTxError('Transaction failed on-chain');
            return false;
          }
        }

        setTxStatus('error');
        setTxError(TX_TIMEOUT_MESSAGES.transaction);
        return false;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Transaction failed';
        setTxError(message);
        setTxStatus('error');
        return false;
      }
    },
    [isConnected, publicKey, csprVaults, scsprVaults, signDeploy, refresh]
  );

  return {
    // State
    csprVaults,
    scsprVaults,
    csprBranch,
    scsprBranch,
    csprPrice,
    scsprPrice,
    balances,
    isLoading,
    isRefreshing,
    txStatus,
    txError,
    txHash,

    // Actions
    refresh,
    openVault,
    adjustVault,
    adjustInterestRate,
    closeVault,
    previewOpenVault,
    resetTxState,
  };
}

// Re-exports
export { formatCsprAmount, formatGusdAmount, CDP_CONSTANTS };
export type { VaultInfo, BranchStatus, CollateralType };
