import { ReactNode } from 'react';

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const TONES = ['sky', 'violet', 'amber', 'rose', 'navy', 'slate'] as const;

export type Tone = (typeof TONES)[number] | 'teal';

/**
 * Color de un tipo de ausencia: las vacaciones siempre en verde azulado; el resto recibe
 * un color estable calculado a partir de su nombre, igual en todas las pantallas.
 */
export function absenceTone(typeName: string): Tone {
  if (/vacaci/i.test(typeName)) return 'teal';
  let hash = 0;
  for (const ch of typeName) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return TONES[hash % TONES.length];
}

/** Mes y día de una fecha AAAA-MM-DD, como una hoja de calendario. */
export function DateChip({ date }: { date: string }) {
  return (
    <span className="date-chip" aria-hidden>
      <span>{MONTHS[Number(date.slice(5, 7)) - 1]}</span>
      <b>{Number(date.slice(8, 10))}</b>
    </span>
  );
}

/** Fila de un evento con fecha: una ausencia, un festivo… */
export function EventRow({ date, title, detail, tone, pending, action }: { date: string; title: ReactNode; detail?: ReactNode; tone: string; pending?: boolean; action?: ReactNode }) {
  return (
    <div className={`event tone-${tone}${pending ? ' is-pending' : ''}`}>
      <DateChip date={date} />
      <div className="event-main">
        <strong>{title}</strong>
        {detail && <small>{detail}</small>}
        {action && <div className="event-actions">{action}</div>}
      </div>
    </div>
  );
}
