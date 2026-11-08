'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode, useState } from 'react';
import { api } from '@/lib/api';
import { Me, SessionProvider, useSession } from '@/lib/session';
import { IconName, useHoverIcon } from './icons';
import { ThemeSwitch } from './ThemeSwitch';

const NAV: { href: string; label: string; icon: IconName; show: (m: Me) => boolean }[] = [
  { href: '/', label: 'Inicio', icon: 'home', show: () => true },
  { href: '/horario', label: 'Mi control horario', icon: 'clock', show: (m) => m.employments.length > 0 },
  { href: '/turnos', label: 'Turnos', icon: 'calendar', show: (m) => m.isManager || m.isHr },
  { href: '/ausencias', label: 'Ausencias', icon: 'vacation', show: () => true },
  { href: '/gastos', label: 'Gastos', icon: 'expenses', show: (m) => m.employments.length > 0 || m.isHr },
  { href: '/documentos', label: 'Documentos', icon: 'documents', show: () => true },
  { href: '/firmas', label: 'Firmas', icon: 'sign', show: () => true },
  { href: '/tareas', label: 'Tareas', icon: 'tasks', show: () => true },
  { href: '/encuestas', label: 'Encuestas', icon: 'surveys', show: () => true },
  { href: '/anuncios', label: 'Anuncios', icon: 'announcements', show: () => true },
  { href: '/politicas', label: 'Políticas', icon: 'policies', show: () => true },
  { href: '/equipo', label: 'Equipo', icon: 'team', show: (m) => m.isManager || m.isHr },
  { href: '/organizacion', label: 'Organización', icon: 'organization', show: (m) => m.isHr },
  { href: '/informes', label: 'Informes', icon: 'reports', show: (m) => m.isHr },
  { href: '/canal-denuncias', label: 'Canal de denuncias', icon: 'whistleblowing', show: (m) => m.isCompliance },
  { href: '/privacidad', label: 'Privacidad', icon: 'privacy', show: () => true },
];

function NavLink({ href, label, icon, active, onNavigate }: { href: string; label: string; icon: IconName; active: boolean; onNavigate: () => void }) {
  const { icon: node, handlers } = useHoverIcon(icon, 18);
  return (
    <Link href={href} className={active ? 'nav-link active' : 'nav-link'} aria-current={active ? 'page' : undefined} onClick={onNavigate} {...handlers}>
      <span className="nav-icon">{node}</span>
      {label}
    </Link>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const name = [me.firstName, me.lastName].filter(Boolean).join(' ') || me.email;
  const logoutIcon = useHoverIcon('logout', 16);
  const menuIcon = useHoverIcon('menu', 22);

  const logout = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    router.replace('/login');
  };

  return (
    <div className="shell">
      <a href="#contenido" className="skip-link">
        Saltar al contenido
      </a>
      <aside className={open ? 'sidebar open' : 'sidebar'} aria-label="Menú principal">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            O
          </span>
          <div>
            <strong>OpenHR</strong>
            <small>{me.tenantName}</small>
          </div>
        </div>
        <nav>
          {NAV.filter((n) => n.show(me)).map((n) => (
            <NavLink
              key={n.href}
              href={n.href}
              label={n.label}
              icon={n.icon}
              active={n.href === '/' ? pathname === '/' : pathname.startsWith(n.href)}
              onNavigate={() => setOpen(false)}
            />
          ))}
        </nav>
        <div className="sidebar-foot">
          <ThemeSwitch compact />
          <Link href="/cuenta" className="user-chip" onClick={() => setOpen(false)}>
            <span className="avatar" aria-hidden>
              {name.slice(0, 1).toUpperCase()}
            </span>
            <span>
              {name}
              <small>{me.isAdmin ? 'Administración' : me.isHr ? 'RR. HH.' : me.isManager ? 'Responsable' : 'Empleado/a'}</small>
            </span>
          </Link>
          <button className="btn btn-ghost btn-sm" onClick={logout} {...logoutIcon.handlers}>
            {logoutIcon.icon}
            Cerrar sesión
          </button>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <button className="btn-icon" onClick={() => setOpen(!open)} aria-label="Abrir menú" aria-expanded={open} {...menuIcon.handlers}>
            {menuIcon.icon}
          </button>
          <strong>OpenHR</strong>
        </div>
        <main id="contenido" className="content" tabIndex={-1}>
          {children}
        </main>
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
