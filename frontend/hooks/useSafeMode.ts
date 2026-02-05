'use client';

import { useCallback, useEffect, useState } from 'react';
import { getRouterSafeMode, type SafeModeStatus } from '@/lib/casperRpc';
import { DATA_REFRESH_INTERVAL_MS } from '@/lib/constants';

export function useSafeMode() {
  const [safeMode, setSafeMode] = useState<SafeModeStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await getRouterSafeMode();
      setSafeMode(data);
    } catch (error) {
      console.warn('[useSafeMode] refresh failed:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const intervalId = setInterval(() => void refresh(), DATA_REFRESH_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [refresh]);

  return { safeMode, isLoading, refresh };
}
