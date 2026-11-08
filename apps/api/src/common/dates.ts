/** Utilidades de fechas civiles (AAAA-MM-DD) y zonas horarias, sin dependencias. */

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function* eachDay(from: string, to: string): Generator<string> {
  for (let d = from; d <= to; d = addDays(d, 1)) yield d;
}

/** 1 = lunes … 7 = domingo */
export function isoWeekday(date: string): number {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function monthRange(period: string): { from: string; to: string } {
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  return f;
}

function parts(instant: Date, tz: string) {
  const p = Object.fromEntries(fmt(tz).formatToParts(instant).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    seconds: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second),
  };
}

/** Fecha civil de un instante en la zona horaria del centro. */
export function localDate(instant: Date, tz: string): string {
  return parts(instant, tz).date;
}

/** Hora local HH:MM de un instante. */
export function localTime(instant: Date, tz: string): string {
  return parts(instant, tz).time;
}

/** Diferencia (ms) entre la hora local de `tz` y UTC en un instante dado. */
function offsetMs(instant: Date, tz: string): number {
  const p = parts(instant, tz);
  const asUtc = Date.parse(`${p.date}T00:00:00Z`) + p.seconds * 1000;
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Instante UTC correspondiente a una hora local (AAAA-MM-DD + HH:MM) en `tz`. */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const naive = Date.parse(`${date}T${time.length === 5 ? `${time}:00` : time}Z`);
  let guess = naive - offsetMs(new Date(naive), tz);
  // Segunda iteración para los días de cambio de hora.
  guess = naive - offsetMs(new Date(guess), tz);
  return new Date(guess);
}

/** Domingo de Pascua (algoritmo de Meeus/Jones/Butcher). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Festivos nacionales comunes de España. Las comunidades autónomas pueden sustituir
 * algunos (p. ej. cuando caen en domingo) y añadir los suyos: revisar el BOE de cada año.
 */
export function spanishNationalHolidays(year: number): { date: string; name: string }[] {
  return [
    { date: `${year}-01-01`, name: 'Año Nuevo' },
    { date: `${year}-01-06`, name: 'Epifanía del Señor' },
    { date: addDays(easterSunday(year), -2), name: 'Viernes Santo' },
    { date: `${year}-05-01`, name: 'Fiesta del Trabajo' },
    { date: `${year}-08-15`, name: 'Asunción de la Virgen' },
    { date: `${year}-10-12`, name: 'Fiesta Nacional de España' },
    { date: `${year}-11-01`, name: 'Todos los Santos' },
    { date: `${year}-12-06`, name: 'Día de la Constitución' },
    { date: `${year}-12-08`, name: 'Inmaculada Concepción' },
    { date: `${year}-12-25`, name: 'Navidad' },
  ];
}
