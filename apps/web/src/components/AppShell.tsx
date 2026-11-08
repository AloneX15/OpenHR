'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode, useState } from 'react';
import { api } from '@/lib/api';
import { SessionProvider, useSession } from '@/lib/session';

const NAV = [
  { href: '/', label: 'Inicio', icon: '⌂', show: () => true },
  { href: '/horario', label: 'Mi control horario', icon: '◷', show: (m: any) => m.employments.length > 0 },
  { href: '/ausencias', label: 'Ausencias', icon: '☼', show: () => true },
  { href: '/documentos', label: 'Documentos', icon: '▤', show: () => true },
  { href: '/equipo', label: 'Equipo', icon: '◎', show: (m: any) => m.isManager || m.isHr },
  { href: '/organizacion', label: 'Organización', icon: '▦', show: (m: any) => m.isHr },
  { href: '/informes', label: 'Informes', icon: '⇩', show: (m: any) => m.isHr },
];

function Shell({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const name = [me.firstName, me.lastName].filter(Boolean).join(' ') || me.email;

  const logout = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    router.replace('/login');
  };

  return (
    <div className="shell">
      <aside className={open ? 'sidebar open' : 'sidebar'}>
        <div className="brand">
          <span className="brand-mark">O</span>
          <div>
            <strong>OpenHR</strong>
            <small>{me.tenantName}</small>
          </div>
        </div>
        <nav>
          {NAV.filter((n) => n.show(me)).map((n) => {
            const active = n.href === '/' ? pathname === '/' : pathname.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href} className={active ? 'nav-link active' : 'nav-link'} onClick={() => setOpen(false)}>
                <span className="nav-icon" aria-hidden>
                  {n.icon}
                </span>
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <Link href="/cuenta" className="user-chip" onClick={() => setOpen(false)}>
            <span className="avatar">{name.slice(0, 1).toUpperCase()}</span>
            <span>
              {name}
              <small>{me.isAdmin ? 'Administración' : me.isHr ? 'RR. HH.' : me.isManager ? 'Responsable' : 'Empleado/a'}</small>
            </span>
          </Link>
          <button className="btn btn-ghost btn-sm" onClick={logout}>
            Cerrar sesión
          </button>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <button className="btn-icon" onClick={() => setOpen(!open)} aria-label="Menú">
            ☰
          </button>
          <strong>OpenHR</strong>
        </div>
        <main className="content">{children}</main>
      </div>
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <Shell>{children}</Shell>
    </SessionProvider>
  );
}
