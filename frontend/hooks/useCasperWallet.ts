'use client';

import { useCallback, useEffect, useState } from 'react';

type CasperWalletHelper = {
  isConnected?: () => Promise<boolean> | boolean;
  requestConnection?: () => Promise<boolean | void> | boolean | void;
  getActivePublicKey?: () => Promise<string> | string;
  getPublicKey?: () => Promise<string> | string;
  disconnectFromSite?: () => Promise<void> | void;
  disconnect?: () => Promise<void> | void;
  // Deploy signing methods (various Casper wallet implementations)
  sign?: (deployJson: string, publicKey: string) => Promise<{ deploy: unknown } | string>;
  signDeploy?: (deployJson: unknown, publicKey: string) => Promise<unknown>;
  signMessage?: (message: string, publicKey: string) => Promise<string>;
};

// Cache the provider instance to avoid re-creating it
let cachedProvider: CasperWalletHelper | null = null;

function getCasperHelper(): CasperWalletHelper | null {
  if (typeof window === 'undefined') return null;

  // Return cached provider if available
  if (cachedProvider) return cachedProvider;

  // Modern Casper Wallet: CasperWalletProvider is a factory function
  const providerFactory = (window as any).CasperWalletProvider;
  if (typeof providerFactory === 'function') {
    try {
      cachedProvider = providerFactory() as CasperWalletHelper;
      return cachedProvider;
    } catch {
      // Factory call failed, continue to fallbacks
    }
  }

  // Legacy fallbacks for older wallet versions
  const legacyCandidates = [
    'casperlabsHelper',
    'casperWalletProvider',
    'CasperWallet',
    'casperWallet',
    'CasperSigner',
    'casperwallet',
  ] as const;

  for (const key of legacyCandidates) {
    const candidate = (window as any)[key];
    if (!candidate) continue;
    if (
      typeof candidate.requestConnection === 'function' ||
      typeof candidate.isConnected === 'function' ||
      typeof candidate.getActivePublicKey === 'function' ||
      typeof candidate.getPublicKey === 'function'
    ) {
      cachedProvider = candidate as CasperWalletHelper;
      return cachedProvider;
    }
  }

  return null;
}

async function resolveBoolean(value: unknown): Promise<boolean | undefined> {
  if (typeof value === 'boolean') return value;
  if (value && typeof (value as Promise<boolean>).then === 'function') {
    try {
      return await (value as Promise<boolean>);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function resolveString(value: unknown): Promise<string | undefined> {
  if (typeof value === 'string') return value;
  if (value && typeof (value as Promise<string>).then === 'function') {
    try {
      return await (value as Promise<string>);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function useCasperWallet() {
  const [isInstalled, setIsInstalled] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const helper = getCasperHelper();
    setIsInstalled(Boolean(helper));
    setError(null);

    if (!helper) {
      setIsConnected(false);
      setPublicKey(null);
      return;
    }

    try {
      const connected = helper.isConnected
        ? await resolveBoolean(helper.isConnected())
        : undefined;

      if (connected === undefined) {
        const keyFallback = helper.getActivePublicKey
          ? await resolveString(helper.getActivePublicKey())
          : helper.getPublicKey
            ? await resolveString(helper.getPublicKey())
            : undefined;
        if (keyFallback) {
          setIsConnected(true);
          setPublicKey(keyFallback);
          return;
        }
        setIsConnected(false);
        setPublicKey(null);
        return;
      }

      setIsConnected(connected);
      if (connected) {
        const key = helper.getActivePublicKey
          ? await resolveString(helper.getActivePublicKey())
          : helper.getPublicKey
            ? await resolveString(helper.getPublicKey())
            : undefined;
        setPublicKey(key ?? null);
      } else {
        setPublicKey(null);
      }
    } catch (err) {
      setError('Failed to read Casper Wallet status');
      setIsConnected(false);
      setPublicKey(null);
    }
  }, []);

  useEffect(() => {
    let attempts = 0;
    let cleared = false;
    let intervalId: number | undefined;

    const tick = async () => {
      await refresh();
      attempts += 1;
      if (getCasperHelper() || attempts >= 10) {
        if (!cleared && intervalId !== undefined) {
          clearInterval(intervalId);
          cleared = true;
        }
      }
    };

    void tick();

    intervalId = window.setInterval(() => {
      void tick();
    }, 500); // Check more frequently for wallet injection

    const onFocus = () => {
      void refresh();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };

    // Listen to Casper Wallet events (modern wallet dispatches these)
    const onWalletEvent = (event: Event) => {
      try {
        const detail = (event as CustomEvent).detail;
        if (detail) {
          // Handle wallet state changes
          if (detail.isConnected !== undefined) {
            setIsConnected(detail.isConnected);
          }
          if (detail.activeKey) {
            setPublicKey(detail.activeKey);
          }
          if (detail.isLocked) {
            setIsConnected(false);
            setPublicKey(null);
          }
        }
      } catch {
        // Fallback to refresh
        void refresh();
      }
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    // Casper Wallet custom events
    window.addEventListener('casper-wallet:connected', onWalletEvent);
    window.addEventListener('casper-wallet:disconnected', onWalletEvent);
    window.addEventListener('casper-wallet:activeKeyChanged', onWalletEvent);
    window.addEventListener('casper-wallet:locked', onWalletEvent);
    window.addEventListener('casper-wallet:unlocked', onWalletEvent);

    return () => {
      if (intervalId !== undefined) {
        clearInterval(intervalId);
      }
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('casper-wallet:connected', onWalletEvent);
      window.removeEventListener('casper-wallet:disconnected', onWalletEvent);
      window.removeEventListener('casper-wallet:activeKeyChanged', onWalletEvent);
      window.removeEventListener('casper-wallet:locked', onWalletEvent);
      window.removeEventListener('casper-wallet:unlocked', onWalletEvent);
    };
  }, [refresh]);

  const connect = useCallback(async () => {
    const helper = getCasperHelper();
    if (!helper) {
      setIsInstalled(false);
      setError('Casper Wallet is not installed');
      return;
    }

    setIsBusy(true);
    setError(null);

    try {
      if (!helper.requestConnection) {
        setError('Casper Wallet connection API not found');
        setIsConnected(false);
        setPublicKey(null);
        return;
      }

      const approved = await resolveBoolean(helper.requestConnection());
      if (approved === false) {
        setError('Connection request was rejected');
        setIsConnected(false);
        setPublicKey(null);
        return;
      }

      const key = helper.getActivePublicKey
        ? await resolveString(helper.getActivePublicKey())
        : helper.getPublicKey
          ? await resolveString(helper.getPublicKey())
          : undefined;

      setIsConnected(true);
      setPublicKey(key ?? null);
    } catch (err) {
      setError('Failed to connect to Casper Wallet');
      setIsConnected(false);
      setPublicKey(null);
    } finally {
      setIsBusy(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const helper = getCasperHelper();
    setIsBusy(true);
    setError(null);

    try {
      if (helper?.disconnectFromSite) {
        await helper.disconnectFromSite();
      } else if (helper?.disconnect) {
        await helper.disconnect();
      }
      setIsConnected(false);
      setPublicKey(null);
    } catch (err) {
      setError('Failed to disconnect from Casper Wallet');
    } finally {
      setIsBusy(false);
    }
  }, []);

  /**
   * Sign a deploy using the Casper Wallet
   *
   * @param deployJson The deploy object to sign
   * @returns The signed deploy object, or null if signing failed
   */
  const signDeploy = useCallback(
    async (deployJson: unknown): Promise<unknown | null> => {
      const helper = getCasperHelper();
      if (!helper) {
        setError('Casper Wallet not installed');
        return null;
      }

      if (!publicKey) {
        setError('Wallet not connected');
        return null;
      }

      setIsBusy(true);
      setError(null);

      try {
        let signedDeploy: unknown;

        // Try different signing methods based on wallet implementation
        if (helper.signDeploy) {
          // CasperLabs Signer style
          signedDeploy = await helper.signDeploy(deployJson, publicKey);
        } else if (helper.sign) {
          // Casper Wallet style - expects JSON string
          const deployJsonStr =
            typeof deployJson === 'string' ? deployJson : JSON.stringify(deployJson);
          const result = await helper.sign(deployJsonStr, publicKey);
          signedDeploy = typeof result === 'string' ? JSON.parse(result) : result;
        } else {
          setError('Wallet does not support deploy signing');
          return null;
        }

        return signedDeploy;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Deploy signing failed';
        setError(message);
        return null;
      } finally {
        setIsBusy(false);
      }
    },
    [publicKey]
  );

  return {
    isInstalled,
    isConnected,
    publicKey,
    isBusy,
    error,
    connect,
    disconnect,
    refresh,
    signDeploy,
  };
}
