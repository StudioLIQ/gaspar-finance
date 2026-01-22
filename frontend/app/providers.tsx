'use client';

import { Toaster } from 'sonner';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <Toaster
        richColors
        closeButton
        position="top-right"
        expand
        toastOptions={{
          duration: 5000,
        }}
      />
    </>
  );
}
