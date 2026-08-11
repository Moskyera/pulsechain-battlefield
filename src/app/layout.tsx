import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PulseChain Battlefield · Live On-Chain Combat',
  description:
    'A real-time 3D battlefield driven entirely by live PulseChain data. Every unit, explosion and front-line movement comes from actual on-chain swaps, reserves and prices.',
};

export const viewport: Viewport = {
  themeColor: '#04070b',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  // The canvas handles its own gestures; browser zoom on drag would fight it.
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
