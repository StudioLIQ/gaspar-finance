'use client';

import { Header } from '@/components/Header';
import { WalletCard } from '@/components/WalletCard';
import { NetworkCard } from '@/components/NetworkCard';
import { ProtocolStatusCard } from '@/components/ProtocolStatusCard';

export default function Home() {
  return (
    <div className="min-h-screen">
      <Header />

      <main className="mx-auto max-w-6xl px-4 md:px-6 lg:px-8 py-10">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <WalletCard />
          <NetworkCard />
        </div>

        <div className="mt-8">
          <ProtocolStatusCard />
        </div>

        <footer className="mt-16 text-center text-sm text-gray-600 pb-8">
          <p>Casper CDP Protocol • Casper Testnet • Casper Wallet</p>
        </footer>
      </main>
    </div>
  );
}
