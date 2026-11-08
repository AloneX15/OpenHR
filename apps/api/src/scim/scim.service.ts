import { HttpException, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Actor, assertAdmin, audit } from '../common/access';
import { sha256 } from '../common/crypto';
import { config } from '../config';
import { Db, Tx } from '../db/db.service';

export const SCIM_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCIM_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

/** Error con el formato de SCIM (RFC 7644 §3.12). */
export class ScimError extends HttpException {
  constructor(status: number, detail: string, scimType?: string) {
    super({ schemas: [SCIM_ERROR], status: String(status), detail, ...(scimType ? { scimType } : {}) }, status);
  }
}

interface UserRow {
  id: string;
  email: string;
  is_active: boolean;
  scim_external_id: string | null;
  created_at: Date;
  updated_at: Date;
  first_name: string | null;
  last_name: string | null;
  person_id: string | null;
}

export interface ScimUserInput {
  userName?: string;
  externalId?: string | null;
  givenName?: string;
  familyName?: string;
  active?: boolean;
}

const USER_SELECT = `SELECT u.id, u.email, u.is_active, u.scim_external_id, u.created_at, u.updated_at, u.person_id, p.first_name, p.last_name
                       FROM app_user u LEFT JOIN person p ON p.id = u.person_id`;

const bool = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() === 'true' : Boolean(v));
const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;

/** Convierte el cuerpo de un POST/PUT de SCIM en nuestros campos. */
export function fromScim(body: any): ScimUserInput {
  const work = Array.isArray(body?.emails) ? (body.emails.find((e: any) => e?.primary) ?? body.emails[0])?.value : undefined;
  return {
    userName: typeof body?.userName === 'string' ? body.userName.trim() : typeof work === 'string' ? work.trim() : undefined,
    externalId: typeof body?.externalId === 'string' ? body.externalId : undefined,
    givenName: typeof body?.name?.givenName === 'string' ? body.name.givenName.trim() : undefined,
    familyName: typeof body?.name?.familyName === 'string' ? body.name.familyName.trim() : undefined,
    active: body?.active === undefined ? undefined : bool(body.active),
  };
}

/**
 * Aplica las operaciones de un PATCH de SCIM. Entra ID escribe «Replace» con mayúscula y envía
 * los booleanos como texto; los atributos que OpenHR no gestiona se ignoran.
 */
export function applyPatch(ops: any[]): ScimUserInput {
  const out: ScimUserInput = {};
  const set = (path: string, value: any) => {
    const p = path.toLowerCase();
    if (p === 'active') out.active = bool(value);
    else if (p === 'username') out.userName = String(value).trim();
    else if (p === 'externalid') out.externalId = value === null ? null : String(value);
    else if (p === 'name.givenname') out.givenName = String(value).trim();
    else if (p === 'name.familyname') out.familyName = String(value).trim();
    else if (p.startsWith('emails') && !out.userName) {
      const v = Array.isArray(value) ? value[0]?.value : typeof value === 'object' ? value?.value : value;
      if (typeof v === 'string') out.userName = v.trim();
    } else if (p === 'name' && typeof value === 'object') {
      if (value.givenName) out.givenName = String(value.givenName).trim();
      if (value.familyName) out.familyName = String(value.familyName).trim();
    }
  };
  for (const op of ops ?? []) {
    const kind = String(op?.op ?? '').toLowerCase();
    if (!['add', 'replace', 'remove'].includes(kind)) throw new ScimError(400, `Operación no admitida: ${op?.op}`, 'invalidSyntax');
    if (kind === 'remove') {
      if (String(op.path ?? '').toLowerCase() === 'externalid') out.externalId = null;
      continue;
    }
    if (op.path) set(op.path, op.value);
    else if (op.value && typeof op.value === 'object') for (const [k, v] of Object.entries(op.value)) set(k, v);
  }
  return out;
}

/** Filtros admitidos: userName eq "…" y externalId eq "…" (los que usa Entra ID). */
export function parseFilter(filter: string | undefined): { field: 'email' | 'scim_external_id'; value: string } | null {
  if (!filter) return null;
  const m = /^\s*(userName|externalId|emails(?:\[type eq "work"\])?\.value)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  if (!m) throw new ScimError(400, 'Filtro no admitido. Usa userName eq "…" o externalId eq "…"', 'invalidFilter');
  const value = m[2].replace(/\\(.)/g, '$1');
  return { field: m[1].toLowerCase() === 'externalid' ? 'scim_external_id' : 'email', value };
}

@Injectable()
export class ScimService {
  constructor(private readonly db: Db) {}

  // ── Tokens (desde la web, administración) ──────────────────────────────────────
  listTokens(tx: Tx, actor: Actor) {
    assertAdmin(actor);
    return tx.query('SELECT id, label, created_at, last_used_at, revoked_at FROM scim_token ORDER BY created_at DESC');
  }

  async createToken(tx: Tx, actor: Actor, label: string) {
    assertAdmin(actor);
    const token = `scim_${randomBytes(32).toString('base64url')}`;
    const row = await tx.one(`INSERT INTO scim_token (tenant_id, label, token_hash, created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [
      tx.tenantId,
      label,
      sha256(token),
      actor.userId,
    ]);
    await audit(tx, 'scim.token_created', 'scim_token', row.id, { label });
    return { id: row.id, token, baseUrl: `${config.publicUrl}/api/scim/v2` };
  }

  async revokeToken(tx: Tx, actor: Actor, id: string) {
    assertAdmin(actor);
    await tx.query('UPDATE scim_token SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
    await audit(tx, 'scim.token_revoked', 'scim_token', id);
    return { ok: true };
  }

  // ── Protocolo ──────────────────────────────────────────────────────────────────
  /** Comprueba el token de portador y ejecuta `fn` en la organización del token. */
  async withToken<T>(authorization: string | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
    if (!m) throw new ScimError(401, 'Falta el token');
    const [t] = await this.db.raw<{ id: string; tenant_id: string }>('SELECT * FROM scim_token_lookup($1)', [sha256(m[1])]);
    if (!t) throw new ScimError(401, 'Token no válido o revocado');
    return this.db.tx(t.tenant_id, null, async (tx) => {
      await tx.query('UPDATE scim_token SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval \'1 minute\')', [t.id]);
      return fn(tx);
    });
  }

  toScim(u: UserRow) {
    const location = `${config.publicUrl}/api/scim/v2/Users/${u.id}`;
    return {
      schemas: [SCIM_USER],
      id: u.id,
      externalId: u.scim_external_id ?? undefined,
      userName: u.email,
      name: { givenName: u.first_name ?? undefined, familyName: u.last_name ?? undefined, formatted: [u.first_name, u.last_name].filter(Boolean).join(' ') || undefined },
      displayName: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email,
      emails: [{ value: u.email, type: 'work', primary: true }],
      active: u.is_active,
      meta: { resourceType: 'User', created: new Date(u.created_at).toISOString(), lastModified: new Date(u.updated_at).toISOString(), location },
    };
  }

  private async get(tx: Tx, id: string): Promise<UserRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ScimError(404, 'Usuario no encontrado');
    const u = await tx.maybeOne<UserRow>(`${USER_SELECT} WHERE u.id = $1`, [id]);
    if (!u) throw new ScimError(404, 'Usuario no encontrado');
    return u;
  }

  async list(tx: Tx, q: { filter?: string; startIndex?: string; count?: string }) {
    const f = parseFilter(q.filter);
    const start = Math.max(1, Number(q.startIndex) || 1);
    const count = Math.min(200, Math.max(0, q.count === undefined ? 100 : Number(q.count) || 0));
    const where = f ? (f.field === 'email' ? 'WHERE lower(u.email) = lower($1)' : 'WHERE u.scim_external_id = $1') : '';
    const params = f ? [f.value] : [];
    const total = Number((await tx.one(`SELECT count(*) AS n FROM app_user u ${where}`, params)).n);
    const rows = count
      ? await tx.query<UserRow>(`${USER_SELECT} ${where} ORDER BY u.created_at, u.id OFFSET ${start - 1} LIMIT ${count}`, params)
      : [];
    return { schemas: [SCIM_LIST], totalResults: total, startIndex: start, itemsPerPage: rows.length, Resources: rows.map((r) => this.toScim(r)) };
  }

  async read(tx: Tx, id: string) {
    return this.toScim(await this.get(tx, id));
  }

  /**
   * Alta de cuenta. Se vincula a la persona con ese email si ya existe en OpenHR; si no, la
   * cuenta queda sin ficha hasta que RR. HH. dé de alta a la persona con el mismo email.
   * No se envía invitación: la persona entra con su cuenta corporativa (OpenID Connect).
   */
  async create(tx: Tx, input: ScimUserInput) {
    if (!input.userName || !emailOk(input.userName)) throw new ScimError(400, 'userName debe ser un email', 'invalidValue');
    const exists = await tx.maybeOne('SELECT id FROM app_user WHERE lower(email) = lower($1)', [input.userName]);
    if (exists) throw new ScimError(409, 'Ya existe una cuenta con ese email', 'uniqueness');
    const person = await tx.maybeOne(
      `SELECT p.id FROM person p WHERE lower(p.email) = lower($1) AND NOT EXISTS (SELECT 1 FROM app_user u WHERE u.person_id = p.id) LIMIT 1`,
      [input.userName],
    );
    let row;
    try {
      row = await tx.one(
        `INSERT INTO app_user (tenant_id, person_id, email, is_active, scim_external_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [tx.tenantId, person?.id ?? null, input.userName, input.active ?? true, input.externalId ?? null],
      );
    } catch (err: any) {
      // El email puede existir en otra organización de la misma instalación.
      if (err?.code === '23505') throw new ScimError(409, 'Ya existe una cuenta con ese email', 'uniqueness');
      throw err;
    }
    await audit(tx, 'scim.user_created', 'app_user', row.id, { email: input.userName, linked: !!person });
    return this.read(tx, row.id);
  }

  async update(tx: Tx, id: string, input: ScimUserInput) {
    const u = await this.get(tx, id);
    if (input.userName !== undefined && input.userName.toLowerCase() !== u.email.toLowerCase()) {
      if (!emailOk(input.userName)) throw new ScimError(400, 'userName debe ser un email', 'invalidValue');
      try {
        await tx.query('UPDATE app_user SET email = $2 WHERE id = $1', [id, input.userName]);
      } catch (err: any) {
        if (err?.code === '23505') throw new ScimError(409, 'Ya existe una cuenta con ese email', 'uniqueness');
        throw err;
      }
    }
    if (input.externalId !== undefined) await tx.query('UPDATE app_user SET scim_external_id = $2 WHERE id = $1', [id, input.externalId]);
    if (input.active !== undefined && input.active !== u.is_active) {
      // Desactivar revoca las sesiones abiertas (el disparador sube session_version).
      await tx.query('UPDATE app_user SET is_active = $2 WHERE id = $1', [id, input.active]);
      await audit(tx, input.active ? 'scim.user_activated' : 'scim.user_deactivated', 'app_user', id);
    }
    // El nombre de la ficha lo lleva RR. HH.; SCIM solo lo completa si falta.
    if (u.person_id && (input.givenName || input.familyName)) {
      await tx.query(
        `UPDATE person SET first_name = CASE WHEN coalesce(first_name, '') = '' THEN coalesce($2, first_name) ELSE first_name END,
                           last_name = CASE WHEN coalesce(last_name, '') = '' THEN coalesce($3, last_name) ELSE last_name END WHERE id = $1`,
        [u.person_id, input.givenName || null, input.familyName || null],
      );
    }
    await tx.query('UPDATE app_user SET updated_at = now() WHERE id = $1', [id]);
    return this.read(tx, id);
  }

  /** «Borrar» desactiva: el registro de jornada y la auditoría deben conservarse. */
  async remove(tx: Tx, id: string) {
    await this.update(tx, id, { active: false });
  }
}
