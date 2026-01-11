'use client';

import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import type { LstExchangeRate } from '@/lib/casperRpc';

interface LstExchangeRateCardProps {
  exchangeRate: LstExchangeRate | null;
  isLoading: boolean;
  onRefresh: () => void;
  isRefreshing: boolean;
}

export function LstExchangeRateCard({
  exchangeRate,
  isLoading,
  onRefresh,
  isRefreshing,
}: LstExchangeRateCardProps) {
  const rate = exchangeRate?.rateFormatted ?? '1.000000';
  const lastUpdate = exchangeRate?.timestamp
    ? new Date(exchangeRate.timestamp).toLocaleTimeString()
    : '--';

  return (
    <Card>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-1">stCSPR Exchange Rate</h2>
          <p className="text-xs text-gray-500">R = CSPR per stCSPR (1e18 scale)</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={onRefresh}
          disabled={isRefreshing}
          isLoading={isRefreshing}
        >
          Refresh
        </Button>
      </div>

      <div className="mt-6 flex items-baseline gap-2">
        {isLoading ? (
          <Skeleton className="h-10 w-48" />
        ) : (
          <>
            <span className="text-4xl font-bold text-primary-600">{rate}</span>
            <span className="text-lg text-gray-500">CSPR/stCSPR</span>
          </>
        )}
      </div>

      <div className="mt-4 flex items-center gap-4 text-sm text-gray-500">
        <div className="flex items-center gap-1">
          <span>1 stCSPR =</span>
          <span className="font-medium text-gray-700">{rate} CSPR</span>
        </div>
        <span className="text-gray-300">|</span>
        <div className="flex items-center gap-1">
          <span>Updated:</span>
          <span className="font-medium text-gray-700">{lastUpdate}</span>
        </div>
      </div>
    </Card>
  );
}
