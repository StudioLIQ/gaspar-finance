'use client';

import { useState } from 'react';

export function LstStubWarning() {
  const [isDismissed, setIsDismissed] = useState(false);

  if (isDismissed) return null;

  return (
    <div className="mb-6 bg-amber-50 border border-amber-200 rounded-xl p-4 relative">
      <button
        onClick={() => setIsDismissed(true)}
        className="absolute top-3 right-3 text-amber-500 hover:text-amber-700 transition-colors"
        aria-label="Dismiss warning"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-5 w-5"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      <div className="flex items-start gap-3 pr-8">
        <div className="flex-shrink-0 mt-0.5">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5 text-amber-500"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
              clipRule="evenodd"
            />
          </svg>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-amber-800">
            Testnet Preview - Browser Wallet Integration
          </h3>
          <p className="mt-1 text-sm text-amber-700">
            <strong>All LST operations</strong> (Stake, Unstake, Claim) are now functional
            via Casper Wallet browser signing.
          </p>
          <p className="mt-2 text-sm text-amber-700">
            <strong>Note:</strong> Staking uses proxy_caller.wasm to attach CSPR to the deposit call.
            Ensure you have sufficient CSPR for both the stake amount and gas fees (~5 CSPR).
          </p>
          <p className="mt-2 text-xs text-amber-600">
            Ensure your Casper Wallet extension is installed and connected.
          </p>
        </div>
      </div>
    </div>
  );
}
