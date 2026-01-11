'use client';

import { Header } from '@/components/Header';
import { LstStubWarning } from '@/components/LstStubWarning';
import { LstExchangeRateCard } from '@/components/LstExchangeRateCard';
import { LstStakeCard } from '@/components/LstStakeCard';
import { LstUnstakeCard } from '@/components/LstUnstakeCard';
import { LstWithdrawRequestsCard } from '@/components/LstWithdrawRequestsCard';
import { LstProtocolStatsCard } from '@/components/LstProtocolStatsCard';
import { useLst } from '@/hooks/useLst';
import { isLSTDeployed } from '@/lib/config';

export default function LstPage() {
  const lstDeployed = isLSTDeployed();
  const lst = useLst();

  if (!lstDeployed) {
    return (
      <div className="min-h-screen">
        <Header />
        <main className="mx-auto max-w-6xl px-4 md:px-6 lg:px-8 py-10">
          <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-6 text-center">
            <h2 className="text-lg font-semibold text-yellow-800 mb-2">LST Not Deployed</h2>
            <p className="text-sm text-yellow-700">
              The stCSPR ybToken and Withdraw Queue contracts have not been deployed yet.
              <br />
              Run the deployment script with DEPLOY_LST=true to enable this feature.
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
        {/* Warning banner for stub implementations */}
        <LstStubWarning />

        {/* Exchange Rate Display */}
        <div className="mb-8">
          <LstExchangeRateCard
            exchangeRate={lst.exchangeRate}
            isLoading={lst.isLoading}
            onRefresh={lst.refresh}
            isRefreshing={lst.isRefreshing}
          />
        </div>

        {/* Stake / Unstake Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
          <LstStakeCard
            exchangeRate={lst.exchangeRate}
            userCsprBalance={lst.userCsprBalance}
            txStatus={lst.txStatus}
            txError={lst.txError}
            onStake={lst.stake}
            previewStake={lst.previewStake}
            resetTxState={lst.resetTxState}
          />
          <LstUnstakeCard
            exchangeRate={lst.exchangeRate}
            userBalance={lst.userBalance}
            txStatus={lst.txStatus}
            txError={lst.txError}
            unstakeStep={lst.unstakeStep}
            onUnstake={lst.requestUnstake}
            previewUnstake={lst.previewUnstake}
            resetTxState={lst.resetTxState}
          />
        </div>

        {/* Withdraw Requests */}
        <div className="mb-8">
          <LstWithdrawRequestsCard
            requests={lst.withdrawRequests}
            isLoading={lst.isLoading}
            txStatus={lst.txStatus}
            txError={lst.txError}
            onClaim={lst.claimWithdraw}
            resetTxState={lst.resetTxState}
          />
        </div>

        {/* Protocol Stats */}
        <div className="mb-8">
          <LstProtocolStatsCard
            stats={lst.protocolStats}
            isLoading={lst.isLoading}
          />
        </div>

        <footer className="mt-16 text-center text-sm text-gray-600 pb-8">
          <p>GasparFinance Protocol - Liquid Staking (stCSPR)</p>
        </footer>
      </main>
    </div>
  );
}
