import type { Metadata } from 'next';
import './globals.css';
import { Providers } from './providers';
import { loadRuntimeConfig } from '@/lib/runtimeConfig';

export const metadata: Metadata = {
  title: 'GasparFinance | Casper',
  description: 'Casper-native CDP protocol frontend',
  icons: {
    icon: '/protocol-logo.webp',
    shortcut: '/protocol-logo.webp',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const runtimeConfig = loadRuntimeConfig();
  const runtimeConfigJson = runtimeConfig
    ? JSON.stringify(runtimeConfig).replace(/</g, '\\u003c')
    : 'null';

  return (
    <html lang="en">
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__CSPR_CDP_CONFIG__ = ${runtimeConfigJson};`,
          }}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
