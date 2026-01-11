'use client';

import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useCasperWallet } from '@/hooks/useCasperWallet';
import {
  formatCsprAmount,
  formatGusdAmount,
  CDP_CONSTANTS,
  type VaultInfo,
  type CollateralType,
  type TxStatus,
} from '@/hooks/useCdp';

interface CdpVaultCardProps {
  vault: VaultInfo | null;
  collateralType: CollateralType;
  collateralPrice: bigint;
  isLoading: boolean;
  txStatus: TxStatus;
  txError: string | null;
  onClose: () => Promise<boolean>;
  onAdjust?: () => void;
  resetTxState: () => void;
}

export function CdpVaultCard({
  vault,
  collateralType,
  collateralPrice,
  isLoading,
  txStatus,
  txError,
  onClose,
  onAdjust,
  resetTxState,
}: CdpVaultCardProps) {
  const { isConnected } = useCasperWallet();

  const collateralLabel = collateralType === 'cspr' ? 'CSPR' : 'stCSPR';
  const isProcessing = txStatus === 'signing' || txStatus === 'pending';

  // Format price for display (18 decimals -> USD)
  const priceUsd = Number(collateralPrice) / 1e18;

  // Calculate liquidation price
  const liquidationPrice = vault
    ? Number(
        (vault.vault.debt * BigInt(CDP_CONSTANTS.MCR_BPS) * BigInt(1e9)) /
          (vault.vault.collateral * BigInt(10000))
      ) / 1e18
    : 0;

  // CR status color
  const getCrColor = (crBps: number) => {
    if (crBps >= 20000) return 'text-green-600'; // >= 200%
    if (crBps >= 15000) return 'text-yellow-600'; // >= 150%
    if (crBps >= 11000) return 'text-orange-500'; // >= 110%
    return 'text-red-600'; // < 110%
  };

  const handleClose = async () => {
    resetTxState();
    await onClose();
  };

  if (!isConnected) {
    return (
      <Card
        title={`My ${collateralLabel} Vault`}
        subtitle="Connect wallet to view"
      >
        <div className="text-center py-8 text-gray-500">
          <p>Connect your wallet to view your vault</p>
        </div>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card title={`My ${collateralLabel} Vault`} subtitle="Loading...">
        <div className="space-y-3">
          <div className="animate-shimmer rounded-md bg-gray-100 h-8 w-full" />
          <div className="animate-shimmer rounded-md bg-gray-100 h-8 w-full" />
          <div className="animate-shimmer rounded-md bg-gray-100 h-8 w-full" />
        </div>
      </Card>
    );
  }

  if (!vault) {
    return (
      <Card
        title={`My ${collateralLabel} Vault`}
        subtitle="No active vault"
      >
        <div className="text-center py-8">
          <p className="text-gray-500 mb-4">You don&apos;t have an active {collateralLabel} vault</p>
          <p className="text-sm text-gray-400">
            Open a vault to deposit {collateralLabel} and borrow gUSD
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card
      title={`My ${collateralLabel} Vault`}
      subtitle={`CR: ${(vault.icrBps / 100).toFixed(1)}%`}
    >
      <div className="space-y-4">
        {/* Collateral */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-600">Collateral</span>
          <div className="text-right">
            <span className="text-sm font-semibold text-gray-900">
              {formatCsprAmount(vault.vault.collateral)} {collateralLabel}
            </span>
            <p className="text-xs text-gray-500">
              ≈ ${(Number(vault.collateralValueUsd) / 1e18).toFixed(2)}
            </p>
          </div>
        </div>

        {/* Debt */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-600">Debt</span>
          <span className="text-sm font-semibold text-gray-900">
            {formatGusdAmount(vault.vault.debt)} gUSD
          </span>
        </div>

        {/* Collateralization Ratio */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-600">Collateral Ratio</span>
          <span className={`text-sm font-semibold ${getCrColor(vault.icrBps)}`}>
            {(vault.icrBps / 100).toFixed(1)}%
          </span>
        </div>

        {/* Interest Rate */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-600">Interest Rate</span>
          <span className="text-sm font-semibold text-gray-900">
            {(vault.vault.interestRateBps / 100).toFixed(2)}%
          </span>
        </div>

        {/* Liquidation Price */}
        <div className="flex items-center justify-between border-t border-gray-100 pt-4">
          <span className="text-sm text-gray-600">Liquidation Price</span>
          <span className="text-sm font-semibold text-orange-600">
            ${liquidationPrice.toFixed(4)}
          </span>
        </div>

        {/* Current Price */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-600">Current Price</span>
          <span className="text-sm font-semibold text-gray-900">
            ${priceUsd.toFixed(4)}
          </span>
        </div>

        {/* Error Display */}
        {txError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-700">{txError}</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-2">
          {onAdjust && (
            <Button
              variant="secondary"
              size="sm"
              className="flex-1"
              onClick={onAdjust}
              disabled={isProcessing}
            >
              Adjust
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            className="flex-1"
            onClick={handleClose}
            disabled={isProcessing}
            isLoading={isProcessing}
          >
            Close Vault
          </Button>
        </div>

        {/* Min CR Warning */}
        {vault.icrBps < CDP_CONSTANTS.CCR_BPS && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
            <p className="text-xs text-yellow-700">
              Your vault is below the recommended 150% CR. Consider adding collateral or repaying debt to avoid liquidation.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
