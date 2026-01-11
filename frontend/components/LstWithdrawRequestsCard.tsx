'use client';

import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { useCasperWallet } from '@/hooks/useCasperWallet';
import { formatCsprAmount, getUnbondingPeriodDisplay } from '@/lib/casperRpc';
import type { WithdrawRequest, TxStatus } from '@/hooks/useLst';

interface LstWithdrawRequestsCardProps {
  requests: WithdrawRequest[];
  isLoading: boolean;
  txStatus: TxStatus;
  txError: string | null;
  onClaim: (requestId: number) => Promise<boolean>;
  resetTxState: () => void;
}

function formatTimeRemaining(claimableAt: number): string {
  const now = Math.floor(Date.now() / 1000);
  const remaining = claimableAt - now;

  if (remaining <= 0) return 'Ready';

  const days = Math.floor(remaining / (24 * 60 * 60));
  const hours = Math.floor((remaining % (24 * 60 * 60)) / (60 * 60));
  const minutes = Math.floor((remaining % (60 * 60)) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function RequestRow({
  request,
  onClaim,
  isProcessing,
}: {
  request: WithdrawRequest;
  onClaim: (id: number) => void;
  isProcessing: boolean;
}) {
  const canClaim = request.status === 'claimable';

  return (
    <div className="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-900">
            #{request.id}
          </span>
          <span
            className={`px-2 py-0.5 text-xs font-medium rounded-full ${
              request.status === 'claimable'
                ? 'bg-green-100 text-green-700'
                : 'bg-yellow-100 text-yellow-700'
            }`}
          >
            {request.status === 'claimable' ? 'Ready' : formatTimeRemaining(request.claimableAt)}
          </span>
        </div>
        <div className="mt-1 text-sm text-gray-600">
          <span>{formatCsprAmount(request.shareAmount)} stCSPR</span>
          <span className="mx-2 text-gray-300">-&gt;</span>
          <span className="font-medium text-gray-900">
            {formatCsprAmount(request.quotedCsprAmount)} CSPR
          </span>
        </div>
      </div>
      <Button
        variant={canClaim ? 'success' : 'secondary'}
        size="sm"
        onClick={() => onClaim(request.id)}
        disabled={!canClaim || isProcessing}
        isLoading={isProcessing}
      >
        {canClaim ? 'Claim' : 'Pending'}
      </Button>
    </div>
  );
}

export function LstWithdrawRequestsCard({
  requests,
  isLoading,
  txStatus,
  txError,
  onClaim,
  resetTxState,
}: LstWithdrawRequestsCardProps) {
  const { isConnected } = useCasperWallet();
  const isProcessing = txStatus === 'signing' || txStatus === 'pending';

  const handleClaim = async (requestId: number) => {
    resetTxState();
    await onClaim(requestId);
  };

  const pendingCount = requests.filter((r) => r.status === 'pending').length;
  const claimableCount = requests.filter((r) => r.status === 'claimable').length;

  return (
    <Card
      title="Withdraw Requests"
      subtitle={
        isConnected
          ? `${pendingCount} pending, ${claimableCount} claimable`
          : 'Connect wallet to view'
      }
    >
      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : !isConnected ? (
        <div className="py-8 text-center text-gray-500">
          Connect your wallet to view withdraw requests.
        </div>
      ) : requests.length === 0 ? (
        <div className="py-8 text-center text-gray-500">
          No pending withdraw requests.
          <br />
          <span className="text-sm">
            Request an unstake above to create a withdraw request.
          </span>
        </div>
      ) : (
        <div className="space-y-0">
          {/* Error Display */}
          {txError && (
            <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-sm text-red-700">{txError}</p>
            </div>
          )}

          {requests.map((request) => (
            <RequestRow
              key={request.id}
              request={request}
              onClaim={handleClaim}
              isProcessing={isProcessing}
            />
          ))}
        </div>
      )}

      {/* Info footer */}
      {isConnected && requests.length > 0 && (
        <div className="mt-4 pt-4 border-t border-gray-100">
          <p className="text-xs text-gray-500">
            Withdraw requests have a {getUnbondingPeriodDisplay()} cooldown period. The CSPR amount
            is locked at the exchange rate when the request was created.
          </p>
        </div>
      )}
    </Card>
  );
}
