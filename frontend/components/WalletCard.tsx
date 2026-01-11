'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useCasperWallet } from '@/hooks/useCasperWallet';
import { shortenPublicKey } from '@/lib/utils';
import {
  getAccountCsprBalance,
  getLstBalance,
  getGusdBalance,
  formatCsprAmount,
} from '@/lib/casperRpc';

interface Balances {
  cspr: bigint | null;
  scspr: bigint | null;
  gusd: bigint | null;
}

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

  const [balances, setBalances] = useState<Balances>({
    cspr: null,
    scspr: null,
    gusd: null,
  });
  const [isLoadingBalances, setIsLoadingBalances] = useState(false);

  // Fetch balances when connected
  const fetchBalances = useCallback(async () => {
    if (!isConnected || !publicKey) {
      setBalances({ cspr: null, scspr: null, gusd: null });
      return;
    }

    setIsLoadingBalances(true);
    try {
      const [csprBalance, lstBalance, gusdBalance] = await Promise.all([
        getAccountCsprBalance(publicKey),
        getLstBalance(publicKey),
        getGusdBalance(publicKey),
      ]);

      setBalances({
        cspr: csprBalance,
        scspr: lstBalance?.scsprBalance ?? null,
        gusd: gusdBalance,
      });
    } catch (err) {
      console.error('Failed to fetch balances:', err);
    } finally {
      setIsLoadingBalances(false);
    }
  }, [isConnected, publicKey]);

  useEffect(() => {
    void fetchBalances();
  }, [fetchBalances]);

  // Refresh both wallet and balances
  const refresh = useCallback(() => {
    refreshWallet();
    void fetchBalances();
  }, [refreshWallet, fetchBalances]);

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
