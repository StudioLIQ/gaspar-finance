'use client';

import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useCasperWallet } from '@/hooks/useCasperWallet';
import { getUnbondingPeriodDisplay, type LstExchangeRate, type LstBalance, type TxStatus, type UnstakeStep } from '@/hooks/useLst';

interface LstUnstakeCardProps {
  exchangeRate: LstExchangeRate | null;
  userBalance: LstBalance | null;
  txStatus: TxStatus;
  txError: string | null;
  unstakeStep: UnstakeStep;
  onUnstake: (amount: string) => Promise<boolean>;
  previewUnstake: (amount: string) => { cspr: bigint; formatted: string } | null;
  resetTxState: () => void;
}

// Helper to get step label
function getStepLabel(step: UnstakeStep): string {
  switch (step) {
    case 'approve-signing':
      return 'Step 1/2: Sign Approve';
    case 'approve-pending':
      return 'Step 1/2: Confirming Approve...';
    case 'request-signing':
      return 'Step 2/2: Sign Request';
    case 'request-pending':
      return 'Step 2/2: Confirming Request...';
    case 'done':
      return 'Complete!';
    default:
      return '';
  }
}

export function LstUnstakeCard({
  exchangeRate,
  userBalance,
  txStatus,
  txError,
  unstakeStep,
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
  const stepLabel = getStepLabel(unstakeStep);

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

        {/* Progress Indicator */}
        {isLoading && unstakeStep !== 'idle' && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex items-center gap-3">
              <div className="animate-spin h-5 w-5 border-2 border-blue-600 border-t-transparent rounded-full" />
              <div>
                <p className="text-sm font-medium text-blue-800">{stepLabel}</p>
                <p className="text-xs text-blue-600 mt-0.5">
                  {unstakeStep.includes('signing') && 'Please confirm in your wallet'}
                  {unstakeStep.includes('pending') && 'Waiting for blockchain confirmation...'}
                </p>
              </div>
            </div>
            {/* Step Progress Bar */}
            <div className="mt-3 flex gap-2">
              <div className={`flex-1 h-1.5 rounded ${
                unstakeStep === 'approve-signing' || unstakeStep === 'approve-pending'
                  ? 'bg-blue-500 animate-pulse'
                  : unstakeStep === 'request-signing' || unstakeStep === 'request-pending' || unstakeStep === 'done'
                    ? 'bg-green-500'
                    : 'bg-gray-200'
              }`} />
              <div className={`flex-1 h-1.5 rounded ${
                unstakeStep === 'request-signing' || unstakeStep === 'request-pending'
                  ? 'bg-blue-500 animate-pulse'
                  : unstakeStep === 'done'
                    ? 'bg-green-500'
                    : 'bg-gray-200'
              }`} />
            </div>
            <div className="mt-1 flex justify-between text-xs text-gray-500">
              <span>Approve</span>
              <span>Request</span>
            </div>
          </div>
        )}

        {/* Error Display */}
        {txError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm font-medium text-red-800">Transaction Failed</p>
            <p className="text-sm text-red-700 mt-1">{txError}</p>
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
              ? stepLabel || 'Processing...'
              : 'Request Unstake'}
        </Button>

        {/* Info */}
        <div className="bg-gray-50 rounded-lg p-3">
          <p className="text-xs text-gray-600 font-medium mb-1">How unstaking works:</p>
          <ol className="text-xs text-gray-500 list-decimal list-inside space-y-0.5">
            <li>Approve stCSPR spending (1st signature)</li>
            <li>Request withdrawal (2nd signature)</li>
            <li>Wait {getUnbondingPeriodDisplay()} cooldown</li>
            <li>Claim your CSPR</li>
          </ol>
        </div>
      </div>
    </Card>
  );
}
