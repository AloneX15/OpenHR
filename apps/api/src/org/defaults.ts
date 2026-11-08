import { spanishNationalHolidays } from '../common/dates';
import { Tx } from '../db/db.service';

/**
 * Tipos de ausencia de partida según el Estatuto de los Trabajadores (art. 37-38).
 * Los convenios colectivos pueden mejorar estos mínimos: se editan en Organización.
 */
export const DEFAULT_ABSENCE_TYPES = [
  { code: 'VAC', name: 'Vacaciones', paid: true, vacation: true, approval: true, unit: 'working', sensitive: false },
  { code: 'AP', name: 'Asuntos propios', paid: true, vacation: false, approval: true, unit: 'working', sensitive: false },
  { code: 'IT', name: 'Incapacidad temporal (baja médica)', paid: true, vacation: false, approval: false, unit: 'calendar', sensitive: true },
  { code: 'MAT', name: 'Matrimonio o pareja de hecho (15 días naturales)', paid: true, vacation: false, approval: true, unit: 'calendar', sensitive: false },
  { code: 'FAM', name: 'Accidente, enfermedad grave u hospitalización de familiar (5 días)', paid: true, vacation: false, approval: true, unit: 'working', sensitive: true },
  { code: 'FALL', name: 'Fallecimiento de familiar (2 días)', paid: true, vacation: false, approval: true, unit: 'working', sensitive: false },
  { code: 'MUD', name: 'Traslado de domicilio (1 día)', paid: true, vacation: false, approval: true, unit: 'working', sensitive: false },
  { code: 'DEB', name: 'Deber inexcusable de carácter público', paid: true, vacation: false, approval: true, unit: 'working', sensitive: false },
  { code: 'NR', name: 'Permiso no retribuido', paid: false, vacation: false, approval: true, unit: 'working', sensitive: false },
  { code: 'COMP', name: 'Compensación de horas (bolsa)', paid: true, vacation: false, approval: true, unit: 'working', sensitive: false, bank: true },
] as const;

/** Categorías de gasto de partida. 0,26 €/km es el importe exento de IRPF por kilometraje. */
export const DEFAULT_EXPENSE_CATEGORIES = [
  { name: 'Comidas', kind: 'amount', rate: null, receipt: true },
  { name: 'Transporte', kind: 'amount', rate: null, receipt: true },
  { name: 'Alojamiento', kind: 'amount', rate: null, receipt: true },
  { name: 'Kilometraje', kind: 'mileage', rate: 26, receipt: false },
  { name: 'Otros', kind: 'amount', rate: null, receipt: true },
] as const;

export async function createTenantDefaults(tx: Tx) {
  for (const t of DEFAULT_ABSENCE_TYPES) {
    await tx.query(
      `INSERT INTO absence_type (tenant_id, code, name, paid, counts_as_vacation, requires_approval, day_unit, sensitive, consumes_hour_bank)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (tenant_id, code) DO NOTHING`,
      [tx.tenantId, t.code, t.name, t.paid, t.vacation, t.approval, t.unit, t.sensitive, 'bank' in t ? t.bank : false],
    );
  }
  for (const c of DEFAULT_EXPENSE_CATEGORIES) {
    await tx.query(
      `INSERT INTO expense_category (tenant_id, name, kind, rate_cents_per_km, requires_receipt)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, name) DO NOTHING`,
      [tx.tenantId, c.name, c.kind, c.rate, c.receipt],
    );
  }
  for (const name of ['Nómina', 'Contrato y documentos', 'Certificados', 'Vacaciones y ausencias', 'Datos personales', 'Otros']) {
    await tx.query('INSERT INTO ticket_category (tenant_id, name) VALUES ($1, $2) ON CONFLICT (tenant_id, name) DO NOTHING', [tx.tenantId, name]);
  }
  const year = new Date().getUTCFullYear();
  for (const y of [year, year + 1]) await addNationalHolidays(tx, y);
}

export async function addNationalHolidays(tx: Tx, year: number) {
  for (const h of spanishNationalHolidays(year)) {
    await tx.query(
      `INSERT INTO holiday (tenant_id, date, name)
       SELECT $1, $2::date, $3 WHERE NOT EXISTS (
         SELECT 1 FROM holiday WHERE company_id IS NULL AND work_center_id IS NULL AND date = $2::date)`,
      [tx.tenantId, h.date, h.name],
    );
  }
}
