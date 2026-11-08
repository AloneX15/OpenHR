import { describe, expect, it } from 'vitest';
import { chainHash, contentDigest, contentOf, dailySummaries, EntryRow, stateAfter, StoredEntry, verifyChain } from './worktime';

let n = 0;
const e = (kind: EntryRow['kind'], iso: string, extra: Partial<EntryRow> = {}): EntryRow => ({
  id: `e${++n}`,
  seq: n,
  kind,
  occurred_at: new Date(iso),
  source: 'clock',
  voids_entry_id: null,
  ...extra,
});

describe('resumen diario', () => {
  it('suma tramos y descuenta pausas', () => {
    const entries = [
      e('in', '2026-11-09T08:00:00Z'), // 09:00 en Madrid
      e('break_start', '2026-11-09T11:00:00Z'),
      e('break_end', '2026-11-09T11:30:00Z'),
      e('out', '2026-11-09T16:30:00Z'),
    ];
    const [d] = dailySummaries(entries, 'Europe/Madrid', '2026-11-09', '2026-11-09', new Date('2026-11-10T00:00:00Z'));
    expect(d.workedMinutes).toBe(8 * 60);
    expect(d.breakMinutes).toBe(30);
    expect(d.firstIn).toBe('09:00');
    expect(d.lastOut).toBe('17:30');
    expect(d.segments).toEqual(['09:00-12:00', '12:30-17:30']);
    expect(d.incidents).toEqual([]);
  });

  it('ignora fichajes anulados', () => {
    const wrong = e('out', '2026-11-09T09:00:00Z');
    const entries = [
      e('in', '2026-11-09T08:00:00Z'),
      wrong,
      e('void', '2026-11-09T18:00:00Z', { voids_entry_id: wrong.id, source: 'manual' }),
      e('out', '2026-11-09T16:00:00Z'),
    ];
    const [d] = dailySummaries(entries, 'Europe/Madrid', '2026-11-09', '2026-11-09');
    expect(d.workedMinutes).toBe(8 * 60);
  });

  it('reparte un turno de noche entre dos días', () => {
    const entries = [e('in', '2026-11-09T21:00:00Z'), e('out', '2026-11-10T05:00:00Z')]; // 22:00 a 06:00
    const days = dailySummaries(entries, 'Europe/Madrid', '2026-11-09', '2026-11-10', new Date('2026-11-11T00:00:00Z'));
    expect(days.map((d) => d.workedMinutes)).toEqual([120, 360]);
    expect(days[0].segments).toEqual(['22:00-24:00']);
  });

  it('el día del cambio de hora de octubre tiene una hora más', () => {
    // De 00:00 a 12:00 hora local el 25/10/2026 son 13 horas reales.
    const entries = [e('in', '2026-10-24T22:00:00Z'), e('out', '2026-10-25T11:00:00Z')];
    const [d] = dailySummaries(entries, 'Europe/Madrid', '2026-10-25', '2026-10-25', new Date('2026-10-26T00:00:00Z'));
    expect(d.workedMinutes).toBe(13 * 60);
  });

  it('marca la salida olvidada', () => {
    const [d] = dailySummaries([e('in', '2026-11-09T08:00:00Z')], 'Europe/Madrid', '2026-11-09', '2026-11-09', new Date('2026-11-12T00:00:00Z'));
    expect(d.open).toBe(true);
    expect(d.incidents).toContain('Falta el fichaje de salida');
  });

  it('calcula el estado', () => {
    expect(stateAfter([])).toBe('out');
    expect(stateAfter([e('in', '2026-11-09T08:00:00Z')])).toBe('working');
    expect(stateAfter([e('in', '2026-11-09T08:00:00Z'), e('break_start', '2026-11-09T10:00:00Z')])).toBe('break');
  });
});

describe('cadena de hashes', () => {
  const build = () => {
    const rows: StoredEntry[] = [];
    let prev: string | null = null;
    for (let i = 1; i <= 3; i++) {
      const base = {
        id: `id${i}`,
        employment_id: 'emp',
        seq: i,
        kind: (i % 2 ? 'in' : 'out') as StoredEntry['kind'],
        occurred_at: new Date(`2026-11-0${i}T08:00:00Z`),
        recorded_at: new Date(`2026-11-0${i}T08:00:01Z`),
        source: 'clock',
        voids_entry_id: null,
        reason: null,
        created_by: 'user',
      };
      const digest = contentDigest(contentOf({ ...base, content_digest: '', prev_hash: null, hash: '' }));
      const hash = chainHash(prev, digest);
      rows.push({ ...base, content_digest: digest, prev_hash: prev, hash });
      prev = hash;
    }
    return rows;
  };

  it('verifica una cadena íntegra', () => {
    expect(verifyChain(build())).toMatchObject({ ok: true, count: 3 });
  });

  it('detecta un cambio de hora', () => {
    const rows = build();
    rows[1].occurred_at = new Date('2026-11-02T07:00:00Z');
    expect(verifyChain(rows)).toMatchObject({ ok: false, seq: 2 });
  });

  it('detecta un borrado', () => {
    const rows = build();
    rows.splice(1, 1);
    expect(verifyChain(rows)).toMatchObject({ ok: false, seq: 3 });
  });
});
