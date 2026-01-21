'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useCasperWallet } from '@/hooks/useCasperWallet';
import {
  formatCsprAmount,
  formatGusdAmount,
  CDP_CONSTANTS,
  type VaultInfo,
  type CollateralType,
  type TxStatus,
  type UserBalances,
} from '@/hooks/useCdp';
import {
  calculateCollateralValue,
  calculateIcr,
  calculateLiquidationPrice,
  calculateMaxBorrow,
  calculateRequiredCollateral,
  parseCsprInput,
} from '@/lib/casperRpc';
import { GAS_BUFFER_MOTES } from '@/lib/constants';

function formatAmountNoGroup(amount: bigint, decimals: number, displayDecimals: number = 9): string {
  const divisor = BigInt(10) ** BigInt(decimals);
  const wholePart = amount / divisor;
  const fractionalPart = amount % divisor;

  if (displayDecimals === 0) return wholePart.toString();

  const fractionalStr = fractionalPart.toString().padStart(decimals, '0');
  const truncated = fractionalStr.slice(0, displayDecimals);
  const trimmed = truncated.replace(/0+$/, '');
  if (!trimmed) return wholePart.toString();
  return `${wholePart.toString()}.${trimmed}`;
}

function formatGusdInput(amount18: bigint): string {
  // Input parsing supports up to 9 decimals; store as 9-decimal units (then scaled to 18 on submit).
  const amount9 = amount18 / BigInt(1_000_000_000);
  return formatAmountNoGroup(amount9, 9, 9);
}

interface CdpAdjustVaultCardProps {
  vault: VaultInfo;
  collateralType: CollateralType;
  collateralPrice: bigint;
  balances: UserBalances;
  txStatus: TxStatus;
  txError: string | null;
  onAdjustVault: (
    collateralType: CollateralType,
    vaultId: bigint,
    collateralDelta: string,
    isCollateralWithdraw: boolean,
    debtDelta: string,
    isDebtRepay: boolean
  ) => Promise<boolean>;
  onAdjustInterestRate: (
    collateralType: CollateralType,
    vaultId: bigint,
    interestRateBps: number
  ) => Promise<boolean>;
  onDone: () => void;
  resetTxState: () => void;
}

export function CdpAdjustVaultCard({
  vault,
  collateralType,
  collateralPrice,
  balances,
  txStatus,
  txError,
  onAdjustVault,
  onAdjustInterestRate,
  onDone,
  resetTxState,
}: CdpAdjustVaultCardProps) {
  const { isConnected } = useCasperWallet();
  const collateralLabel = collateralType === 'cspr' ? 'CSPR' : 'stCSPR';
  const collateralBalance = collateralType === 'cspr' ? balances.cspr : balances.scspr;
  const isProcessing = txStatus === 'signing' || txStatus === 'approving' || txStatus === 'pending';

  const [collateralDelta, setCollateralDelta] = useState('');
  const [collateralMode, setCollateralMode] = useState<'add' | 'withdraw'>('add');
  const [debtDelta, setDebtDelta] = useState('');
  const [debtMode, setDebtMode] = useState<'borrow' | 'repay'>('borrow');
  const [interestRate, setInterestRate] = useState<string>((vault.vault.interestRateBps / 100).toFixed(1));

  useEffect(() => {
    setInterestRate((vault.vault.interestRateBps / 100).toFixed(1));
  }, [vault.vault.interestRateBps]);

  const preview = useMemo(() => {
    const collateralDeltaMotes = parseCsprInput(collateralDelta) ?? BigInt(0);
    const debtDelta9 = parseCsprInput(debtDelta) ?? BigInt(0);
    const debtDelta18 = debtDelta9 * BigInt(1_000_000_000);

    if (collateralMode === 'withdraw' && collateralDeltaMotes > vault.vault.collateral) {
      return { isValid: false, error: 'Withdraw exceeds vault collateral' as string | null };
    }
    if (debtMode === 'repay' && debtDelta18 > vault.vault.debt) {
      return { isValid: false, error: 'Repay exceeds vault debt' as string | null };
    }

    const nextCollateral =
      collateralMode === 'withdraw'
        ? vault.vault.collateral - collateralDeltaMotes
        : vault.vault.collateral + collateralDeltaMotes;
    const nextDebt =
      debtMode === 'repay'
        ? vault.vault.debt - debtDelta18
        : vault.vault.debt + debtDelta18;

    if (nextDebt !== BigInt(0) && nextDebt < CDP_CONSTANTS.MIN_DEBT) {
      return { isValid: false, error: `Debt must be >= ${formatGusdAmount(CDP_CONSTANTS.MIN_DEBT)} gUSD` };
    }

    const collateralValueUsd = calculateCollateralValue(nextCollateral, collateralPrice, collateralType);
    const icrBps = calculateIcr(collateralValueUsd, nextDebt);

    if (nextDebt !== BigInt(0) && icrBps < CDP_CONSTANTS.MCR_BPS) {
      return { isValid: false, error: `CR must be >= ${CDP_CONSTANTS.MCR_BPS / 100}%` };
    }

    const liquidationPrice = calculateLiquidationPrice(nextCollateral, nextDebt, collateralType);

    const isNoop = collateralDeltaMotes === BigInt(0) && debtDelta18 === BigInt(0);

    return {
      isValid: !isNoop,
      error: isNoop ? 'Enter a collateral or debt change' : null,
      nextCollateral,
      nextDebt,
      icrBps,
      liquidationPrice,
    };
  }, [
    collateralDelta,
    collateralMode,
    debtDelta,
    debtMode,
    vault.vault.collateral,
    vault.vault.debt,
    collateralPrice,
    collateralType,
  ]);

  const handleMaxCollateral = () => {
    if (collateralMode === 'add') {
      const gasBuffer = collateralType === 'cspr' ? GAS_BUFFER_MOTES : BigInt(0);
      const maxDelta = collateralBalance > gasBuffer ? collateralBalance - gasBuffer : BigInt(0);
      setCollateralDelta(formatAmountNoGroup(maxDelta, 9, 9));
      return;
    }

    // Max withdraw while staying at MCR (keeping debt unchanged)
    const required = calculateRequiredCollateral(vault.vault.debt, collateralPrice, collateralType, CDP_CONSTANTS.MCR_BPS);
    const maxWithdraw =
      vault.vault.collateral > required ? vault.vault.collateral - required : BigInt(0);
    setCollateralDelta(formatAmountNoGroup(maxWithdraw, 9, 9));
  };

  const handleMaxDebt = () => {
    if (debtMode === 'repay') {
      const maxRepay = balances.gusd < vault.vault.debt ? balances.gusd : vault.vault.debt;
      setDebtDelta(formatGusdInput(maxRepay));
      return;
    }

    // Max additional borrow at MCR (based on preview collateral if present)
    const collateralDeltaMotes = parseCsprInput(collateralDelta) ?? BigInt(0);
    const nextCollateral =
      collateralMode === 'withdraw'
        ? vault.vault.collateral - collateralDeltaMotes
        : vault.vault.collateral + collateralDeltaMotes;
    const maxTotalDebt = calculateMaxBorrow(nextCollateral, collateralPrice, collateralType, CDP_CONSTANTS.MCR_BPS);
    const maxBorrowDelta = maxTotalDebt > vault.vault.debt ? maxTotalDebt - vault.vault.debt : BigInt(0);
    setDebtDelta(formatGusdInput(maxBorrowDelta));
  };

  const handleApplyAdjust = async () => {
    resetTxState();
    const success = await onAdjustVault(
      collateralType,
      vault.vaultId,
      collateralDelta,
      collateralMode === 'withdraw',
      debtDelta,
      debtMode === 'repay'
    );
    if (success) {
      setCollateralDelta('');
      setDebtDelta('');
    }
  };

  const handleInterestRateChange = (value: string) => {
    if (value === '' || /^\d*\.?\d{0,1}$/.test(value)) {
      setInterestRate(value);
    }
  };

  const handleUpdateRate = async () => {
    resetTxState();
    const bps = Math.round(parseFloat(interestRate) * 100);
    const success = await onAdjustInterestRate(collateralType, vault.vaultId, bps);
    if (success) {
      // Refresh will update displayed rate
    }
  };

  if (!isConnected) {
    return null;
  }

  const nextCrPct = preview && 'icrBps' in preview ? (preview.icrBps / 100).toFixed(1) : null;
  const nextLiq = preview && 'liquidationPrice' in preview ? preview.liquidationPrice : null;

  return (
    <Card title={`Adjust Vault #${vault.vaultId.toString()}`} subtitle="Collateral / debt / rate">
      <div className="space-y-4">
        {/* Current balances */}
        <div className="bg-gray-50 rounded-lg p-3 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Vault Collateral</span>
            <span className="text-sm font-semibold text-gray-900">
              {formatCsprAmount(vault.vault.collateral)} {collateralLabel}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Vault Debt</span>
            <span className="text-sm font-semibold text-gray-900">
              {formatGusdAmount(vault.vault.debt)} gUSD
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Your {collateralLabel} Balance</span>
            <span className="text-sm font-semibold text-gray-900">
              {formatCsprAmount(collateralBalance)} {collateralLabel}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Your gUSD Balance</span>
            <span className="text-sm font-semibold text-gray-900">
              {formatGusdAmount(balances.gusd)} gUSD
            </span>
          </div>
        </div>

        {/* Collateral delta */}
        <div className="flex gap-2">
          <div className="w-40">
            <label className="block text-sm font-medium text-gray-700 mb-1">Collateral</label>
            <select
              className="w-full px-3 py-2 border border-gray-200 rounded-xl bg-white text-sm"
              value={collateralMode}
              onChange={(e) => setCollateralMode(e.target.value as 'add' | 'withdraw')}
              disabled={isProcessing}
            >
              <option value="add">Add</option>
              <option value="withdraw">Withdraw</option>
            </select>
          </div>
          <div className="flex-1">
            <Input
              label={
                <div className="flex items-center justify-between w-full">
                  <span>Amount</span>
                  <button
                    type="button"
                    onClick={handleMaxCollateral}
                    className="text-xs text-primary-600 hover:text-primary-700 font-medium"
                    disabled={isProcessing}
                  >
                    MAX
                  </button>
                </div>
              }
              type="text"
              inputMode="decimal"
              placeholder="0.0"
              value={collateralDelta}
              onChange={(e) => setCollateralDelta(e.target.value)}
              rightElement={<span className="text-sm font-medium text-gray-500">{collateralLabel}</span>}
              disabled={isProcessing}
            />
          </div>
        </div>

        {/* Debt delta */}
        <div className="flex gap-2">
          <div className="w-40">
            <label className="block text-sm font-medium text-gray-700 mb-1">Debt</label>
            <select
              className="w-full px-3 py-2 border border-gray-200 rounded-xl bg-white text-sm"
              value={debtMode}
              onChange={(e) => setDebtMode(e.target.value as 'borrow' | 'repay')}
              disabled={isProcessing}
            >
              <option value="borrow">Borrow</option>
              <option value="repay">Repay</option>
            </select>
          </div>
          <div className="flex-1">
            <Input
              label={
                <div className="flex items-center justify-between w-full">
                  <span>Amount</span>
                  <button
                    type="button"
                    onClick={handleMaxDebt}
                    className="text-xs text-primary-600 hover:text-primary-700 font-medium"
                    disabled={isProcessing}
                  >
                    MAX
                  </button>
                </div>
              }
              type="text"
              inputMode="decimal"
              placeholder="0.0"
              value={debtDelta}
              onChange={(e) => setDebtDelta(e.target.value)}
              rightElement={<span className="text-sm font-medium text-gray-500">gUSD</span>}
              disabled={isProcessing}
            />
          </div>
        </div>

        {/* Preview */}
        {preview && (
          <div className="bg-gray-50 rounded-lg p-4 space-y-2">
            {'error' in preview && preview.error ? (
              <p className="text-xs text-red-600">{preview.error}</p>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">Next Collateral Ratio</span>
                  <span className="text-sm font-semibold text-gray-900">{nextCrPct}%</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">Next Liquidation Price</span>
                  <span className="text-sm font-semibold text-orange-600">
                    ${nextLiq ? (Number(nextLiq) / 1e18).toFixed(6) : '0.000000'}
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {/* Interest Rate */}
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <Input
              label={
                <div className="flex items-center justify-between w-full">
                  <span>Interest Rate</span>
                  <span className="text-xs text-gray-400">0% - 40%</span>
                </div>
              }
              type="text"
              inputMode="decimal"
              placeholder="5.0"
              value={interestRate}
              onChange={(e) => handleInterestRateChange(e.target.value)}
              rightElement={<span className="text-sm font-medium text-gray-500">%</span>}
              disabled={isProcessing}
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleUpdateRate}
            disabled={isProcessing || !interestRate}
          >
            Update Rate
          </Button>
        </div>

        {/* Error / Success */}
        {txError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-700">{txError}</p>
          </div>
        )}
        {txStatus === 'success' && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3">
            <p className="text-sm text-green-700">Update successful!</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-2">
          <Button
            variant="secondary"
            size="sm"
            className="flex-1"
            onClick={onDone}
            disabled={isProcessing}
          >
            Done
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="flex-1"
            onClick={handleApplyAdjust}
            disabled={isProcessing || !preview.isValid}
            isLoading={isProcessing}
          >
            {txStatus === 'signing'
              ? 'Confirm...'
              : txStatus === 'approving'
                ? 'Approving...'
                : txStatus === 'pending'
                  ? 'Applying...'
                  : 'Apply Changes'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

