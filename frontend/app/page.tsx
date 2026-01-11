'use client';

import { useState } from 'react';
import { Header } from '@/components/Header';
import { CdpVaultCard } from '@/components/CdpVaultCard';
import { CdpOpenVaultCard } from '@/components/CdpOpenVaultCard';
import { CdpStatsCard } from '@/components/CdpStatsCard';
import { useCdp, type CollateralType } from '@/hooks/useCdp';

export default function Home() {
  const [activeCollateral, setActiveCollateral] = useState<CollateralType>('cspr');

  const {
    csprVault,
    scsprVault,
    csprBranch,
    scsprBranch,
    csprPrice,
    scsprPrice,
    balances,
    isLoading,
    txStatus,
    txError,
    openVault,
    closeVault,
    previewOpenVault,
    resetTxState,
  } = useCdp();

  const currentVault = activeCollateral === 'cspr' ? csprVault : scsprVault;
  const currentPrice = activeCollateral === 'cspr' ? csprPrice : scsprPrice;
  const hasExistingVault = currentVault !== null;

  return (
    <div className="min-h-screen">
      <Header />

      <main className="mx-auto max-w-6xl px-4 md:px-6 lg:px-8 py-10">
        {/* Collateral Type Tabs */}
        <div className="flex justify-center">
          <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1 shadow-sm">
            <button
              onClick={() => setActiveCollateral('cspr')}
              className={`px-6 py-2 text-sm font-medium rounded-md transition-colors ${
                activeCollateral === 'cspr'
                  ? 'bg-primary-600 text-white'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              CSPR Vault
            </button>
            <button
              onClick={() => setActiveCollateral('scspr')}
              className={`px-6 py-2 text-sm font-medium rounded-md transition-colors ${
                activeCollateral === 'scspr'
                  ? 'bg-primary-600 text-white'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              stCSPR Vault
            </button>
          </div>
        </div>

        {/* CDP Main Content */}
        <div className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Column - Vault Status */}
          <div className="lg:col-span-2 space-y-6">
            {/* Existing Vault Card */}
            <CdpVaultCard
              vault={currentVault}
              collateralType={activeCollateral}
              collateralPrice={currentPrice}
              isLoading={isLoading}
              txStatus={txStatus}
              txError={txError}
              onClose={() => closeVault(activeCollateral)}
              resetTxState={resetTxState}
            />

            {/* Open New Vault Card */}
            <CdpOpenVaultCard
              collateralType={activeCollateral}
              collateralPrice={currentPrice}
              balances={balances}
              hasExistingVault={hasExistingVault}
              txStatus={txStatus}
              txError={txError}
              onOpenVault={openVault}
              previewOpenVault={previewOpenVault}
              resetTxState={resetTxState}
            />
          </div>

          {/* Right Column - Protocol Stats */}
          <div>
            <CdpStatsCard
              csprBranch={csprBranch}
              scsprBranch={scsprBranch}
              csprPrice={csprPrice}
              scsprPrice={scsprPrice}
              isLoading={isLoading}
            />
          </div>
        </div>

        <footer className="mt-16 text-center text-sm text-gray-600 pb-8">
          <p>GasparFinance Protocol • Casper Testnet • Casper Wallet</p>
        </footer>
      </main>
    </div>
  );
}
