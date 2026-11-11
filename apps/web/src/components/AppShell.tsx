'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useStagger } from '@/lib/motion';
import { Me, SessionProvider, useSession } from '@/lib/session';
import { ClockWidget } from './ClockWidget';
import { Icon, IconName, useHoverIcon } from './icons';
import { ThemeSwitch } from './ThemeSwitch';
import { Collapse, Menu, Modal } from './ui';

type NavItem = { href: string; label: string; icon: IconName; show: (m: Me) => boolean };

const HOME: NavItem = { href: '/', label: 'Inicio', icon: 'home', show: () => true };

/** El menú se agrupa por para quién es cada cosa: lo mío, lo de la empresa y lo que gestiono. */
const GROUPS: { id: string; title: string; items: NavItem[] }[] = [
  {
    id: 'mio',
    title: 'Mi espacio',
    items: [
      { href: '/horario', label: 'Mi control horario', icon: 'clock', show: (m) => m.employments.length > 0 },
      { href: '/ausencias', label: 'Ausencias', icon: 'vacation', show: () => true },
      { href: '/gastos', label: 'Gastos', icon: 'expenses', show: (m) => m.employments.length > 0 || m.isHr },
      { href: '/documentos', label: 'Documentos', icon: 'documents', show: () => true },
      { href: '/firmas', label: 'Firmas', icon: 'sign', show: () => true },
      { href: '/tareas', label: 'Tareas', icon: 'tasks', show: () => true },
      { href: '/consultas', label: 'Consultas a RR. HH.', icon: 'tickets', show: (m) => m.employments.length > 0 || m.isHr },
    ],
  },
  {
    id: 'empresa',
    title: 'Empresa',
    items: [
      { href: '/anuncios', label: 'Anuncios', icon: 'announcements', show: () => true },
      { href: '/politicas', label: 'Políticas', icon: 'policies', show: () => true },
      { href: '/encuestas', label: 'Encuestas', icon: 'surveys', show: () => true },
      { href: '/privacidad', label: 'Privacidad', icon: 'privacy', show: () => true },
    ],
  },
  {
    id: 'gestion',
    title: 'Gestión',
    items: [
      { href: '/equipo', label: 'Equipo', icon: 'team', show: (m) => m.isManager || m.isHr },
      { href: '/turnos', label: 'Turnos', icon: 'calendar', show: (m) => m.isManager || m.isHr },
      { href: '/organizacion', label: 'Organización', icon: 'organization', show: (m) => m.isHr },
      { href: '/informes', label: 'Informes', icon: 'reports', show: (m) => m.isHr },
      { href: '/canal-denuncias', label: 'Canal de denuncias', icon: 'whistleblowing', show: (m) => m.isCompliance },
    ],
  },
];

const COLLAPSED_KEY = 'openhr-nav-collapsed';

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

function NavLink({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate: () => void }) {
  const { icon: node, handlers } = useHoverIcon(item.icon, 18);
  return (
    <Link href={item.href} className={active ? 'nav-link active' : 'nav-link'} aria-current={active ? 'page' : undefined} onClick={onNavigate} {...handlers}>
      <span className="nav-icon">{node}</span>
      {item.label}
    </Link>
  );
}

function NavGroup({ title, items, pathname, open, onToggle, onNavigate }: { title: string; items: NavItem[]; pathname: string; open: boolean; onToggle: () => void; onNavigate: () => void }) {
  return (
    <div className="nav-group">
      <button type="button" className="nav-group-title" aria-expanded={open} onClick={onToggle}>
        {title}
        <span className="chev">
          <Icon name="chevronDown" size={14} />
        </span>
      </button>
      <Collapse open={open}>
        <div className="nav-group-items">
          {items.map((n) => (
            <NavLink key={n.href} item={n} active={isActive(pathname, n.href)} onNavigate={onNavigate} />
          ))}
        </div>
      </Collapse>
    </div>
  );
}

function TabLink({ href, label, icon, active }: { href: string; label: string; icon: IconName; active: boolean }) {
  const { icon: node, handlers } = useHoverIcon(icon, 22);
  return (
    <Link href={href} className={active ? 'tabbar-item active' : 'tabbar-item'} aria-current={active ? 'page' : undefined} {...handlers}>
      {node}
      {label}
    </Link>
  );
}

type ClockState = 'out' | 'working' | 'break';

function Shell({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [clocking, setClocking] = useState(false);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [clockState, setClockState] = useState<ClockState>('out');
  const content = useStagger<HTMLElement>(pathname);
  const name = [me.firstName, me.lastName].filter(Boolean).join(' ') || me.email;
  const role = me.isAdmin ? 'Administración' : me.isHr ? 'RR. HH.' : me.isManager ? 'Responsable' : 'Empleado/a';
  const menuIcon = useHoverIcon('menu', 22);
  const moreIcon = useHoverIcon('grid', 22);
  const canClock = me.employments.length > 0;

  useEffect(() => {
    try {
      setCollapsed(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'));
    } catch {
      /* almacenamiento no disponible */
    }
  }, []);

  const toggleGroup = (id: string) => {
    const next = collapsed.includes(id) ? collapsed.filter((g) => g !== id) : [...collapsed, id];
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
    } catch {
      /* almacenamiento no disponible */
    }
  };

  // Estado del fichaje para el botón central de la barra inferior.
  const refreshClock = useCallback(async () => {
    if (!canClock) return;
    const status = await api.get<{ state: ClockState }[]>('/time/status').catch(() => []);
    setClockState(status.some((s) => s.state === 'working') ? 'working' : status.some((s) => s.state === 'break') ? 'break' : 'out');
  }, [canClock]);
  useEffect(() => {
    void refreshClock();
  }, [refreshClock, pathname]);

  const logout = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    router.replace('/login');
  };

  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((n) => n.show(me)) })).filter((g) => g.items.length);
  const closeDrawer = () => setOpen(false);

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
            <small title={me.tenantName}>{me.tenantName}</small>
          </div>
        </div>
        <nav>
          <NavLink item={HOME} active={pathname === '/'} onNavigate={closeDrawer} />
          {groups.map((g) => (
            <NavGroup
              key={g.id}
              title={g.title}
              items={g.items}
              pathname={pathname}
              // Un grupo plegado se abre solo si la página actual está dentro.
              open={!collapsed.includes(g.id) || g.items.some((n) => isActive(pathname, n.href))}
              onToggle={() => toggleGroup(g.id)}
              onNavigate={closeDrawer}
            />
          ))}
        </nav>
        <div className="sidebar-foot">
          <ThemeSwitch compact />
          <Menu
            label={`Cuenta de ${name}`}
            className="user-chip"
            align="start"
            up
            header={<span className="eyebrow">{me.email}</span>}
            items={[
              { label: 'Mi cuenta', icon: 'user', href: '/cuenta' },
              { label: 'Privacidad y mis datos', icon: 'privacy', href: '/privacidad' },
              'separator',
              { label: 'Cerrar sesión', icon: 'logout', onSelect: logout, danger: true },
            ]}
          >
            <span className="avatar" aria-hidden>
              {name.slice(0, 1).toUpperCase()}
            </span>
            <span className="who">
              {name}
              <small>{role}</small>
            </span>
            <Icon name="more" size={18} />
          </Menu>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <button className="btn-icon" onClick={() => setOpen(!open)} aria-label="Abrir menú" aria-expanded={open} {...menuIcon.handlers}>
            {menuIcon.icon}
          </button>
          <span className="brand-mark" aria-hidden>
            O
          </span>
          <strong>OpenHR</strong>
          <Link href="/cuenta" className="avatar" aria-label="Mi cuenta">
            {name.slice(0, 1).toUpperCase()}
          </Link>
        </div>
        <main id="contenido" className="content" tabIndex={-1} ref={content}>
          {children}
        </main>
      </div>
      {open && <div className="scrim" onClick={closeDrawer} />}

      <nav className="tabbar" aria-label="Accesos rápidos" style={canClock ? undefined : { gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <TabLink href="/" label="Inicio" icon="home" active={pathname === '/'} />
        {canClock ? <TabLink href="/horario" label="Horario" icon="clock" active={isActive(pathname, '/horario')} /> : <TabLink href="/documentos" label="Documentos" icon="documents" active={isActive(pathname, '/documentos')} />}
        {canClock && (
          <button
            type="button"
            className="tabbar-fab"
            data-state={clockState}
            onClick={() => setClocking(true)}
            aria-label={clockState === 'working' ? 'Fichaje: estás trabajando' : clockState === 'break' ? 'Fichaje: estás en pausa' : 'Fichar'}
          >
            <Icon name={clockState === 'working' ? 'pause' : 'play'} size={24} />
          </button>
        )}
        <TabLink href="/ausencias" label="Ausencias" icon="vacation" active={isActive(pathname, '/ausencias')} />
        <button type="button" className="tabbar-item" onClick={() => setOpen(true)} aria-label="Abrir el menú completo" {...moreIcon.handlers}>
          {moreIcon.icon}
          Más
        </button>
      </nav>

      {clocking && (
        <Modal
          title="Fichaje"
          onClose={() => {
            setClocking(false);
            void refreshClock();
          }}
        >
          <ClockWidget me={me} onChange={refreshClock} />
        </Modal>
      )}
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
