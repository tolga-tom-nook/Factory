/**
 * Root layout for QA Tools UI.
 *
 * Provides the global navigation shell. All pages are client components;
 * this server layout just supplies the HTML skeleton and meta tags.
 */

import type { Metadata } from 'next';
import Script from 'next/script';
import './globals.css';
import { NavBar } from '@/components/nav';

export const metadata: Metadata = {
  title: { default: 'QA Tools', template: '%s — QA Tools' },
  description: 'Factory QA Testing Platform — a11y audits, screenshots, and regression detection.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Script src="https://accounts.google.com/gsi/client" async defer />
        <NavBar />
        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          {children}
        </main>
      </body>
    </html>
  );
}
