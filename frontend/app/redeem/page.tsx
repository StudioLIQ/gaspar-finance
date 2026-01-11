'use client';

import { Header } from '@/components/Header';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatCard } from '@/components/ui/StatCard';
import { useRedemption, type CollateralType, type RedemptionQuote } from '@/hooks/useRedemption';
import { useCasperWallet } from '@/hooks/useCasperWallet';
import { CONTRACTS, PROTOCOL_PARAMS } from '@/lib/config';
import { useState, useEffect } from 'react';

// Check if redemption engine is deployed
function isRedemptionDeployed(): boolean {
  return CONTRACTS.redemptionEngine !== null && CONTRACTS.redemptionEngine !== 'null';
}

// Collateral selector component
function CollateralSelector({
  selected,
  onChange,
}: {
  selected: CollateralType;
  onChange: (type: CollateralType) => void;
}) {
  return (
    <div className="flex gap-2">
      <button
        onClick={() => onChange('CSPR')}
        className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
          selected === 'CSPR'
            ? 'bg-primary-100 text-primary-700 border-2 border-primary-500'
            : 'bg-gray-100 text-gray-600 border-2 border-transparent hover:bg-gray-200'
        }`}
      >
        CSPR
      </button>
      <button
        onClick={() => onChange('stCSPR')}
        className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
          selected === 'stCSPR'
            ? 'bg-primary-100 text-primary-700 border-2 border-primary-500'
            : 'bg-gray-100 text-gray-600 border-2 border-transparent hover:bg-gray-200'
        }`}
      >
        stCSPR
      </button>
    </div>
  );
}

// Quote display component
function QuoteDisplay({ quote }: { quote: RedemptionQuote | null }) {
  if (!quote) return null;

  return (
    <div className="bg-gray-50 rounded-lg p-4 space-y-2">
      <div className="flex justify-between text-sm">
        <span className="text-gray-600">You will receive:</span>
        <span className="font-medium text-gray-900">{quote.collateralFormatted}</span>
      </div>
      <div className="flex justify-between text-sm">
        <span className="text-gray-600">Fee ({(quote.feeBps / 100).toFixed(2)}%):</span>
        <span className="text-gray-600">{quote.feeFormatted}</span>
      </div>
      <div className="border-t border-gray-200 pt-2 mt-2">
        <div className="flex justify-between text-sm">
          <span className="text-gray-600">Exchange rate:</span>
          <span className="text-gray-600">1 gUSD = $1.00</span>
        </div>
      </div>
    </div>
  );
}

// Redemption Card Component
function RedemptionCard({
  userGusdBalanceFormatted,
  stats,
  txStatus,
  txError,
  getQuote,
  onRedeem,
  resetTxState,
}: {
  userGusdBalanceFormatted: string | null;
  stats: { baseFeeBps: number; isSafeModeActive: boolean } | null;
  txStatus: string;
  txError: string | null;
  getQuote: (amount: string, collateralType: CollateralType) => RedemptionQuote | null;
  onRedeem: (amount: string, collateralType: CollateralType, maxFeeBps: number) => Promise<boolean>;
  resetTxState: () => void;
}) {
  const { isConnected } = useCasperWallet();
  const [amount, setAmount] = useState('');
  const [collateralType, setCollateralType] = useState<CollateralType>('CSPR');
  const [quote, setQuote] = useState<RedemptionQuote | null>(null);

  // Update quote when amount or collateral type changes
  useEffect(() => {
    const newQuote = getQuote(amount, collateralType);
    setQuote(newQuote);
  }, [amount, collateralType, getQuote]);

  const handleRedeem = async () => {
    resetTxState();
    // Allow up to 1% slippage on fee
    const maxFeeBps = (stats?.baseFeeBps ?? PROTOCOL_PARAMS.REDEMPTION_BASE_FEE_BPS) + 100;
    const success = await onRedeem(amount, collateralType, maxFeeBps);
    if (success) setAmount('');
  };

  const canRedeem =
    isConnected &&
    amount.length > 0 &&
    parseFloat(amount) > 0 &&
    quote !== null &&
    !stats?.isSafeModeActive &&
    txStatus !== 'signing' &&
    txStatus !== 'pending';

  return (
    <Card title="Redeem gUSD" subtitle="Exchange gUSD for collateral at face value">
      <div className="space-y-4">
        {/* Collateral Type Selector */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Select Collateral
          </label>
          <CollateralSelector selected={collateralType} onChange={setCollateralType} />
        </div>

        {/* Amount Input */}
        <Input
          label="gUSD Amount"
          type="number"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          rightElement={<span className="text-gray-500 text-sm">gUSD</span>}
        />

        {/* Balance Display */}
        {userGusdBalanceFormatted && (
          <div className="flex justify-between text-sm text-gray-600">
            <span>Your Balance:</span>
            <span>{userGusdBalanceFormatted} gUSD</span>
          </div>
        )}

        {/* Quote Display */}
        <QuoteDisplay quote={quote} />

        {/* Safe Mode Warning */}
        {stats?.isSafeModeActive && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-700">
            Redemptions are currently paused due to Safe Mode. This happens when oracle prices
            are stale or unreliable.
          </div>
        )}

        {/* Error Display */}
        {txError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            {txError}
          </div>
        )}

        {/* Success Display */}
        {txStatus === 'success' && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-700">
            Redemption successful! Check your wallet for the received collateral.
          </div>
        )}

        {/* Redeem Button */}
        <Button
          onClick={handleRedeem}
          disabled={!canRedeem}
          isLoading={txStatus === 'signing' || txStatus === 'pending'}
          className="w-full"
        >
          {!isConnected
            ? 'Connect Wallet'
            : stats?.isSafeModeActive
              ? 'Redemptions Paused'
              : txStatus === 'signing'
                ? 'Confirm in Wallet...'
                : txStatus === 'pending'
                  ? 'Processing...'
                  : `Redeem for ${collateralType}`}
        </Button>

        {/* Info */}
        <p className="text-xs text-gray-500 text-center">
          Redemptions allow you to exchange gUSD for collateral at $1 per gUSD, minus the
          redemption fee. Vaults with the lowest interest rates are redeemed first.
        </p>
      </div>
    </Card>
  );
}

// Stats Card Component
function RedemptionStatsCard({
  stats,
  isLoading,
}: {
  stats: {
    baseFeeBps: number;
    totalRedeemedFormatted: string;
    isSafeModeActive: boolean;
  } | null;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <Card title="Redemption Statistics">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      </Card>
    );
  }

  const feePercent = stats ? (stats.baseFeeBps / 100).toFixed(2) : '0.50';

  return (
    <Card title="Redemption Statistics">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Current Fee"
          value={`${feePercent}%`}
          subtitle="Base redemption fee"
        />
        <StatCard
          label="Total Redeemed"
          value={stats?.totalRedeemedFormatted ?? '0.00'}
          subtitle="gUSD all time"
        />
        <StatCard
          label="Min Redemption"
          value="1 gUSD"
          subtitle="Minimum amount"
        />
        <StatCard
          label="Status"
          value={stats?.isSafeModeActive ? 'Paused' : 'Active'}
          subtitle={stats?.isSafeModeActive ? 'Safe Mode' : 'Ready'}
        />
      </div>
    </Card>
  );
}

export default function RedeemPage() {
  const redeemDeployed = isRedemptionDeployed();
  const redemption = useRedemption();

  if (!redeemDeployed) {
    return (
      <div className="min-h-screen">
        <Header />
        <main className="mx-auto max-w-6xl px-4 md:px-6 lg:px-8 py-10">
          <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-6 text-center">
            <h2 className="text-lg font-semibold text-yellow-800 mb-2">
              Redemption Engine Not Deployed
            </h2>
            <p className="text-sm text-yellow-700">
              The Redemption Engine contract has not been deployed yet.
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
          <h3 className="text-sm font-medium text-blue-800 mb-1">What are Redemptions?</h3>
          <p className="text-sm text-blue-700">
            Redemptions allow gUSD holders to exchange their stablecoins for underlying
            collateral at face value ($1 per gUSD). This mechanism helps maintain the gUSD peg
            by creating arbitrage opportunities when gUSD trades below $1.
          </p>
        </div>

        {/* Stats */}
        <div className="mb-8">
          <RedemptionStatsCard stats={redemption.stats} isLoading={redemption.isLoading} />
        </div>

        {/* Redemption Card */}
        <div className="max-w-xl mx-auto mb-8">
          <RedemptionCard
            userGusdBalanceFormatted={redemption.userGusdBalanceFormatted}
            stats={redemption.stats}
            txStatus={redemption.txStatus}
            txError={redemption.txError}
            getQuote={redemption.getQuote}
            onRedeem={redemption.redeem}
            resetTxState={redemption.resetTxState}
          />
        </div>

        {/* How It Works */}
        <div className="mb-8">
          <Card title="How Redemptions Work">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="text-center p-4">
                <div className="w-10 h-10 bg-primary-100 text-primary-700 rounded-full flex items-center justify-center mx-auto mb-3 text-lg font-bold">
                  1
                </div>
                <h4 className="font-medium text-gray-900 mb-1">Choose Collateral</h4>
                <p className="text-sm text-gray-600">
                  Select CSPR or stCSPR as your desired redemption collateral.
                </p>
              </div>
              <div className="text-center p-4">
                <div className="w-10 h-10 bg-primary-100 text-primary-700 rounded-full flex items-center justify-center mx-auto mb-3 text-lg font-bold">
                  2
                </div>
                <h4 className="font-medium text-gray-900 mb-1">Enter Amount</h4>
                <p className="text-sm text-gray-600">
                  Specify how much gUSD you want to redeem. View the quote including fees.
                </p>
              </div>
              <div className="text-center p-4">
                <div className="w-10 h-10 bg-primary-100 text-primary-700 rounded-full flex items-center justify-center mx-auto mb-3 text-lg font-bold">
                  3
                </div>
                <h4 className="font-medium text-gray-900 mb-1">Receive Collateral</h4>
                <p className="text-sm text-gray-600">
                  Confirm the transaction and receive collateral directly to your wallet.
                </p>
              </div>
            </div>
          </Card>
        </div>

        <footer className="mt-16 text-center text-sm text-gray-600 pb-8">
          <p>Casper CDP Protocol - Redemptions</p>
        </footer>
      </main>
    </div>
  );
}
