'use client';

import { useEffect } from 'react';

/** Registra el service worker (aplicación instalable, uso sin conexión y avisos push). */
export function ServiceWorker() {
  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }
  }, []);
  return null;
}
