'use client';

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { TxToast } from '@/components/ui/TxToast';
import type { TxStatus } from './useCdp';

interface UseTxToastParams {
  title: string;
  status: TxStatus;
  error?: string | null;
  deployHash?: string | null;
}

const TOAST_ID = 'tx-toast';
const SUCCESS_DURATION = 5000;
const ERROR_DURATION = 6000;

export function useTxToast({ title, status, error, deployHash }: UseTxToastParams) {
  const prevStatusRef = useRef<TxStatus>('idle');

  useEffect(() => {
    // Don't show toast for idle state unless transitioning from non-idle
    if (status === 'idle') {
      // Only dismiss if we were previously showing something
      if (prevStatusRef.current !== 'idle') {
        toast.dismiss(TOAST_ID);
      }
      prevStatusRef.current = status;
      return;
    }

    // Determine duration based on status
    const isTerminal = status === 'success' || status === 'error';
    const duration = isTerminal
      ? status === 'success'
        ? SUCCESS_DURATION
        : ERROR_DURATION
      : Infinity;

    // Show or update toast
    toast.custom(
      () =>
        TxToast({
          title,
          status,
          error,
          deployHash,
        }),
      {
        id: TOAST_ID,
        duration,
        dismissible: true,
      }
    );

    prevStatusRef.current = status;
  }, [title, status, error, deployHash]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      toast.dismiss(TOAST_ID);
    };
  }, []);
}
