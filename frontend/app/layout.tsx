import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { loadRuntimeConfig } from '@/lib/runtimeConfig';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

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
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="font-sans">
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
