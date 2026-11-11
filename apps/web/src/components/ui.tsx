'use client';

import Link from 'next/link';
import { type KeyboardEvent as ReactKeyboardEvent, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useCollapse, useModalIn, usePopIn } from '@/lib/motion';
import { Icon, IconName, useHoverIcon } from './icons';

/** Carga datos y expone recarga; los errores se muestran con <ErrorBox>. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const ref = useRef(loader);
  ref.current = loader;
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await ref.current());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload, setData };
}

/** Ejecuta una acción mostrando estado de envío y error. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

export function ErrorBox({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <div className="alert alert-error" role="alert" aria-live="assertive">
      {error}
    </div>
  );
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'success' | 'warning' }) {
  return <div className={`alert alert-${tone}`}>{children}</div>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Card({ title, children, actions, className }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const close = useHoverIcon('close', 18);
  const ref = useModalIn<HTMLDivElement>();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="sheet-grip" aria-hidden />
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn-icon" onClick={onClose} aria-label="Cerrar" {...close.handlers}>
            {close.icon}
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Abre y cierra un desplegable: clic fuera y Escape lo cierran y devuelven el foco. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      root.current?.querySelector<HTMLElement>('[aria-haspopup]')?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, root };
}

/** Mueve el foco entre las opciones con las flechas, Inicio y Fin. */
function moveFocus(e: ReactKeyboardEvent<HTMLElement>) {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  e.preventDefault();
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('.option'));
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}

export interface SelectOption<T extends string> {
  value: T;
  label: ReactNode;
  hint?: ReactNode;
}

/**
 * Desplegable propio para elegir una opción entre pocas (sociedad, periodo, vista…).
 * En formularios largos se sigue usando <select>, que en móvil abre el selector del sistema.
 */
export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  block,
  align = 'start',
  icon,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SelectOption<T>[];
  /** Nombre accesible: qué se está eligiendo. */
  label: string;
  block?: boolean;
  align?: 'start' | 'end';
  icon?: IconName;
}) {
  const { open, setOpen, root } = usePopover();
  const pop = usePopIn<HTMLDivElement>(open);
  const chev = useHoverIcon('chevronDown', 16);
  const current = options.find((o) => o.value === value);
  useEffect(() => {
    if (open) (pop.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? pop.current?.querySelector<HTMLElement>('.option'))?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const pick = (v: T) => {
    onChange(v);
    setOpen(false);
    root.current?.querySelector<HTMLElement>('[aria-haspopup]')?.focus();
  };
  return (
    <div className={block ? 'select select-block' : 'select'} ref={root}>
      <button
        type="button"
        className="select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${typeof current?.label === 'string' ? current.label : ''}`}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => (e.key === 'ArrowDown' || e.key === 'ArrowUp') && (e.preventDefault(), setOpen(true))}
        {...chev.handlers}
      >
        {icon && <Icon name={icon} size={16} />}
        <span className="select-value">{current?.label ?? 'Elegir…'}</span>
        <span className="select-chev">{chev.icon}</span>
      </button>
      {open && (
        <div className={align === 'end' ? 'popover align-end' : 'popover'} role="listbox" aria-label={label} ref={pop} onKeyDown={moveFocus}>
          {options.map((o) => (
            <button key={o.value} type="button" role="option" aria-selected={o.value === value} className="option" onClick={() => pick(o.value)}>
              <span className="option-main">
                {o.label}
                {o.hint && <small>{o.hint}</small>}
              </span>
              {o.value === value && <Icon name="check" size={16} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export type MenuItem = { label: ReactNode; icon?: IconName; onSelect?: () => void; href?: string; danger?: boolean; disabled?: boolean } | 'separator';

/** Menú de acciones que se despliega desde un botón. */
export function Menu({
  label,
  items,
  children,
  className = 'btn',
  align = 'end',
  up,
  header,
}: {
  /** Nombre accesible del botón. */
  label: string;
  items: MenuItem[];
  /** Contenido del botón que abre el menú. */
  children: ReactNode;
  className?: string;
  align?: 'start' | 'end';
  /** Se abre hacia arriba (para botones al pie de la pantalla). */
  up?: boolean;
  header?: ReactNode;
}) {
  const { open, setOpen, root } = usePopover();
  const pop = usePopIn<HTMLDivElement>(open);
  useEffect(() => {
    if (open) pop.current?.querySelector<HTMLElement>('.option')?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <div className="select" ref={root}>
      <button type="button" className={className} aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen(!open)}>
        {children}
      </button>
      {open && (
        <div className={`popover${align === 'end' ? ' align-end' : ''}${up ? ' drop-up' : ''}`} role="menu" aria-label={label} ref={pop} onKeyDown={moveFocus}>
          {header && <div className="popover-label">{header}</div>}
          {items.map((item, i) =>
            item === 'separator' ? (
              <div key={i} className="option-sep" role="separator" />
            ) : item.href ? (
              <Link key={i} href={item.href} role="menuitem" className="option" onClick={() => setOpen(false)}>
                {item.icon && <Icon name={item.icon} size={16} />}
                <span className="option-main">{item.label}</span>
              </Link>
            ) : (
              <button
                key={i}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={item.danger ? 'option danger' : 'option'}
                onClick={() => {
                  setOpen(false);
                  item.onSelect?.();
                }}
              >
                {item.icon && <Icon name={item.icon} size={16} />}
                <span className="option-main">{item.label}</span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Contenido que se pliega y despliega en altura. */
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const ref = useCollapse<HTMLDivElement>(open);
  return (
    <div ref={ref} className={className} style={{ overflow: 'hidden' }}>
      {children}
    </div>
  );
}

/** Conmutador entre dos o tres vistas. */
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { id: T; label: ReactNode }[]; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Anterior / etiqueta / siguiente: para moverse por semanas, meses o años. */
export function Stepper({ label, onPrev, onNext, prevLabel = 'Anterior', nextLabel = 'Siguiente' }: { label: ReactNode; onPrev: () => void; onNext: () => void; prevLabel?: string; nextLabel?: string }) {
  const prev = useHoverIcon('chevronLeft', 16);
  const next = useHoverIcon('chevronRight', 16);
  return (
    <div className="stepper">
      <button type="button" className="btn-icon" onClick={onPrev} aria-label={prevLabel} {...prev.handlers}>
        {prev.icon}
      </button>
      <span className="stepper-label" aria-live="polite">
        {label}
      </span>
      <button type="button" className="btn-icon" onClick={onNext} aria-label={nextLabel} {...next.handlers}>
        {next.icon}
      </button>
    </div>
  );
}

/** Estado vacío con icono, título y una frase que dice qué hacer. */
export function EmptyState({ icon = 'inbox', title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={22} />
      </span>
      <strong>{title}</strong>
      {children && <span>{children}</span>}
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: ReactNode }[] }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? 'tab active' : 'tab'} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
