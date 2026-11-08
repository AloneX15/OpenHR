'use client';

import { usePathname, useRouter } from 'next/navigation';
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api';

export interface Me {
  userId: string;
  tenantId: string;
  tenantName: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  mfaEnabled: boolean;
  personId: string | null;
  isAdmin: boolean;
  isCompliance: boolean;
  isHr: boolean;
  hrCompanyIds: string[] | null;
  isManager: boolean;
  employments: {
    id: string;
    company_id: string;
    company_name: string;
    job_title: string | null;
    work_center_name: string | null;
    timezone: string;
  }[];
}

const SessionContext = createContext<{ me: Me; reload: () => Promise<void> } | null>(null);

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession fuera de SessionProvider');
  return ctx;
}

/** Carga la sesión; si no hay, manda a /login (o a la configuración inicial). */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  const reload = useCallback(async () => {
    try {
      setMe(await api.get<Me>('/auth/me'));
    } catch {
      const { done } = await api.get<{ done: boolean }>('/setup/status').catch(() => ({ done: true }));
      router.replace(done ? `/login?next=${encodeURIComponent(pathname)}` : '/configuracion-inicial');
    }
  }, [router, pathname]);

  useEffect(() => {
    void reload();
    const onUnauthorized = () => router.replace('/login');
    window.addEventListener('openhr:unauthorized', onUnauthorized);
    return () => window.removeEventListener('openhr:unauthorized', onUnauthorized);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!me) return <div className="splash">Cargando…</div>;
  return <SessionContext.Provider value={{ me, reload }}>{children}</SessionContext.Provider>;
}
