'use client';

import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useCasperWallet } from '@/hooks/useCasperWallet';
import type { LstExchangeRate, TxStatus } from '@/hooks/useLst';
import { formatCsprAmount, parseCsprInput } from '@/lib/casperRpc';

// Casper network minimum stake requirement
const MIN_STAKE_CSPR = BigInt('500000000000'); // 500 CSPR in motes

interface LstStakeCardProps {
  exchangeRate: LstExchangeRate | null;
  userCsprBalance: bigint | null;
  txStatus: TxStatus;
  txError: string | null;
  onStake: (amount: string) => Promise<boolean>;
  previewStake: (amount: string) => { shares: bigint; formatted: string } | null;
  resetTxState: () => void;
}

export function LstStakeCard({
  exchangeRate,
  userCsprBalance,
  txStatus,
  txError,
  onStake,
  previewStake,
  resetTxState,
}: LstStakeCardProps) {
  const { isConnected } = useCasperWallet();
  const [amount, setAmount] = useState('');
  const [preview, setPreview] = useState<{ shares: bigint; formatted: string } | null>(null);

  // Format CSPR balance for display
  const formattedCsprBalance = userCsprBalance !== null ? formatCsprAmount(userCsprBalance) : null;

  // Handle max button click (leave 5 CSPR for gas)
  const handleMax = () => {
    if (userCsprBalance !== null) {
      const gasBuffer = BigInt('5000000000'); // 5 CSPR
      const maxAmount = userCsprBalance > gasBuffer ? userCsprBalance - gasBuffer : BigInt(0);
      const formatted = formatCsprAmount(maxAmount);
      setAmount(formatted);
    }
  };

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

  // Check minimum stake requirement
  const parsedAmount = parseCsprInput(amount);
  const isBelowMinimum = parsedAmount !== null && parsedAmount < MIN_STAKE_CSPR;
  const canStake = isConnected && amount && preview && !isLoading && !isBelowMinimum;

  return (
    <Card title="Stake CSPR" subtitle="Deposit CSPR to receive stCSPR">
      <div className="space-y-4">
        {/* Balance Display */}
        {isConnected && (
          <div className="bg-gray-50 rounded-lg p-3 mb-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">Your CSPR Balance</span>
              <span className="text-sm font-semibold text-gray-900">
                {formattedCsprBalance !== null ? `${formattedCsprBalance} CSPR` : 'Loading...'}
              </span>
            </div>
          </div>
        )}

        <Input
          label={
            <div className="flex items-center justify-between w-full">
              <span>CSPR Amount</span>
              {isConnected && formattedCsprBalance !== null && (
                <button
                  type="button"
                  onClick={handleMax}
                  className="text-xs text-primary-600 hover:text-primary-700 font-medium"
                  disabled={isLoading}
                >
                  MAX
                </button>
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

        {/* Minimum Stake Warning */}
        {isBelowMinimum && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
            <p className="text-sm text-yellow-700">
              Minimum stake is 500 CSPR (Casper network requirement)
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
        <div className="text-xs text-gray-500 space-y-1">
          <p>• Minimum stake: 500 CSPR</p>
          <p>• Your stCSPR balance will increase as staking rewards accrue</p>
        </div>
      </div>
    </Card>
  );
}
