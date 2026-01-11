'use client';

import { Header } from '@/components/Header';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatCard } from '@/components/ui/StatCard';
import { useStabilityPool } from '@/hooks/useStabilityPool';
import { useCasperWallet } from '@/hooks/useCasperWallet';
import { CONTRACTS } from '@/lib/config';
import { useState, useEffect } from 'react';

// Check if stability pool is deployed
function isStabilityPoolDeployed(): boolean {
  return CONTRACTS.stabilityPool !== null && CONTRACTS.stabilityPool !== 'null';
}

// Deposit Card Component
// Format bigint to human-readable string (18 decimals)
function formatBalance(value: bigint): string {
  const num = Number(value) / 1e18;
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function DepositCard({
  userGusdBalance,
  userGusdBalanceFormatted,
  txStatus,
  txError,
  onDeposit,
  resetTxState,
}: {
  userGusdBalance: bigint | null;
  userGusdBalanceFormatted: string | null;
  txStatus: string;
  txError: string | null;
  onDeposit: (amount: string) => Promise<boolean>;
  resetTxState: () => void;
}) {
  const { isConnected } = useCasperWallet();
  const [amount, setAmount] = useState('');

  const handleDeposit = async () => {
    resetTxState();
    const success = await onDeposit(amount);
    if (success) setAmount('');
  };

  const handleMaxDeposit = () => {
    if (userGusdBalance && userGusdBalance > BigInt(0)) {
      setAmount(formatBalance(userGusdBalance));
    }
  };

  const canDeposit =
    isConnected &&
    amount.length > 0 &&
    parseFloat(amount) > 0 &&
    txStatus !== 'signing' &&
    txStatus !== 'pending';

  return (
    <Card title="Deposit gUSD" subtitle="Earn liquidation gains">
      <div className="space-y-4">
        <Input
          label={
            <div className="flex items-center justify-between w-full">
              <span>Amount</span>
              {isConnected && userGusdBalance && userGusdBalance > BigInt(0) && (
                <button
                  type="button"
                  onClick={handleMaxDeposit}
                  className="text-xs text-primary-600 hover:text-primary-700 font-medium"
                  disabled={txStatus === 'signing' || txStatus === 'pending'}
                >
                  MAX
                </button>
              )}
            </div>
          }
          type="number"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          rightElement={<span className="text-gray-500 text-sm">gUSD</span>}
        />

        {userGusdBalanceFormatted && (
          <div className="flex justify-between text-sm text-gray-600">
            <span>Balance:</span>
            <span>{userGusdBalanceFormatted} gUSD</span>
          </div>
        )}

        {txError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            {txError}
          </div>
        )}

        {txStatus === 'success' && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-700">
            Deposit successful!
          </div>
        )}

        <Button
          onClick={handleDeposit}
          disabled={!canDeposit}
          isLoading={txStatus === 'signing' || txStatus === 'pending'}
          className="w-full"
        >
          {!isConnected
            ? 'Connect Wallet'
            : txStatus === 'signing'
              ? 'Confirm in Wallet...'
              : txStatus === 'pending'
                ? 'Processing...'
                : 'Deposit gUSD'}
        </Button>

        <p className="text-xs text-gray-500 text-center">
          Depositors earn a share of liquidation proceeds (CSPR + stCSPR)
        </p>
      </div>
    </Card>
  );
}

// Withdraw Card Component
function WithdrawCard({
  userDeposit,
  txStatus,
  txError,
  onWithdraw,
  resetTxState,
}: {
  userDeposit: { depositedAmount: bigint; depositedFormatted: string } | null;
  txStatus: string;
  txError: string | null;
  onWithdraw: (amount: string) => Promise<boolean>;
  resetTxState: () => void;
}) {
  const { isConnected } = useCasperWallet();
  const [amount, setAmount] = useState('');

  const handleWithdraw = async () => {
    resetTxState();
    const success = await onWithdraw(amount);
    if (success) setAmount('');
  };

  const handleMaxWithdraw = () => {
    if (userDeposit && userDeposit.depositedAmount > BigInt(0)) {
      setAmount(formatBalance(userDeposit.depositedAmount));
    }
  };

  const canWithdraw =
    isConnected &&
    amount.length > 0 &&
    parseFloat(amount) > 0 &&
    userDeposit &&
    userDeposit.depositedAmount > BigInt(0) &&
    txStatus !== 'signing' &&
    txStatus !== 'pending';

  return (
    <Card title="Withdraw gUSD" subtitle="Withdraw your deposit">
      <div className="space-y-4">
        <Input
          label={
            <div className="flex items-center justify-between w-full">
              <span>Amount</span>
              {isConnected && userDeposit && userDeposit.depositedAmount > BigInt(0) && (
                <button
                  type="button"
                  onClick={handleMaxWithdraw}
                  className="text-xs text-primary-600 hover:text-primary-700 font-medium"
                  disabled={txStatus === 'signing' || txStatus === 'pending'}
                >
                  MAX
                </button>
              )}
            </div>
          }
          type="number"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          rightElement={<span className="text-gray-500 text-sm">gUSD</span>}
        />

        {userDeposit && (
          <div className="flex justify-between text-sm text-gray-600">
            <span>Your Deposit:</span>
            <span>{userDeposit.depositedFormatted} gUSD</span>
          </div>
        )}

        {txError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            {txError}
          </div>
        )}

        {txStatus === 'success' && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-700">
            Withdrawal successful!
          </div>
        )}

        <Button
          onClick={handleWithdraw}
          disabled={!canWithdraw}
          isLoading={txStatus === 'signing' || txStatus === 'pending'}
          variant="secondary"
          className="w-full"
        >
          {!isConnected
            ? 'Connect Wallet'
            : txStatus === 'signing'
              ? 'Confirm in Wallet...'
              : txStatus === 'pending'
                ? 'Processing...'
                : 'Withdraw gUSD'}
        </Button>
      </div>
    </Card>
  );
}

// Gains Card Component
function GainsCard({
  userDeposit,
  txStatus,
  txError,
  onClaimGains,
  resetTxState,
}: {
  userDeposit: {
    pendingCsprGains: bigint;
    csprGainsFormatted: string;
    pendingScsprGains: bigint;
    scsprGainsFormatted: string;
  } | null;
  txStatus: string;
  txError: string | null;
  onClaimGains: () => Promise<boolean>;
  resetTxState: () => void;
}) {
  const { isConnected } = useCasperWallet();

  const handleClaim = async () => {
    resetTxState();
    await onClaimGains();
  };

  const hasGains =
    userDeposit &&
    (userDeposit.pendingCsprGains > BigInt(0) || userDeposit.pendingScsprGains > BigInt(0));

  const canClaim =
    isConnected && hasGains && txStatus !== 'signing' && txStatus !== 'pending';

  return (
    <Card title="Your Gains" subtitle="Accumulated liquidation rewards">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-gray-50 rounded-lg p-4">
            <p className="text-xs text-gray-500 mb-1">CSPR Gains</p>
            <p className="text-xl font-semibold text-gray-900">
              {userDeposit?.csprGainsFormatted ?? '0.00'}
            </p>
          </div>
          <div className="bg-gray-50 rounded-lg p-4">
            <p className="text-xs text-gray-500 mb-1">stCSPR Gains</p>
            <p className="text-xl font-semibold text-gray-900">
              {userDeposit?.scsprGainsFormatted ?? '0.00'}
            </p>
          </div>
        </div>

        {txError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            {txError}
          </div>
        )}

        {txStatus === 'success' && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-700">
            Gains claimed successfully!
          </div>
        )}

        <Button
          onClick={handleClaim}
          disabled={!canClaim}
          isLoading={txStatus === 'signing' || txStatus === 'pending'}
          variant="primary"
          className="w-full"
        >
          {!isConnected
            ? 'Connect Wallet'
            : !hasGains
              ? 'No Gains to Claim'
              : txStatus === 'signing'
                ? 'Confirm in Wallet...'
                : txStatus === 'pending'
                  ? 'Processing...'
                  : 'Claim Gains'}
        </Button>
      </div>
    </Card>
  );
}

// Pool Stats Card Component
function PoolStatsCard({
  stats,
  isLoading,
}: {
  stats: {
    totalDepositsFormatted: string;
    estimatedAprBps: number;
  } | null;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <Card title="Pool Statistics">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      </Card>
    );
  }

  const aprPercent = stats ? (stats.estimatedAprBps / 100).toFixed(2) : '0.00';

  return (
    <Card title="Pool Statistics">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Total Deposits"
          value={stats?.totalDepositsFormatted ?? '0.00'}
          subtitle="gUSD in pool"
        />
        <StatCard
          label="Estimated APR"
          value={`${aprPercent}%`}
          subtitle="From liquidations"
        />
        <StatCard
          label="Pool Share"
          value="--"
          subtitle="Your percentage"
        />
        <StatCard
          label="Status"
          value="Active"
          subtitle="Ready for liquidations"
        />
      </div>
    </Card>
  );
}

export default function StabilityPoolPage() {
  const spDeployed = isStabilityPoolDeployed();
  const sp = useStabilityPool();

  if (!spDeployed) {
    return (
      <div className="min-h-screen">
        <Header />
        <main className="mx-auto max-w-6xl px-4 md:px-6 lg:px-8 py-10">
          <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-6 text-center">
            <h2 className="text-lg font-semibold text-yellow-800 mb-2">
              Stability Pool Not Deployed
            </h2>
            <p className="text-sm text-yellow-700">
              The Stability Pool contract has not been deployed yet.
              <br />
              Run the deployment script to enable this feature.
            </p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Header />

      <main className="mx-auto max-w-6xl px-4 md:px-6 lg:px-8 py-10">
        {/* Info Banner */}
        <div className="mb-8 bg-blue-50 border border-blue-200 rounded-xl p-4">
          <h3 className="text-sm font-medium text-blue-800 mb-1">
            What is the Stability Pool?
          </h3>
          <p className="text-sm text-blue-700">
            The Stability Pool is the first line of defense in maintaining system solvency.
            Depositors provide gUSD to liquidate undercollateralized positions in exchange for
            discounted collateral (CSPR and stCSPR).
          </p>
        </div>

        {/* Pool Stats */}
        <div className="mb-8">
          <PoolStatsCard stats={sp.poolStats} isLoading={sp.isLoading} />
        </div>

        {/* Deposit / Withdraw Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
          <DepositCard
            userGusdBalance={sp.userGusdBalance}
            userGusdBalanceFormatted={sp.userGusdBalanceFormatted}
            txStatus={sp.txStatus}
            txError={sp.txError}
            onDeposit={sp.deposit}
            resetTxState={sp.resetTxState}
          />
          <WithdrawCard
            userDeposit={sp.userDeposit}
            txStatus={sp.txStatus}
            txError={sp.txError}
            onWithdraw={sp.withdraw}
            resetTxState={sp.resetTxState}
          />
        </div>

        {/* Gains Card */}
        <div className="mb-8">
          <GainsCard
            userDeposit={sp.userDeposit}
            txStatus={sp.txStatus}
            txError={sp.txError}
            onClaimGains={sp.claimGains}
            resetTxState={sp.resetTxState}
          />
        </div>

        <footer className="mt-16 text-center text-sm text-gray-600 pb-8">
          <p>GasparFinance Protocol - Stability Pool</p>
        </footer>
      </main>
    </div>
  );
}
