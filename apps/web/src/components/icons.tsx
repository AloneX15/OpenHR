'use client';

/**
 * Iconos animados de AnimateIcons (https://animateicons.in, licencia MIT, basados en Lucide).
 * Se importan uno a uno para no cargar el paquete entero. Todos respetan
 * prefers-reduced-motion: si la persona lo tiene activado, no se animan.
 */
import type { IconHandle } from '@animateicons/react';
import { BellIcon } from '@animateicons/react/lucide/bell-icon';
import { Building2Icon } from '@animateicons/react/lucide/building-2-icon';
import { CalendarDaysIcon } from '@animateicons/react/lucide/calendar-days-icon';
import { ChartColumnIcon } from '@animateicons/react/lucide/chart-column-icon';
import { CheckIcon } from '@animateicons/react/lucide/check-icon';
import { ClockIcon } from '@animateicons/react/lucide/clock-icon';
import { DownloadIcon } from '@animateicons/react/lucide/download-icon';
import { FileTextIcon } from '@animateicons/react/lucide/file-text-icon';
import { HouseIcon } from '@animateicons/react/lucide/house-icon';
import { LogOutIcon } from '@animateicons/react/lucide/log-out-icon';
import { MenuIcon } from '@animateicons/react/lucide/menu-icon';
import { MonitorIcon } from '@animateicons/react/lucide/monitor-icon';
import { MoonIcon } from '@animateicons/react/lucide/moon-icon';
import { PlaneIcon } from '@animateicons/react/lucide/plane-icon';
import { PlusIcon } from '@animateicons/react/lucide/plus-icon';
import { SettingsIcon } from '@animateicons/react/lucide/settings-icon';
import { ShieldCheckIcon } from '@animateicons/react/lucide/shield-check-icon';
import { SunIcon } from '@animateicons/react/lucide/sun-icon';
import { TimerIcon } from '@animateicons/react/lucide/timer-icon';
import { UploadIcon } from '@animateicons/react/lucide/upload-icon';
import { UsersIcon } from '@animateicons/react/lucide/users-icon';
import { XIcon } from '@animateicons/react/lucide/x-icon';
import { ComponentType, ReactNode, RefAttributes, useRef } from 'react';

type AnyIcon = ComponentType<{ size?: number; className?: string; isAnimated?: boolean; 'aria-hidden'?: boolean } & RefAttributes<IconHandle>>;

export const Icons = {
  home: HouseIcon,
  clock: ClockIcon,
  timer: TimerIcon,
  vacation: PlaneIcon,
  calendar: CalendarDaysIcon,
  documents: FileTextIcon,
  team: UsersIcon,
  organization: Building2Icon,
  reports: ChartColumnIcon,
  download: DownloadIcon,
  upload: UploadIcon,
  settings: SettingsIcon,
  logout: LogOutIcon,
  bell: BellIcon,
  sun: SunIcon,
  moon: MoonIcon,
  system: MonitorIcon,
  menu: MenuIcon,
  close: XIcon,
  plus: PlusIcon,
  check: CheckIcon,
  security: ShieldCheckIcon,
} satisfies Record<string, AnyIcon>;

export type IconName = keyof typeof Icons;

/** Icono decorativo suelto: se anima al pasar el ratón por encima. */
export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  const C = Icons[name] as AnyIcon;
  return (
    <span className={`icon-inline ${className ?? ''}`} aria-hidden>
      <C size={size} />
    </span>
  );
}

/**
 * Devuelve un icono controlado y los manejadores para animarlo cuando el ratón o el foco
 * entran en el elemento contenedor (un enlace o un botón), no solo en el icono.
 */
export function useHoverIcon(name: IconName, size = 18) {
  const ref = useRef<IconHandle>(null);
  const C = Icons[name] as AnyIcon;
  const start = () => ref.current?.startAnimation();
  const stop = () => ref.current?.stopAnimation();
  const icon: ReactNode = (
    <span className="icon-inline" aria-hidden>
      <C ref={ref} size={size} />
    </span>
  );
  return { icon, handlers: { onMouseEnter: start, onMouseLeave: stop, onFocus: start, onBlur: stop } };
}

/** Botón con icono animado. */
export function IconButton({
  icon,
  children,
  className = 'btn',
  size = 16,
  ...props
}: { icon: IconName; size?: number; children?: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { icon: node, handlers } = useHoverIcon(icon, size);
  return (
    <button className={className} {...handlers} {...props}>
      {node}
      {children}
    </button>
  );
}
