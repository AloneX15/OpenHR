import type { NextConfig } from 'next';

const isProd = process.env.NODE_ENV === 'production';

// Política de seguridad de contenidos de lo que no es una página (respuestas de la API,
// estáticos): sin scripts en línea. Las páginas reciben la suya, con un nonce por petición,
// en src/proxy.ts, que sustituye a esta.
const csp = [
  "default-src 'self'",
  `script-src 'self'${isProd ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  // Las peticiones a /api/* las reenvía src/app/api/[...path]/route.ts a la API (API_URL),
  // así web y API comparten origen y la cookie de sesión funciona sin CORS.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'Content-Security-Policy', value: csp },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(self), payment=(), usb=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
