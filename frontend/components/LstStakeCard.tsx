'use client';

import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useCasperWallet } from '@/hooks/useCasperWallet';
import type { LstExchangeRate, TxStatus } from '@/hooks/useLst';

interface LstStakeCardProps {
  exchangeRate: LstExchangeRate | null;
  txStatus: TxStatus;
  txError: string | null;
  onStake: (amount: string) => Promise<boolean>;
  previewStake: (amount: string) => { shares: bigint; formatted: string } | null;
  resetTxState: () => void;
}

export function LstStakeCard({
  exchangeRate,
  txStatus,
  txError,
  onStake,
  previewStake,
  resetTxState,
}: LstStakeCardProps) {
  const { isConnected } = useCasperWallet();
  const [amount, setAmount] = useState('');
  const [preview, setPreview] = useState<{ shares: bigint; formatted: string } | null>(null);

  // Update preview when amount changes
  useEffect(() => {
    if (amount) {
      const result = previewStake(amount);
      setPreview(result);
    } else {
      setPreview(null);
    }
  }, [amount, previewStake]);

  const handleStake = async () => {
    resetTxState();
    const success = await onStake(amount);
    if (success) {
      setAmount('');
    }
  };

  const isLoading = txStatus === 'signing' || txStatus === 'pending';
  const canStake = isConnected && amount && preview && !isLoading;

  return (
    <Card title="Stake CSPR" subtitle="Deposit CSPR to receive stCSPR">
      <div className="space-y-4">
        <Input
          label={
            <div className="flex items-center justify-between w-full">
              <span>CSPR Amount</span>
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
            <span className="text-sm font-medium text-gray-500">CSPR</span>
          }
          disabled={isLoading}
        />

        {/* Preview */}
        {preview && (
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">You will receive</span>
              <span className="text-lg font-semibold text-gray-900">
                {preview.formatted} stCSPR
              </span>
            </div>
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
          onClick={handleStake}
          disabled={!canStake}
          isLoading={isLoading}
        >
          {!isConnected
            ? 'Connect Wallet'
            : isLoading
              ? 'Processing...'
              : 'Stake CSPR'}
        </Button>

        {/* Info */}
        <p className="text-xs text-gray-500 text-center">
          Staking requires a proxy_caller WASM for payable calls.
          <br />
          Your stCSPR balance will increase as staking rewards accrue.
        </p>
      </div>
    </Card>
  );
}
