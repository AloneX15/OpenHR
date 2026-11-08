'use client';

import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
const KEY = 'openhr-theme';

/**
 * Script que se ejecuta antes de pintar la página para aplicar el tema guardado y evitar
 * un destello del tema equivocado. 'system' no fija atributo: manda prefers-color-scheme.
 */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem('${KEY}');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

function apply(pref: ThemePreference) {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

export function useTheme(): [ThemePreference, (p: ThemePreference) => void] {
  const [pref, setPref] = useState<ThemePreference>('system');

  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === 'light' || saved === 'dark') setPref(saved);
    } catch {
      /* almacenamiento no disponible */
    }
  }, []);

  const update = useCallback((p: ThemePreference) => {
    setPref(p);
    apply(p);
    try {
      if (p === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, p);
    } catch {
      /* almacenamiento no disponible */
    }
  }, []);

  return [pref, update];
}
