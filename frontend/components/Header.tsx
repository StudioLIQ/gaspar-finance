'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import { useCasperWallet } from '@/hooks/useCasperWallet';
import { useBalances } from '@/hooks/useBalances';
import { useSafeMode } from '@/hooks/useSafeMode';
import { SUPPORTED_WALLET } from '@/lib/config';
import { shortenPublicKey, cn } from '@/lib/utils';
import { formatCsprAmount, formatGusdAmount, type SafeModeStatus } from '@/lib/casperRpc';
import {
  SafeModeBadge,
  formatSafeModeReason,
  formatSafeModeReasonDetail,
  formatSafeModeTime,
} from '@/components/SafeModeBanner';

const NAV_ITEMS = [
  { href: '/', label: 'CDP' },
  { href: '/lst', label: 'LST' },
  { href: '/stability-pool', label: 'Stability Pool' },
  { href: '/redeem', label: 'Redeem' },
];

function SafeModeIndicator({
  safeMode,
  className,
}: {
  safeMode: SafeModeStatus | null;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const popoverId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const impactedActions = [
    'Open or close a vault',
    'Borrow more or withdraw collateral',
    'Redeem gUSD for collateral',
    'Withdraw or claim Stability Pool gains',
  ];

  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!safeMode?.isActive) setIsOpen(false);
  }, [safeMode?.isActive]);

  useEffect(() => {
    const handleOpen = () => setIsOpen(true);
    window.addEventListener('safe-mode:open', handleOpen);
    return () => window.removeEventListener('safe-mode:open', handleOpen);
  }, []);

  if (!safeMode?.isActive) return null;

  const reasonLabel = formatSafeModeReason(safeMode.reason);
  const reasonDetail = formatSafeModeReasonDetail(safeMode.reason);
  const triggeredLabel = formatSafeModeTime(safeMode.triggeredAt);

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={popoverId}
        aria-haspopup="dialog"
        onClick={() => setIsOpen((prev) => !prev)}
        className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      >
        <SafeModeBadge
          isActive
          reason={safeMode.reason}
          triggeredAt={safeMode.triggeredAt}
          className="pointer-events-none"
        />
      </button>

      {isOpen && (
        <div
          id={popoverId}
          role="dialog"
          aria-label="Safe Mode details"
          className="absolute right-0 mt-2 w-72 rounded-xl border border-amber-200 bg-white/95 p-4 shadow-lg backdrop-blur"
        >
          <p className="text-xs uppercase tracking-wider text-amber-600 font-semibold">
            Safe Mode Details
          </p>
          <p className="mt-2 text-sm text-gray-900 font-medium">{reasonLabel}</p>
          {reasonDetail && (
            <p className="mt-1 text-xs text-gray-600">{reasonDetail}</p>
          )}
          <div className="mt-3 text-xs text-gray-500">
            Triggered: {triggeredLabel ?? 'Unknown'}
          </div>
          <div className="mt-3">
            <p className="text-xs font-semibold text-gray-700">Impacted actions</p>
            <ul className="mt-2 list-disc list-inside text-xs text-gray-600 space-y-1">
              {impactedActions.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-gray-500">
              Deposits and debt repayments remain available.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export function Header() {
  const pathname = usePathname();
  const { isInstalled, isConnected, publicKey, isBusy, connect, disconnect } = useCasperWallet();
  const { balances, isLoading: isLoadingBalances } = useBalances({ isConnected, publicKey });
  const { safeMode } = useSafeMode();
  const prevSafeModeRef = useRef<boolean | null>(null);

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

  useEffect(() => {
    if (!safeMode) return;
    if (prevSafeModeRef.current === null) {
      prevSafeModeRef.current = safeMode.isActive;
      return;
    }
    if (safeMode.isActive === prevSafeModeRef.current) return;

    const reasonLabel = formatSafeModeReason(safeMode.reason);
    const reasonDetail = formatSafeModeReasonDetail(safeMode.reason);

    if (safeMode.isActive) {
      toast.warning('Safe Mode activated', {
        description: reasonDetail ?? `Reason: ${reasonLabel}`,
        duration: 8000,
        action: {
          label: '자세히 보기',
          onClick: () => window.dispatchEvent(new CustomEvent('safe-mode:open')),
        },
      });
    } else {
      toast.success('Safe Mode cleared', {
        description: 'Oracle data stabilized. Protocol actions resumed.',
        duration: 5000,
      });
    }

    prevSafeModeRef.current = safeMode.isActive;
  }, [safeMode]);

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
          <nav className="hidden sm:flex items-center gap-1 ml-4 flex-shrink-0" aria-label="Main navigation">
            {NAV_ITEMS.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? 'page' : undefined}
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
          <SafeModeIndicator safeMode={safeMode} className="hidden md:block" />
          {/* Wallet Info - Address & Balances */}
          {isConnected && publicKey && (
            <div className="hidden lg:flex items-center gap-4 bg-gray-50 rounded-lg px-4 py-2">
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
                    {isLoadingBalances ? '...' : formatGusdAmount(balances.gusd ?? BigInt(0))}
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

          {/* Tablet/Mobile: Just show address */}
          {isConnected && publicKey && (
            <div className="lg:hidden flex flex-col text-right">
              <span className="text-sm font-medium text-gray-900">{shortenPublicKey(publicKey, 6)}</span>
            </div>
          )}

          <Button variant={isConnected ? 'secondary' : 'primary'} size="sm" isLoading={isBusy} onClick={onClick}>
            {buttonLabel}
          </Button>
        </div>
      </div>

      {safeMode?.isActive && (
        <div className="md:hidden px-4 pb-3">
          <SafeModeIndicator safeMode={safeMode} className="w-full" />
        </div>
      )}

      {/* Mobile Navigation */}
      <nav className="sm:hidden border-t border-gray-100 px-4 py-2 flex gap-2" aria-label="Mobile navigation">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? 'page' : undefined}
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
      </nav>
    </header>
  );
}
