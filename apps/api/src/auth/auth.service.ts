import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { decrypt, encrypt, newTotpSecret, sha256, verifyTotp } from '../common/crypto';
import { audit, loadActor } from '../common/access';
import { SessionUser } from '../common/http';
import { config } from '../config';
import { Db, Tx } from '../db/db.service';
import { NotificationsService } from '../notifications/notifications.service';
import { createTenantDefaults } from '../org/defaults';
import { RateLimiter } from './rate-limit';
import { sessionState } from './session-state';
import { signMfaChallenge, signPasswordToken, verifyMfaChallenge, verifyPasswordToken } from './session';

export const MIN_PASSWORD = 10;

// Hash ficticio para igualar tiempos cuando el email no existe.
const DUMMY_HASH = bcrypt.hashSync('openhr-dummy-password', 10);

export type LoginResult = { user: SessionUser } | { mfaRequired: true; challenge: string };

@Injectable()
export class AuthService {
  private readonly loginLimiter: RateLimiter;
  // Límite por cuenta, independiente de la IP (que puede falsearse tras un proxy).
  private readonly accountLimiter: RateLimiter;
  private readonly mfaLimiter: RateLimiter;

  constructor(
    private readonly db: Db,
    private readonly notifications: NotificationsService,
  ) {
    this.loginLimiter = new RateLimiter(db, 'login', 10, 15 * 60 * 1000);
    this.accountLimiter = new RateLimiter(db, 'account', 20, 15 * 60 * 1000);
    this.mfaLimiter = new RateLimiter(db, 'mfa', 10, 15 * 60 * 1000);
  }

  async login(rawEmail: string, password: string, ip: string): Promise<LoginResult> {
    const email = rawEmail.trim().toLowerCase();
    const key = `${ip}:${email}`;
    await this.loginLimiter.check(key);
    await this.accountLimiter.check(email);
    const [row] = await this.db.raw('SELECT * FROM auth_find_user($1)', [email]);
    const ok = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !row.password_hash || !ok || !row.is_active) {
      throw new UnauthorizedException('Email o contraseña incorrectos');
    }
    await this.loginLimiter.reset(key);
    await this.accountLimiter.reset(email);
    const user = { userId: row.user_id, tenantId: row.tenant_id };
    if (row.totp_enabled) return { mfaRequired: true, challenge: signMfaChallenge(user) };
    await this.touchLogin(user);
    return { user };
  }

  async completeMfa(challenge: string, code: string): Promise<SessionUser> {
    const user = verifyMfaChallenge(challenge);
    if (!user) throw new UnauthorizedException('El reto ha caducado, vuelve a iniciar sesión');
    await this.mfaLimiter.check(user.userId);
    const row = await this.db.tx(user.tenantId, user.userId, (tx) =>
      tx.one('SELECT totp_secret, totp_enabled, is_active FROM app_user WHERE id = $1', [user.userId]),
    );
    if (!row.is_active || !row.totp_enabled || !verifyTotp(decrypt(row.totp_secret), code)) {
      throw new UnauthorizedException('Código incorrecto');
    }
    await this.mfaLimiter.reset(user.userId);
    await this.touchLogin(user);
    return user;
  }

  private async touchLogin(user: SessionUser) {
    await this.db.tx(user.tenantId, user.userId, (tx) =>
      tx.query('UPDATE app_user SET last_login_at = now() WHERE id = $1', [user.userId]),
    );
  }

  /** Versión de sesión vigente: se usa para reemitir la cookie tras un cambio sensible. */
  async sessionVersion(user: SessionUser): Promise<number> {
    const state = await sessionState(this.db, user);
    if (!state) throw new UnauthorizedException();
    return state.sessionVersion;
  }

  async me(user: SessionUser) {
    return this.db.tx(user.tenantId, user.userId, async (tx) => {
      const actor = await loadActor(tx);
      const info = await tx.one(
        `SELECT u.email, u.totp_enabled, p.first_name, p.last_name, t.name AS tenant_name
           FROM app_user u
           JOIN tenant t ON t.id = u.tenant_id
           LEFT JOIN person p ON p.id = u.person_id
          WHERE u.id = $1`,
        [user.userId],
      );
      const employments = actor.personId
        ? await tx.query(
            `SELECT e.id, e.company_id, c.name AS company_name, e.job_title, e.start_date, e.end_date,
                    wc.name AS work_center_name, coalesce(wc.timezone, 'Europe/Madrid') AS timezone,
                    coalesce(wc.geo_policy, 'off') AS geo_policy
               FROM employment e
               JOIN company c ON c.id = e.company_id
               LEFT JOIN work_center wc ON wc.id = e.work_center_id
              WHERE e.person_id = $1 AND (e.end_date IS NULL OR e.end_date >= current_date)
              ORDER BY e.start_date`,
            [actor.personId],
          )
        : [];
      const reports = actor.employments.length
        ? await tx.one<{ n: number }>(
            'SELECT count(*)::int AS n FROM employment WHERE manager_employment_id = ANY($1)',
            [actor.employments.map((e) => e.id)],
          )
        : { n: 0 };
      return {
        userId: user.userId,
        tenantId: user.tenantId,
        tenantName: info.tenant_name,
        email: info.email,
        firstName: info.first_name,
        lastName: info.last_name,
        mfaEnabled: info.totp_enabled,
        personId: actor.personId,
        isAdmin: actor.isAdmin,
        isCompliance: actor.isCompliance,
        isHr: actor.isAdmin || actor.hrAll || actor.hrCompanyIds.length > 0,
        hrCompanyIds: actor.isAdmin || actor.hrAll ? null : actor.hrCompanyIds,
        isManager: reports.n > 0,
        employments,
      };
    });
  }

  /** Cierra todas las sesiones de la cuenta, también esta (ver ADR 0003). */
  async revokeSessions(user: SessionUser) {
    await this.db.tx(user.tenantId, user.userId, async (tx) => {
      await tx.query('UPDATE app_user SET session_version = session_version + 1 WHERE id = $1', [user.userId]);
      await audit(tx, 'auth.sessions_revoked', 'app_user', user.userId);
    });
  }

  async changePassword(user: SessionUser, current: string, next: string) {
    assertPasswordPolicy(next);
    await this.db.tx(user.tenantId, user.userId, async (tx) => {
      const row = await tx.one('SELECT password_hash FROM app_user WHERE id = $1', [user.userId]);
      if (!row.password_hash || !(await bcrypt.compare(current, row.password_hash))) {
        throw new BadRequestException('La contraseña actual no es correcta');
      }
      await tx.query('UPDATE app_user SET password_hash = $2 WHERE id = $1', [user.userId, await hashPassword(next)]);
    });
  }

  async setPasswordWithToken(token: string, password: string): Promise<SessionUser> {
    assertPasswordPolicy(password);
    const t = verifyPasswordToken(token);
    if (!t) throw new BadRequestException('El enlace no es válido o ha caducado');
    return this.db.tx(t.tenantId, t.userId, async (tx) => {
      const row = await tx.maybeOne('SELECT password_hash, is_active FROM app_user WHERE id = $1 FOR UPDATE', [
        t.userId,
      ]);
      if (!row || !row.is_active || sha256(row.password_hash ?? '').slice(0, 16) !== t.pwv) {
        throw new BadRequestException('El enlace ya se ha usado o ha caducado');
      }
      await tx.query('UPDATE app_user SET password_hash = $2 WHERE id = $1', [t.userId, await hashPassword(password)]);
      return { userId: t.userId, tenantId: t.tenantId };
    });
  }

  /** Siempre responde igual para no revelar qué emails existen. */
  async requestPasswordReset(email: string, ip: string) {
    await this.loginLimiter.check(`reset:${ip}`);
    await this.accountLimiter.check(`reset:${email.toLowerCase()}`);
    const [row] = await this.db.raw('SELECT * FROM auth_find_user($1)', [email]);
    if (!row || !row.is_active) return;
    await this.db.tx(row.tenant_id, null, async (tx) => {
      const token = signPasswordToken({ userId: row.user_id, tenantId: row.tenant_id }, row.password_hash, 1);
      await this.notifications.queueEmail(
        tx,
        email,
        'Restablecer tu contraseña de OpenHR',
        `Para elegir una contraseña nueva abre este enlace (caduca en 24 horas):\n\n${passwordLink(token)}\n\nSi no lo has pedido tú, ignora este mensaje.`,
      );
    });
  }

  /** Envía (o reenvía) la invitación para que la persona fije su contraseña. */
  async sendInvitation(tx: Tx, userId: string) {
    const u = await tx.one('SELECT email, password_hash FROM app_user WHERE id = $1', [userId]);
    const token = signPasswordToken({ userId, tenantId: tx.tenantId }, u.password_hash, 7);
    await this.notifications.queueEmail(
      tx,
      u.email,
      'Te damos la bienvenida a OpenHR',
      `Se ha creado tu cuenta en OpenHR. Para activarla, elige tu contraseña aquí (el enlace caduca en 7 días):\n\n${passwordLink(token)}`,
    );
    return token;
  }

  // ── MFA ──────────────────────────────────────────────────────────────────────────
  async mfaSetup(user: SessionUser) {
    return this.db.tx(user.tenantId, user.userId, async (tx) => {
      const row = await tx.one('SELECT email, totp_enabled FROM app_user WHERE id = $1', [user.userId]);
      if (row.totp_enabled) throw new ConflictException('La verificación en dos pasos ya está activa');
      const secret = newTotpSecret();
      await tx.query('UPDATE app_user SET totp_secret = $2 WHERE id = $1', [user.userId, encrypt(secret)]);
      const label = encodeURIComponent(`OpenHR:${row.email}`);
      return { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=OpenHR&digits=6&period=30` };
    });
  }

  async mfaEnable(user: SessionUser, code: string) {
    await this.db.tx(user.tenantId, user.userId, async (tx) => {
      const row = await tx.one('SELECT totp_secret FROM app_user WHERE id = $1', [user.userId]);
      if (!row.totp_secret || !verifyTotp(decrypt(row.totp_secret), code)) {
        throw new BadRequestException('Código incorrecto');
      }
      await tx.query('UPDATE app_user SET totp_enabled = true WHERE id = $1', [user.userId]);
    });
  }

  async mfaDisable(user: SessionUser, password: string) {
    await this.db.tx(user.tenantId, user.userId, async (tx) => {
      const row = await tx.one('SELECT password_hash FROM app_user WHERE id = $1', [user.userId]);
      if (!row.password_hash || !(await bcrypt.compare(password, row.password_hash))) {
        throw new BadRequestException('La contraseña no es correcta');
      }
      await tx.query('UPDATE app_user SET totp_enabled = false, totp_secret = NULL WHERE id = $1', [user.userId]);
    });
  }

  // ── Primera puesta en marcha ─────────────────────────────────────────────────────
  async setupDone(): Promise<boolean> {
    const [row] = await this.db.raw<{ setup_is_done: boolean }>('SELECT setup_is_done()');
    return row.setup_is_done;
  }

  async setup(input: {
    organizationName: string;
    companyName: string;
    companyTaxId: string;
    firstName: string;
    lastName: string;
    email: string;
    password: string;
  }): Promise<SessionUser> {
    assertPasswordPolicy(input.password);
    const [{ setup_create_tenant: tenantId }] = await this.db.raw('SELECT setup_create_tenant($1)', [
      input.organizationName,
    ]);
    return this.db.tx(tenantId, null, async (tx) => {
      const company = await tx.one(
        `INSERT INTO company (tenant_id, name, legal_name, tax_id) VALUES ($1, $2, $2, $3) RETURNING id`,
        [tenantId, input.companyName, input.companyTaxId.toUpperCase()],
      );
      const center = await tx.one(
        `INSERT INTO work_center (tenant_id, company_id, name) VALUES ($1, $2, 'Sede central') RETURNING id`,
        [tenantId, company.id],
      );
      const person = await tx.one(
        `INSERT INTO person (tenant_id, first_name, last_name, email) VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenantId, input.firstName, input.lastName, input.email],
      );
      const user = await tx.one(
        `INSERT INTO app_user (tenant_id, person_id, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenantId, person.id, input.email, await hashPassword(input.password)],
      );
      await tx.query(`INSERT INTO role_assignment (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [
        tenantId,
        user.id,
      ]);
      // Quien configura suele trabajar también en el grupo: se le da de alta para que pueda
      // fichar y pedir ausencias. Si no es así, RR. HH. puede darle de baja.
      await tx.query(
        `INSERT INTO employment (tenant_id, person_id, company_id, work_center_id, start_date) VALUES ($1, $2, $3, $4, current_date)`,
        [tenantId, person.id, company.id, center.id],
      );
      await createTenantDefaults(tx);
      return { userId: user.id, tenantId };
    });
  }
}

function passwordLink(token: string) {
  return `${config.publicUrl}/definir-contrasena?token=${encodeURIComponent(token)}`;
}

export function assertPasswordPolicy(password: string) {
  if (password.length < MIN_PASSWORD) {
    throw new BadRequestException(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`);
  }
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}
