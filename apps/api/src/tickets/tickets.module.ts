import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { Actor, audit, canHr, hrCompanyFilter, isHrAnywhere, loadActor } from '../common/access';
import { CurrentUser, parse, SessionUser, zUuid } from '../common/http';
import { Db, Tx } from '../db/db.service';
import { sendFile } from '../documents/documents.controller';
import { DocumentsModule } from '../documents/documents.module';
import { StorageService } from '../documents/storage.service';
import { NotificationsService } from '../notifications/notifications.service';

const MAX_FILE = 10 * 1024 * 1024;
const FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'text/plain'];
type Status = 'open' | 'in_progress' | 'waiting' | 'resolved' | 'closed';
const STATUS_LABEL: Record<Status, string> = { open: 'abierta', in_progress: 'en curso', waiting: 'pendiente de tu respuesta', resolved: 'resuelta', closed: 'cerrada' };

const SELECT = `
  SELECT t.id, t.number, t.company_id, co.name AS company_name, t.requester_user_id, t.category_id, c.name AS category_name,
         t.subject, t.status, t.priority, t.assignee_user_id, t.created_at, t.updated_at, t.resolved_at,
         coalesce(rp.first_name || ' ' || rp.last_name, ru.email) AS requester_name,
         coalesce(ap.first_name || ' ' || ap.last_name, au.email) AS assignee_name
    FROM ticket t
    JOIN ticket_category c ON c.id = t.category_id
    JOIN company co ON co.id = t.company_id
    JOIN app_user ru ON ru.id = t.requester_user_id LEFT JOIN person rp ON rp.id = ru.person_id
    LEFT JOIN app_user au ON au.id = t.assignee_user_id LEFT JOIN person ap ON ap.id = au.person_id`;

interface File {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

@Injectable()
export class TicketsService {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly storage: StorageService,
  ) {}

  categories(tx: Tx, all = false) {
    return tx.query('SELECT id, name, active FROM ticket_category WHERE active OR $1 ORDER BY name', [all]);
  }

  async saveCategory(tx: Tx, actor: Actor, id: string | null, input: { name: string; active: boolean }) {
    if (!actor.isAdmin && !actor.hrAll) throw new ForbiddenException('Las categorías las gestiona administración o RR. HH. del grupo');
    const row = id
      ? await tx.maybeOne('UPDATE ticket_category SET name = $2, active = $3 WHERE id = $1 RETURNING id', [id, input.name, input.active])
      : await tx.one('INSERT INTO ticket_category (tenant_id, name, active) VALUES ($1,$2,$3) RETURNING id', [tx.tenantId, input.name, input.active]);
    if (!row) throw new NotFoundException();
    return row;
  }

  private async load(tx: Tx, actor: Actor, id: string) {
    const t = await tx.maybeOne(`${SELECT} WHERE t.id = $1`, [id]);
    if (!t) throw new NotFoundException('Consulta no encontrada');
    const hr = canHr(actor, t.company_id);
    const own = t.requester_user_id === actor.userId;
    if (!hr && !own) throw new NotFoundException('Consulta no encontrada');
    return { t, hr, own };
  }

  private async saveFile(tx: Tx, file?: File) {
    if (!file) return null;
    if (!FILE_TYPES.includes(file.mimetype)) throw new BadRequestException('Adjunta una foto, un PDF o un texto');
    return (await this.storage.store(tx, file.buffer, file.originalname, file.mimetype)).id;
  }

  // ── Para todo el mundo ──────────────────────────────────────────────────────────
  async create(tx: Tx, actor: Actor, input: { companyId?: string; categoryId: string; subject: string; body: string }, file?: File) {
    const companies = [...new Set(actor.employments.filter((e) => e.active).map((e) => e.companyId))];
    const companyId = input.companyId ?? companies[0];
    if (!companyId || !companies.includes(companyId)) throw new BadRequestException('Elige una de tus sociedades');
    const cat = await tx.maybeOne('SELECT name FROM ticket_category WHERE id = $1 AND active', [input.categoryId]);
    if (!cat) throw new BadRequestException('Categoría no válida');
    const t = await tx.one(
      `INSERT INTO ticket (tenant_id, company_id, requester_user_id, category_id, subject) VALUES ($1,$2,$3,$4,$5) RETURNING id, number`,
      [tx.tenantId, companyId, actor.userId, input.categoryId, input.subject],
    );
    const fileId = await this.saveFile(tx, file);
    await tx.query('INSERT INTO ticket_message (tenant_id, ticket_id, author_user_id, body, file_id) VALUES ($1,$2,$3,$4,$5)', [
      tx.tenantId,
      t.id,
      actor.userId,
      input.body,
      fileId,
    ]);
    const hr = (await this.notifications.hrUserIds(tx, companyId)).filter((u) => u !== actor.userId);
    await this.notifications.notifyUsers(tx, hr, {
      type: 'ticket.created',
      title: `Nueva consulta #${t.number}: ${input.subject}`,
      body: `${cat.name}. Responde desde Consultas.`,
      link: `/consultas/${t.id}`,
    });
    await audit(tx, 'ticket.created', 'ticket', t.id, { category: cat.name });
    return t;
  }

  mine(tx: Tx, actor: Actor) {
    return tx.query(`${SELECT} WHERE t.requester_user_id = $1 ORDER BY t.updated_at DESC LIMIT 200`, [actor.userId]);
  }

  async get(tx: Tx, actor: Actor, id: string) {
    const { t, hr } = await this.load(tx, actor, id);
    const messages = await tx.query(
      `SELECT m.id, m.author_user_id, m.body, m.internal, m.created_at, m.file_id IS NOT NULL AS has_file, f.filename,
              coalesce(p.first_name || ' ' || p.last_name, u.email) AS author_name,
              (m.author_user_id <> $2) AS from_hr
         FROM ticket_message m JOIN app_user u ON u.id = m.author_user_id LEFT JOIN person p ON p.id = u.person_id
         LEFT JOIN stored_file f ON f.id = m.file_id
        WHERE m.ticket_id = $1 AND (NOT m.internal OR $3) ORDER BY m.created_at`,
      [id, t.requester_user_id, hr],
    );
    return { ...t, canManage: hr, messages };
  }

  async reply(tx: Tx, actor: Actor, id: string, input: { body: string; internal: boolean }, file?: File) {
    const { t, hr, own } = await this.load(tx, actor, id);
    if (input.internal && !hr) throw new ForbiddenException('Solo RR. HH. puede escribir notas internas');
    if (t.status === 'closed') throw new BadRequestException('La consulta está cerrada');
    const fileId = await this.saveFile(tx, file);
    await tx.query('INSERT INTO ticket_message (tenant_id, ticket_id, author_user_id, body, internal, file_id) VALUES ($1,$2,$3,$4,$5,$6)', [
      tx.tenantId,
      id,
      actor.userId,
      input.body,
      input.internal,
      fileId,
    ]);
    let status: Status = t.status;
    if (own && !input.internal && ['waiting', 'resolved'].includes(t.status)) status = 'open'; // la persona vuelve a escribir
    else if (hr && !own && !input.internal && t.status === 'open') status = 'in_progress';
    const assignee = t.assignee_user_id ?? (hr && !own ? actor.userId : null);
    await tx.query('UPDATE ticket SET status = $2, assignee_user_id = $3, updated_at = now(), resolved_at = CASE WHEN $2 = \'resolved\' THEN resolved_at END WHERE id = $1', [
      id,
      status,
      assignee,
    ]);
    if (!input.internal) {
      const to = own ? (assignee ? [assignee] : await this.notifications.hrUserIds(tx, t.company_id)) : [t.requester_user_id];
      await this.notifications.notifyUsers(
        tx,
        to.filter((u: string) => u !== actor.userId),
        {
          type: 'ticket.reply',
          title: own ? `Respuesta en la consulta #${t.number}` : `RR. HH. ha respondido a tu consulta #${t.number}`,
          body: t.subject,
          link: `/consultas/${id}`,
        },
      );
    }
    return { ok: true, status };
  }

  /** Cambios de RR. HH. (estado, responsable, prioridad, categoría) y cierre o reapertura por la persona. */
  async update(tx: Tx, actor: Actor, id: string, input: { status?: Status; assigneeUserId?: string | null; priority?: 'normal' | 'high'; categoryId?: string }) {
    const { t, hr, own } = await this.load(tx, actor, id);
    if (!hr) {
      // La persona solo puede cerrar su consulta o reabrirla si estaba resuelta.
      const allowed = own && Object.keys(input).every((k) => k === 'status') && (input.status === 'closed' || (input.status === 'open' && t.status === 'resolved'));
      if (!allowed) throw new ForbiddenException();
    }
    if (input.assigneeUserId) {
      const ok = (await this.notifications.hrUserIds(tx, t.company_id)).includes(input.assigneeUserId);
      if (!ok) throw new BadRequestException('Solo se puede asignar a RR. HH. de la sociedad');
    }
    await tx.query(
      `UPDATE ticket SET status = coalesce($2, status), assignee_user_id = CASE WHEN $3 THEN $4::uuid ELSE assignee_user_id END,
              priority = coalesce($5, priority), category_id = coalesce($6, category_id), updated_at = now(),
              resolved_at = CASE WHEN $2 = 'resolved' THEN now() WHEN $2 IN ('open', 'in_progress', 'waiting') THEN NULL ELSE resolved_at END
        WHERE id = $1`,
      [id, input.status ?? null, input.assigneeUserId !== undefined, input.assigneeUserId ?? null, input.priority ?? null, input.categoryId ?? null],
    );
    if (input.status && input.status !== t.status && hr && !own && ['waiting', 'resolved'].includes(input.status)) {
      await this.notifications.notifyUsers(tx, [t.requester_user_id], {
        type: 'ticket.status',
        title: `Tu consulta #${t.number} está ${STATUS_LABEL[input.status]}`,
        body: t.subject,
        link: `/consultas/${id}`,
      });
    }
    if (input.assigneeUserId && input.assigneeUserId !== actor.userId) {
      await this.notifications.notifyUsers(tx, [input.assigneeUserId], { type: 'ticket.assigned', title: `Te han asignado la consulta #${t.number}`, body: t.subject, link: `/consultas/${id}` });
    }
    await audit(tx, 'ticket.updated', 'ticket', id, input);
    return { ok: true };
  }

  /** Bandeja de RR. HH. */
  queue(tx: Tx, actor: Actor, f: { status?: string; mine?: boolean }) {
    if (!isHrAnywhere(actor)) throw new ForbiddenException();
    const open = f.status === 'active' || !f.status;
    return tx.query(
      `${SELECT}
        WHERE ($1::uuid[] IS NULL OR t.company_id = ANY($1))
          AND (CASE WHEN $2 THEN t.status IN ('open', 'in_progress', 'waiting') ELSE t.status = $3 END)
          AND (NOT $4 OR t.assignee_user_id = $5)
        ORDER BY (t.priority = 'high') DESC, t.updated_at LIMIT 500`,
      [hrCompanyFilter(actor), open, f.status ?? null, !!f.mine, actor.userId],
    );
  }

  /** Personas de RR. HH. a las que se puede asignar una consulta. */
  async assignees(tx: Tx, actor: Actor, id: string) {
    const { t, hr } = await this.load(tx, actor, id);
    if (!hr) throw new ForbiddenException();
    const ids = await this.notifications.hrUserIds(tx, t.company_id);
    return tx.query(
      `SELECT u.id, coalesce(p.first_name || ' ' || p.last_name, u.email) AS name FROM app_user u LEFT JOIN person p ON p.id = u.person_id
        WHERE u.id = ANY($1) AND u.is_active ORDER BY 2`,
      [ids],
    );
  }

  async file(tx: Tx, actor: Actor, id: string, messageId: string) {
    const { hr } = await this.load(tx, actor, id);
    const m = await tx.maybeOne('SELECT file_id, internal FROM ticket_message WHERE id = $1 AND ticket_id = $2', [messageId, id]);
    if (!m?.file_id || (m.internal && !hr)) throw new NotFoundException();
    return this.storage.read(tx, m.file_id);
  }
}

const zStatus = z.enum(['open', 'in_progress', 'waiting', 'resolved', 'closed']);

@Controller('tickets')
export class TicketsController {
  constructor(
    private readonly db: Db,
    private readonly tickets: TicketsService,
  ) {}

  private run<T>(u: SessionUser, fn: (tx: Tx, a: Actor) => Promise<T>) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => fn(tx, await loadActor(tx)));
  }

  @Get('categories')
  categories(@CurrentUser() u: SessionUser, @Query('all') all?: string) {
    return this.db.tx(u.tenantId, u.userId, (tx) => this.tickets.categories(tx, all === 'true'));
  }

  @Post('categories')
  createCategory(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(z.object({ name: z.string().trim().min(1).max(80), active: z.boolean().default(true) }), body);
    return this.run(u, (tx, a) => this.tickets.saveCategory(tx, a, null, input));
  }

  @Patch('categories/:id')
  updateCategory(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(z.object({ name: z.string().trim().min(1).max(80), active: z.boolean().default(true) }), body);
    return this.run(u, (tx, a) => this.tickets.saveCategory(tx, a, id, input));
  }

  @Get('mine')
  mine(@CurrentUser() u: SessionUser) {
    return this.run(u, (tx, a) => this.tickets.mine(tx, a));
  }

  @Get()
  queue(@CurrentUser() u: SessionUser, @Query() q: unknown) {
    const f = parse(z.object({ status: z.union([zStatus, z.literal('active')]).optional(), mine: z.enum(['true', 'false']).optional() }), q);
    return this.run(u, (tx, a) => this.tickets.queue(tx, a, { status: f.status, mine: f.mine === 'true' }));
  }

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE } }))
  create(@CurrentUser() u: SessionUser, @Body() body: unknown, @UploadedFile() file?: Express.Multer.File) {
    const input = parse(
      z.object({ companyId: zUuid.optional(), categoryId: zUuid, subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(10000) }),
      body,
    );
    return this.run(u, (tx, a) => this.tickets.create(tx, a, input, file));
  }

  @Get(':id')
  get(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.run(u, (tx, a) => this.tickets.get(tx, a, id));
  }

  @Get(':id/assignees')
  assignees(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.run(u, (tx, a) => this.tickets.assignees(tx, a, id));
  }

  @Post(':id/messages')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE } }))
  reply(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @UploadedFile() file?: Express.Multer.File) {
    const input = parse(
      z.object({ body: z.string().trim().min(1).max(10000), internal: z.preprocess((v) => v === true || v === 'true', z.boolean()).default(false) }),
      body,
    );
    return this.run(u, (tx, a) => this.tickets.reply(tx, a, id, input, file));
  }

  @Patch(':id')
  update(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(
      z.object({ status: zStatus.optional(), assigneeUserId: zUuid.nullable().optional(), priority: z.enum(['normal', 'high']).optional(), categoryId: zUuid.optional() }),
      body,
    );
    return this.run(u, (tx, a) => this.tickets.update(tx, a, id, input));
  }

  @Get(':id/messages/:messageId/file')
  async file(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Param('messageId', ParseUUIDPipe) messageId: string, @Res() res: Response) {
    const { file, data } = await this.run(u, (tx, a) => this.tickets.file(tx, a, id, messageId));
    sendFile(res, data, file.filename, file.content_type, true);
  }
}

@Module({ imports: [DocumentsModule], controllers: [TicketsController], providers: [TicketsService] })
export class TicketsModule {}
