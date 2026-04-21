import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Live Translation Dashboard',
  description: 'Real-time latency monitoring for the Live Translation voice pipeline',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-gray-950 text-gray-100 antialiased">
        {children}
      </body>
    </html>
  );
}
