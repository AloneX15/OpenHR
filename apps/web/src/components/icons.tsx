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
import { ClipboardCheckIcon } from '@animateicons/react/lucide/clipboard-check-icon';
import { ClipboardListIcon } from '@animateicons/react/lucide/clipboard-list-icon';
import { ClockIcon } from '@animateicons/react/lucide/clock-icon';
import { DownloadIcon } from '@animateicons/react/lucide/download-icon';
import { FileTextIcon } from '@animateicons/react/lucide/file-text-icon';
import { HouseIcon } from '@animateicons/react/lucide/house-icon';
import { LogOutIcon } from '@animateicons/react/lucide/log-out-icon';
import { MegaphoneIcon } from '@animateicons/react/lucide/megaphone-icon';
import { MenuIcon } from '@animateicons/react/lucide/menu-icon';
import { ScrollTextIcon } from '@animateicons/react/lucide/scroll-text-icon';
import { SignatureIcon } from '@animateicons/react/lucide/signature-icon';
import { MonitorIcon } from '@animateicons/react/lucide/monitor-icon';
import { MoonIcon } from '@animateicons/react/lucide/moon-icon';
import { PlaneIcon } from '@animateicons/react/lucide/plane-icon';
import { ReceiptIcon } from '@animateicons/react/lucide/receipt-icon';
import { PencilIcon } from '@animateicons/react/lucide/pencil-icon';
import { PlusIcon } from '@animateicons/react/lucide/plus-icon';
import { SettingsIcon } from '@animateicons/react/lucide/settings-icon';
import { ShieldCheckIcon } from '@animateicons/react/lucide/shield-check-icon';
import { ShieldUserIcon } from '@animateicons/react/lucide/shield-user-icon';
import { LockIcon } from '@animateicons/react/lucide/lock-icon';
import { LifeBuoyIcon } from '@animateicons/react/lucide/life-buoy-icon';
import { SunIcon } from '@animateicons/react/lucide/sun-icon';
import { TimerIcon } from '@animateicons/react/lucide/timer-icon';
import { UploadIcon } from '@animateicons/react/lucide/upload-icon';
import { UsersIcon } from '@animateicons/react/lucide/users-icon';
import { XIcon } from '@animateicons/react/lucide/x-icon';
import { ChevronDownIcon } from '@animateicons/react/lucide/chevron-down-icon';
import { ChevronLeftIcon } from '@animateicons/react/lucide/chevron-left-icon';
import { ChevronRightIcon } from '@animateicons/react/lucide/chevron-right-icon';
import { EllipsisIcon } from '@animateicons/react/lucide/ellipsis-icon';
import { PauseIcon } from '@animateicons/react/lucide/pause-icon';
import { PlayIcon } from '@animateicons/react/lucide/play-icon';
import { CoffeeIcon } from '@animateicons/react/lucide/coffee-icon';
import { PartyPopperIcon } from '@animateicons/react/lucide/party-popper-icon';
import { InboxIcon } from '@animateicons/react/lucide/inbox-icon';
import { InfoIcon } from '@animateicons/react/lucide/info-icon';
import { MapPinIcon } from '@animateicons/react/lucide/map-pin-icon';
import { UserIcon } from '@animateicons/react/lucide/user-icon';
import { LayoutGridIcon } from '@animateicons/react/lucide/layout-grid-icon';
import { CalendarPlusIcon } from '@animateicons/react/lucide/calendar-plus-icon';
import { ComponentType, ReactNode, RefAttributes, useRef } from 'react';

type AnyIcon = ComponentType<{ size?: number; className?: string; isAnimated?: boolean; 'aria-hidden'?: boolean } & RefAttributes<IconHandle>>;

export const Icons = {
  home: HouseIcon,
  clock: ClockIcon,
  timer: TimerIcon,
  vacation: PlaneIcon,
  expenses: ReceiptIcon,
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
  edit: PencilIcon,
  check: CheckIcon,
  tasks: ClipboardCheckIcon,
  surveys: ClipboardListIcon,
  tickets: LifeBuoyIcon,
  announcements: MegaphoneIcon,
  policies: ScrollTextIcon,
  sign: SignatureIcon,
  security: ShieldCheckIcon,
  privacy: LockIcon,
  whistleblowing: ShieldUserIcon,
  chevronDown: ChevronDownIcon,
  chevronLeft: ChevronLeftIcon,
  chevronRight: ChevronRightIcon,
  more: EllipsisIcon,
  pause: PauseIcon,
  play: PlayIcon,
  coffee: CoffeeIcon,
  party: PartyPopperIcon,
  inbox: InboxIcon,
  info: InfoIcon,
  pin: MapPinIcon,
  user: UserIcon,
  grid: LayoutGridIcon,
  calendarPlus: CalendarPlusIcon,
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
