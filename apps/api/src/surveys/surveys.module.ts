import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { Actor, assertAdmin, audit, canHr, hrCompanyFilter, isHrAnywhere, loadActor } from '../common/access';
import { CurrentUser, parse, SessionUser, zDate, zUuid } from '../common/http';
import { Db, Tx } from '../db/db.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Answers, Question, summarize, validateAnswers } from './results';

const zQuestion = z.object({
  kind: z.enum(['scale', 'enps', 'choice', 'text']),
  text: z.string().trim().min(1).max(500),
  options: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  required: z.boolean().default(true),
});
const zSurvey = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  companyId: zUuid.nullable().default(null),
  anonymous: z.boolean().default(true),
  minResponses: z.number().int().min(3).max(50).default(5),
  closesOn: zDate.nullish(),
  questions: z.array(zQuestion).min(1).max(40),
});
type SurveyInput = z.infer<typeof zSurvey>;

@Injectable()
export class SurveysService {
  constructor(private readonly notifications: NotificationsService) {}

  private assertManage(actor: Actor, companyId: string | null) {
    if (companyId ? !canHr(actor, companyId) : !(actor.isAdmin || actor.hrAll)) {
      throw new ForbiddenException(companyId ? 'Necesitas permisos de RR. HH. en esta sociedad' : 'Las encuestas de todo el grupo las lanza administración o RR. HH. del grupo');
    }
  }

  private inAudience(actor: Actor, companyId: string | null) {
    return actor.employments.some((e) => e.active && (!companyId || e.companyId === companyId));
  }

  private async load(tx: Tx, id: string) {
    const s = await tx.maybeOne('SELECT *, closes_on::text AS closes_on FROM survey WHERE id = $1', [id]);
    if (!s) throw new NotFoundException('Encuesta no encontrada');
    return s;
  }

  private questions(tx: Tx, surveyId: string) {
    return tx.query<Question>('SELECT id, kind, text, options, required FROM survey_question WHERE survey_id = $1 ORDER BY position', [surveyId]);
  }

  private async audience(tx: Tx, companyId: string | null): Promise<string[]> {
    const rows = await tx.query(
      `SELECT DISTINCT u.id FROM employment e JOIN app_user u ON u.person_id = e.person_id AND u.is_active
        WHERE (e.end_date IS NULL OR e.end_date >= current_date) AND e.start_date <= current_date AND ($1::uuid IS NULL OR e.company_id = $1)`,
      [companyId],
    );
    return rows.map((r) => r.id);
  }

  // ── Para todo el mundo ──────────────────────────────────────────────────────────
  async mine(tx: Tx, actor: Actor) {
    const rows = await tx.query(
      `SELECT s.id, s.title, s.description, s.anonymous, s.company_id, s.closes_on::text, s.opened_at,
              EXISTS (SELECT 1 FROM survey_participation p WHERE p.survey_id = s.id AND p.user_id = $1) AS answered
         FROM survey s WHERE s.status = 'open' ORDER BY s.opened_at DESC`,
      [actor.userId],
    );
    return rows.filter((s) => this.inAudience(actor, s.company_id));
  }

  async get(tx: Tx, actor: Actor, id: string) {
    const s = await this.load(tx, id);
    const manage = s.company_id ? canHr(actor, s.company_id) : actor.isAdmin || actor.hrAll;
    if (!manage && !(s.status === 'open' && this.inAudience(actor, s.company_id))) throw new NotFoundException('Encuesta no encontrada');
    const answered = !!(await tx.maybeOne('SELECT 1 FROM survey_participation WHERE survey_id = $1 AND user_id = $2', [id, actor.userId]));
    return { ...s, answered, canManage: manage, questions: await this.questions(tx, id) };
  }

  async respond(tx: Tx, actor: Actor, id: string, raw: Record<string, unknown>) {
    const s = await tx.maybeOne('SELECT id, company_id, anonymous, status, closes_on::text FROM survey WHERE id = $1 FOR SHARE', [id]);
    if (!s || !this.inAudience(actor, s.company_id)) throw new NotFoundException('Encuesta no encontrada');
    if (s.status !== 'open' || (s.closes_on && s.closes_on < new Date().toISOString().slice(0, 10))) throw new ConflictException('La encuesta está cerrada');
    let answers: Answers;
    try {
      answers = validateAnswers(await this.questions(tx, id), raw);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const first = await tx.maybeOne(
      'INSERT INTO survey_participation (tenant_id, survey_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id',
      [tx.tenantId, id, actor.userId],
    );
    if (!first) throw new ConflictException('Ya has respondido esta encuesta');
    await tx.query('INSERT INTO survey_response (tenant_id, survey_id, user_id, answers) VALUES ($1,$2,$3,$4)', [
      tx.tenantId,
      id,
      s.anonymous ? null : actor.userId,
      JSON.stringify(answers),
    ]);
    return { ok: true };
  }

  // ── RR. HH. ─────────────────────────────────────────────────────────────────────
  list(tx: Tx, actor: Actor) {
    if (!isHrAnywhere(actor)) throw new ForbiddenException();
    const companies = hrCompanyFilter(actor);
    return tx.query(
      `SELECT s.id, s.title, s.status, s.anonymous, s.company_id, c.name AS company_name, s.closes_on::text, s.opened_at, s.closed_at, s.created_at,
              (SELECT count(*)::int FROM survey_participation p WHERE p.survey_id = s.id) AS responses
         FROM survey s LEFT JOIN company c ON c.id = s.company_id
        WHERE $1::uuid[] IS NULL OR s.company_id = ANY($1)
        ORDER BY s.created_at DESC`,
      [companies],
    );
  }

  private async writeQuestions(tx: Tx, surveyId: string, questions: SurveyInput['questions']) {
    await tx.query('DELETE FROM survey_question WHERE survey_id = $1', [surveyId]);
    for (const [i, q] of questions.entries()) {
      if (q.kind === 'choice' && q.options.length < 2) throw new BadRequestException(`La pregunta «${q.text}» necesita al menos dos opciones`);
      await tx.query(`INSERT INTO survey_question (tenant_id, survey_id, position, kind, text, options, required) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
        tx.tenantId,
        surveyId,
        i,
        q.kind,
        q.text,
        q.kind === 'choice' ? q.options : [],
        q.required,
      ]);
    }
  }

  async create(tx: Tx, actor: Actor, input: SurveyInput) {
    this.assertManage(actor, input.companyId);
    const row = await tx.one(
      `INSERT INTO survey (tenant_id, company_id, title, description, anonymous, min_responses, closes_on, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [tx.tenantId, input.companyId, input.title, input.description ?? null, input.anonymous, input.minResponses, input.closesOn ?? null, actor.userId],
    );
    await this.writeQuestions(tx, row.id, input.questions);
    await audit(tx, 'survey.created', 'survey', row.id, { title: input.title, anonymous: input.anonymous });
    return row;
  }

  async update(tx: Tx, actor: Actor, id: string, input: SurveyInput) {
    const s = await this.load(tx, id);
    this.assertManage(actor, s.company_id);
    this.assertManage(actor, input.companyId);
    if (s.status !== 'draft') throw new ConflictException('Solo se puede editar una encuesta en borrador');
    await tx.query(
      `UPDATE survey SET company_id = $2, title = $3, description = $4, anonymous = $5, min_responses = $6, closes_on = $7 WHERE id = $1`,
      [id, input.companyId, input.title, input.description ?? null, input.anonymous, input.minResponses, input.closesOn ?? null],
    );
    await this.writeQuestions(tx, id, input.questions);
    return { ok: true };
  }

  async open(tx: Tx, actor: Actor, id: string) {
    const s = await this.load(tx, id);
    this.assertManage(actor, s.company_id);
    if (s.status !== 'draft') throw new ConflictException('La encuesta ya se ha lanzado');
    await tx.query(`UPDATE survey SET status = 'open', opened_at = now() WHERE id = $1`, [id]);
    await this.notifications.notifyUsers(tx, await this.audience(tx, s.company_id), {
      type: 'survey.opened',
      title: `Nueva encuesta: ${s.title}`,
      body: `${s.anonymous ? 'Es anónima. ' : ''}${s.closes_on ? `Puedes responder hasta el ${s.closes_on}.` : 'Tu opinión cuenta.'}`,
      link: `/encuestas/${id}`,
    });
    await audit(tx, 'survey.opened', 'survey', id);
    return { ok: true };
  }

  async close(tx: Tx, actor: Actor, id: string) {
    const s = await this.load(tx, id);
    this.assertManage(actor, s.company_id);
    if (s.status !== 'open') throw new ConflictException('La encuesta no está abierta');
    await tx.query(`UPDATE survey SET status = 'closed', closed_at = now() WHERE id = $1`, [id]);
    await audit(tx, 'survey.closed', 'survey', id);
    return { ok: true };
  }

  async results(tx: Tx, actor: Actor, id: string) {
    const s = await this.load(tx, id);
    this.assertManage(actor, s.company_id);
    const total = Number((await tx.one('SELECT count(*) AS n FROM survey_response WHERE survey_id = $1', [id])).n);
    const audienceSize = (await this.audience(tx, s.company_id)).length;
    const base = { survey: { id: s.id, title: s.title, status: s.status, anonymous: s.anonymous, minResponses: s.min_responses }, responses: total, audience: audienceSize };
    // Anonimato: con pocas respuestas se podría saber quién ha dicho qué.
    if (s.anonymous && total < s.min_responses) return { ...base, hidden: true, questions: [] };
    const rows = await tx.query<{ answers: Answers; name: string | null }>(
      `SELECT r.answers, ${s.anonymous ? 'NULL' : "coalesce(p.first_name || ' ' || p.last_name, u.email)"} AS name
         FROM survey_response r LEFT JOIN app_user u ON u.id = r.user_id LEFT JOIN person p ON p.id = u.person_id WHERE r.survey_id = $1`,
      [id],
    );
    await audit(tx, 'survey.results_viewed', 'survey', id);
    const questions = summarize(await this.questions(tx, id), rows.map((r) => r.answers));
    return { ...base, hidden: false, questions, ...(s.anonymous ? {} : { respondents: rows.map((r) => ({ name: r.name, answers: r.answers })) }) };
  }

  async remove(tx: Tx, actor: Actor, id: string) {
    const s = await this.load(tx, id);
    this.assertManage(actor, s.company_id);
    if (s.status !== 'draft') assertAdmin(actor);
    await tx.query('DELETE FROM survey WHERE id = $1', [id]);
    await audit(tx, 'survey.deleted', 'survey', id, { title: s.title });
    return { ok: true };
  }
}

@Controller('surveys')
export class SurveysController {
  constructor(
    private readonly db: Db,
    private readonly surveys: SurveysService,
  ) {}

  private run<T>(u: SessionUser, fn: (tx: Tx, actor: Actor) => Promise<T>) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => fn(tx, await loadActor(tx)));
  }

  @Get('mine')
  mine(@CurrentUser() u: SessionUser) {
    return this.run(u, (tx, a) => this.surveys.mine(tx, a));
  }

  @Get()
  list(@CurrentUser() u: SessionUser) {
    return this.run(u, (tx, a) => this.surveys.list(tx, a));
  }

  @Post()
  create(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(zSurvey, body);
    return this.run(u, (tx, a) => this.surveys.create(tx, a, input));
  }

  @Get(':id')
  get(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.run(u, (tx, a) => this.surveys.get(tx, a, id));
  }

  @Put(':id')
  update(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(zSurvey, body);
    return this.run(u, (tx, a) => this.surveys.update(tx, a, id, input));
  }

  @Post(':id/open')
  open(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.run(u, (tx, a) => this.surveys.open(tx, a, id));
  }

  @Post(':id/close')
  close(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.run(u, (tx, a) => this.surveys.close(tx, a, id));
  }

  @Post(':id/delete')
  remove(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.run(u, (tx, a) => this.surveys.remove(tx, a, id));
  }

  @Post(':id/responses')
  respond(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { answers } = parse(z.object({ answers: z.record(z.string(), z.unknown()) }), body);
    return this.run(u, (tx, a) => this.surveys.respond(tx, a, id, answers));
  }

  @Get(':id/results')
  results(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.run(u, (tx, a) => this.surveys.results(tx, a, id));
  }
}

@Module({ controllers: [SurveysController], providers: [SurveysService] })
export class SurveysModule {}
