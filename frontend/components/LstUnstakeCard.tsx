'use client';

import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useCasperWallet } from '@/hooks/useCasperWallet';
import { getUnbondingPeriodDisplay, type LstExchangeRate, type LstBalance, type TxStatus } from '@/hooks/useLst';

interface LstUnstakeCardProps {
  exchangeRate: LstExchangeRate | null;
  userBalance: LstBalance | null;
  txStatus: TxStatus;
  txError: string | null;
  onUnstake: (amount: string) => Promise<boolean>;
  previewUnstake: (amount: string) => { cspr: bigint; formatted: string } | null;
  resetTxState: () => void;
}

export function LstUnstakeCard({
  exchangeRate,
  userBalance,
  txStatus,
  txError,
  onUnstake,
  previewUnstake,
  resetTxState,
}: LstUnstakeCardProps) {
  const { isConnected } = useCasperWallet();
  const [amount, setAmount] = useState('');
  const [preview, setPreview] = useState<{ cspr: bigint; formatted: string } | null>(null);

  // Update preview when amount changes
  useEffect(() => {
    if (amount) {
      const result = previewUnstake(amount);
      setPreview(result);
    } else {
      setPreview(null);
    }
  }, [amount, previewUnstake]);

  const handleUnstake = async () => {
    resetTxState();
    const success = await onUnstake(amount);
    if (success) {
      setAmount('');
    }
  };

  const handleMax = () => {
    if (userBalance) {
      setAmount(userBalance.scsprFormatted);
    }
  };

  const isLoading = txStatus === 'signing' || txStatus === 'pending';
  const canUnstake = isConnected && amount && preview && !isLoading;

  return (
    <Card title="Unstake stCSPR" subtitle="Request withdrawal to receive CSPR">
      <div className="space-y-4">
        {/* Balance Display */}
        {isConnected && userBalance && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-600">Your stCSPR Balance</span>
            <button
              onClick={handleMax}
              className="font-medium text-primary-600 hover:text-primary-700 transition-colors"
            >
              {userBalance.scsprFormatted} stCSPR (Max)
            </button>
          </div>
        )}

        <Input
          label={
            <div className="flex items-center justify-between w-full">
              <span>stCSPR Amount</span>
              {exchangeRate && (
                <span className="text-xs text-gray-400">
                  Rate: {exchangeRate.rateFormatted} CSPR/stCSPR
                </span>
              )}
            </div>
          }
          type="text"
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          rightElement={
            <span className="text-sm font-medium text-gray-500">stCSPR</span>
          }
          disabled={isLoading}
        />

        {/* Preview */}
        {preview && (
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">You will receive (after cooldown)</span>
              <span className="text-lg font-semibold text-gray-900">
                {preview.formatted} CSPR
              </span>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Rate is locked at request time. {getUnbondingPeriodDisplay()} cooldown period applies.
            </p>
          </div>
        )}

        {/* Error Display */}
        {txError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-700">{txError}</p>
          </div>
        )}

        {/* Action Button */}
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          onClick={handleUnstake}
          disabled={!canUnstake}
          isLoading={isLoading}
        >
          {!isConnected
            ? 'Connect Wallet'
            : isLoading
              ? 'Processing...'
              : 'Request Unstake'}
        </Button>

        {/* Info */}
        <p className="text-xs text-gray-500 text-center">
          Unstaking requires a 2-step process: Approve stCSPR, then Request Withdraw.
          <br />
          Withdrawals can be claimed after the {getUnbondingPeriodDisplay()} cooldown period.
        </p>
      </div>
    </Card>
  );
}
