import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes, randomInt } from 'node:crypto';
import { RateLimiter } from '../auth/rate-limit';
import { Actor, assertHr, audit, hrCompanyFilter } from '../common/access';
import { sha256 } from '../common/crypto';
import { config } from '../config';
import { Db, Tx } from '../db/db.service';
import { TimeService } from './time.service';

const QR_SECONDS = 60;

/**
 * Kiosco de fichaje: una tableta en el centro, autenticada con un token de dispositivo.
 * Cada persona se identifica con su código y PIN o mostrando un QR que cambia cada minuto.
 */
@Injectable()
export class KioskService {
  private readonly attempts: RateLimiter;

  constructor(
    private readonly db: Db,
    private readonly time: TimeService,
  ) {
    this.attempts = new RateLimiter(db, 'kiosk', 5, 15 * 60 * 1000);
  }

  // ── Dispositivos (RR. HH.) ──────────────────────────────────────────────────────────
  devices(tx: Tx, actor: Actor) {
    const companies = hrCompanyFilter(actor);
    if (companies !== null && !companies.length) throw new ForbiddenException();
    return tx.query(
      `SELECT d.id, d.name, d.active, d.created_at, d.last_seen_at, wc.name AS work_center_name, c.name AS company_name
         FROM kiosk_device d JOIN work_center wc ON wc.id = d.work_center_id JOIN company c ON c.id = wc.company_id
        WHERE $1::uuid[] IS NULL OR wc.company_id = ANY($1) ORDER BY d.created_at DESC`,
      [companies],
    );
  }

  async createDevice(tx: Tx, actor: Actor, input: { workCenterId: string; name: string }) {
    const wc = await tx.maybeOne('SELECT company_id FROM work_center WHERE id = $1', [input.workCenterId]);
    if (!wc) throw new NotFoundException('Centro no encontrado');
    assertHr(actor, wc.company_id);
    const token = randomBytes(32).toString('base64url');
    const row = await tx.one(
      `INSERT INTO kiosk_device (tenant_id, work_center_id, name, token_hash, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [tx.tenantId, input.workCenterId, input.name, sha256(token), actor.userId],
    );
    await audit(tx, 'kiosk.created', 'kiosk_device', row.id, { name: input.name });
    // El token solo se muestra ahora: el dispositivo lo guarda al abrir el enlace.
    return { id: row.id, token };
  }

  async deactivate(tx: Tx, actor: Actor, id: string) {
    const d = await tx.maybeOne('SELECT wc.company_id FROM kiosk_device d JOIN work_center wc ON wc.id = d.work_center_id WHERE d.id = $1', [id]);
    if (!d) throw new NotFoundException();
    assertHr(actor, d.company_id);
    await tx.query('UPDATE kiosk_device SET active = false WHERE id = $1', [id]);
    await audit(tx, 'kiosk.deactivated', 'kiosk_device', id);
    return { ok: true };
  }

  // ── Credenciales de cada persona ────────────────────────────────────────────────────
  private ownEmployment(actor: Actor, employmentId?: string) {
    const active = actor.employments.filter((e) => e.active);
    const e = employmentId ? active.find((x) => x.id === employmentId) : active[0];
    if (!e) throw new BadRequestException('No tienes ninguna relación laboral activa');
    return e.id;
  }

  async myCredentials(tx: Tx, actor: Actor, employmentId?: string) {
    const id = this.ownEmployment(actor, employmentId);
    const e = await tx.one('SELECT kiosk_code, (kiosk_pin_hash IS NOT NULL) AS has_pin FROM employment WHERE id = $1', [id]);
    return { employmentId: id, code: e.kiosk_code as string | null, hasPin: e.has_pin as boolean };
  }

  async setPin(tx: Tx, actor: Actor, pin: string, employmentId?: string) {
    if (!/^\d{4,6}$/.test(pin)) throw new BadRequestException('El PIN debe tener de 4 a 6 cifras');
    if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) throw new BadRequestException('Elige un PIN menos obvio');
    const id = this.ownEmployment(actor, employmentId);
    const e = await tx.one('SELECT kiosk_code FROM employment WHERE id = $1', [id]);
    let code = e.kiosk_code as string | null;
    for (let i = 0; !code && i < 20; i++) {
      const candidate = String(randomInt(100000, 1000000));
      const taken = await tx.maybeOne('SELECT 1 FROM employment WHERE kiosk_code = $1', [candidate]);
      if (!taken) code = candidate;
    }
    await tx.query('UPDATE employment SET kiosk_code = $2, kiosk_pin_hash = $3 WHERE id = $1', [id, code, await bcrypt.hash(pin, 10)]);
    return { code };
  }

  /** QR personal: token firmado que caduca en un minuto (la pantalla lo renueva). */
  qrToken(actor: Actor, employmentId?: string) {
    const id = this.ownEmployment(actor, employmentId);
    const token = jwt.sign({ typ: 'kioskqr', eid: id, tid: actor.tenantId }, config.jwtSecret, { expiresIn: QR_SECONDS, algorithm: 'HS256' });
    return { token, expiresIn: QR_SECONDS };
  }

  // ── Uso desde el dispositivo (sin sesión) ───────────────────────────────────────────
  private async device(token: string | undefined) {
    if (!token) throw new UnauthorizedException('Kiosco no registrado');
    const [d] = await this.db.raw<{ tenant_id: string; device_id: string }>('SELECT * FROM kiosk_by_token_hash($1)', [sha256(token)]);
    if (!d) throw new UnauthorizedException('Este kiosco está desactivado o no existe');
    return d;
  }

  async info(token: string | undefined) {
    const d = await this.device(token);
    return this.db.tx(d.tenant_id, d.device_id, async (tx) => {
      await tx.query('UPDATE kiosk_device SET last_seen_at = now() WHERE id = $1', [d.device_id]);
      return tx.one(
        `SELECT d.name, wc.name AS work_center_name, coalesce(wc.timezone, 'Europe/Madrid') AS timezone, c.name AS company_name
           FROM kiosk_device d JOIN work_center wc ON wc.id = d.work_center_id JOIN company c ON c.id = wc.company_id WHERE d.id = $1`,
        [d.device_id],
      );
    });
  }

  async clock(token: string | undefined, input: { code?: string; pin?: string; qr?: string; idempotencyKey: string }) {
    const d = await this.device(token);
    return this.db.tx(d.tenant_id, d.device_id, async (tx) => {
      const dev = await tx.one(`SELECT wc.company_id FROM kiosk_device k JOIN work_center wc ON wc.id = k.work_center_id WHERE k.id = $1`, [d.device_id]);
      let employmentId: string;
      if (input.qr) {
        let p: jwt.JwtPayload;
        try {
          p = jwt.verify(input.qr, config.jwtSecret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
        } catch {
          throw new UnauthorizedException('Código QR caducado: vuelve a mostrarlo');
        }
        if (p.typ !== 'kioskqr' || p.tid !== d.tenant_id) throw new UnauthorizedException('Código QR no válido');
        employmentId = p.eid;
      } else {
        const key = `${d.device_id}:${input.code}`;
        await this.attempts.check(key);
        const e = await tx.maybeOne('SELECT id, kiosk_pin_hash FROM employment WHERE kiosk_code = $1', [input.code ?? '']);
        if (!e?.kiosk_pin_hash || !(await bcrypt.compare(input.pin ?? '', e.kiosk_pin_hash))) throw new UnauthorizedException('Código o PIN incorrectos');
        await this.attempts.reset(key);
        employmentId = e.id;
      }
      const emp = await tx.maybeOne(
        `SELECT e.company_id, e.start_date::text, p.first_name FROM employment e JOIN person p ON p.id = e.person_id
          WHERE e.id = $1 AND (e.end_date IS NULL OR e.end_date >= current_date)`,
        [employmentId],
      );
      if (!emp || emp.company_id !== dev.company_id) throw new ForbiddenException('No puedes fichar en este kiosco');
      if (emp.start_date > new Date().toISOString().slice(0, 10)) throw new ForbiddenException('Tu relación laboral aún no ha empezado');
      const entry = await this.time.kioskClock(tx, employmentId, d.device_id, input.idempotencyKey);
      await tx.query('UPDATE kiosk_device SET last_seen_at = now() WHERE id = $1', [d.device_id]);
      // Solo el nombre de pila: la pantalla del kiosco es pública.
      return { name: emp.first_name as string, kind: entry.kind, at: entry.occurred_at };
    });
  }
}
