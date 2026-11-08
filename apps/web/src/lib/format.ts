export function hhmm(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—';
  const sign = minutes < 0 ? '−' : '';
  const m = Math.abs(Math.round(minutes));
  return `${sign}${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

export function shortHm(minutes: number): string {
  const sign = minutes < 0 ? '−' : '';
  const m = Math.abs(Math.round(minutes));
  return `${sign}${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

const dateFmt = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
const longDateFmt = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });

/** AAAA-MM-DD → «lun, 9 nov» */
export function dayLabel(date: string): string {
  return dateFmt.format(new Date(`${date}T12:00:00Z`));
}

export function longDate(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date.length === 10 ? `${date}T12:00:00Z` : date) : date;
  return longDateFmt.format(d);
}

export function timeIn(iso: string | Date, timeZone = 'Europe/Madrid'): string {
  return new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(iso));
}

export function dateTime(iso: string | Date): string {
  return new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
}

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Lunes de la semana de la fecha. */
export function weekStart(date: string): string {
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, wd === 0 ? -6 : 1 - wd);
}

export function monthBounds(period: string) {
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` };
}

export const KIND_LABEL: Record<string, string> = {
  in: 'Entrada',
  out: 'Salida',
  break_start: 'Inicio de pausa',
  break_end: 'Fin de pausa',
};

export const STATUS_LABEL: Record<string, string> = {
  pending: 'Pendiente',
  approved: 'Aprobada',
  rejected: 'Rechazada',
  cancelled: 'Anulada',
};

export const CATEGORY_LABEL: Record<string, string> = {
  payslip: 'Nómina',
  contract: 'Contrato',
  certificate: 'Certificado',
  policy: 'Política',
  signed: 'Firmado',
  other: 'Otro',
};
