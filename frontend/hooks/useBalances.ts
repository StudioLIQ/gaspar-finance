'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  getAccountCsprBalance,
  getLstBalance,
  getGusdBalance,
} from '@/lib/casperRpc';

export interface Balances {
  cspr: bigint | null;
  scspr: bigint | null;
  gusd: bigint | null;
}

const EMPTY_BALANCES: Balances = {
  cspr: null,
  scspr: null,
  gusd: null,
};

interface UseBalancesOptions {
  isConnected: boolean;
  publicKey: string | null;
}

interface UseBalancesReturn {
  balances: Balances;
  isLoading: boolean;
  refresh: () => void;
}

/**
 * Hook to fetch and manage wallet balances (CSPR, stCSPR, gUSD)
 */
export function useBalances({ isConnected, publicKey }: UseBalancesOptions): UseBalancesReturn {
  const [balances, setBalances] = useState<Balances>(EMPTY_BALANCES);
  const [isLoading, setIsLoading] = useState(false);

  const fetchBalances = useCallback(async () => {
    if (!isConnected || !publicKey) {
      setBalances(EMPTY_BALANCES);
      return;
    }

    setIsLoading(true);
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
    } catch {
      // Silently fail - balances will remain null
      // Error logging removed for production cleanliness
    } finally {
      setIsLoading(false);
    }
  }, [isConnected, publicKey]);

  useEffect(() => {
    void fetchBalances();
  }, [fetchBalances]);

  const refresh = useCallback(() => {
    void fetchBalances();
  }, [fetchBalances]);

  return { balances, isLoading, refresh };
}
