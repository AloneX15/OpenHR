import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Actor, assertAdmin } from '../common/access';
import { addDays, zonedToUtc } from '../common/dates';
import { isValidNationalId, normalizeNationalId } from '../common/spanish-id';
import { Db, Tx } from '../db/db.service';
import { createTenantDefaults } from '../org/defaults';
import { weekdaySchedule } from '../org/employees.service';
import { TimeService } from '../time/time.service';
import { FactorialClient, FContractVersion, FEmployee, FLeave, FLeaveType, FLegalEntity, FLocation, FShift, FTeam } from './factorial-client';

export interface FactorialOptions {
  environment: 'production' | 'demo';
  dryRun: boolean;
  /** Fichajes desde esta fecha (AAAA-MM-DD). Sin fecha no se importan fichajes. */
  shiftsFrom?: string;
  includeLeaves: boolean;
  includeSalaries: boolean;
}

type Counts = Record<string, number>;
const id = (v: string | number | null | undefined) => (v === null || v === undefined ? null : String(v));
const IMPORT_REASON = 'Importado de Factorial';

/** Vacaciones, asuntos propios, IT… por nombre o identificador del tipo en Factorial. */
export function guessAbsenceCode(t: Pick<FLeaveType, 'name' | 'identifier'>): string | null {
  const s = `${t.identifier ?? ''} ${t.name}`.toLowerCase();
  if (/vacac|holiday|vacation/.test(s)) return 'VAC';
  if (/asunto|personal day/.test(s)) return 'AP';
  if (/baja|enfermedad|sick|incapacidad|\bit\b/.test(s)) return 'IT';
  if (/matrimonio|boda|wedding|marriage/.test(s)) return 'MAT';
  if (/fallec|death|bereavement/.test(s)) return 'FALL';
  if (/mudanza|traslado de domicilio|moving/.test(s)) return 'MUD';
  if (/no retribuid|unpaid/.test(s)) return 'NR';
  if (/compensa/.test(s)) return 'COMP';
  return null;
}

/** Minutos semanales a partir de la versión de contrato de Factorial. */
export function weeklyMinutesFrom(cv?: FContractVersion | null): number | null {
  if (!cv?.working_hours) return null;
  const f = (cv.working_hours_frequency ?? 'week').toLowerCase();
  if (f.startsWith('week')) return Math.round(cv.working_hours * 60);
  if (f.startsWith('day')) return Math.round(cv.working_hours * 60 * 5);
  if (f.startsWith('month')) return Math.round((cv.working_hours * 60 * 12) / 52);
  if (f.startsWith('year')) return Math.round((cv.working_hours * 60) / 52);
  return null;
}

/** Salario anual en euros a partir de la versión de contrato (importes en céntimos). */
export function annualSalaryFrom(cv?: FContractVersion | null): number | null {
  if (!cv?.salary_amount) return null;
  const eur = cv.salary_amount / 100;
  const f = (cv.salary_frequency ?? 'yearly').toLowerCase();
  if (f.startsWith('year') || f.startsWith('annual')) return eur;
  if (f.startsWith('month')) return eur * 12;
  return null;
}

@Injectable()
export class FactorialMigrationService {
  private readonly log = new Logger('Factorial');

  constructor(
    private readonly db: Db,
    private readonly time: TimeService,
  ) {}

  baseUrl(env: 'production' | 'demo') {
    // Solo hosts de Factorial (evita usar la API como proxy hacia otras direcciones).
    if (process.env.FACTORIAL_BASE_URL && process.env.NODE_ENV !== 'production') return process.env.FACTORIAL_BASE_URL;
    return env === 'demo' ? 'https://api.eu2.demo.factorial.dev' : 'https://api.factorialhr.com';
  }

  /** Arranca la migración en segundo plano y devuelve el trabajo. La clave no se guarda. */
  async start(actor: Actor, tenantId: string, apiKey: string, opts: FactorialOptions) {
    assertAdmin(actor);
    const job = await this.db.tx(tenantId, actor.userId, (tx) =>
      tx.one(
        `INSERT INTO migration_job (tenant_id, source, dry_run, options, started_by) VALUES ($1,'factorial',$2,$3,$4) RETURNING id`,
        [tenantId, opts.dryRun, JSON.stringify(opts), actor.userId],
      ),
    );
    const client = new FactorialClient(apiKey, this.baseUrl(opts.environment));
    void this.run(tenantId, actor.userId, job.id, client, opts).catch(() => undefined);
    return { jobId: job.id as string };
  }

  getJob(tx: Tx, actor: Actor, jobId: string) {
    if (!actor.isAdmin) throw new ForbiddenException();
    return tx.maybeOne('SELECT id, dry_run, options, status, counts, log, error, started_at, finished_at FROM migration_job WHERE id = $1', [jobId]).then((j) => {
      if (!j) throw new NotFoundException();
      return j;
    });
  }

  listJobs(tx: Tx, actor: Actor) {
    if (!actor.isAdmin) throw new ForbiddenException();
    return tx.query('SELECT id, dry_run, status, counts, error, started_at, finished_at FROM migration_job ORDER BY started_at DESC LIMIT 20');
  }

  /** Ejecuta la migración. Visible para los tests (que la esperan). */
  async run(tenantId: string, userId: string, jobId: string, client: FactorialClient, opts: FactorialOptions) {
    const counts: Counts = {};
    const lines: string[] = [];
    const note = (s: string) => {
      lines.push(s);
      if (lines.length > 500) lines.shift();
    };
    const inc = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);
    const save = (status: string, error?: string) =>
      this.db.tx(tenantId, userId, (tx) =>
        tx.query(`UPDATE migration_job SET counts = $2, log = $3, status = $4, error = $5, finished_at = CASE WHEN $4 <> 'running' THEN now() END WHERE id = $1`, [
          jobId,
          JSON.stringify(counts),
          lines,
          status,
          error ?? null,
        ]),
      );
    try {
      note('Leyendo datos de Factorial…');
      const [entities, locations, teams, employees] = await Promise.all([
        client.list<FLegalEntity>('companies/legal_entities'),
        client.list<FLocation>('locations/locations'),
        client.list<FTeam>('teams/teams'),
        client.list<FEmployee>('employees/employees'),
      ]);
      const contracts = await client.list<FContractVersion>('contracts/contract_versions');
      note(`Factorial: ${entities.length} sociedades, ${locations.length} centros, ${teams.length} equipos, ${employees.length} personas, ${contracts.length} versiones de contrato`);

      // Versión de contrato vigente (la más reciente) y la primera de cada persona.
      const byEmp = new Map<string, FContractVersion[]>();
      for (const c of contracts) byEmp.set(String(c.employee_id), [...(byEmp.get(String(c.employee_id)) ?? []), c]);
      for (const list of byEmp.values()) list.sort((a, b) => a.effective_on.localeCompare(b.effective_on));
      const teamOf = new Map<string, FTeam>();
      for (const t of teams) for (const e of t.employee_ids ?? []) if (!teamOf.has(String(e))) teamOf.set(String(e), t);

      if (opts.dryRun) {
        inc('sociedades', entities.length);
        inc('personas', employees.length);
        const invalidIds = employees.filter((e) => e.identifier && !isValidNationalId(e.identifier)).length;
        if (invalidIds) note(`Aviso: ${invalidIds} persona(s) con documento que no es un DNI/NIE válido (se importarán sin él)`);
        const noEntity = employees.filter((e) => !e.legal_entity_id).length;
        if (noEntity) note(`Aviso: ${noEntity} persona(s) sin sociedad en Factorial (se asignarán a la primera)`);
        if (opts.includeLeaves) inc('ausencias', (await client.list<FLeave>('timeoff/leaves', { include_deleted_leaves: 'false' })).filter((l) => l.approved === true).length);
        if (opts.shiftsFrom) inc('fichajes', (await client.list<FShift>('attendance/shifts', { start_on: opts.shiftsFrom })).filter((s) => s.clock_in).length);
        note('Simulación terminada: no se ha escrito nada.');
        await save('done');
        return;
      }

      // 1) Organización y personas en una transacción.
      await this.db.tx(tenantId, userId, async (tx) => {
        await createTenantDefaults(tx); // garantiza los tipos de ausencia de partida
        const map = new MappingStore(tx);
        const companyIds = new Map<string, string>();
        for (const le of entities) {
          const taxId = (le.tin ?? '').toUpperCase().replace(/[\s-]/g, '') || `FACTORIAL-${le.id}`;
          let companyId = await map.get('legal_entity', String(le.id));
          if (!companyId) {
            const existing = await tx.maybeOne('SELECT id FROM company WHERE tax_id = $1', [taxId]);
            companyId =
              existing?.id ??
              (
                await tx.one(`INSERT INTO company (tenant_id, name, legal_name, tax_id, address) VALUES ($1,$2,$2,$3,$4) RETURNING id`, [
                  tx.tenantId,
                  le.legal_name,
                  taxId,
                  [le.address_line_1, le.city].filter(Boolean).join(', ') || null,
                ])
              ).id;
            await map.set('legal_entity', String(le.id), companyId!);
            inc(existing ? 'sociedades enlazadas' : 'sociedades creadas');
          }
          companyIds.set(String(le.id), companyId!);
        }
        if (!companyIds.size) throw new BadRequestException('Factorial no devolvió ninguna sociedad');
        const firstCompany = [...companyIds.values()][0];

        // Centros y departamentos se crean por sociedad cuando alguien los usa.
        const locationById = new Map(locations.map((l) => [String(l.id), l]));
        const centerFor = async (companyId: string, locationId: string | null) => {
          if (!locationId) return null;
          const key = `${companyId}:${locationId}`;
          const known = await map.get('location', key);
          if (known) return known;
          const loc = locationById.get(locationId);
          if (!loc) return null;
          const tz = loc.timezone && Intl.supportedValuesOf('timeZone').includes(loc.timezone) ? loc.timezone : 'Europe/Madrid';
          const row = await tx.one(`INSERT INTO work_center (tenant_id, company_id, name, timezone, address) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [
            tx.tenantId,
            companyId,
            loc.name,
            tz,
            [loc.address_line_1, loc.city].filter(Boolean).join(', ') || null,
          ]);
          await map.set('location', key, row.id);
          inc('centros creados');
          return row.id as string;
        };
        const departmentFor = async (companyId: string, team?: FTeam) => {
          if (!team) return null;
          const found = await tx.maybeOne('SELECT id FROM department WHERE company_id = $1 AND lower(name) = lower($2)', [companyId, team.name]);
          if (found) return found.id as string;
          inc('departamentos creados');
          return (await tx.one(`INSERT INTO department (tenant_id, company_id, name) VALUES ($1,$2,$3) RETURNING id`, [tx.tenantId, companyId, team.name])).id as string;
        };

        for (const e of employees) {
          const eid = String(e.id);
          const versions = byEmp.get(eid) ?? [];
          const current = versions[versions.length - 1];
          const companyId = companyIds.get(id(e.legal_entity_id) ?? '') ?? firstCompany;
          const nationalId = e.identifier && isValidNationalId(e.identifier) ? normalizeNationalId(e.identifier) : null;
          const email = (e.email || e.login_email || '').toLowerCase() || null;
          const sex = e.gender === 'female' || e.gender === 'male' ? e.gender : null;
          const start = versions[0]?.starts_on || e.seniority_calculation_date || (e.created_at ?? '').slice(0, 10) || new Date().toISOString().slice(0, 10);
          const weekly = weeklyMinutesFrom(current) ?? 2400;

          let employmentId = await map.get('employee', eid);
          if (employmentId) {
            // Repetir la migración actualiza lo que cambió en Factorial.
            await tx.query(`UPDATE employment SET end_date = $2, job_title = coalesce($3, job_title) WHERE id = $1`, [employmentId, e.terminated_on ?? null, current?.job_title ?? null]);
            inc('personas actualizadas');
            continue;
          }
          let person = nationalId ? await tx.maybeOne('SELECT id FROM person WHERE national_id = $1', [nationalId]) : null;
          if (!person && email) person = await tx.maybeOne('SELECT id FROM person WHERE lower(email) = $1 AND (national_id IS NULL OR $2::text IS NULL OR national_id = $2)', [email, nationalId]);
          if (!person) {
            person = await tx.one(
              `INSERT INTO person (tenant_id, first_name, last_name, national_id, email, phone, birth_date, sex) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
              [tx.tenantId, e.first_name, e.last_name, nationalId, email, e.phone_number ?? null, e.birthday_on ?? null, sex],
            );
          }
          const emp = await tx.one(
            `INSERT INTO employment (tenant_id, person_id, company_id, work_center_id, department_id, job_title, start_date, end_date, weekly_minutes, schedule)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [
              tx.tenantId,
              person!.id,
              companyId,
              await centerFor(companyId, id(e.location_id)),
              await departmentFor(companyId, teamOf.get(eid)),
              current?.job_title ?? null,
              start,
              e.terminated_on && e.terminated_on >= start ? e.terminated_on : null,
              weekly,
              JSON.stringify(weekdaySchedule(weekly)),
            ],
          );
          employmentId = emp.id as string;
          await map.set('employee', eid, employmentId);
          inc('personas creadas');

          if (opts.includeSalaries) {
            for (const cv of versions) {
              const annual = annualSalaryFrom(cv);
              if (annual === null) continue;
              await tx.query(
                `INSERT INTO compensation (tenant_id, employment_id, effective_from, base_annual, note, created_by) VALUES ($1,$2,$3,$4,$5,$6)
                 ON CONFLICT (employment_id, effective_from) DO NOTHING`,
                [tx.tenantId, employmentId, cv.effective_on, annual, IMPORT_REASON, userId],
              );
              inc('retribuciones');
            }
          }
        }
        // Responsables, cuando ya existen todas las relaciones laborales.
        for (const e of employees) {
          if (!e.manager_id) continue;
          const mine = await map.get('employee', String(e.id));
          const boss = await map.get('employee', String(e.manager_id));
          if (mine && boss && mine !== boss) await tx.query('UPDATE employment SET manager_employment_id = $2 WHERE id = $1', [mine, boss]);
        }
        note('Organización y personas importadas.');
      });
      await save('running');

      // 2) Ausencias aprobadas.
      if (opts.includeLeaves) {
        const types = await client.list<FLeaveType>('timeoff/leave_types');
        const leaves = (await client.list<FLeave>('timeoff/leaves', { include_deleted_leaves: 'false' })).filter((l) => l.approved === true && !l.deleted_at);
        await this.db.tx(tenantId, userId, async (tx) => {
          const map = new MappingStore(tx);
          const typeIds = new Map<string, string>();
          for (const t of types) {
            let internal = await map.get('leave_type', String(t.id));
            if (!internal) {
              const code = guessAbsenceCode(t);
              const existing = code ? await tx.maybeOne('SELECT id FROM absence_type WHERE code = $1', [code]) : null;
              internal =
                existing?.id ??
                (
                  await tx.one(
                    `INSERT INTO absence_type (tenant_id, code, name, paid, requires_approval) VALUES ($1,$2,$3,$4,$5)
                     ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
                    [tx.tenantId, `F${String(t.id).slice(-8)}`, t.name, t.payable ?? true, t.approval_required ?? true],
                  )
                ).id;
              await map.set('leave_type', String(t.id), internal!);
            }
            typeIds.set(String(t.id), internal!);
          }
          for (const l of leaves) {
            if (await map.get('leave', String(l.id))) continue;
            const employmentId = await map.get('employee', String(l.employee_id));
            const typeId = l.leave_type_id ? typeIds.get(String(l.leave_type_id)) : null;
            if (!employmentId || !typeId) {
              inc('ausencias omitidas');
              continue;
            }
            const days = l.days_taken ?? 1;
            const row = await tx.one(
              `INSERT INTO absence_request (tenant_id, employment_id, absence_type_id, start_date, end_date, days, status, comment, requested_by, decided_by, decided_at)
               VALUES ($1,$2,$3,$4,$5,$6,'approved',$7,$8,$8,now()) RETURNING id`,
              [tx.tenantId, employmentId, typeId, l.start_on, l.finish_on ?? l.start_on, days, l.description ? `${IMPORT_REASON}: ${l.description}` : IMPORT_REASON, userId],
            );
            await map.set('leave', String(l.id), row.id);
            inc('ausencias');
          }
        });
        note('Ausencias aprobadas importadas.');
        await save('running');
      }

      // 3) Fichajes: cada tramo trabajado (o pausa) se convierte en entrada y salida.
      if (opts.shiftsFrom) {
        const shifts = (await client.list<FShift>('attendance/shifts', { start_on: opts.shiftsFrom })).filter((s) => s.clock_in && s.clock_out);
        const byEmployee = new Map<string, FShift[]>();
        for (const s of shifts) byEmployee.set(String(s.employee_id), [...(byEmployee.get(String(s.employee_id)) ?? []), s]);
        for (const [fid, list] of byEmployee) {
          await this.db.tx(tenantId, userId, async (tx) => {
            const employmentId = await new MappingStore(tx).get('employee', fid);
            if (!employmentId) {
              inc('fichajes omitidos', list.length);
              return;
            }
            const tz = (await tx.one(`SELECT coalesce(wc.timezone, 'Europe/Madrid') AS tz FROM employment e LEFT JOIN work_center wc ON wc.id = e.work_center_id WHERE e.id = $1`, [employmentId])).tz;
            list.sort((a, b) => `${a.date} ${a.clock_in}`.localeCompare(`${b.date} ${b.clock_in}`));
            for (const s of list) {
              const inAt = zonedToUtc(s.date, s.clock_in!.slice(0, 5), tz);
              // Un tramo que acaba a una hora anterior a la de inicio termina al día siguiente.
              const outDate = s.clock_out!.slice(0, 5) <= s.clock_in!.slice(0, 5) ? addDays(s.date, 1) : s.date;
              const outAt = zonedToUtc(outDate, s.clock_out!.slice(0, 5), tz);
              const [kIn, kOut] = s.workable === false ? (['break_start', 'break_end'] as const) : (['in', 'out'] as const);
              const a = await this.time.importEntry(tx, employmentId, { kind: kIn, occurredAt: inAt, reason: IMPORT_REASON, idempotencyKey: `factorial:shift:${s.id}:in` });
              await this.time.importEntry(tx, employmentId, { kind: kOut, occurredAt: outAt, reason: IMPORT_REASON, idempotencyKey: `factorial:shift:${s.id}:out` });
              inc(a ? 'fichajes' : 'fichajes ya importados');
            }
          });
        }
        note('Fichajes importados.');
      }

      note('Migración terminada.');
      await save('done');
    } catch (err) {
      const msg = (err as Error).message;
      this.log.error(msg);
      note(`Error: ${msg}`);
      await save('failed', msg).catch(() => undefined);
      throw err;
    }
  }
}

class MappingStore {
  constructor(private readonly tx: Tx) {}

  async get(entity: string, externalId: string): Promise<string | null> {
    const r = await this.tx.maybeOne(`SELECT internal_id FROM migration_mapping WHERE source = 'factorial' AND entity = $1 AND external_id = $2`, [entity, externalId]);
    return r?.internal_id ?? null;
  }

  async set(entity: string, externalId: string, internalId: string) {
    await this.tx.query(
      `INSERT INTO migration_mapping (tenant_id, source, entity, external_id, internal_id) VALUES ($1,'factorial',$2,$3,$4)
       ON CONFLICT (tenant_id, source, entity, external_id) DO UPDATE SET internal_id = EXCLUDED.internal_id, updated_at = now()`,
      [this.tx.tenantId, entity, externalId, internalId],
    );
  }
}
