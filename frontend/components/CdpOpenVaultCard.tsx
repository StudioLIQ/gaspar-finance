'use client';

import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useCasperWallet } from '@/hooks/useCasperWallet';
import {
  formatCsprAmount,
  formatGusdAmount,
  CDP_CONSTANTS,
  type CollateralType,
  type TxStatus,
  type UserBalances,
} from '@/hooks/useCdp';

interface CdpOpenVaultCardProps {
  collateralType: CollateralType;
  collateralPrice: bigint;
  balances: UserBalances;
  hasExistingVault: boolean;
  txStatus: TxStatus;
  txError: string | null;
  onOpenVault: (
    collateralType: CollateralType,
    collateralAmount: string,
    borrowAmount: string,
    interestRateBps: number
  ) => Promise<boolean>;
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

export function CdpOpenVaultCard({
  collateralType,
  collateralPrice,
  balances,
  hasExistingVault,
  txStatus,
  txError,
  onOpenVault,
  previewOpenVault,
  resetTxState,
}: CdpOpenVaultCardProps) {
  const { isConnected } = useCasperWallet();
  const [collateralAmount, setCollateralAmount] = useState('');
  const [borrowAmount, setBorrowAmount] = useState('');
  const [interestRate, setInterestRate] = useState('5.0'); // Default 5.0%
  const [preview, setPreview] = useState<ReturnType<typeof previewOpenVault>>(null);

  const collateralLabel = collateralType === 'cspr' ? 'CSPR' : 'stCSPR';
  const userBalance = collateralType === 'cspr' ? balances.cspr : balances.scspr;
  const isProcessing = txStatus === 'signing' || txStatus === 'pending';

  // Update preview when inputs change
  useEffect(() => {
    if (collateralAmount && borrowAmount) {
      const result = previewOpenVault(collateralType, collateralAmount, borrowAmount);
      setPreview(result);
    } else {
      setPreview(null);
    }
  }, [collateralAmount, borrowAmount, collateralType, previewOpenVault]);

  const handleOpenVault = async () => {
    resetTxState();
    const interestRateBps = Math.round(parseFloat(interestRate) * 100);
    const success = await onOpenVault(collateralType, collateralAmount, borrowAmount, interestRateBps);
    if (success) {
      setCollateralAmount('');
      setBorrowAmount('');
    }
  };

  // Only allow one decimal place for interest rate (e.g., 5.0, 5.5, 10.3)
  const handleInterestRateChange = (value: string) => {
    // Allow empty, or numbers with up to 1 decimal place
    if (value === '' || /^\d*\.?\d{0,1}$/.test(value)) {
      // Clamp to 0-40 range on blur, but allow typing freely
      setInterestRate(value);
    }
  };

  const handleMaxCollateral = () => {
    // Leave some for gas
    const gasBuffer = collateralType === 'cspr' ? BigInt('5000000000') : BigInt(0);
    const maxAmount = userBalance > gasBuffer ? userBalance - gasBuffer : BigInt(0);
    setCollateralAmount(formatCsprAmount(maxAmount));
  };

  // Calculate max borrowable gUSD based on current collateral at MCR
  const handleMaxBorrow = () => {
    if (!collateralAmount || !collateralPrice) return;
    try {
      const collateralWei = BigInt(Math.floor(parseFloat(collateralAmount) * 1e9)) * BigInt(1e9);
      const collateralValue = (collateralWei * collateralPrice) / BigInt(1e18);
      // Max borrow = collateralValue / MCR (110%)
      const maxBorrow = (collateralValue * BigInt(10000)) / BigInt(CDP_CONSTANTS.MCR_BPS);
      setBorrowAmount(formatGusdAmount(maxBorrow));
    } catch {
      // Invalid input, ignore
    }
  };

  // CR color
  const getCrColor = (crBps: number) => {
    if (crBps >= 20000) return 'text-green-600';
    if (crBps >= 15000) return 'text-yellow-600';
    if (crBps >= 11000) return 'text-orange-500';
    return 'text-red-600';
  };

  const canOpen = isConnected && !hasExistingVault && preview?.isValid && !isProcessing;

  if (hasExistingVault) {
    return (
      <Card
        title={`Open ${collateralLabel} Vault`}
        subtitle="You already have a vault"
      >
        <div className="text-center py-8 text-gray-500">
          <p>You already have an active {collateralLabel} vault.</p>
          <p className="text-sm mt-2">Close your existing vault or adjust it instead.</p>
        </div>
      </Card>
    );
  }

  return (
    <Card
      title={`Open ${collateralLabel} Vault`}
      subtitle="Deposit collateral & borrow gUSD"
    >
      <div className="space-y-4">
        {/* Balance Display */}
        {isConnected && (
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">Your {collateralLabel} Balance</span>
              <span className="text-sm font-semibold text-gray-900">
                {formatCsprAmount(userBalance)} {collateralLabel}
              </span>
            </div>
          </div>
        )}

        {/* Collateral Input */}
        <Input
          label={
            <div className="flex items-center justify-between w-full">
              <span>Collateral Amount</span>
              {isConnected && (
                <button
                  type="button"
                  onClick={handleMaxCollateral}
                  className="text-xs text-primary-600 hover:text-primary-700 font-medium"
                  disabled={isProcessing}
                >
                  MAX
                </button>
              )}
            </div>
          }
          type="text"
          inputMode="decimal"
          placeholder="0.0"
          value={collateralAmount}
          onChange={(e) => setCollateralAmount(e.target.value)}
          rightElement={<span className="text-sm font-medium text-gray-500">{collateralLabel}</span>}
          disabled={isProcessing}
        />

        {/* Borrow Input */}
        <Input
          label={
            <div className="flex items-center justify-between w-full">
              <span>Borrow Amount</span>
              {isConnected && collateralAmount && (
                <button
                  type="button"
                  onClick={handleMaxBorrow}
                  className="text-xs text-primary-600 hover:text-primary-700 font-medium"
                  disabled={isProcessing}
                >
                  MAX
                </button>
              )}
            </div>
          }
          type="text"
          inputMode="decimal"
          placeholder="0.0"
          value={borrowAmount}
          onChange={(e) => setBorrowAmount(e.target.value)}
          rightElement={<span className="text-sm font-medium text-gray-500">gUSD</span>}
          disabled={isProcessing}
        />

        {/* Interest Rate */}
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

        {/* Preview */}
        {preview && (
          <div className="bg-gray-50 rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">Collateral Ratio</span>
              <span className={`text-sm font-semibold ${getCrColor(preview.icrBps)}`}>
                {(preview.icrBps / 100).toFixed(1)}%
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">Liquidation Price</span>
              <span className="text-sm font-semibold text-orange-600">
                ${(Number(preview.liquidationPrice) / 1e18).toFixed(6)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">Borrowing Fee (0.5%)</span>
              <span className="text-sm font-semibold text-gray-900">
                {formatGusdAmount(preview.borrowingFee)} gUSD
              </span>
            </div>
            {preview.error && (
              <p className="text-xs text-red-600 mt-2">{preview.error}</p>
            )}
          </div>
        )}

        {/* Error Display */}
        {txError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-700">{txError}</p>
          </div>
        )}

        {/* Success Message */}
        {txStatus === 'success' && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3">
            <p className="text-sm text-green-700">Vault opened successfully!</p>
          </div>
        )}

        {/* Action Button */}
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          onClick={handleOpenVault}
          disabled={!canOpen}
          isLoading={isProcessing}
        >
          {!isConnected
            ? 'Connect Wallet'
            : isProcessing
              ? 'Processing...'
              : 'Open Vault'}
        </Button>

        {/* Info */}
        <div className="text-xs text-gray-500 space-y-1">
          <p>• Minimum collateral ratio: {CDP_CONSTANTS.MCR_BPS / 100}%</p>
          <p>• Minimum debt: 1 gUSD</p>
          <p>• Borrowing fee: {CDP_CONSTANTS.BORROWING_FEE_BPS / 100}%</p>
        </div>
      </div>
    </Card>
  );
}
