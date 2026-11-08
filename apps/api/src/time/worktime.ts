import { addDays, localDate, localTime, zonedToUtc } from '../common/dates';
import { canonicalJson, sha256 } from '../common/crypto';

export type EntryKind = 'in' | 'out' | 'break_start' | 'break_end' | 'void';
export type WorkState = 'out' | 'working' | 'break';

export interface EntryRow {
  id: string;
  seq: number | string;
  kind: EntryKind;
  occurred_at: Date;
  source: string;
  voids_entry_id: string | null;
  reason?: string | null;
}

/** Fichajes vigentes: sin los anulados ni los propios eventos de anulación. */
export function effectiveEntries<T extends EntryRow>(entries: T[]): T[] {
  const voided = new Set(entries.filter((e) => e.kind === 'void').map((e) => e.voids_entry_id));
  return entries
    .filter((e) => e.kind !== 'void' && !voided.has(e.id))
    .sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime() || Number(a.seq) - Number(b.seq));
}

export const TRANSITIONS: Record<WorkState, Partial<Record<Exclude<EntryKind, 'void'>, WorkState>>> = {
  out: { in: 'working' },
  working: { out: 'out', break_start: 'break' },
  break: { break_end: 'working', out: 'out' },
};

export function stateAfter(entries: EntryRow[]): WorkState {
  let state: WorkState = 'out';
  for (const e of effectiveEntries(entries)) {
    const next: WorkState | undefined = TRANSITIONS[state][e.kind as Exclude<EntryKind, 'void'>];
    // Una secuencia incoherente (p. ej. dos entradas seguidas) se trata como si el
    // fichaje llevara al estado que indica, para no bloquear a la persona.
    state = next ?? (e.kind === 'in' || e.kind === 'break_end' ? 'working' : e.kind === 'break_start' ? 'break' : 'out');
  }
  return state;
}

export interface DaySummary {
  date: string;
  workedMinutes: number;
  breakMinutes: number;
  firstIn: string | null; // HH:MM local
  lastOut: string | null;
  open: boolean; // hay un tramo sin cerrar al final del día
  incidents: string[];
  segments: string[]; // tramos de trabajo HH:MM-HH:MM
}

/**
 * Resume minutos trabajados y de pausa por día civil en la zona horaria del centro.
 * Los tramos que cruzan medianoche se reparten entre los dos días. Las pausas no
 * computan como trabajo (si el convenio dice lo contrario, se ajusta en la exportación).
 */
export function dailySummaries(entries: EntryRow[], tz: string, from: string, to: string, now = new Date()): DaySummary[] {
  const days = new Map<string, DaySummary>();
  const day = (d: string) => {
    let s = days.get(d);
    if (!s) {
      s = { date: d, workedMinutes: 0, breakMinutes: 0, firstIn: null, lastOut: null, open: false, incidents: [], segments: [] };
      days.set(d, s);
    }
    return s;
  };

  const addInterval = (start: Date, end: Date, type: 'work' | 'break') => {
    let cursor = start;
    while (cursor < end) {
      const d = localDate(cursor, tz);
      const nextMidnight = zonedToUtc(addDays(d, 1), '00:00', tz);
      const sliceEnd = end < nextMidnight ? end : nextMidnight;
      const minutes = (sliceEnd.getTime() - cursor.getTime()) / 60000;
      if (type === 'work') {
        day(d).workedMinutes += minutes;
        const endLabel = sliceEnd.getTime() === nextMidnight.getTime() ? '24:00' : localTime(sliceEnd, tz);
        day(d).segments.push(`${localTime(cursor, tz)}-${endLabel}`);
      }
      else day(d).breakMinutes += minutes;
      cursor = sliceEnd;
    }
  };

  let state: WorkState = 'out';
  let since: Date | null = null;
  for (const e of effectiveEntries(entries)) {
    const at = e.occurred_at;
    const d = day(localDate(at, tz));
    const expected: WorkState | undefined = TRANSITIONS[state][e.kind as Exclude<EntryKind, 'void'>];
    if (!expected) d.incidents.push(`Fichaje «${kindLabel(e.kind)}» inesperado a las ${localTime(at, tz)}`);
    if (since && state !== 'out') addInterval(since, at, state === 'working' ? 'work' : 'break');
    if (e.kind === 'in' && !d.firstIn) d.firstIn = localTime(at, tz);
    if (e.kind === 'out') d.lastOut = localTime(at, tz);
    state = expected ?? (e.kind === 'in' || e.kind === 'break_end' ? 'working' : e.kind === 'break_start' ? 'break' : 'out');
    since = state === 'out' ? null : at;
  }
  if (since && state !== 'out') {
    const today = localDate(now, tz);
    const startDay = localDate(since, tz);
    if (startDay === today) {
      // Jornada en curso: cuenta hasta ahora.
      addInterval(since, now, state === 'working' ? 'work' : 'break');
      day(today).open = true;
    } else {
      day(startDay).open = true;
      day(startDay).incidents.push('Falta el fichaje de salida');
    }
  }

  const out: DaySummary[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const s = day(d);
    s.workedMinutes = Math.round(s.workedMinutes);
    s.breakMinutes = Math.round(s.breakMinutes);
    out.push(s);
  }
  return out;
}

export function kindLabel(kind: EntryKind): string {
  return { in: 'entrada', out: 'salida', break_start: 'inicio de pausa', break_end: 'fin de pausa', void: 'anulación' }[kind];
}

// ── Cadena de hashes (docs/adr/0002) ───────────────────────────────────────────────
export interface ChainContent {
  employmentId: string;
  seq: number;
  kind: EntryKind;
  occurredAt: string; // ISO UTC
  recordedAt: string;
  source: string;
  voidsEntryId: string | null;
  reason: string | null;
  createdBy: string;
}

export function contentDigest(c: ChainContent): string {
  return sha256(canonicalJson(c));
}

export function chainHash(prevHash: string | null, digest: string): string {
  return sha256(`${prevHash ?? 'GENESIS'}|${digest}`);
}

export interface StoredEntry {
  id: string;
  employment_id: string;
  seq: number | string;
  kind: EntryKind;
  occurred_at: Date;
  recorded_at: Date;
  source: string;
  voids_entry_id: string | null;
  reason: string | null;
  created_by: string;
  content_digest: string;
  prev_hash: string | null;
  hash: string;
}

export function contentOf(e: StoredEntry): ChainContent {
  return {
    employmentId: e.employment_id,
    seq: Number(e.seq),
    kind: e.kind,
    occurredAt: e.occurred_at.toISOString(),
    recordedAt: e.recorded_at.toISOString(),
    source: e.source,
    voidsEntryId: e.voids_entry_id,
    reason: e.reason,
    createdBy: e.created_by,
  };
}

export type ChainCheck = { ok: true; count: number; head: string | null } | { ok: false; seq: number; problem: string };

/** Verifica una cadena completa ordenada por seq. */
export function verifyChain(entries: StoredEntry[]): ChainCheck {
  let prev: string | null = null;
  let expectedSeq = 1;
  for (const e of [...entries].sort((a, b) => Number(a.seq) - Number(b.seq))) {
    const seq = Number(e.seq);
    if (seq !== expectedSeq) return { ok: false, seq, problem: `Falta el eslabón ${expectedSeq}` };
    if (e.prev_hash !== prev) return { ok: false, seq, problem: 'El enlace con el fichaje anterior no coincide' };
    if (contentDigest(contentOf(e)) !== e.content_digest) return { ok: false, seq, problem: 'El contenido del fichaje ha cambiado' };
    if (chainHash(prev, e.content_digest) !== e.hash) return { ok: false, seq, problem: 'El hash no coincide' };
    prev = e.hash;
    expectedSeq++;
  }
  return { ok: true, count: expectedSeq - 1, head: prev };
}
