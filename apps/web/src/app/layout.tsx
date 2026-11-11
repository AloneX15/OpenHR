import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { MotionRoot } from '@/components/MotionRoot';
import { ServiceWorker } from '@/components/ServiceWorker';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'OpenHR', template: '%s · OpenHR' },
  description: 'Gestión de personas open source y autoalojable',
  // Instalable como aplicación (PWA) para fichar desde el móvil.
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
  appleWebApp: { capable: true, title: 'OpenHR', statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#0b1f3a' },
    { media: '(prefers-color-scheme: dark)', color: '#050e1a' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Nonce de la CSP de esta petición (lo genera src/proxy.ts). Leerlo hace que las páginas
  // se rendericen en cada petición, que es lo que necesita un nonce.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        {/* Aplica el tema guardado antes de pintar (evita el destello del tema equivocado). */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        {children}
        <ServiceWorker />
        <MotionRoot />
      </body>
    </html>
  );
}
