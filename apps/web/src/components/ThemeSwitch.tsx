'use client';

import { ThemePreference, useTheme } from '@/lib/theme';
import { IconName, useHoverIcon } from './icons';

const OPTIONS: { id: ThemePreference; label: string; icon: IconName }[] = [
  { id: 'light', label: 'Claro', icon: 'sun' },
  { id: 'dark', label: 'Oscuro', icon: 'moon' },
  { id: 'system', label: 'Sistema', icon: 'system' },
];

function Option({ id, label, icon, active, onSelect, compact }: (typeof OPTIONS)[number] & { active: boolean; onSelect: () => void; compact: boolean }) {
  const { icon: node, handlers } = useHoverIcon(icon, 15);
  return (
    <button type="button" aria-pressed={active} onClick={onSelect} title={`Tema ${label.toLowerCase()}`} {...handlers}>
      {node}
      {compact ? <span className="sr-only">{label}</span> : label}
    </button>
  );
}

/** Selector de tema: Claro, Oscuro o el del Sistema. */
export function ThemeSwitch({ compact = false }: { compact?: boolean }) {
  const [pref, setPref] = useTheme();
  return (
    <div className="theme-switch" role="group" aria-label="Tema de color">
      {OPTIONS.map((o) => (
        <Option key={o.id} {...o} active={pref === o.id} onSelect={() => setPref(o.id)} compact={compact} />
      ))}
    </div>
  );
}
