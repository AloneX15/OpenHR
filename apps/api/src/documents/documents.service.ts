import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Actor, assertHr, audit, canHr, hrCompanyFilter } from '../common/access';
import { monthRange } from '../common/dates';
import { findNationalIds } from '../common/spanish-id';
import { Tx } from '../db/db.service';
import { NotificationsService } from '../notifications/notifications.service';
import { extractPages, extractPageTexts, pageCount } from './pdf';
import { StorageService } from './storage.service';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export function periodLabel(period: string) {
  const [y, m] = period.split('-').map(Number);
  return `${MONTHS[m - 1]} de ${y}`;
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Mis documentos ──────────────────────────────────────────────────────────────
  async mine(tx: Tx, actor: Actor) {
    if (!actor.personId) return [];
    return tx.query(
      `SELECT d.id, d.category, d.title, d.period, d.published_at, d.first_read_at, c.name AS company_name,
              f.size_bytes, f.content_type
         FROM document d JOIN stored_file f ON f.id = d.file_id LEFT JOIN company c ON c.id = d.company_id
        WHERE d.person_id = $1 ORDER BY d.published_at DESC, d.title`,
      [actor.personId],
    );
  }

  async ofPerson(tx: Tx, actor: Actor, personId: string) {
    const companies = hrCompanyFilter(actor);
    if (companies !== null && companies.length === 0) throw new ForbiddenException();
    return tx.query(
      `SELECT d.id, d.category, d.title, d.period, d.published_at, d.first_read_at, c.name AS company_name
         FROM document d LEFT JOIN company c ON c.id = d.company_id
        WHERE d.person_id = $1 AND ($2::uuid[] IS NULL OR d.company_id = ANY($2))
        ORDER BY d.published_at DESC`,
      [personId, companies],
    );
  }

  async download(tx: Tx, actor: Actor, documentId: string) {
    const doc = await tx.maybeOne('SELECT * FROM document WHERE id = $1', [documentId]);
    if (!doc) throw new NotFoundException('Documento no encontrado');
    const own = doc.person_id === actor.personId;
    if (!own && !(doc.company_id && canHr(actor, doc.company_id)) && !actor.isAdmin) throw new ForbiddenException();
    if (own && !doc.first_read_at) {
      // Acuse de lectura: primera descarga por la propia persona.
      await tx.query('UPDATE document SET first_read_at = now() WHERE id = $1', [documentId]);
    }
    if (!own) await audit(tx, 'document.downloaded', 'document', documentId);
    return this.storage.read(tx, doc.file_id);
  }

  async upload(
    tx: Tx,
    actor: Actor,
    input: { personId: string; companyId: string; category: string; title: string; period?: string },
    file: { buffer: Buffer; originalname: string; mimetype: string },
  ) {
    assertHr(actor, input.companyId);
    const emp = await tx.maybeOne('SELECT 1 FROM employment WHERE person_id = $1 AND company_id = $2', [input.personId, input.companyId]);
    if (!emp) throw new BadRequestException('La persona no tiene relación laboral con esa sociedad');
    const stored = await this.storage.store(tx, file.buffer, file.originalname, file.mimetype || 'application/octet-stream');
    const doc = await tx.one(
      `INSERT INTO document (tenant_id, person_id, company_id, file_id, category, title, period, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [tx.tenantId, input.personId, input.companyId, stored.id, input.category, input.title, input.period ?? null, tx.userId],
    );
    const user = await tx.maybeOne('SELECT id FROM app_user WHERE person_id = $1', [input.personId]);
    if (user) {
      await this.notifications.notifyUsers(tx, [user.id], {
        type: 'document.published',
        title: `Tienes un documento nuevo: ${input.title}`,
        link: '/documentos',
      });
    }
    await audit(tx, 'document.uploaded', 'document', doc.id, { personId: input.personId, category: input.category });
    return doc;
  }

  // ── Reparto de nóminas ──────────────────────────────────────────────────────────
  async createBatch(tx: Tx, actor: Actor, input: { companyId: string; period: string }, file: { buffer: Buffer; originalname: string }) {
    assertHr(actor, input.companyId);
    if (file.buffer.subarray(0, 5).toString() !== '%PDF-') throw new BadRequestException('El fichero no es un PDF');
    let pages: number;
    try {
      pages = await pageCount(file.buffer);
    } catch {
      throw new BadRequestException('No se puede leer el PDF (¿está protegido con contraseña?)');
    }
    if (pages === 0 || pages > 2000) throw new BadRequestException('El PDF debe tener entre 1 y 2000 páginas');
    let texts: string[];
    try {
      texts = await extractPageTexts(file.buffer);
    } catch {
      texts = new Array(pages).fill('');
    }

    // Personas con relación laboral en la sociedad durante el periodo.
    const { from, to } = monthRange(input.period);
    const people = await tx.query<{ id: string; national_id: string }>(
      `SELECT DISTINCT p.id, p.national_id FROM employment e JOIN person p ON p.id = e.person_id
        WHERE e.company_id = $1 AND p.national_id IS NOT NULL AND e.start_date <= $3 AND (e.end_date IS NULL OR e.end_date >= $2)`,
      [input.companyId, from, to],
    );
    const byId = new Map(people.map((p) => [p.national_id, p.id]));

    const stored = await this.storage.store(tx, file.buffer, file.originalname, 'application/pdf');
    const batch = await tx.one(
      `INSERT INTO payslip_batch (tenant_id, company_id, period, file_id, page_count, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [tx.tenantId, input.companyId, input.period, stored.id, pages, tx.userId],
    );
    let matched = 0;
    for (let i = 0; i < pages; i++) {
      const ids = findNationalIds(texts[i] ?? '');
      const candidates = [...new Set(ids.map((id) => byId.get(id)).filter(Boolean))] as string[];
      // Solo se sugiere si hay exactamente una persona de la sociedad en la página.
      const suggestion = candidates.length === 1 ? candidates[0] : null;
      if (suggestion) matched++;
      await tx.query(
        `INSERT INTO payslip_page (tenant_id, batch_id, page_number, detected_ids, suggested_person_id) VALUES ($1,$2,$3,$4,$5)`,
        [tx.tenantId, batch.id, i + 1, ids, suggestion],
      );
    }
    await audit(tx, 'payslips.batch_created', 'payslip_batch', batch.id, { pages, matched, period: input.period });
    return { id: batch.id, pages, matched };
  }

  async listBatches(tx: Tx, actor: Actor) {
    const companies = hrCompanyFilter(actor);
    if (companies !== null && companies.length === 0) throw new ForbiddenException();
    return tx.query(
      `SELECT b.id, b.period, b.page_count, b.status, b.created_at, b.published_at, c.name AS company_name, b.company_id,
              count(pg.id) FILTER (WHERE pg.review_status = 'pending')::int AS pending_pages,
              count(pg.id) FILTER (WHERE pg.review_status = 'confirmed')::int AS confirmed_pages
         FROM payslip_batch b JOIN company c ON c.id = b.company_id LEFT JOIN payslip_page pg ON pg.batch_id = b.id
        WHERE ($1::uuid[] IS NULL OR b.company_id = ANY($1))
        GROUP BY b.id, c.name ORDER BY b.created_at DESC LIMIT 100`,
      [companies],
    );
  }

  private async batchFor(tx: Tx, actor: Actor, batchId: string, lock = false) {
    const b = await tx.maybeOne(`SELECT * FROM payslip_batch WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [batchId]);
    if (!b) throw new NotFoundException('Lote no encontrado');
    assertHr(actor, b.company_id);
    return b;
  }

  async getBatch(tx: Tx, actor: Actor, batchId: string) {
    const b = await this.batchFor(tx, actor, batchId);
    const pages = await tx.query(
      `SELECT pg.id, pg.page_number, pg.detected_ids, pg.review_status, pg.suggested_person_id, pg.person_id,
              sp.first_name || ' ' || sp.last_name AS suggested_name, sp.national_id AS suggested_national_id,
              ap.first_name || ' ' || ap.last_name AS person_name, ap.national_id AS person_national_id
         FROM payslip_page pg
         LEFT JOIN person sp ON sp.id = pg.suggested_person_id
         LEFT JOIN person ap ON ap.id = pg.person_id
        WHERE pg.batch_id = $1 ORDER BY pg.page_number`,
      [batchId],
    );
    const company = await tx.one('SELECT name FROM company WHERE id = $1', [b.company_id]);
    return { ...b, company_name: company.name, pages };
  }

  async pagePdf(tx: Tx, actor: Actor, batchId: string, pageNumber: number) {
    const b = await this.batchFor(tx, actor, batchId);
    if (pageNumber < 1 || pageNumber > b.page_count) throw new NotFoundException();
    const { data } = await this.storage.read(tx, b.file_id);
    return extractPages(data, [pageNumber]);
  }

  async reviewPage(tx: Tx, actor: Actor, batchId: string, pageId: string, input: { status: 'confirmed' | 'skipped' | 'pending'; personId?: string | null }) {
    const b = await this.batchFor(tx, actor, batchId, true);
    if (b.status !== 'review') throw new ConflictException('El lote ya no está en revisión');
    let personId: string | null = null;
    if (input.status === 'confirmed') {
      if (!input.personId) throw new BadRequestException('Indica a quién corresponde la página');
      const ok = await tx.maybeOne('SELECT 1 FROM employment WHERE person_id = $1 AND company_id = $2', [input.personId, b.company_id]);
      if (!ok) throw new BadRequestException('Esa persona no trabaja en la sociedad del lote');
      personId = input.personId;
    }
    const updated = await tx.query(
      `UPDATE payslip_page SET review_status = $3, person_id = $4, reviewed_by = $5, reviewed_at = now()
        WHERE id = $1 AND batch_id = $2 RETURNING id`,
      [pageId, batchId, input.status, personId, tx.userId],
    );
    if (!updated.length) throw new NotFoundException('Página no encontrada');
    return { ok: true };
  }

  /** Confirma de una vez las páginas con una única sugerencia (acción explícita de RR. HH.). */
  async confirmSuggestions(tx: Tx, actor: Actor, batchId: string) {
    const b = await this.batchFor(tx, actor, batchId, true);
    if (b.status !== 'review') throw new ConflictException('El lote ya no está en revisión');
    const rows = await tx.query(
      `UPDATE payslip_page SET review_status = 'confirmed', person_id = suggested_person_id, reviewed_by = $2, reviewed_at = now()
        WHERE batch_id = $1 AND review_status = 'pending' AND suggested_person_id IS NOT NULL RETURNING id`,
      [batchId, tx.userId],
    );
    await audit(tx, 'payslips.suggestions_confirmed', 'payslip_batch', batchId, { pages: rows.length });
    return { confirmed: rows.length };
  }

  async publish(tx: Tx, actor: Actor, batchId: string) {
    const b = await this.batchFor(tx, actor, batchId, true);
    if (b.status !== 'review') throw new ConflictException('El lote ya no está en revisión');
    const pages = await tx.query('SELECT page_number, review_status, person_id FROM payslip_page WHERE batch_id = $1 ORDER BY page_number', [batchId]);
    const pending = pages.filter((p) => p.review_status === 'pending').length;
    if (pending) throw new BadRequestException(`Faltan ${pending} página(s) por revisar`);
    const byPerson = new Map<string, number[]>();
    for (const p of pages.filter((x) => x.review_status === 'confirmed')) {
      byPerson.set(p.person_id, [...(byPerson.get(p.person_id) ?? []), p.page_number]);
    }
    if (!byPerson.size) throw new BadRequestException('No hay ninguna página asignada');

    const { data } = await this.storage.read(tx, b.file_id);
    const company = await tx.one('SELECT name FROM company WHERE id = $1', [b.company_id]);
    const title = `Nómina de ${periodLabel(b.period)} · ${company.name}`;
    for (const [personId, nums] of byPerson) {
      const pdf = await extractPages(data, nums);
      const stored = await this.storage.store(tx, pdf, `nomina-${b.period}.pdf`, 'application/pdf', { generated: true });
      await tx.query(
        `INSERT INTO document (tenant_id, person_id, company_id, file_id, category, title, period, batch_id, created_by)
         VALUES ($1,$2,$3,$4,'payslip',$5,$6,$7,$8)`,
        [tx.tenantId, personId, b.company_id, stored.id, title, b.period, batchId, tx.userId],
      );
      const user = await tx.maybeOne('SELECT id FROM app_user WHERE person_id = $1 AND is_active', [personId]);
      if (user) {
        await this.notifications.notifyUsers(tx, [user.id], {
          type: 'payslip.published',
          title: `Ya tienes tu nómina de ${periodLabel(b.period)}`,
          body: `Puedes descargarla en OpenHR, en Mis documentos.`,
          link: '/documentos',
        });
      }
    }
    await tx.query(`UPDATE payslip_batch SET status = 'published', published_by = $2, published_at = now() WHERE id = $1`, [batchId, tx.userId]);
    await audit(tx, 'payslips.published', 'payslip_batch', batchId, { people: byPerson.size });
    return { people: byPerson.size };
  }

  async discard(tx: Tx, actor: Actor, batchId: string) {
    const b = await this.batchFor(tx, actor, batchId, true);
    if (b.status !== 'review') throw new ConflictException('Solo se pueden descartar lotes en revisión');
    await tx.query(`UPDATE payslip_batch SET status = 'discarded' WHERE id = $1`, [batchId]);
    await audit(tx, 'payslips.discarded', 'payslip_batch', batchId);
    return { ok: true };
  }
}
