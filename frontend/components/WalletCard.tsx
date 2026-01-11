'use client';

import { useCallback } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useCasperWallet } from '@/hooks/useCasperWallet';
import { useBalances } from '@/hooks/useBalances';
import { shortenPublicKey } from '@/lib/utils';
import { formatCsprAmount } from '@/lib/casperRpc';

export function WalletCard() {
  const {
    isInstalled,
    isConnected,
    publicKey,
    isBusy,
    error,
    connect,
    disconnect,
    refresh: refreshWallet,
  } = useCasperWallet();

  const { balances, isLoading: isLoadingBalances, refresh: refreshBalances } = useBalances({ isConnected, publicKey });

  // Refresh both wallet and balances
  const refresh = useCallback(() => {
    refreshWallet();
    refreshBalances();
  }, [refreshWallet, refreshBalances]);

  return (
    <Card title="Wallet" subtitle="Casper Wallet only">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-600">Extension</span>
          <span className={`text-sm font-medium ${isInstalled ? 'text-success' : 'text-error'}`}>
            {isInstalled ? 'Detected' : 'Not installed'}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-600">Status</span>
          <span className={`text-sm font-medium ${isConnected ? 'text-success' : 'text-gray-500'}`}>
            {isConnected ? 'Connected' : 'Not connected'}
          </span>
        </div>
        <div className="flex items-start justify-between gap-4">
          <span className="text-sm text-gray-600">Public Key</span>
          <span className="text-sm font-medium text-gray-900 break-all text-right">
            {publicKey ? shortenPublicKey(publicKey, 10) : '--'}
          </span>
        </div>

        {/* Balances */}
        {isConnected && (
          <div className="border-t border-gray-100 pt-4 mt-4">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Balances</p>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600">CSPR</span>
                <span className="text-sm font-semibold text-gray-900">
                  {isLoadingBalances
                    ? '...'
                    : balances.cspr !== null
                      ? formatCsprAmount(balances.cspr)
                      : '0.00'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600">stCSPR</span>
                <span className="text-sm font-semibold text-gray-900">
                  {isLoadingBalances
                    ? '...'
                    : balances.scspr !== null
                      ? formatCsprAmount(balances.scspr)
                      : '0.00'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600">gUSD</span>
                <span className="text-sm font-semibold text-gray-900">
                  {isLoadingBalances
                    ? '...'
                    : balances.gusd !== null
                      ? formatCsprAmount(balances.gusd)
                      : '0.00'}
                </span>
              </div>
            </div>
          </div>
        )}

        {error && (
          <p className="text-sm text-error">{error}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant={isConnected ? 'secondary' : 'primary'}
            size="sm"
            isLoading={isBusy}
            onClick={isConnected ? disconnect : connect}
            disabled={!isInstalled}
          >
            {isConnected ? 'Disconnect' : 'Connect'}
          </Button>
          <Button variant="secondary" size="sm" onClick={refresh} disabled={isBusy}>
            Refresh
          </Button>
        </div>
        {!isInstalled && (
          <p className="text-xs text-gray-500">
            Casper Wallet browser extension is required.
          </p>
        )}
      </div>
    </Card>
  );
}
