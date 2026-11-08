import { zonedToUtc } from '../common/dates';
import { Tx } from '../db/db.service';
import { StoredEntry } from './worktime';

export const ENTRY_COLUMNS = `id, employment_id, seq, kind, occurred_at, recorded_at, device_time, source, voids_entry_id,
  reason, created_by, content_digest, prev_hash, hash, channel, kiosk_device_id, latitude, longitude, accuracy_m, inside_zone`;

/**
 * Fichajes de una relación laboral entre dos instantes, más las anulaciones (aunque sean
 * posteriores) de los fichajes de ese rango.
 */
export function entriesBetween(tx: Tx, employmentId: string, from: Date, to: Date): Promise<StoredEntry[]> {
  return tx.query<StoredEntry>(
    `SELECT ${ENTRY_COLUMNS} FROM time_entry
      WHERE employment_id = $1 AND (
        (kind <> 'void' AND occurred_at >= $2 AND occurred_at < $3)
        OR (kind = 'void' AND voids_entry_id IN (
              SELECT id FROM time_entry WHERE employment_id = $1 AND occurred_at >= $2 AND occurred_at < $3)))
      ORDER BY occurred_at, seq`,
    [employmentId, from, to],
  );
}

/** Fichajes de un rango de fechas civiles (AAAA-MM-DD, inclusive) en la zona del centro. */
export function entriesForDates(tx: Tx, employmentId: string, fromDate: string, toDate: string, timezone: string) {
  const start = zonedToUtc(fromDate, '00:00', timezone);
  const end = new Date(zonedToUtc(toDate, '23:59', timezone).getTime() + 60_000);
  return entriesBetween(tx, employmentId, start, end);
}
