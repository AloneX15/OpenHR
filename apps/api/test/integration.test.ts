/**
 * Tests de integración: API completa contra PostgreSQL real.
 * Requiere la base de datos de pruebas: docker compose -f docker-compose.test.yml up -d
 */
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { signPasswordToken } from '../src/auth/session';
import { runMigrations } from '../src/db/migrate';
import { configureApp } from '../src/main';

const ownerUrl = process.env.MIGRATION_DATABASE_URL!;
let app: NestExpressApplication;
let owner: Client;
let server: any;

const admin = () => request.agent(server);
let adminAgent: ReturnType<typeof request.agent>;
let luis: ReturnType<typeof request.agent>;
let marta: ReturnType<typeof request.agent>;
let tenantId: string;
let companyId: string;
let centerId: string;
let martaEmp: string;
let luisEmp: string;

const today = new Date().toISOString().slice(0, 10);
const year = Number(today.slice(0, 4));
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

async function loginWithToken(email: string) {
  const { rows } = await owner.query('SELECT id, tenant_id, password_hash FROM app_user WHERE email = $1', [email]);
  const token = signPasswordToken({ userId: rows[0].id, tenantId: rows[0].tenant_id }, rows[0].password_hash);
  const agent = request.agent(server);
  await agent.post('/api/auth/set-password').send({ token, password: 'una-contraseña-larga' }).expect(200);
  return agent;
}

/** Siguiente día laborable (lunes a viernes) a partir de dentro de `offset` días. */
function nextWeekday(offset: number) {
  const d = new Date(Date.now() + offset * 86400000);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await owner.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(ownerUrl, process.env.OPENHR_APP_DB_PASSWORD!, () => undefined);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ['error'] });
  configureApp(app);
  await app.init();
  server = app.getHttpServer();
  adminAgent = admin();
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
});

describe('puesta en marcha y organización', () => {
  it('crea la instalación y la persona administradora', async () => {
    expect((await request(server).get('/api/setup/status')).body).toEqual({ done: false });
    await adminAgent
      .post('/api/setup')
      .send({
        organizationName: 'Grupo Demo',
        companyName: 'Demo SL',
        companyTaxId: 'B12345678',
        firstName: 'Ana',
        lastName: 'Admin',
        email: 'ana@demo.test',
        password: 'password-segura-1',
      })
      .expect(201);
    expect((await request(server).get('/api/setup/status')).body).toEqual({ done: true });
    await request(server).post('/api/setup').send({}).expect(403);
    const me = await adminAgent.get('/api/auth/me').expect(200);
    expect(me.body).toMatchObject({ isAdmin: true, tenantName: 'Grupo Demo', email: 'ana@demo.test' });
    tenantId = me.body.tenantId;
  });

  it('rechaza peticiones sin sesión y logins incorrectos', async () => {
    await request(server).get('/api/auth/me').expect(401);
    await request(server).post('/api/auth/login').send({ email: 'ana@demo.test', password: 'mala-mala-mala' }).expect(401);
    const ok = await request(server).post('/api/auth/login').send({ email: 'ANA@demo.test', password: 'password-segura-1' }).expect(200);
    expect(ok.headers['set-cookie'][0]).toMatch(/openhr_session=.*HttpOnly/);
  });

  it('da de alta personas y envía invitaciones', async () => {
    companyId = (await adminAgent.get('/api/org/companies')).body[0].id;
    centerId = (await adminAgent.get('/api/org/work-centers')).body[0].id;
    const m = await adminAgent
      .post('/api/org/employees')
      .send({ firstName: 'Marta', lastName: 'Jefa', nationalId: '12345678Z', email: 'marta@demo.test', companyId, workCenterId: centerId, startDate: '2025-01-01' })
      .expect(201);
    martaEmp = m.body.employmentId;
    expect(m.body.invited).toBe(true);
    const l = await adminAgent
      .post('/api/org/employees')
      .send({
        firstName: 'Luis',
        lastName: 'Empleado',
        nationalId: '00000000-t',
        email: 'luis@demo.test',
        companyId,
        workCenterId: centerId,
        managerEmploymentId: martaEmp,
        startDate: '2025-01-01',
      })
      .expect(201);
    luisEmp = l.body.employmentId;
    await adminAgent.post('/api/org/employees').send({ firstName: 'X', lastName: 'Y', nationalId: '12345678A', companyId, startDate: '2025-01-01' }).expect(400);
    const outbox = await owner.query(`SELECT payload FROM outbox WHERE type = 'email' ORDER BY id`);
    expect(outbox.rows.map((r) => r.payload.to)).toEqual(['marta@demo.test', 'luis@demo.test']);
    expect(outbox.rows[0].payload.text).toContain('/definir-contrasena?token=');

    luis = await loginWithToken('luis@demo.test');
    marta = await loginWithToken('marta@demo.test');
    const me = await marta.get('/api/auth/me').expect(200);
    expect(me.body).toMatchObject({ isManager: true, isHr: false, isAdmin: false });
  });

  it('el enlace de contraseña es de un solo uso', async () => {
    const { rows } = await owner.query(`SELECT id, tenant_id FROM app_user WHERE email = 'luis@demo.test'`);
    const stale = signPasswordToken({ userId: rows[0].id, tenantId: rows[0].tenant_id }, null);
    await request(server).post('/api/auth/set-password').send({ token: stale, password: 'otra-contraseña-larga' }).expect(400);
  });

  it('cada persona ve solo lo que le corresponde', async () => {
    expect((await marta.get('/api/org/employees')).body.map((e: any) => e.first_name)).toEqual(['Luis']);
    expect((await luis.get('/api/org/employees')).body).toEqual([]);
    await luis.get(`/api/org/employees/${martaEmp}`).expect(403);
    const mine = await luis.get(`/api/org/employees/${luisEmp}`).expect(200);
    expect(mine.body.national_id).toBe('00000000T');
    const asManager = await marta.get(`/api/org/employees/${luisEmp}`).expect(200);
    expect(asManager.body.national_id).toBeUndefined();
    await luis.post('/api/org/companies').send({ name: 'X', legalName: 'X', taxId: 'B87654321' }).expect(403);
  });
});

describe('seguridad de la base de datos', () => {
  it('todas las tablas con tenant_id tienen RLS', async () => {
    const { rows } = await owner.query(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id')
         AND NOT c.relrowsecurity`);
    expect(rows).toEqual([]);
  });

  it('un tenant no ve los datos de otro', async () => {
    const other = await owner.query(`INSERT INTO tenant (name) VALUES ('Otro grupo') RETURNING id`);
    await owner.query(`INSERT INTO company (tenant_id, name, legal_name, tax_id) VALUES ($1, 'Ajena SL', 'Ajena SL', 'B99999999')`, [other.rows[0].id]);
    const app = new Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const visible = await app.query('SELECT tax_id FROM company');
      expect(visible.rows.map((r) => r.tax_id)).toEqual(['B12345678']);
      await expect(
        app.query(`INSERT INTO company (tenant_id, name, legal_name, tax_id) VALUES ($1, 'X', 'X', 'B11111111')`, [other.rows[0].id]),
      ).rejects.toThrow(/row-level security/);
      await app.query('ROLLBACK');
      // Sin contexto de tenant no se ve nada.
      expect((await app.query('SELECT count(*)::int AS n FROM company')).rows[0].n).toBe(0);
      expect((await app.query('SELECT count(*)::int AS n FROM tenant')).rows[0].n).toBe(0);
    } finally {
      await app.end();
    }
  });

  it('los fichajes no se pueden modificar ni borrar', async () => {
    await luis.post('/api/time/clock').send({ idempotencyKey: 'inmutable-1', kind: 'in' }).expect(201);
    const app = new Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      await expect(app.query(`UPDATE time_entry SET kind = 'out'`)).rejects.toThrow(/permission denied/);
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
    // Ni siquiera el propietario puede, gracias al trigger.
    await expect(owner.query(`DELETE FROM time_entry`)).rejects.toThrow(/inmutable/);
    await luis.post('/api/time/clock').send({ idempotencyKey: 'inmutable-2', kind: 'out' }).expect(201);
  });
});

describe('fichaje', () => {
  it('ficha entrada y salida de forma idempotente', async () => {
    const first = await luis.post('/api/time/clock').send({ idempotencyKey: 'clave-0001' }).expect(201);
    expect(first.body.entry.kind).toBe('in');
    const again = await luis.post('/api/time/clock').send({ idempotencyKey: 'clave-0001' }).expect(201);
    expect(again.body).toMatchObject({ replayed: true, entry: { id: first.body.entry.id } });
    const status = await luis.get('/api/time/status').expect(200);
    expect(status.body[0].state).toBe('working');
    await luis.post('/api/time/clock').send({ idempotencyKey: 'clave-0002', kind: 'break_end' }).expect(409);
    await luis.post('/api/time/clock').send({ idempotencyKey: 'clave-0003', kind: 'break_start' }).expect(201);
    await luis.post('/api/time/clock').send({ idempotencyKey: 'clave-0004', kind: 'break_end' }).expect(201);
    const out = await luis.post('/api/time/clock').send({ idempotencyKey: 'clave-0005' }).expect(201);
    expect(out.body.entry.kind).toBe('out');
    // Nadie sin relación laboral activa puede fichar.
    await adminAgent.post('/api/time/clock').send({ idempotencyKey: 'clave-admin' }).expect(400);
    const team = await marta.get('/api/time/team').expect(200);
    expect(team.body).toEqual([expect.objectContaining({ name: 'Luis Empleado', state: 'out' })]);
  });

  it('registra correcciones con motivo y avisa al responsable', async () => {
    await luis.post('/api/time/entries').send({ employmentId: luisEmp, kind: 'in', date: yesterday, time: '09:00', reason: 'x' }).expect(400);
    const added = await luis
      .post('/api/time/entries')
      .send({ employmentId: luisEmp, kind: 'in', date: yesterday, time: '09:00', reason: 'Olvidé fichar' })
      .expect(201);
    await luis.post('/api/time/entries').send({ employmentId: luisEmp, kind: 'out', date: yesterday, time: '17:00', reason: 'Olvidé fichar' }).expect(201);
    await marta.post('/api/time/entries').send({ employmentId: luisEmp, kind: 'out', date: yesterday, time: '18:00', reason: 'No debería' }).expect(403);
    const range = await luis.get(`/api/time/employments/${luisEmp}?from=${yesterday}&to=${yesterday}`).expect(200);
    expect(range.body.days[0].workedMinutes).toBe(480);
    expect(range.body.entries.every((e: any) => e.source === 'manual')).toBe(true);

    await luis.post(`/api/time/entries/${added.body.id}/void`).send({ reason: 'Me equivoqué de hora' }).expect(201);
    await luis.post(`/api/time/entries/${added.body.id}/void`).send({ reason: 'Otra vez' }).expect(409);
    const after = await marta.get(`/api/time/employments/${luisEmp}?from=${yesterday}&to=${yesterday}`).expect(200);
    expect(after.body.entries.find((e: any) => e.id === added.body.id).voided.reason).toBe('Me equivoqué de hora');
    expect(after.body.days[0].workedMinutes).toBe(0);

    const notes = await marta.get('/api/notifications').expect(200);
    expect(notes.body.some((n: any) => n.type === 'time.correction')).toBe(true);
  });

  it('la cadena de hashes se verifica y se sella', async () => {
    const v = await luis.get(`/api/time/employments/${luisEmp}/verify`).expect(200);
    expect(v.body).toMatchObject({ ok: true });
    expect(v.body.count).toBeGreaterThanOrEqual(9);
    const seal = await adminAgent.post('/api/time/seal').send({ companyId }).expect(201);
    expect(seal.body.digest).toMatch(/^[0-9a-f]{64}$/);
    await luis.post('/api/time/seal').send({ companyId }).expect(403);
  });
});

describe('ausencias', () => {
  let vacId: string;
  let reqId: string;
  const start = nextWeekday(20);

  it('solicita vacaciones y las aprueba el responsable', async () => {
    const types = await luis.get('/api/org/absence-types').expect(200);
    vacId = types.body.find((t: any) => t.code === 'VAC').id;
    const r = await luis.post('/api/absences').send({ absenceTypeId: vacId, startDate: start, endDate: start }).expect(201);
    expect(r.body).toMatchObject({ days: 1, status: 'pending' });
    reqId = r.body.id;
    await luis.post('/api/absences').send({ absenceTypeId: vacId, startDate: start, endDate: start }).expect(409);
    await luis.post(`/api/absences/${reqId}/approve`).send({}).expect(403);

    const pending = await marta.get('/api/absences/pending').expect(200);
    expect(pending.body.map((p: any) => p.id)).toContain(reqId);
    await marta.post(`/api/absences/${reqId}/approve`).send({ comment: '¡Disfruta!' }).expect(201);
    await marta.post(`/api/absences/${reqId}/approve`).send({}).expect(409);

    const bal = await luis.get(`/api/absences/balance/${luisEmp}?year=${start.slice(0, 4)}`).expect(200);
    expect(bal.body).toMatchObject({ entitled: 22, approved: 1, pending: 0, available: 21 });
    const notes = await luis.get('/api/notifications').expect(200);
    expect(notes.body[0]).toMatchObject({ type: 'absence.approved' });
  });

  it('no deja pedir más vacaciones que el saldo', async () => {
    const from = `${year + 1}-02-01`;
    const to = `${year + 1}-04-30`;
    const r = await luis.post('/api/absences').send({ absenceTypeId: vacId, startDate: from, endDate: to }).expect(400);
    expect(r.body.message).toMatch(/saldo/);
  });

  it('oculta el motivo de una baja médica al responsable', async () => {
    const types = (await luis.get('/api/org/absence-types')).body;
    const it = types.find((t: any) => t.code === 'IT');
    const d = nextWeekday(40);
    const r = await luis.post('/api/absences').send({ absenceTypeId: it.id, startDate: d, endDate: d }).expect(201);
    expect(r.body.status).toBe('approved'); // la IT se comunica, no se aprueba
    const team = await marta.get(`/api/absences/team?from=${d}&to=${d}`).expect(200);
    expect(team.body[0]).toMatchObject({ type_name: 'Ausencia', type_code: null });
    const asHr = await adminAgent.get(`/api/absences/team?from=${d}&to=${d}`).expect(200);
    expect(asHr.body[0].type_code).toBe('IT');
  });

  it('la ausencia aprobada descuenta la jornada teórica', async () => {
    const range = await luis.get(`/api/time/employments/${luisEmp}?from=${start}&to=${start}`).expect(200);
    expect(range.body.days[0]).toMatchObject({ expectedMinutes: 0, absence: expect.objectContaining({ code: 'VAC' }) });
  });
});

describe('nóminas', () => {
  let batchId: string;
  let pdf: Buffer;

  beforeAll(async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const text of ['NOMINA  Trabajador: EMPLEADO, LUIS  NIF: 00000000T', 'NOMINA  Trabajadora: JEFA, MARTA  NIF 12.345.678-Z', 'Resumen de la empresa (sin DNI)']) {
      doc.addPage([595, 842]).drawText(text, { x: 50, y: 780, size: 12, font });
    }
    pdf = Buffer.from(await doc.save());
  });

  it('sugiere a quién va cada página y exige revisión', async () => {
    const r = await adminAgent
      .post('/api/payslips/batches')
      .field('companyId', companyId)
      .field('period', '2026-10')
      .attach('file', pdf, { filename: 'nominas.pdf', contentType: 'application/pdf' })
      .expect(201);
    expect(r.body).toMatchObject({ pages: 3, matched: 2 });
    batchId = r.body.id;
    await luis.get(`/api/payslips/batches/${batchId}`).expect(403);
    const b = await adminAgent.get(`/api/payslips/batches/${batchId}`).expect(200);
    expect(b.body.pages.map((p: any) => p.suggested_name)).toEqual(['Luis Empleado', 'Marta Jefa', null]);
    expect(b.body.pages.every((p: any) => p.review_status === 'pending')).toBe(true);
    const page = await adminAgent.get(`/api/payslips/batches/${batchId}/pages/1/pdf`).expect(200);
    expect(page.headers['content-type']).toBe('application/pdf');

    await adminAgent.post(`/api/payslips/batches/${batchId}/publish`).expect(400);
    const c = await adminAgent.post(`/api/payslips/batches/${batchId}/confirm-suggestions`).expect(201);
    expect(c.body.confirmed).toBe(2);
    await adminAgent.post(`/api/payslips/batches/${batchId}/publish`).expect(400);
    await adminAgent.post(`/api/payslips/batches/${batchId}/pages/${b.body.pages[2].id}`).send({ status: 'skipped' }).expect(201);
    const p = await adminAgent.post(`/api/payslips/batches/${batchId}/publish`).expect(201);
    expect(p.body.people).toBe(2);
  });

  it('cada persona descarga solo su nómina, con acuse de lectura', async () => {
    const mine = await luis.get('/api/documents/mine').expect(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0]).toMatchObject({ category: 'payslip', period: '2026-10', first_read_at: null });
    const file = await luis.get(`/api/documents/${mine.body[0].id}/download`).buffer(true).expect(200);
    const parsed = await PDFDocument.load(file.body);
    expect(parsed.getPageCount()).toBe(1);
    expect((await luis.get('/api/documents/mine')).body[0].first_read_at).not.toBeNull();
    await marta.get(`/api/documents/${mine.body[0].id}/download`).expect(403);
  });
});

describe('exportaciones', () => {
  it('exporta el registro de jornada de la sociedad', async () => {
    const r = await adminAgent.get(`/api/exports/time-register?companyId=${companyId}&from=${yesterday}&to=${today}`).buffer(true).expect(200);
    const text = r.text.replace(/^﻿/, '');
    expect(text.split('\r\n')[0]).toContain('Primera entrada');
    expect(text).toContain('00000000T');
    expect(r.headers['x-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('la persona puede exportar su propio registro, pero no el de la sociedad', async () => {
    await luis.get(`/api/exports/time-register?employmentId=${luisEmp}&from=${yesterday}&to=${today}`).expect(200);
    await luis.get(`/api/exports/time-register?companyId=${companyId}&from=${yesterday}&to=${today}`).expect(403);
    await luis.get(`/api/exports/time-register?employmentId=${martaEmp}&from=${yesterday}&to=${today}`).expect(403);
  });

  it('exporta las variables de nómina', async () => {
    const period = today.slice(0, 7);
    const r = await adminAgent.get(`/api/exports/payroll-variables?companyId=${companyId}&period=${period}`).buffer(true).expect(200);
    const lines = r.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toContain('Horas trabajadas');
    expect(lines[0]).toContain('VAC (días)');
    expect(lines).toHaveLength(3);
  });
});

describe('importación', () => {
  const header = 'nombre;apellidos;dni;email;cif_sociedad;centro;departamento;fecha_alta;horas_semanales;dni_responsable';

  it('valida sin escribir y rechaza ficheros con errores', async () => {
    const csv = `${header}\nPedro;Ruiz;11111111H;pedro@demo.test;B12345678;Almacén;Logística;15/03/2024;40;12345678Z\nMal;Dato;123;no-email;B00000000;;;32/01/2024;;\n`;
    const dry = await adminAgent.post('/api/imports/employees?dryRun=true').attach('file', Buffer.from(csv), 'p.csv').expect(201);
    expect(dry.body).toMatchObject({ dryRun: true, total: 2, errors: 1 });
    expect(dry.body.report[1].errors.length).toBeGreaterThanOrEqual(3);
    const commit = await adminAgent.post('/api/imports/employees?dryRun=false').attach('file', Buffer.from(csv), 'p.csv').expect(201);
    expect(commit.body.dryRun).toBe(true); // con errores no se escribe nada
  });

  it('importa personas, crea centros y asigna responsables', async () => {
    const csv = `${header}\nPedro;Ruiz;11111111H;pedro@demo.test;B12345678;Almacén;Logística;15/03/2024;40;12345678Z\nSara;López;22222222J;;B12345678;Almacén;Logística;2024-04-01;20;11111111H\n`;
    const r = await adminAgent.post('/api/imports/employees?dryRun=false').attach('file', Buffer.from(csv), 'p.csv').expect(201);
    expect(r.body).toMatchObject({ dryRun: false, created: 2 });
    const list = (await adminAgent.get('/api/org/employees?q=sara')).body;
    expect(list[0]).toMatchObject({ manager_name: 'Pedro Ruiz', work_center_name: 'Almacén', department_name: 'Logística' });
    const sara = await adminAgent.get(`/api/org/employees/${list[0].id}`).expect(200);
    expect(sara.body.weekly_minutes).toBe(1200);
  });
});
