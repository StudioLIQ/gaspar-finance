'use client';

import { useEffect, useState } from 'react';
import { Header } from '@/components/Header';
import { CdpVaultCard } from '@/components/CdpVaultCard';
import { CdpAdjustVaultCard } from '@/components/CdpAdjustVaultCard';
import { CdpOpenVaultCard } from '@/components/CdpOpenVaultCard';
import { CdpStatsCard } from '@/components/CdpStatsCard';
import { SafeModeBanner } from '@/components/SafeModeBanner';
import { useCdp, type CollateralType } from '@/hooks/useCdp';

export default function Home() {
  const [activeCollateral, setActiveCollateral] = useState<CollateralType>('cspr');
  const [showAdjust, setShowAdjust] = useState(false);
  const [selectedVaultIds, setSelectedVaultIds] = useState<{
    cspr: bigint | null;
    scspr: bigint | null;
  }>({ cspr: null, scspr: null });

  const {
    csprVaults,
    scsprVaults,
    csprBranch,
    scsprBranch,
    stabilityPoolStats,
    csprPrice,
    scsprPrice,
    balances,
    isLoading,
    txStatus,
    txError,
    openVault,
    adjustVault,
    adjustInterestRate,
    closeVault,
    previewOpenVault,
    resetTxState,
  } = useCdp();

  useEffect(() => {
    setShowAdjust(false);
  }, [activeCollateral]);

  // Keep selection stable when vault lists change
  useEffect(() => {
    setSelectedVaultIds((prev) => {
      const next = { ...prev };
      if (csprVaults.length === 0) {
        next.cspr = null;
      } else if (!next.cspr || !csprVaults.some((v) => v.vaultId === next.cspr)) {
        next.cspr = csprVaults[0].vaultId;
      }
      if (scsprVaults.length === 0) {
        next.scspr = null;
      } else if (!next.scspr || !scsprVaults.some((v) => v.vaultId === next.scspr)) {
        next.scspr = scsprVaults[0].vaultId;
      }
      return next;
    });
  }, [csprVaults, scsprVaults]);

  const vaultsForType = activeCollateral === 'cspr' ? csprVaults : scsprVaults;
  const selectedIdForType =
    activeCollateral === 'cspr' ? selectedVaultIds.cspr : selectedVaultIds.scspr;
  const currentVault =
    (selectedIdForType
      ? vaultsForType.find((v) => v.vaultId === selectedIdForType)
      : null) ?? vaultsForType[0] ?? null;
  const currentPrice = activeCollateral === 'cspr' ? csprPrice : scsprPrice;
  const safeModeSource =
    csprBranch?.isSafeModeActive
      ? csprBranch
      : scsprBranch?.isSafeModeActive
        ? scsprBranch
        : null;

  return (
    <div className="min-h-screen">
      <Header />

      <main className="mx-auto max-w-6xl px-4 md:px-6 lg:px-8 py-10">
        <SafeModeBanner
          isActive={Boolean(safeModeSource?.isSafeModeActive)}
          triggeredAt={safeModeSource?.safeModeTriggeredAt}
          reason={safeModeSource?.safeModeReason}
          context="Vault operations are limited while Safe Mode is active."
        />

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
            {/* Vault Selector */}
            {vaultsForType.length > 1 && (
              <div className="flex justify-end">
                <div className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-sm">
                  <span className="text-sm text-gray-600">Vault</span>
                  <select
                    className="text-sm bg-transparent outline-none"
                    value={(currentVault?.vaultId ?? vaultsForType[0].vaultId).toString()}
                    onChange={(e) =>
                      setSelectedVaultIds((prev) => ({
                        ...prev,
                        [activeCollateral]: BigInt(e.target.value),
                      }))
                    }
                  >
                    {vaultsForType
                      .slice()
                      .sort((a, b) => (a.vaultId < b.vaultId ? -1 : a.vaultId > b.vaultId ? 1 : 0))
                      .map((v) => (
                        <option key={v.vaultId.toString()} value={v.vaultId.toString()}>
                          #{v.vaultId.toString()}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
            )}

            {/* Existing Vault Card */}
            <CdpVaultCard
              vault={currentVault}
              collateralType={activeCollateral}
              collateralPrice={currentPrice}
              isLoading={isLoading}
              txStatus={txStatus}
              txError={txError}
              onAdjust={() => setShowAdjust(true)}
              onClose={() =>
                currentVault ? closeVault(activeCollateral, currentVault.vaultId) : Promise.resolve(false)
              }
              resetTxState={resetTxState}
            />

            {/* Adjust Vault Card */}
            {showAdjust && currentVault && (
              <CdpAdjustVaultCard
                vault={currentVault}
                collateralType={activeCollateral}
                collateralPrice={currentPrice}
                balances={balances}
                txStatus={txStatus}
                txError={txError}
                onAdjustVault={adjustVault}
                onAdjustInterestRate={adjustInterestRate}
                onDone={() => setShowAdjust(false)}
                resetTxState={resetTxState}
              />
            )}

            {/* Open New Vault Card */}
            <CdpOpenVaultCard
              collateralType={activeCollateral}
              collateralPrice={currentPrice}
              balances={balances}
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
              stabilityPoolStats={stabilityPoolStats}
              csprPrice={csprPrice}
              scsprPrice={scsprPrice}
              isLoading={isLoading}
            />
          </div>
        </div>

        <footer className="mt-16 text-center text-sm text-gray-600 pb-8">
          <p>GasparFinance Protocol • Casper Wallet</p>
        </footer>
      </main>
    </div>
  );
}
