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
    expect((await request(server).get('/api/setup/status')).body).toMatchObject({ done: false });
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
    expect((await request(server).get('/api/setup/status')).body).toMatchObject({ done: true });
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

describe('sesiones', () => {
  it('cambiar la contraseña revoca las demás sesiones y renueva la actual', async () => {
    const other = request.agent(server);
    await other.post('/api/auth/login').send({ email: 'luis@demo.test', password: 'una-contraseña-larga' }).expect(200);
    await other.get('/api/auth/me').expect(200);
    await luis.post('/api/auth/password').send({ current: 'una-contraseña-larga', next: 'otra-contraseña-larga' }).expect(200);
    await other.get('/api/auth/me').expect(401);
    await luis.get('/api/auth/me').expect(200);
  });

  it('una cuenta desactivada pierde la sesión al instante', async () => {
    const { rows } = await owner.query(`SELECT id FROM app_user WHERE email = 'marta@demo.test'`);
    await owner.query('UPDATE app_user SET is_active = false WHERE id = $1', [rows[0].id]);
    await marta.get('/api/auth/me').expect(401);
    await owner.query('UPDATE app_user SET is_active = true WHERE id = $1', [rows[0].id]);
    marta = await loginWithToken('marta@demo.test');
  });

  it('el registro de auditoría es solo para administración', async () => {
    await marta.get('/api/org/audit').expect(403);
    await adminAgent.get('/api/org/audit').expect(200);
  });

  it('no se revela si un email existe en otra organización', async () => {
    const r = await adminAgent.post('/api/org/employees').send({ firstName: 'D', lastName: 'Up', email: 'marta@demo.test', companyId, startDate: '2025-01-01' });
    expect(JSON.stringify(r.body)).not.toContain('Key (');
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
    // Quien configura la instalación también queda dada de alta y puede fichar.
    await adminAgent.post('/api/time/clock').send({ idempotencyKey: 'clave-admin' }).expect(201);
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
    expect(lines).toHaveLength(4);
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

  it('importa también desde Excel (.xlsx), con fechas como celdas de fecha', async () => {
    const { default: writeXlsxFile } = await import('write-excel-file/node');
    const cell = (value: unknown) => ({ value }) as any;
    const sheet = [
      ['Nombre', 'Apellidos', 'DNI', 'CIF sociedad', 'Fecha alta', 'Horas semanales'].map(cell),
      ['Elena', 'Mora', '33333333P', 'B12345678', new Date(Date.UTC(2024, 4, 2)), 30].map((v) => ({ value: v, ...(v instanceof Date ? { format: 'dd/mm/yyyy' } : {}) }) as any),
    ];
    const xlsx = await writeXlsxFile(sheet as any).toBuffer();
    const r = await adminAgent.post('/api/imports/employees?dryRun=false').attach('file', xlsx, 'personas.xlsx').expect(201);
    expect(r.body).toMatchObject({ dryRun: false, created: 1 });
    const elena = (await adminAgent.get('/api/org/employees?q=elena')).body[0];
    expect(elena).toMatchObject({ start_date: '2024-05-02', national_id: '33333333P' });
  });
});

describe('turnos y bolsa de horas', () => {
  const monday = (() => {
    const d = new Date(Date.now() + 14 * 86400000);
    while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  })();
  const tuesday = new Date(Date.parse(monday) + 86400000).toISOString().slice(0, 10);
  const sunday = new Date(Date.parse(monday) + 6 * 86400000).toISOString().slice(0, 10);
  let closing: string;
  let opening: string;

  it('RR. HH. crea plantillas de turno', async () => {
    closing = (await adminAgent.post('/api/shifts/templates').send({ companyId, name: 'Cierre', start: '14:00', end: '23:00', breakMinutes: 30 }).expect(201)).body.id;
    opening = (await adminAgent.post('/api/shifts/templates').send({ companyId, name: 'Apertura', start: '07:00', end: '15:00', breakMinutes: 30 }).expect(201)).body.id;
    await luis.post('/api/shifts/templates').send({ companyId, name: 'X', start: '07:00', end: '15:00' }).expect(403);
  });

  it('el responsable planifica y ve los incumplimientos de descanso', async () => {
    await marta
      .put('/api/shifts')
      .send({
        items: [
          { employmentId: luisEmp, date: monday, templateId: closing },
          { employmentId: luisEmp, date: tuesday, templateId: opening },
        ],
      })
      .expect(200);
    await luis.put('/api/shifts').send({ items: [{ employmentId: luisEmp, date: monday, templateId: opening }] }).expect(403);
    const plan = await marta.get(`/api/shifts?from=${monday}&to=${sunday}`).expect(200);
    expect(plan.body.shifts).toHaveLength(2);
    expect(plan.body.violations).toContainEqual(expect.objectContaining({ rule: 'rest_between_shifts', date: tuesday, employmentId: luisEmp }));
  });

  it('solo se ven y cuentan los turnos publicados', async () => {
    expect((await luis.get(`/api/shifts/mine?from=${monday}&to=${sunday}`).expect(200)).body).toEqual([]);
    const before = await luis.get(`/api/time/employments/${luisEmp}?from=${monday}&to=${monday}`).expect(200);
    expect(before.body.days[0].expectedMinutes).toBe(480);
    const p = await marta.post('/api/shifts/publish').send({ from: monday, to: sunday }).expect(201);
    expect(p.body).toMatchObject({ published: 2, people: 1 });
    expect((await luis.get(`/api/shifts/mine?from=${monday}&to=${sunday}`).expect(200)).body).toHaveLength(2);
    const after = await luis.get(`/api/time/employments/${luisEmp}?from=${monday}&to=${monday}`).expect(200);
    expect(after.body.days[0].expectedMinutes).toBe(510); // 9 h menos 30 min de pausa
    expect((await luis.get('/api/notifications')).body[0]).toMatchObject({ type: 'shifts.published' });
  });

  it('la bolsa de horas suma los ajustes y solo RR. HH. los registra', async () => {
    await adminAgent.patch(`/api/org/employees/${luisEmp}`).send({ hourBankEnabled: true, hourBankStart: '2025-01-01' }).expect(200);
    const b0 = await luis.get(`/api/time/employments/${luisEmp}/hour-bank`).expect(200);
    expect(b0.body.enabled).toBe(true);
    expect(typeof b0.body.balance).toBe('number');
    await luis.post('/api/time/hour-bank/adjustments').send({ employmentId: luisEmp, date: today, minutes: 60, kind: 'adjustment', reason: 'Me sumo horas' }).expect(403);
    await adminAgent.post('/api/time/hour-bank/adjustments').send({ employmentId: luisEmp, date: today, minutes: 600, kind: 'opening', reason: 'Saldo inicial' }).expect(201);
    const b1 = await luis.get(`/api/time/employments/${luisEmp}/hour-bank`).expect(200);
    expect(b1.body.balance - b0.body.balance).toBe(600);
    expect(b1.body.adjustments[0]).toMatchObject({ minutes: 600, kind: 'opening' });
  });
});

describe('aprobaciones multinivel y delegación', () => {
  let apId: string;
  const day = (offset: number) => nextWeekday(offset);

  it('un circuito de dos pasos pasa del responsable a RR. HH.', async () => {
    apId = (await luis.get('/api/org/absence-types')).body.find((t: any) => t.code === 'AP').id;
    await marta.put('/api/approvals/flows').send({ steps: [{ kind: 'manager' }, { kind: 'hr' }] }).expect(403);
    await adminAgent.put('/api/approvals/flows').send({ absenceTypeId: apId, steps: [{ kind: 'manager' }, { kind: 'hr' }] }).expect(200);
    const d = day(60);
    const r = await luis.post('/api/absences').send({ absenceTypeId: apId, startDate: d, endDate: d }).expect(201);
    expect(r.body.status).toBe('pending');
    // RR. HH. aún no tiene el paso, pero puede intervenir; el responsable sí lo tiene.
    const step1 = await marta.post(`/api/absences/${r.body.id}/approve`).send({ comment: 'Por mi parte, sí' }).expect(201);
    expect(step1.body.status).toBe('pending');
    const mine = (await luis.get('/api/absences/mine')).body.find((x: any) => x.id === r.body.id);
    expect(mine.steps.map((s: any) => [s.kind, s.status])).toEqual([
      ['manager', 'approved'],
      ['hr', 'pending'],
    ]);
    await marta.post(`/api/absences/${r.body.id}/approve`).send({}).expect(403);
    const step2 = await adminAgent.post(`/api/absences/${r.body.id}/approve`).send({}).expect(201);
    expect(step2.body.status).toBe('approved');
  });

  it('una persona delegada aprueba en nombre del responsable', async () => {
    const pedro = await loginWithToken('pedro@demo.test');
    const { rows } = await owner.query(`SELECT id FROM app_user WHERE email = 'pedro@demo.test'`);
    await marta.post('/api/approvals/delegations').send({ toUserId: rows[0].id, startDate: today, endDate: today, reason: 'Vacaciones' }).expect(201);
    const vac = (await luis.get('/api/org/absence-types')).body.find((t: any) => t.code === 'VAC').id;
    const d = day(70);
    const r = await luis.post('/api/absences').send({ absenceTypeId: vac, startDate: d, endDate: d }).expect(201);
    const pending = await pedro.get('/api/absences/pending').expect(200);
    expect(pending.body.map((p: any) => p.id)).toContain(r.body.id);
    const ok = await pedro.post(`/api/absences/${r.body.id}/approve`).send({}).expect(201);
    expect(ok.body.status).toBe('approved');
    const steps = (await luis.get('/api/absences/mine')).body.find((x: any) => x.id === r.body.id).steps;
    expect(steps[0]).toMatchObject({ status: 'approved', decided_as: 'delegate', decided_by_name: 'Pedro Ruiz' });
  });

  it('si el paso no tiene a nadie (sin responsable) pasa a RR. HH.', async () => {
    // Marta no tiene responsable: su solicitud va directamente a RR. HH.
    const d = day(80);
    const r = await marta.post('/api/absences').send({ absenceTypeId: apId, startDate: d, endDate: d }).expect(201);
    const steps = (await marta.get('/api/absences/mine')).body.find((x: any) => x.id === r.body.id).steps;
    expect(steps.map((s: any) => [s.kind, s.status])).toEqual([
      ['manager', 'skipped'],
      ['hr', 'pending'],
    ]);
  });
});

describe('altas, bajas, traspasos y campos personalizados', () => {
  let nuriaEmp: string;

  it('al dar de alta se crea el checklist de la plantilla y cada uno ve sus tareas', async () => {
    await adminAgent
      .post('/api/checklists/templates')
      .send({
        kind: 'onboarding',
        name: 'Bienvenida',
        items: [
          { title: 'Preparar contrato', assignee: 'hr', dueOffsetDays: -3 },
          { title: 'Presentar al equipo', assignee: 'manager', dueOffsetDays: 0 },
          { title: 'Leer el manual de acogida', assignee: 'employee', dueOffsetDays: 7 },
        ],
      })
      .expect(201);
    await marta.post('/api/checklists/templates').send({ kind: 'onboarding', name: 'X', items: [{ title: 'Y', assignee: 'hr' }] }).expect(403);
    const n = await adminAgent
      .post('/api/org/employees')
      .send({ firstName: 'Nuria', lastName: 'Nueva', nationalId: '44444444A', companyId, managerEmploymentId: martaEmp, startDate: '2026-12-01', createAccount: false })
      .expect(201);
    nuriaEmp = n.body.employmentId;
    const lists = (await adminAgent.get(`/api/org/employees/${nuriaEmp}/checklists`).expect(200)).body;
    expect(lists).toHaveLength(1);
    expect(lists[0].tasks.map((t: any) => [t.assignee, t.due_date])).toEqual([
      ['hr', '2026-11-28'],
      ['manager', '2026-12-01'],
      ['employee', '2026-12-08'],
    ]);
    const martaTasks = (await marta.get('/api/checklists/tasks').expect(200)).body;
    expect(martaTasks.map((t: any) => t.title)).toEqual(['Presentar al equipo']);
    const hrTask = lists[0].tasks[0];
    await marta.post(`/api/checklists/tasks/${hrTask.id}`).send({ done: true }).expect(403);
    await adminAgent.post(`/api/checklists/tasks/${hrTask.id}`).send({ done: true, note: 'Firmado' }).expect(201);
    await marta.post(`/api/checklists/tasks/${martaTasks[0].id}`).send({ done: true }).expect(201);
  });

  it('el traspaso cierra la relación laboral y abre otra en la sociedad de destino', async () => {
    const other = await adminAgent.post('/api/org/companies').send({ name: 'Demo Dos', legalName: 'Demo Dos SL', taxId: 'B76543210' }).expect(201);
    await adminAgent
      .post('/api/checklists/templates')
      .send({ kind: 'transfer', name: 'Traspaso', items: [{ title: 'Alta en la Seguridad Social de la nueva sociedad', assignee: 'hr' }] })
      .expect(201);
    await adminAgent.post(`/api/org/employees/${nuriaEmp}/transfer`).send({ companyId, effectiveDate: '2027-01-01' }).expect(400);
    const t = await adminAgent.post(`/api/org/employees/${nuriaEmp}/transfer`).send({ companyId: other.body.id, effectiveDate: '2027-01-01', jobTitle: 'Analista' }).expect(201);
    const old = (await adminAgent.get(`/api/org/employees/${nuriaEmp}`)).body;
    expect(old.end_date).toBe('2026-12-31');
    const fresh = (await adminAgent.get(`/api/org/employees/${t.body.employmentId}`)).body;
    expect(fresh).toMatchObject({ company_name: 'Demo Dos', start_date: '2027-01-01', job_title: 'Analista', transferred_from_employment_id: nuriaEmp });
    const lists = (await adminAgent.get(`/api/org/employees/${t.body.employmentId}/checklists`)).body;
    expect(lists[0]).toMatchObject({ kind: 'transfer', name: 'Traspaso' });
  });

  it('los campos personalizados respetan tipo y visibilidad', async () => {
    await adminAgent
      .post('/api/org/custom-fields')
      .send({ entity: 'person', key: 'talla_camiseta', label: 'Talla de camiseta', type: 'select', options: ['S', 'M', 'L'], visibility: 'employee' })
      .expect(201);
    await adminAgent.post('/api/org/custom-fields').send({ entity: 'employment', key: 'coste_hora', label: 'Coste por hora', type: 'number' }).expect(201);
    await marta.post('/api/org/custom-fields').send({ entity: 'person', key: 'x_y', label: 'X', type: 'text' }).expect(403);
    await adminAgent.put(`/api/org/employees/${luisEmp}/custom-values`).send({ person: { talla_camiseta: 'XXL' } }).expect(400);
    await adminAgent.put(`/api/org/employees/${luisEmp}/custom-values`).send({ person: { talla_camiseta: 'M' }, employment: { coste_hora: '18,5' } }).expect(200);
    const asHr = (await adminAgent.get(`/api/org/employees/${luisEmp}`)).body.custom_fields;
    expect(asHr.map((f: any) => [f.key, f.value])).toEqual([
      ['coste_hora', 18.5],
      ['talla_camiseta', 'M'],
    ]);
    const asSelf = (await luis.get(`/api/org/employees/${luisEmp}`)).body.custom_fields;
    expect(asSelf.map((f: any) => f.key)).toEqual(['talla_camiseta']);
    const asManager = (await marta.get(`/api/org/employees/${luisEmp}`)).body.custom_fields;
    expect(asManager.map((f: any) => f.key)).toEqual(['talla_camiseta']);
  });
});

describe('anuncios, políticas y firma', () => {
  const pdf = async (pages = 1) => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pages; i++) doc.addPage([595, 842]).drawText(`Página ${i + 1}`.replace('á', 'a'), { x: 50, y: 780, size: 12, font });
    return Buffer.from(await doc.save());
  };

  it('publica anuncios para el grupo y registra quién los lee', async () => {
    await marta.post('/api/announcements').send({ title: 'X', body: 'Y' }).expect(403);
    const a = await adminAgent.post('/api/announcements').send({ title: 'Cena de Navidad', body: 'El 19 de diciembre a las 21:00.', pinned: true }).expect(201);
    const list = (await luis.get('/api/announcements').expect(200)).body;
    expect(list[0]).toMatchObject({ id: a.body.id, title: 'Cena de Navidad', read: false, pinned: true });
    await luis.post(`/api/announcements/${a.body.id}/read`).expect(201);
    expect((await luis.get('/api/announcements')).body[0].read).toBe(true);
    expect((await adminAgent.get('/api/announcements')).body[0].reads).toBe(1);
  });

  it('las políticas se aceptan por versión', async () => {
    const p1 = await adminAgent
      .post('/api/policies')
      .field('title', 'Desconexión digital')
      .field('requiresAcceptance', 'true')
      .attach('file', await pdf(), { filename: 'desconexion.pdf', contentType: 'application/pdf' })
      .expect(201);
    const mine = (await luis.get('/api/policies').expect(200)).body;
    expect(mine[0]).toMatchObject({ id: p1.body.id, version: 1, accepted_at: null });
    await luis.get(`/api/policies/${p1.body.id}/file`).expect(200);
    await luis.post(`/api/policies/${p1.body.id}/accept`).expect(201);
    const acc = (await adminAgent.get(`/api/policies/${p1.body.id}/acceptances`).expect(200)).body;
    expect(acc.find((r: any) => r.name === 'Luis Empleado').accepted_at).not.toBeNull();
    expect(acc.find((r: any) => r.name === 'Marta Jefa').accepted_at).toBeNull();
    const series = mine[0].series_id;
    const p2 = await adminAgent
      .post('/api/policies')
      .field('seriesId', series)
      .field('title', 'Desconexión digital')
      .attach('file', await pdf(2), { filename: 'desconexion-v2.pdf', contentType: 'application/pdf' })
      .expect(201);
    expect(p2.body.version).toBe(2);
    const after = (await luis.get('/api/policies')).body;
    expect(after.map((p: any) => [p.version, p.accepted_at])).toEqual([[2, null]]);
  });

  it('firma individual con código por email y hoja de evidencias', async () => {
    await marta.post('/api/signatures').field('personId', 'x').field('companyId', companyId).field('title', 'X').attach('file', await pdf(), 'x.pdf').expect(400);
    const { rows } = await owner.query(`SELECT person_id FROM app_user WHERE email = 'luis@demo.test'`);
    const req = await adminAgent
      .post('/api/signatures')
      .field('personId', rows[0].person_id)
      .field('companyId', companyId)
      .field('title', 'Anexo de teletrabajo')
      .attach('file', await pdf(2), { filename: 'anexo.pdf', contentType: 'application/pdf' })
      .expect(201);
    const id = req.body.id;
    await marta.post(`/api/signatures/${id}/code`).expect(403);
    await luis.post(`/api/signatures/${id}/sign`).send({ code: '000000', consent: true }).expect(400); // sin código pedido
    const sent = await luis.post(`/api/signatures/${id}/code`).expect(201);
    expect(sent.body.sentTo).toMatch(/^l\*\*\*@demo\.test$/);
    const mail = await owner.query(`SELECT payload FROM outbox WHERE payload->>'subject' LIKE 'Código para firmar%' ORDER BY id DESC LIMIT 1`);
    const code = /código de firma es: (\d{6})/.exec(mail.rows[0].payload.text)![1];
    const wrong = code === '123456' ? '654321' : '123456';
    await luis.post(`/api/signatures/${id}/sign`).send({ code: wrong, consent: true }).expect(400);
    const attempts = await owner.query('SELECT otp_attempts FROM signature_request WHERE id = $1', [id]);
    expect(attempts.rows[0].otp_attempts).toBe(1);
    await luis.post(`/api/signatures/${id}/sign`).send({ code, consent: false }).expect(400);
    const signed = await luis.post(`/api/signatures/${id}/sign`).send({ code, consent: true }).expect(201);
    expect(signed.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    await luis.post(`/api/signatures/${id}/sign`).send({ code, consent: true }).expect(409);
    const file = await luis.get(`/api/signatures/${id}/file?signed=true`).buffer(true).expect(200);
    expect((await PDFDocument.load(file.body)).getPageCount()).toBe(3);
    const ev = (await adminAgent.get(`/api/signatures/${id}/evidence`).expect(200)).body;
    expect(ev.evidence).toMatchObject({ method: 'session+email_otp', signer: { name: 'Luis Empleado', nationalId: '00000000T' } });
    const docs = (await luis.get('/api/documents/mine')).body;
    expect(docs.some((d: any) => d.category === 'signed' && d.title === 'Anexo de teletrabajo (firmado)')).toBe(true);
    await marta.get(`/api/signatures/${id}/file`).expect(403);
  });
});

describe('registro retributivo', () => {
  it('calcula medias, medianas y brecha por grupo equiparando a jornada completa', async () => {
    await adminAgent.patch(`/api/org/employees/${martaEmp}`).send({ sex: 'female', professionalGroup: 'Grupo 2' }).expect(200);
    await adminAgent.patch(`/api/org/employees/${luisEmp}`).send({ sex: 'male', professionalGroup: 'Grupo 2' }).expect(200);
    await luis.post('/api/pay/compensation').send({ employmentId: luisEmp, effectiveFrom: '2025-01-01', baseAnnual: 1 }).expect(403);
    await adminAgent.post('/api/pay/compensation').send({ employmentId: luisEmp, effectiveFrom: '2025-01-01', baseAnnual: 36000, complementsAnnual: 4000 }).expect(201);
    // Marta a media jornada: 15.000 € equivalen a 30.000 € a jornada completa.
    await adminAgent.patch(`/api/org/employees/${martaEmp}`).send({ weeklyMinutes: 1200 }).expect(200);
    await adminAgent.post('/api/pay/compensation').send({ employmentId: martaEmp, effectiveFrom: '2025-01-01', baseAnnual: 15000 }).expect(201);
    const r = (await adminAgent.get(`/api/pay/register?companyId=${companyId}&year=${year}`).expect(200)).body;
    const g = r.groups.find((x: any) => x.group === 'Grupo 2');
    expect(g.women.total).toMatchObject({ n: 1, mean: 30000 });
    expect(g.men.total).toMatchObject({ n: 1, mean: 40000 });
    expect(g.gapMeanPct).toBe(25);
    expect(g.flagged).toBe(true);
    expect(r.withoutCompensation).toBeGreaterThan(0);
    await luis.get(`/api/pay/register?companyId=${companyId}&year=${year}`).expect(403);
    await marta.get(`/api/pay/compensation/${luisEmp}`).expect(403);
    const csv = await adminAgent.get(`/api/pay/register.csv?companyId=${companyId}&year=${year}`).buffer(true).expect(200);
    expect(csv.text).toContain('Grupo 2;Total;1;30000,00;30000,00;1;40000,00;40000,00;25,00;25,00');
    expect((await marta.get(`/api/org/employees/${martaEmp}`)).body.sex).toBe('female');
    expect((await marta.get(`/api/org/employees/${luisEmp}`)).body.sex).toBeUndefined();
  });
});

describe('RGPD y canal de denuncias', () => {
  it('cada persona descarga sus datos y ejerce sus derechos', async () => {
    const data = JSON.parse((await luis.get('/api/privacy/my-data').buffer(true).expect(200)).text);
    expect(data.person).toMatchObject({ first_name: 'Luis', national_id: '00000000T' });
    expect(data.timeEntries.length).toBeGreaterThan(0);
    expect(data.absences.length).toBeGreaterThan(0);
    const r = await luis.post('/api/privacy/requests').send({ kind: 'rectification', details: 'Mi segundo apellido está mal escrito' }).expect(201);
    await marta.get('/api/privacy/requests').expect(403);
    const list = (await adminAgent.get('/api/privacy/requests').expect(200)).body;
    expect(list[0]).toMatchObject({ id: r.body.id, kind: 'rectification', status: 'received' });
    await adminAgent.post(`/api/privacy/requests/${r.body.id}`).send({ status: 'completed' }).expect(400);
    await adminAgent.post(`/api/privacy/requests/${r.body.id}`).send({ status: 'completed', response: 'Corregido.' }).expect(201);
    expect((await luis.get('/api/privacy/requests/mine')).body[0]).toMatchObject({ status: 'completed', response: 'Corregido.' });
  });

  it('aplica los plazos de conservación y anonimiza a quien dejó el grupo hace años', async () => {
    await adminAgent.put('/api/privacy/retention').send({ time_entries: 100 }).expect(400);
    await adminAgent.put('/api/privacy/retention').send({ notifications: 30 }).expect(200);
    const { rows } = await owner.query(`SELECT id FROM app_user WHERE email = 'luis@demo.test'`);
    await owner.query(`INSERT INTO notification (tenant_id, user_id, type, title, created_at) VALUES ($1, $2, 'x', 'Antigua', now() - interval '60 days')`, [tenantId, rows[0].id]);
    const old = await adminAgent
      .post('/api/org/employees')
      .send({ firstName: 'Olga', lastName: 'Antigua', nationalId: '55555555K', email: 'olga@demo.test', companyId, startDate: '2015-01-01' })
      .expect(201);
    await adminAgent.post(`/api/org/employees/${old.body.employmentId}/terminate`).send({ endDate: '2020-01-31' }).expect(201);
    const dry = (await adminAgent.post('/api/privacy/retention/run').send({ dryRun: true }).expect(201)).body;
    expect(dry.result.notifications).toBeGreaterThanOrEqual(1);
    expect(dry.result.formerEmployees).toBe(1);
    await luis.post('/api/privacy/retention/run').send({ dryRun: false }).expect(403);
    await adminAgent.post('/api/privacy/retention/run').send({ dryRun: false }).expect(201);
    const olga = (await adminAgent.get(`/api/org/employees/${old.body.employmentId}`)).body;
    expect(olga).toMatchObject({ first_name: 'Persona', last_name: 'anonimizada', national_id: null, email: null });
    const n = await owner.query(`SELECT count(*)::int AS n FROM notification WHERE title = 'Antigua'`);
    expect(n.rows[0].n).toBe(0);
    // El registro de jornada no se puede purgar antes de 4 años, ni siquiera desde la base de datos.
    const app = new Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      await expect(app.query(`SELECT retention_purge_time_entries($1, now() - interval '1 year')`, [tenantId])).rejects.toThrow(/4 años/);
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
  });

  it('el canal de denuncias es anónimo, cifrado y solo lo ve la persona responsable', async () => {
    await luis.post('/api/whistleblowing/enable').send({}).expect(403);
    const { token } = (await adminAgent.post('/api/whistleblowing/enable').send({}).expect(201)).body;
    const info = (await request(server).get(`/api/public/whistleblowing/${token}`).expect(200)).body;
    expect(info.organization).toBe('Grupo Demo');
    await request(server).get('/api/public/whistleblowing/no-existe').expect(404);
    const sent = await request(server)
      .post(`/api/public/whistleblowing/${token}/reports`)
      .send({ category: 'Acoso laboral o sexual', subject: 'Comentarios ofensivos', description: 'Desde hace semanas se repiten comentarios ofensivos en reuniones.', anonymous: true })
      .expect(201);
    const code = sent.body.code as string;
    expect(code).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
    const stored = await owner.query('SELECT subject_enc, description_enc FROM wb_report');
    expect(stored.rows[0].subject_enc).not.toContain('ofensivos');

    await adminAgent.get('/api/whistleblowing/reports').expect(403); // administración no lo ve por serlo
    const { rows } = await owner.query(`SELECT id FROM app_user WHERE email = 'ana@demo.test'`);
    await adminAgent.put(`/api/org/users/${rows[0].id}/roles`).send({ admin: true, hrAll: false, compliance: true }).expect(200);
    const list = (await adminAgent.get('/api/whistleblowing/reports').expect(200)).body;
    expect(list[0]).toMatchObject({ subject: 'Comentarios ofensivos', status: 'received', anonymous: true });
    await adminAgent.post(`/api/whistleblowing/reports/${list[0].id}/messages`).send({ body: 'Recibido. ¿Puedes indicar en qué reuniones?' }).expect(201);
    const status = (await request(server).post(`/api/public/whistleblowing/${token}/status`).send({ code: code.toLowerCase() }).expect(201)).body;
    expect(status).toMatchObject({ status: 'acknowledged', messages: [{ author: 'handler' }] });
    expect(status.id).toBeUndefined();
    await request(server).post(`/api/public/whistleblowing/${token}/messages`).send({ code, body: 'En las de los lunes.' }).expect(201);
    await adminAgent.post(`/api/whistleblowing/reports/${list[0].id}/status`).send({ status: 'resolved' }).expect(400);
    await adminAgent.post(`/api/whistleblowing/reports/${list[0].id}/status`).send({ status: 'resolved', resolution: 'Se han tomado medidas.' }).expect(201);
    await request(server).post(`/api/public/whistleblowing/${token}/messages`).send({ code, body: 'Gracias' }).expect(400);
    await request(server).post(`/api/public/whistleblowing/${token}/status`).send({ code: 'AAAAA-BBBBB-CCCCC-DDDDD' }).expect(404);
  });
});

describe('migración desde Factorial', () => {
  const LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
  const dni = (n: number) => `${n}${LETTERS[n % 23]}`;
  let mock: import('node:http').Server;
  const calls: string[] = [];

  beforeAll(async () => {
    const http = await import('node:http');
    const fixtures: Record<string, any[][]> = {
      'companies/legal_entities': [[{ id: 1, legal_name: 'Factorial Import SL', tin: 'B11223344', country: 'es' }]],
      'locations/locations': [[{ id: 10, name: 'Oficina Bilbao', timezone: 'Europe/Madrid' }]],
      'teams/teams': [[{ id: 5, name: 'Ventas', employee_ids: [100, 101] }]],
      // Dos páginas para probar la paginación por cursor.
      'employees/employees': [
        [{ id: 100, first_name: 'Iker', last_name: 'Importado', identifier: dni(66666666), gender: 'male', email: 'iker@factorial.test', legal_entity_id: 1, location_id: 10, manager_id: 101 }],
        [{ id: 101, first_name: 'Irene', last_name: 'Importada', identifier: 'X0000000', gender: 'female', legal_entity_id: 1, location_id: 10 }],
      ],
      'contracts/contract_versions': [
        [
          { employee_id: 100, effective_on: '2024-01-01', starts_on: '2024-01-01', job_title: 'Comercial', working_hours: 30, working_hours_frequency: 'week', salary_amount: 2800000, salary_frequency: 'yearly' },
          { employee_id: 101, effective_on: '2023-05-01', starts_on: '2023-05-01', job_title: 'Directora comercial', working_hours: 40, working_hours_frequency: 'week' },
        ],
      ],
      'timeoff/leave_types': [[{ id: 7, name: 'Vacaciones', identifier: 'holiday' }]],
      'timeoff/leaves': [
        [
          { id: 70, employee_id: 100, start_on: '2025-08-04', finish_on: '2025-08-08', leave_type_id: 7, approved: true, days_taken: 5 },
          { id: 71, employee_id: 100, start_on: '2025-09-15', finish_on: '2025-09-15', leave_type_id: 7, approved: null, days_taken: 1 },
        ],
      ],
      'attendance/shifts': [
        [
          { id: 900, employee_id: 100, date: '2025-09-01', clock_in: '09:00', clock_out: '14:00', workable: true },
          { id: 901, employee_id: 100, date: '2025-09-01', clock_in: '15:00', clock_out: '18:00', workable: true },
          { id: 902, employee_id: 100, date: '2025-09-02', clock_in: '09:00', clock_out: null, workable: true },
        ],
      ],
    };
    mock = http.createServer((req, res) => {
      const url = new URL(req.url!, 'http://x');
      calls.push(url.pathname);
      if (req.headers['x-api-key'] !== 'clave-de-prueba-123') {
        res.writeHead(401).end();
        return;
      }
      const resource = url.pathname.replace('/api/2026-10-01/resources/', '');
      const pages = fixtures[resource] ?? [[]];
      const page = url.searchParams.get('after_id') ? Number(url.searchParams.get('after_id')) : 0;
      const hasNext = page + 1 < pages.length;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: pages[page], meta: { has_next_page: hasNext, end_cursor: hasNext ? String(page + 1) : null, limit: 100 } }));
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
    process.env.FACTORIAL_BASE_URL = `http://127.0.0.1:${(mock.address() as any).port}`;
  });

  afterAll(() => {
    mock?.close();
    delete process.env.FACTORIAL_BASE_URL;
  });

  const waitJob = async (jobId: string) => {
    for (let i = 0; i < 150; i++) {
      const j = (await adminAgent.get(`/api/migration/jobs/${jobId}`).expect(200)).body;
      if (j.status !== 'running') return j;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('La migración no terminó');
  };

  it('solo administración puede migrar y una clave mala falla con un mensaje claro', async () => {
    await luis.post('/api/migration/factorial').send({ apiKey: 'clave-de-prueba-123' }).expect(403);
    const bad = await adminAgent.post('/api/migration/factorial').send({ apiKey: 'clave-incorrecta-1' }).expect(201);
    const job = await waitJob(bad.body.jobId);
    expect(job).toMatchObject({ status: 'failed' });
    expect(job.error).toMatch(/clave de API/);
  });

  it('la simulación cuenta sin escribir nada', async () => {
    const r = await adminAgent.post('/api/migration/factorial').send({ apiKey: 'clave-de-prueba-123', dryRun: true, shiftsFrom: '2025-01-01' }).expect(201);
    const job = await waitJob(r.body.jobId);
    expect(job).toMatchObject({ status: 'done', counts: { personas: 2, sociedades: 1, ausencias: 1, fichajes: 3 } });
    expect(job.log.join('\n')).toMatch(/no es un DNI\/NIE válido/);
    expect((await owner.query(`SELECT count(*)::int AS n FROM company WHERE tax_id = 'B11223344'`)).rows[0].n).toBe(0);
  });

  it('importa sociedad, centro, equipo, personas, responsable, contratos, ausencias y fichajes, y se puede repetir', async () => {
    const r = await adminAgent
      .post('/api/migration/factorial')
      .send({ apiKey: 'clave-de-prueba-123', dryRun: false, shiftsFrom: '2025-01-01', includeSalaries: true })
      .expect(201);
    const job = await waitJob(r.body.jobId);
    expect(job.error).toBeNull();
    expect(job.status).toBe('done');
    expect(job.counts).toMatchObject({ 'sociedades creadas': 1, 'centros creados': 1, 'personas creadas': 2, ausencias: 1, fichajes: 2, retribuciones: 1 });
    const iker = (await adminAgent.get('/api/org/employees?q=iker')).body[0];
    expect(iker).toMatchObject({
      company_name: 'Factorial Import SL',
      work_center_name: 'Oficina Bilbao',
      department_name: 'Ventas',
      manager_name: 'Irene Importada',
      job_title: 'Comercial',
      national_id: dni(66666666),
    });
    const detail = (await adminAgent.get(`/api/org/employees/${iker.id}`)).body;
    expect(detail).toMatchObject({ weekly_minutes: 1800, start_date: '2024-01-01', sex: 'male' });
    const day = (await adminAgent.get(`/api/time/employments/${iker.id}?from=2025-09-01&to=2025-09-01`)).body;
    expect(day.days[0].workedMinutes).toBe(8 * 60);
    expect(day.entries.every((e: any) => e.source === 'import')).toBe(true);
    expect((await adminAgent.get(`/api/time/employments/${iker.id}/verify`)).body.ok).toBe(true);

    // Repetir no duplica.
    const again = await waitJob(
      (await adminAgent.post('/api/migration/factorial').send({ apiKey: 'clave-de-prueba-123', dryRun: false, shiftsFrom: '2025-01-01' }).expect(201)).body.jobId,
    );
    expect(again.counts).toMatchObject({ 'personas actualizadas': 2, 'fichajes ya importados': 2 });
    expect((await owner.query(`SELECT count(*)::int AS n FROM person WHERE last_name LIKE 'Importad%'`)).rows[0].n).toBe(2);
    expect(calls.some((c) => c.endsWith('/employees/employees'))).toBe(true);
  });
});

describe('inicio de sesión con OpenID Connect (Microsoft 365)', () => {
  let idp: import('node:http').Server;
  let issuer: string;
  let nextNonce = '';
  let nextEmail = 'luis@demo.test';

  beforeAll(async () => {
    const http = await import('node:http');
    const jose = await import('jose');
    const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
    const jwk = { ...(await jose.exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    idp = http.createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://x');
      const json = (o: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (url.pathname === '/.well-known/openid-configuration') {
        return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
      }
      if (url.pathname === '/jwks') return json({ keys: [jwk] });
      if (url.pathname === '/token') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const p = new URLSearchParams(body);
        if (p.get('client_secret') !== 'secreto-cliente' || p.get('code') !== 'codigo-ok' || !p.get('code_verifier')) {
          res.writeHead(400).end();
          return;
        }
        const idToken = await new jose.SignJWT({ email: nextEmail, nonce: nextNonce, email_verified: true })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuer(issuer)
          .setAudience('cliente-openhr')
          .setSubject('sub-1')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
        return json({ id_token: idToken, access_token: 'x', token_type: 'Bearer' });
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => idp.listen(0, '127.0.0.1', () => r()));
    issuer = `http://127.0.0.1:${(idp.address() as any).port}`;
  });

  afterAll(() => idp?.close());

  const startFlow = async (email: string) => {
    const agent = request.agent(server);
    const start = await agent.get(`/api/auth/oidc/start?email=${encodeURIComponent(email)}`).expect(302);
    const auth = new URL(start.headers.location);
    expect(auth.origin + auth.pathname).toBe(`${issuer}/authorize`);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    nextNonce = auth.searchParams.get('nonce')!;
    return { agent, state: auth.searchParams.get('state')! };
  };

  it('administración configura el proveedor y la persona entra con su cuenta corporativa', async () => {
    await marta.put('/api/auth/oidc/config').send({ issuer, clientId: 'x', clientSecret: 'y', domains: ['demo.test'] }).expect(403);
    await adminAgent
      .put('/api/auth/oidc/config')
      .send({ label: 'Microsoft 365', issuer, clientId: 'cliente-openhr', clientSecret: 'secreto-cliente', domains: ['@Demo.test'] })
      .expect(200);
    expect((await request(server).post('/api/auth/oidc/lookup').send({ email: 'luis@demo.test' }).expect(200)).body).toMatchObject({ sso: true, label: 'Microsoft 365' });
    expect((await request(server).post('/api/auth/oidc/lookup').send({ email: 'x@otro.test' }).expect(200)).body).toEqual({ sso: false });

    const { agent, state } = await startFlow('luis@demo.test');
    const cb = await agent.get(`/api/auth/oidc/callback?code=codigo-ok&state=${state}`).expect(302);
    expect(cb.headers.location).toBe('http://localhost:3000/');
    expect((await agent.get('/api/auth/me').expect(200)).body.email).toBe('luis@demo.test');
  });

  it('rechaza estado manipulado, nonce ajeno y emails sin cuenta', async () => {
    const a = await startFlow('luis@demo.test');
    const bad = await a.agent.get(`/api/auth/oidc/callback?code=codigo-ok&state=otro`).expect(302);
    expect(bad.headers.location).toMatch(/\/login\?error=/);

    const b = await startFlow('luis@demo.test');
    nextNonce = 'nonce-de-otro';
    const wrongNonce = await b.agent.get(`/api/auth/oidc/callback?code=codigo-ok&state=${b.state}`).expect(302);
    expect(decodeURIComponent(wrongNonce.headers.location)).toMatch(/nonce/);

    const c = await startFlow('luis@demo.test');
    nextEmail = 'nadie@demo.test';
    const unknown = await c.agent.get(`/api/auth/oidc/callback?code=codigo-ok&state=${c.state}`).expect(302);
    expect(decodeURIComponent(unknown.headers.location)).toMatch(/No hay ninguna cuenta/);
    await c.agent.get('/api/auth/me').expect(401);
    nextEmail = 'luis@demo.test';
  });

  it('con «obligatorio», ya no se puede entrar con contraseña', async () => {
    await adminAgent
      .put('/api/auth/oidc/config')
      .send({ issuer, clientId: 'cliente-openhr', domains: ['demo.test'], enforce: true })
      .expect(200);
    await request(server).post('/api/auth/login').send({ email: 'luis@demo.test', password: 'otra-contraseña-larga' }).expect(403);
    await adminAgent.put('/api/auth/oidc/config').send({ issuer, clientId: 'cliente-openhr', domains: ['demo.test'], enforce: false, enabled: false }).expect(200);
  });
});

describe('kiosco, geolocalización y fichaje sin conexión', () => {
  let token: string;
  const key = () => `k-${Math.random().toString(36).slice(2)}`;

  it('el kiosco ficha con código y PIN o con el QR personal, alternando entrada y salida', async () => {
    await luis.post('/api/kiosk/devices').send({ workCenterId: centerId, name: 'Tableta' }).expect(403);
    token = (await adminAgent.post('/api/kiosk/devices').send({ workCenterId: centerId, name: 'Tableta recepción' }).expect(201)).body.token;
    await request(server).get('/api/kiosk/device').set('x-kiosk-token', 'otro').expect(401);
    expect((await request(server).get('/api/kiosk/device').set('x-kiosk-token', token).expect(200)).body).toMatchObject({ name: 'Tableta recepción', company_name: 'Demo SL' });

    await luis.put('/api/kiosk/pin').send({ pin: '1234' }).expect(400); // demasiado obvio
    const { code } = (await luis.put('/api/kiosk/pin').send({ pin: '1357' }).expect(200)).body;
    expect(code).toMatch(/^\d{6}$/);
    const me = (await luis.get('/api/org/employees/' + luisEmp)).body;
    expect(me.kiosk_pin_hash).toBeUndefined();

    await request(server).post('/api/kiosk/device/clock').set('x-kiosk-token', token).send({ code, pin: '9999', idempotencyKey: key() }).expect(401);
    const first = (await request(server).post('/api/kiosk/device/clock').set('x-kiosk-token', token).send({ code, pin: '1357', idempotencyKey: key() }).expect(201)).body;
    expect(first.name).toBe('Luis');
    const qr = (await luis.get('/api/kiosk/qr').expect(200)).body.token;
    const second = (await request(server).post('/api/kiosk/device/clock').set('x-kiosk-token', token).send({ qr, idempotencyKey: key() }).expect(201)).body;
    expect(new Set([first.kind, second.kind])).toEqual(new Set(['in', 'out']));
    await request(server).post('/api/kiosk/device/clock').set('x-kiosk-token', token).send({ qr: 'falso', idempotencyKey: key() }).expect(401);
    const today = (await luis.get(`/api/time/employments/${luisEmp}?from=${new Date().toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`)).body;
    expect(today.entries.length).toBeGreaterThanOrEqual(2);
    expect((await luis.get(`/api/time/employments/${luisEmp}/verify`)).body.ok).toBe(true);
  });

  it('con la zona exigida solo se ficha dentro, salvo teletrabajo permitido', async () => {
    await adminAgent.patch(`/api/org/work-centers/${centerId}`).send({ geoPolicy: 'require' }).expect(400);
    await adminAgent.patch(`/api/org/work-centers/${centerId}`).send({ latitude: 40.4169, longitude: -3.7035, radiusM: 100, geoPolicy: 'require' }).expect(200);
    const status = (await luis.get('/api/time/status')).body[0].state;
    const kind = status === 'out' ? 'in' : 'out';
    await luis.post('/api/time/clock').send({ idempotencyKey: key(), kind }).expect(403);
    await luis.post('/api/time/clock').send({ idempotencyKey: key(), kind, location: { latitude: 40.43, longitude: -3.69, accuracy: 10 } }).expect(403);
    const ok = await luis.post('/api/time/clock').send({ idempotencyKey: key(), kind, location: { latitude: 40.41691, longitude: -3.70351, accuracy: 15 } }).expect(201);
    expect(ok.body.entry).toMatchObject({ channel: 'web', inside_zone: true });
    await adminAgent.patch(`/api/org/employees/${luisEmp}`).send({ remoteAllowed: true }).expect(200);
    const back = kind === 'in' ? 'out' : 'in';
    const remote = await luis.post('/api/time/clock').send({ idempotencyKey: key(), kind: back, location: { latitude: 41.39, longitude: 2.17 } }).expect(201);
    expect(remote.body.entry.inside_zone).toBe(false);
    await adminAgent.patch(`/api/org/work-centers/${centerId}`).send({ geoPolicy: 'off' }).expect(200);
    await adminAgent.patch(`/api/org/employees/${luisEmp}`).send({ remoteAllowed: false }).expect(200);
    expect((await luis.get(`/api/time/employments/${luisEmp}/verify`)).body.ok).toBe(true);
  });

  it('los fichajes sin conexión se envían después con su hora, hasta 72 horas', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    const r = await luis.post('/api/time/clock').send({ idempotencyKey: key(), kind: 'in', offlineAt: twoHoursAgo }).expect(201);
    expect(r.body.entry).toMatchObject({ source: 'offline', channel: 'offline' });
    expect(new Date(r.body.entry.occurred_at).toISOString()).toBe(twoHoursAgo);
    const k = key();
    await luis.post('/api/time/clock').send({ idempotencyKey: k, kind: 'out', offlineAt: new Date(Date.now() - 3600_000).toISOString() }).expect(201);
    const replay = await luis.post('/api/time/clock').send({ idempotencyKey: k, kind: 'out', offlineAt: new Date(Date.now() - 3600_000).toISOString() }).expect(201);
    expect(replay.body.replayed).toBe(true);
    await luis.post('/api/time/clock').send({ idempotencyKey: key(), kind: 'in', offlineAt: new Date(Date.now() - 4 * 86400_000).toISOString() }).expect(400);
    await luis.post('/api/time/clock').send({ idempotencyKey: key(), kind: 'in', offlineAt: new Date(Date.now() + 3600_000).toISOString() }).expect(400);
    expect((await luis.get(`/api/time/employments/${luisEmp}/verify`)).body.ok).toBe(true);
  });
});
