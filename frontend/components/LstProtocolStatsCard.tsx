'use client';

import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatCsprAmount, formatRate } from '@/lib/casperRpc';
import type { LstProtocolStats } from '@/hooks/useLst';

interface LstProtocolStatsCardProps {
  stats: LstProtocolStats | null;
  isLoading: boolean;
}

function StatRow({
  label,
  value,
  subValue,
}: {
  label: string;
  value: string;
  subValue?: string;
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-gray-600">{label}</span>
      <div className="text-right">
        <span className="text-sm font-medium text-gray-900">{value}</span>
        {subValue && (
          <span className="block text-xs text-gray-500">{subValue}</span>
        )}
      </div>
    </div>
  );
}

export function LstProtocolStatsCard({ stats, isLoading }: LstProtocolStatsCardProps) {
  if (isLoading) {
    return (
      <Card title="Protocol Statistics" subtitle="stCSPR ybToken">
        <div className="space-y-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      </Card>
    );
  }

  if (!stats) {
    return (
      <Card title="Protocol Statistics" subtitle="stCSPR ybToken">
        <div className="py-8 text-center text-gray-500">
          Unable to load protocol statistics.
        </div>
      </Card>
    );
  }

  return (
    <Card title="Protocol Statistics" subtitle="stCSPR ybToken">
      <div className="divide-y divide-gray-100">
        <StatRow
          label="Exchange Rate (R)"
          value={`${formatRate(stats.exchangeRate)} CSPR/stCSPR`}
        />
        <StatRow
          label="Total Assets"
          value={`${formatCsprAmount(stats.totalAssets)} CSPR`}
        />
        <StatRow
          label="Total Shares (Supply)"
          value={`${formatCsprAmount(stats.totalShares)} stCSPR`}
        />

        <div className="pt-3 mt-3">
          <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
            Asset Breakdown
          </h4>
          <StatRow
            label="Idle CSPR"
            value={`${formatCsprAmount(stats.idleCspr)} CSPR`}
            subValue="Available for delegation"
          />
          <StatRow
            label="Delegated CSPR"
            value={`${formatCsprAmount(stats.delegatedCspr)} CSPR`}
            subValue="Earning rewards"
          />
          <StatRow
            label="Undelegating CSPR"
            value={`${formatCsprAmount(stats.undelegatingCspr)} CSPR`}
            subValue="In cooldown period"
          />
          <StatRow
            label="Claimable CSPR"
            value={`${formatCsprAmount(stats.claimableCspr)} CSPR`}
            subValue="Ready for withdrawals"
          />
        </div>
      </div>
    </Card>
  );
}
