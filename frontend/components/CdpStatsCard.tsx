'use client';

import { Card } from '@/components/ui/Card';
import { formatCsprAmount, formatGusdAmount, type BranchStatus } from '@/hooks/useCdp';

interface CdpStatsCardProps {
  csprBranch: BranchStatus | null;
  scsprBranch: BranchStatus | null;
  csprPrice: bigint;
  scsprPrice: bigint;
  isLoading: boolean;
}

export function CdpStatsCard({
  csprBranch,
  scsprBranch,
  csprPrice,
  scsprPrice,
  isLoading,
}: CdpStatsCardProps) {
  if (isLoading) {
    return (
      <Card title="Protocol Statistics" subtitle="Loading...">
        <div className="space-y-3">
          <div className="animate-shimmer rounded-md bg-gray-100 h-8 w-full" />
          <div className="animate-shimmer rounded-md bg-gray-100 h-8 w-full" />
          <div className="animate-shimmer rounded-md bg-gray-100 h-8 w-full" />
        </div>
      </Card>
    );
  }

  const totalCollateralCspr = csprBranch?.totalCollateral ?? BigInt(0);
  const totalCollateralScspr = scsprBranch?.totalCollateral ?? BigInt(0);
  const totalDebtCspr = csprBranch?.totalDebt ?? BigInt(0);
  const totalDebtScspr = scsprBranch?.totalDebt ?? BigInt(0);
  const totalVaults = (csprBranch?.vaultCount ?? 0) + (scsprBranch?.vaultCount ?? 0);

  // Calculate TVL in USD
  const csprValueUsd = (totalCollateralCspr * csprPrice) / BigInt(1e9);
  const scsprValueUsd = (totalCollateralScspr * scsprPrice) / BigInt(1e9);
  const totalTvlUsd = csprValueUsd + scsprValueUsd;
  const totalDebt = totalDebtCspr + totalDebtScspr;

  return (
    <Card title="Protocol Statistics" subtitle="GasparFinance CDP">
      <div className="space-y-4">
        {/* TVL */}
        <div className="bg-primary-50 rounded-lg p-4">
          <p className="text-xs text-primary-600 font-medium uppercase tracking-wider mb-1">
            Total Value Locked
          </p>
          <p className="text-2xl font-bold text-primary-900">
            ${(Number(totalTvlUsd) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </p>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 gap-4">
          {/* Total Debt */}
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-xs text-gray-500 mb-1">Total Debt</p>
            <p className="text-lg font-semibold text-gray-900">
              {formatGusdAmount(totalDebt, 0)} gUSD
            </p>
          </div>

          {/* Total Vaults */}
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-xs text-gray-500 mb-1">Active Vaults</p>
            <p className="text-lg font-semibold text-gray-900">{totalVaults}</p>
          </div>
        </div>

        {/* Branch Details */}
        <div className="border-t border-gray-100 pt-4">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
            By Collateral
          </p>

          {/* CSPR Branch */}
          <div className="flex items-center justify-between py-2">
            <span className="text-sm text-gray-600">CSPR</span>
            <div className="text-right">
              <span className="text-sm font-semibold text-gray-900">
                {formatCsprAmount(totalCollateralCspr)} CSPR
              </span>
              <p className="text-xs text-gray-500">
                {csprBranch?.vaultCount ?? 0} vaults
              </p>
            </div>
          </div>

          {/* stCSPR Branch */}
          <div className="flex items-center justify-between py-2">
            <span className="text-sm text-gray-600">stCSPR</span>
            <div className="text-right">
              <span className="text-sm font-semibold text-gray-900">
                {formatCsprAmount(totalCollateralScspr)} stCSPR
              </span>
              <p className="text-xs text-gray-500">
                {scsprBranch?.vaultCount ?? 0} vaults
              </p>
            </div>
          </div>
        </div>

        {/* Prices */}
        <div className="border-t border-gray-100 pt-4">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
            Oracle Prices
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">CSPR</span>
              <span className="text-sm font-semibold text-gray-900">
                ${(Number(csprPrice) / 1e18).toFixed(4)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">stCSPR</span>
              <span className="text-sm font-semibold text-gray-900">
                ${(Number(scsprPrice) / 1e18).toFixed(4)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
