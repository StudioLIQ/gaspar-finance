'use client';

import { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { useCasperWallet } from '@/hooks/useCasperWallet';
import { SUPPORTED_WALLET } from '@/lib/config';
import { shortenPublicKey, cn } from '@/lib/utils';
import {
  getAccountCsprBalance,
  getLstBalance,
  getGusdBalance,
  formatCsprAmount,
} from '@/lib/casperRpc';

const NAV_ITEMS = [
  { href: '/', label: 'CDP' },
  { href: '/lst', label: 'LST' },
  { href: '/stability-pool', label: 'Stability Pool' },
  { href: '/redeem', label: 'Redeem' },
];

interface Balances {
  cspr: bigint | null;
  scspr: bigint | null;
  gusd: bigint | null;
}

export function Header() {
  const pathname = usePathname();
  const { isInstalled, isConnected, publicKey, isBusy, connect, disconnect } = useCasperWallet();

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

  const buttonLabel = !isInstalled
    ? 'Casper Wallet required'
    : isConnected
      ? 'Disconnect'
      : 'Connect Wallet';

  const onClick = async () => {
    if (!isInstalled) return;
    if (isConnected) {
      await disconnect();
    } else {
      await connect();
    }
  };

  return (
    <header className="sticky top-0 z-50 border-b border-gray-200 bg-white/80 backdrop-blur">
      <div className="mx-auto max-w-6xl px-4 md:px-6 lg:px-8 py-4 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-3">
            <Image src="/protocol-logo.webp" alt="Protocol logo" width={40} height={40} />
            <div>
              <h1 className="text-lg font-semibold text-gray-900">GasparFinance</h1>
              <p className="text-xs text-gray-500">{SUPPORTED_WALLET}</p>
            </div>
          </Link>

          {/* Navigation */}
          <nav className="hidden sm:flex items-center gap-1 ml-4">
            {NAV_ITEMS.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'px-4 py-2 text-sm font-medium rounded-lg transition-colors',
                    isActive
                      ? 'bg-primary-100 text-primary-700'
                      : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-4">
          {/* Network Badge */}
          <span className="hidden sm:inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
            Testnet
          </span>

          {/* Wallet Info - Address & Balances */}
          {isConnected && publicKey && (
            <div className="hidden md:flex items-center gap-4 bg-gray-50 rounded-lg px-4 py-2">
              {/* Balances */}
              <div className="flex items-center gap-3 text-sm">
                <span className="text-gray-600">
                  <span className="font-medium text-gray-900">
                    {isLoadingBalances ? '...' : formatCsprAmount(balances.cspr ?? BigInt(0))}
                  </span>
                  {' '}CSPR
                </span>
                <span className="text-gray-300">|</span>
                <span className="text-gray-600">
                  <span className="font-medium text-gray-900">
                    {isLoadingBalances ? '...' : formatCsprAmount(balances.scspr ?? BigInt(0))}
                  </span>
                  {' '}stCSPR
                </span>
                <span className="text-gray-300">|</span>
                <span className="text-gray-600">
                  <span className="font-medium text-gray-900">
                    {isLoadingBalances ? '...' : formatCsprAmount(balances.gusd ?? BigInt(0))}
                  </span>
                  {' '}gUSD
                </span>
              </div>
              <span className="text-gray-300">|</span>
              {/* Address */}
              <span className="text-sm font-medium text-gray-900">
                {shortenPublicKey(publicKey, 6)}
              </span>
            </div>
          )}

          {/* Mobile: Just show address */}
          {isConnected && publicKey && (
            <div className="md:hidden flex flex-col text-right">
              <span className="text-sm font-medium text-gray-900">{shortenPublicKey(publicKey, 6)}</span>
            </div>
          )}

          <Button variant={isConnected ? 'secondary' : 'primary'} size="sm" isLoading={isBusy} onClick={onClick}>
            {buttonLabel}
          </Button>
        </div>
      </div>

      {/* Mobile Navigation */}
      <div className="sm:hidden border-t border-gray-100 px-4 py-2 flex gap-2">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex-1 py-2 text-center text-sm font-medium rounded-lg transition-colors',
                isActive
                  ? 'bg-primary-100 text-primary-700'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </header>
  );
}
