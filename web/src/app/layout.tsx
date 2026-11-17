import type { Metadata, Viewport } from 'next';
import './globals.css';
import Footer from '@/components/Footer';
import Header from '@/components/Header';
import { siteUrl } from '@/lib/server';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: 'Whimsy Web: make the internet yours', template: '%s · Whimsy Web' },
  description: 'A community library of themes for the websites you use every day. Discover one, preview it, and apply it with the Whimsy Web extension.',
  openGraph: { title: 'Whimsy Web', description: 'Make the internet yours.', type: 'website' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, colorScheme: 'light dark' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="skip-link">Skip to content</a>
        <Header />
        <main id="main" className="container page">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
