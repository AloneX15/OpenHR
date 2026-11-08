import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Actor, assertEmploymentAccess, audit, canHr, employmentAccess, hrCompanyFilter, isHrAnywhere } from '../common/access';
import { Tx } from '../db/db.service';
import { ApprovalsService } from '../absences/approvals.service';
import { StorageService } from '../documents/storage.service';
import { NotificationsService } from '../notifications/notifications.service';

export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
const RECEIPT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

export interface ExpenseInput {
  employmentId: string;
  categoryId: string;
  date: string;
  description: string;
  amount?: number; // euros
  km?: number;
}

export interface Receipt {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

const euros = (cents: number) => (cents / 100).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

const SELECT = `
  SELECT x.id, x.employment_id, x.company_id, x.category_id, x.expense_date::text, x.description, x.amount_cents, x.km,
         x.status, x.stage, x.created_at, x.decision_comment, x.paid_at, x.paid_period, x.manager_decided_at, x.hr_decided_at,
         x.receipt_file_id IS NOT NULL AS has_receipt,
         c.name AS category_name, c.kind AS category_kind, c.limit_cents,
         (c.limit_cents IS NOT NULL AND x.amount_cents > c.limit_cents) AS over_limit,
         p.first_name || ' ' || p.last_name AS person_name, co.name AS company_name
    FROM expense x
    JOIN expense_category c ON c.id = x.category_id
    JOIN employment e ON e.id = x.employment_id
    JOIN person p ON p.id = e.person_id
    JOIN company co ON co.id = x.company_id`;

@Injectable()
export class ExpensesService {
  constructor(
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
    private readonly approvals: ApprovalsService,
  ) {}

  // ── Categorías ──────────────────────────────────────────────────────────────────
  categories(tx: Tx, all = false) {
    return tx.query(
      `SELECT id, name, kind, rate_cents_per_km, limit_cents, requires_receipt, active FROM expense_category
        WHERE active OR $1 ORDER BY active DESC, name`,
      [all],
    );
  }

  private assertCatalogAdmin(actor: Actor) {
    if (!actor.isAdmin && !actor.hrAll) throw new ForbiddenException('Las categorías las gestiona administración o RR. HH. del grupo');
  }

  async saveCategory(
    tx: Tx,
    actor: Actor,
    id: string | null,
    input: { name: string; kind: 'amount' | 'mileage'; rateCentsPerKm?: number | null; limitCents?: number | null; requiresReceipt: boolean; active: boolean },
  ) {
    this.assertCatalogAdmin(actor);
    if (input.kind === 'mileage' && !input.rateCentsPerKm) throw new BadRequestException('Indica la tarifa por kilómetro');
    const values = [input.name, input.kind, input.kind === 'mileage' ? input.rateCentsPerKm : null, input.limitCents ?? null, input.requiresReceipt, input.active];
    const row = id
      ? await tx.maybeOne(
          `UPDATE expense_category SET name = $2, kind = $3, rate_cents_per_km = $4, limit_cents = $5, requires_receipt = $6, active = $7
            WHERE id = $1 RETURNING id`,
          [id, ...values],
        )
      : await tx.one(
          `INSERT INTO expense_category (tenant_id, name, kind, rate_cents_per_km, limit_cents, requires_receipt, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [tx.tenantId, ...values],
        );
    if (!row) throw new NotFoundException();
    await audit(tx, 'expense_category.saved', 'expense_category', row.id, input);
    return row;
  }

  // ── Alta ────────────────────────────────────────────────────────────────────────
  async create(tx: Tx, actor: Actor, input: ExpenseInput, receipt?: Receipt) {
    await assertEmploymentAccess(tx, actor, input.employmentId, ['self']);
    const emp = await tx.one('SELECT company_id FROM employment WHERE id = $1', [input.employmentId]);
    const cat = await tx.maybeOne('SELECT * FROM expense_category WHERE id = $1 AND active', [input.categoryId]);
    if (!cat) throw new BadRequestException('Categoría no válida');
    if (input.date > new Date().toISOString().slice(0, 10)) throw new BadRequestException('La fecha del gasto no puede ser futura');

    let amountCents: number;
    let km: number | null = null;
    if (cat.kind === 'mileage') {
      if (!input.km || input.km <= 0) throw new BadRequestException('Indica los kilómetros');
      km = Math.round(input.km * 10) / 10;
      amountCents = Math.round(km * cat.rate_cents_per_km);
    } else {
      if (!input.amount || input.amount <= 0) throw new BadRequestException('Indica el importe');
      amountCents = Math.round(input.amount * 100);
    }
    if (cat.requires_receipt && !receipt) throw new BadRequestException(`Los gastos de «${cat.name}» necesitan justificante`);
    if (receipt && !RECEIPT_TYPES.includes(receipt.mimetype)) throw new BadRequestException('El justificante debe ser una foto o un PDF');

    const file = receipt ? await this.storage.store(tx, receipt.buffer, receipt.originalname, receipt.mimetype) : null;
    const managerId = await this.notifications.managerUserId(tx, input.employmentId);
    const stage = managerId && managerId !== actor.userId ? 'manager' : 'hr';
    const row = await tx.one(
      `INSERT INTO expense (tenant_id, employment_id, company_id, category_id, expense_date, description, amount_cents, km, receipt_file_id, stage, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [tx.tenantId, input.employmentId, emp.company_id, cat.id, input.date, input.description, amountCents, km, file?.id ?? null, stage, actor.userId],
    );
    await audit(tx, 'expense.created', 'expense', row.id, { amountCents, category: cat.name });
    await this.notifyStage(tx, row.id);
    return { id: row.id, amountCents, stage };
  }

  private async notifyStage(tx: Tx, id: string) {
    const x = await tx.one(`${SELECT} WHERE x.id = $1`, [id]);
    let to: string[];
    if (x.stage === 'manager') {
      const m = await this.notifications.managerUserId(tx, x.employment_id);
      to = m ? [m, ...(await this.approvals.delegatesOf(tx, [m]))] : [];
    } else {
      to = await this.notifications.hrUserIds(tx, x.company_id);
    }
    const self = await this.notifications.userIdForEmployment(tx, x.employment_id);
    await this.notifications.notifyUsers(
      tx,
      to.filter((u) => u !== self),
      {
        type: 'expense.requested',
        title: `${x.person_name} ha enviado un gasto de ${euros(x.amount_cents)}`,
        body: `${x.category_name}: ${x.description}. Necesita tu aprobación.`,
        link: '/gastos?tab=aprobar',
      },
    );
  }

  // ── Consultas ───────────────────────────────────────────────────────────────────
  mine(tx: Tx, actor: Actor) {
    const ids = actor.employments.map((e) => e.id);
    return tx.query(`${SELECT} WHERE x.employment_id = ANY($1) ORDER BY x.expense_date DESC, x.created_at DESC LIMIT 500`, [ids]);
  }

  /** Gastos pendientes cuyo paso actual me toca: como responsable (o delegación) o como RR. HH. */
  async toApprove(tx: Tx, actor: Actor) {
    const delegators = await tx.query(
      `SELECT DISTINCT from_user_id FROM approval_delegation WHERE to_user_id = $1 AND current_date BETWEEN start_date AND end_date`,
      [actor.userId],
    );
    const managerUsers = [actor.userId, ...delegators.map((d) => d.from_user_id)];
    return tx.query(
      `${SELECT}
        WHERE x.status = 'pending' AND x.created_by <> $1
          AND ((x.stage = 'manager' AND EXISTS (
                 SELECT 1 FROM employment m JOIN app_user u ON u.person_id = m.person_id
                  WHERE m.id = e.manager_employment_id AND u.id = ANY($2)))
               OR ($3::boolean AND ($4::uuid[] IS NULL OR x.company_id = ANY($4))))
        ORDER BY x.created_at`,
      [actor.userId, managerUsers, isHrAnywhere(actor), hrCompanyFilter(actor)],
    );
  }

  /** Listado de RR. HH. con filtros. */
  list(tx: Tx, actor: Actor, f: { status?: string; companyId?: string; period?: string }) {
    if (!isHrAnywhere(actor)) throw new ForbiddenException();
    return tx.query(
      `${SELECT}
        WHERE ($1::uuid[] IS NULL OR x.company_id = ANY($1))
          AND ($2::text IS NULL OR x.status = $2)
          AND ($3::uuid IS NULL OR x.company_id = $3)
          AND ($4::text IS NULL OR to_char(x.expense_date, 'YYYY-MM') = $4)
        ORDER BY x.expense_date DESC, x.created_at DESC LIMIT 2000`,
      [hrCompanyFilter(actor), f.status ?? null, f.companyId ?? null, f.period ?? null],
    );
  }

  private async load(tx: Tx, id: string) {
    const x = await tx.maybeOne(`${SELECT} WHERE x.id = $1`, [id]);
    if (!x) throw new NotFoundException('Gasto no encontrado');
    return x;
  }

  async receipt(tx: Tx, actor: Actor, id: string) {
    const x = await tx.maybeOne('SELECT employment_id, receipt_file_id FROM expense WHERE id = $1', [id]);
    if (!x) throw new NotFoundException();
    const access = await assertEmploymentAccess(tx, actor, x.employment_id);
    if (!x.receipt_file_id) throw new NotFoundException('Este gasto no tiene justificante');
    if (access !== 'self') await audit(tx, 'expense.receipt_viewed', 'expense', id);
    return this.storage.read(tx, x.receipt_file_id);
  }

  // ── Decisiones ──────────────────────────────────────────────────────────────────
  async decide(tx: Tx, actor: Actor, id: string, approve: boolean, comment?: string) {
    const x = await tx.maybeOne('SELECT *, expense_date::text AS day FROM expense WHERE id = $1 FOR UPDATE', [id]);
    if (!x) throw new NotFoundException('Gasto no encontrado');
    if (x.status !== 'pending') throw new BadRequestException('Este gasto ya está resuelto');
    if (x.created_by === actor.userId) throw new ForbiddenException('No puedes aprobar tus propios gastos');
    const isHr = canHr(actor, x.company_id);
    let asManager = false;
    if (x.stage === 'manager') {
      const m = await this.notifications.managerUserId(tx, x.employment_id);
      asManager = !!m && (m === actor.userId || (await this.approvals.delegatesOf(tx, [m])).includes(actor.userId));
      if (!asManager && (await employmentAccess(tx, actor, x.employment_id)) === 'manager') asManager = true;
    }
    if (!asManager && !isHr) throw new ForbiddenException('Este gasto no te toca aprobarlo');
    if (!approve && !comment?.trim()) throw new BadRequestException('Indica el motivo del rechazo');

    const self = await this.notifications.userIdForEmployment(tx, x.employment_id);
    const desc = `${euros(x.amount_cents)} del ${x.day}`;
    if (!approve) {
      const col = x.stage === 'manager' && !isHr ? 'manager' : 'hr';
      await tx.query(
        `UPDATE expense SET status = 'rejected', stage = NULL, decision_comment = $2, ${col}_decided_by = $3, ${col}_decided_at = now() WHERE id = $1`,
        [id, comment, actor.userId],
      );
      await audit(tx, 'expense.rejected', 'expense', id, { comment });
      if (self) await this.notifications.notifyUsers(tx, [self], { type: 'expense.rejected', title: 'Gasto rechazado', body: `Tu gasto de ${desc} se ha rechazado: ${comment}`, link: '/gastos' });
      return { status: 'rejected' };
    }
    if (x.stage === 'manager' && asManager && !isHr) {
      await tx.query(`UPDATE expense SET stage = 'hr', manager_decided_by = $2, manager_decided_at = now(), decision_comment = $3 WHERE id = $1`, [
        id,
        actor.userId,
        comment ?? null,
      ]);
      await audit(tx, 'expense.manager_approved', 'expense', id, { comment });
      await this.notifyStage(tx, id);
      return { status: 'pending', stage: 'hr' };
    }
    // RR. HH. resuelve el gasto entero.
    await tx.query(
      `UPDATE expense SET status = 'approved', stage = NULL, hr_decided_by = $2, hr_decided_at = now(), decision_comment = coalesce($3, decision_comment) WHERE id = $1`,
      [id, actor.userId, comment ?? null],
    );
    await audit(tx, 'expense.approved', 'expense', id, { comment });
    if (self) await this.notifications.notifyUsers(tx, [self], { type: 'expense.approved', title: 'Gasto aprobado', body: `Tu gasto de ${desc} está aprobado y se abonará con la nómina.`, link: '/gastos' });
    return { status: 'approved' };
  }

  async cancel(tx: Tx, actor: Actor, id: string) {
    const x = await this.load(tx, id);
    await assertEmploymentAccess(tx, actor, x.employment_id, ['self']);
    if (x.status !== 'pending') throw new BadRequestException('Solo se pueden anular gastos pendientes');
    await tx.query(`UPDATE expense SET status = 'cancelled', stage = NULL WHERE id = $1`, [id]);
    await audit(tx, 'expense.cancelled', 'expense', id);
    return { ok: true };
  }

  /** Marca gastos aprobados como abonados en la nómina de un periodo. */
  async markPaid(tx: Tx, actor: Actor, ids: string[], period: string) {
    const rows = await tx.query('SELECT id, company_id, status, employment_id, amount_cents FROM expense WHERE id = ANY($1) FOR UPDATE', [ids]);
    if (rows.length !== new Set(ids).size) throw new NotFoundException('Algún gasto no existe');
    for (const r of rows) {
      if (!canHr(actor, r.company_id)) throw new ForbiddenException();
      if (r.status !== 'approved') throw new BadRequestException('Solo se pueden abonar gastos aprobados');
    }
    await tx.query(`UPDATE expense SET status = 'paid', paid_at = now(), paid_period = $2 WHERE id = ANY($1)`, [ids, period]);
    await audit(tx, 'expense.paid', 'expense', null, { ids, period });
    return { paid: rows.length };
  }

  /** CSV para la nómina: un total por persona y sociedad de los gastos aprobados (o abonados en un periodo). */
  async exportCsv(tx: Tx, actor: Actor, f: { status: 'approved' | 'paid'; period?: string; companyId?: string }) {
    const rows = await this.list(tx, actor, { status: f.status, companyId: f.companyId });
    const filtered = f.status === 'paid' && f.period ? rows.filter((r) => r.paid_period === f.period) : rows;
    const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['Sociedad', 'Persona', 'Fecha', 'Categoría', 'Descripción', 'Km', 'Importe (EUR)', 'Estado', 'Periodo abonado'].map(q).join(';')];
    for (const r of filtered) {
      lines.push(
        [r.company_name, r.person_name, r.expense_date, r.category_name, r.description, r.km ?? '', (r.amount_cents / 100).toFixed(2).replace('.', ','), r.status, r.paid_period ?? '']
          .map(q)
          .join(';'),
      );
    }
    await audit(tx, 'expense.exported', 'expense', null, f);
    return '﻿' + lines.join('\r\n') + '\r\n';
  }
}
