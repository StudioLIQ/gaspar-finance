'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { useCasperWallet } from '@/hooks/useCasperWallet';
import { CASPER_TESTNET, SUPPORTED_WALLET } from '@/lib/config';
import { shortenPublicKey, cn } from '@/lib/utils';

const NAV_ITEMS = [
  { href: '/', label: 'CDP' },
  { href: '/lst', label: 'LST' },
];

export function Header() {
  const pathname = usePathname();
  const { isInstalled, isConnected, publicKey, isBusy, connect, disconnect } = useCasperWallet();

  const buttonLabel = !isInstalled
    ? 'Casper Wallet required'
    : isConnected
      ? 'Disconnect'
      : 'Connect Casper Wallet';

  const onClick = async () => {
    if (!isInstalled) return;
    if (isConnected) {
      await disconnect();
    } else {
      await connect();
    }
  };

  return (
    <header className="border-b border-gray-200 bg-white/80 backdrop-blur">
      <div className="mx-auto max-w-6xl px-4 md:px-6 lg:px-8 py-4 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-3">
            <Image src="/logo.svg" alt="Casper CDP" width={40} height={40} />
            <div>
              <h1 className="text-lg font-semibold text-gray-900">Casper CDP</h1>
              <p className="text-xs text-gray-500">
                {CASPER_TESTNET.name} • {SUPPORTED_WALLET}
              </p>
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
          {isConnected && publicKey ? (
            <div className="hidden sm:flex flex-col text-right">
              <span className="text-xs text-gray-500">Connected</span>
              <span className="text-sm font-medium text-gray-900">{shortenPublicKey(publicKey, 8)}</span>
            </div>
          ) : (
            <span className="hidden sm:inline text-xs text-gray-500">Not connected</span>
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
