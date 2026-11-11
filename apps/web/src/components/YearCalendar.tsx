'use client';

import { useGrow, useStagger } from '@/lib/motion';
import { addDays, STATUS_LABEL, todayIso } from '@/lib/format';
import { absenceTone } from './Events';

export interface CalendarAbsence {
  start_date: string;
  end_date: string;
  type_name: string;
  status: string;
}

const DOW = ['lu', 'ma', 'mi', 'ju', 'vi', 'sá', 'do'];
const monthName = new Intl.DateTimeFormat('es-ES', { month: 'long', timeZone: 'UTC' });
const fullDay = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

/**
 * El año de un vistazo: mis ausencias (aprobadas en color, pendientes con borde), los
 * festivos y el día de hoy. Si se pasa `onPickDay`, los días libres a partir de hoy son
 * botones para empezar una solicitud en esa fecha.
 */
export function YearCalendar({ year, absences, holidays, onPickDay }: { year: number; absences: CalendarAbsence[]; holidays: { date: string; name: string }[]; onPickDay?: (date: string) => void }) {
  const today = todayIso();
  const ref = useStagger<HTMLDivElement>(year);
  const holidayName = new Map(holidays.map((h) => [h.date, h.name]));
  const byDay = new Map<string, CalendarAbsence & { first: boolean; last: boolean }>();
  for (const a of absences) {
    if (a.status !== 'approved' && a.status !== 'pending') continue;
    for (let d = a.start_date; d <= a.end_date; d = addDays(d, 1)) {
      // Lo aprobado manda sobre lo pendiente si coinciden en un día.
      if (byDay.get(d)?.status === 'approved' && a.status !== 'approved') continue;
      byDay.set(d, { ...a, first: d === a.start_date, last: d === a.end_date });
    }
  }

  return (
    <div className="year-cal" ref={ref}>
      {Array.from({ length: 12 }, (_, m) => {
        const first = new Date(Date.UTC(year, m, 1));
        const days = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
        const offset = (first.getUTCDay() + 6) % 7; // lunes = 0
        return (
          // En móvil los meses ya pasados del año en curso se ocultan: se empieza por el actual.
          <section className={`${year}-${String(m + 1).padStart(2, '0')}` < today.slice(0, 7) ? 'month is-gone' : 'month'} key={m} aria-label={`${monthName.format(first)} de ${year}`}>
            <h3>{monthName.format(first)}</h3>
            <div className="month-grid">
              {DOW.map((d) => (
                <span key={d} className="dow" aria-hidden>
                  {d}
                </span>
              ))}
              {Array.from({ length: offset }, (_, i) => (
                <span key={`b${i}`} />
              ))}
              {Array.from({ length: days }, (_, i) => {
                const date = `${year}-${String(m + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
                const col = (offset + i) % 7;
                const absence = byDay.get(date);
                const holiday = holidayName.get(date);
                const cls = ['day'];
                if (col >= 5) cls.push('is-weekend');
                if (date < today) cls.push('is-past');
                if (date === today) cls.push('is-today');
                if (holiday && !absence) cls.push('is-holiday');
                if (absence) {
                  cls.push('has-absence', `tone-${absenceTone(absence.type_name)}`);
                  if (absence.status === 'pending') cls.push('is-pending');
                  // Los extremos del tramo (o de la semana) llevan las esquinas redondeadas.
                  if (absence.first || col === 0 || i === 0) cls.push('range-start');
                  if (absence.last || col === 6 || i === days - 1) cls.push('range-end');
                }
                const what = [absence ? `${absence.type_name} (${STATUS_LABEL[absence.status].toLowerCase()})` : '', holiday ? `Festivo: ${holiday}` : '', date === today ? 'Hoy' : ''].filter(Boolean).join(' · ');
                const label = `${fullDay.format(new Date(`${date}T12:00:00Z`))}${what ? `: ${what}` : ''}`;
                return onPickDay && !absence && date >= today ? (
                  <button key={date} type="button" className={cls.join(' ')} title={what || 'Solicitar ausencia este día'} aria-label={`${label}. Solicitar ausencia`} onClick={() => onPickDay(date)}>
                    {i + 1}
                  </button>
                ) : (
                  <span key={date} className={cls.join(' ')} title={what || undefined} aria-label={what ? label : undefined}>
                    {i + 1}
                  </span>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** Barra de saldo: usado, pendiente de aprobar y lo que queda. */
export function BalanceBar({ used, held, available }: { used: number; held: number; available: number }) {
  const total = Math.max(1, used + held + Math.max(0, available));
  const ref = useGrow<HTMLDivElement>(`${used}/${held}/${available}`);
  return (
    <div className="balance-bar" ref={ref} role="img" aria-label={`${used} usados, ${held} pendientes y ${available} disponibles`}>
      <span className="used" data-grow style={{ width: `${(used / total) * 100}%` }} />
      <span className="held" data-grow style={{ width: `${(held / total) * 100}%` }} />
    </div>
  );
}
