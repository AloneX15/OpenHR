import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Actor, assertAdmin, audit } from '../common/access';
import { decrypt, encrypt } from '../common/crypto';
import { SessionUser } from '../common/http';
import { config } from '../config';
import { Db, Tx } from '../db/db.service';

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface Flow {
  tid: string;
  pid: string;
  nonce: string;
  verifier: string;
  state: string;
}

const b64url = (b: Buffer) => b.toString('base64url');
export const OIDC_COOKIE = 'openhr_oidc';

/**
 * Inicio de sesión con OpenID Connect (código de autorización + PKCE). Valida el ID token
 * (firma con las claves publicadas por el proveedor, emisor, audiencia, caducidad y nonce)
 * y entra en la cuenta de OpenHR con el mismo email. No crea cuentas: eso es cosa de
 * RR. HH. o de SCIM.
 */
@Injectable()
export class OidcService {
  private discoveryCache = new Map<string, { at: number; doc: Discovery }>();

  constructor(private readonly db: Db) {}

  private redirectUri() {
    return `${config.publicUrl}/api/auth/oidc/callback`;
  }

  async discovery(issuer: string): Promise<Discovery> {
    const cached = this.discoveryCache.get(issuer);
    if (cached && Date.now() - cached.at < 3600_000) return cached.doc;
    if (!issuer.startsWith('https://') && !(process.env.NODE_ENV !== 'production' && issuer.startsWith('http://127.0.0.1'))) {
      throw new BadRequestException('El emisor debe usar https');
    }
    const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new BadRequestException('No se puede leer la configuración del proveedor (¿emisor correcto?)');
    const doc = (await res.json()) as Discovery;
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new BadRequestException('Configuración OIDC incompleta');
    this.discoveryCache.set(issuer, { at: Date.now(), doc });
    return doc;
  }

  // ── Configuración (administración) ──────────────────────────────────────────────────
  async getConfig(tx: Tx, actor: Actor) {
    assertAdmin(actor);
    const row = await tx.maybeOne('SELECT label, issuer, client_id, domains, enabled, enforce, updated_at FROM oidc_provider');
    return { config: row, redirectUri: this.redirectUri() };
  }

  async saveConfig(
    tx: Tx,
    actor: Actor,
    input: { label: string; issuer: string; clientId: string; clientSecret?: string; domains: string[]; enabled: boolean; enforce: boolean },
  ) {
    assertAdmin(actor);
    await this.discovery(input.issuer); // comprueba que el emisor responde
    const existing = await tx.maybeOne('SELECT client_secret_enc FROM oidc_provider');
    if (!existing && !input.clientSecret) throw new BadRequestException('Falta el secreto del cliente');
    const secret = input.clientSecret ? encrypt(input.clientSecret) : existing.client_secret_enc;
    const domains = [...new Set(input.domains.map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
    await tx.query(
      `INSERT INTO oidc_provider (tenant_id, label, issuer, client_id, client_secret_enc, domains, enabled, enforce)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant_id) DO UPDATE SET label = EXCLUDED.label, issuer = EXCLUDED.issuer, client_id = EXCLUDED.client_id,
         client_secret_enc = EXCLUDED.client_secret_enc, domains = EXCLUDED.domains, enabled = EXCLUDED.enabled, enforce = EXCLUDED.enforce, updated_at = now()`,
      [tx.tenantId, input.label, input.issuer.replace(/\/$/, ''), input.clientId, secret, domains, input.enabled, input.enforce],
    );
    await audit(tx, 'oidc.configured', 'tenant', tx.tenantId, { issuer: input.issuer, domains, enabled: input.enabled, enforce: input.enforce });
    return { ok: true };
  }

  // ── Flujo de inicio de sesión ───────────────────────────────────────────────────────
  /** ¿Este email tiene acceso con el proveedor? (Lo usa la pantalla de acceso.) */
  async lookup(email: string) {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return { sso: false };
    const [p] = await this.db.raw('SELECT * FROM oidc_provider_by_domain($1)', [domain]);
    if (!p) return { sso: false };
    const row = await this.db.tx(p.tenant_id, null, (tx) => tx.one('SELECT label FROM oidc_provider WHERE id = $1', [p.provider_id]));
    return { sso: true, label: row.label as string, enforce: p.enforce as boolean };
  }

  /** ¿Debe entrar obligatoriamente con el proveedor? (Bloquea el acceso con contraseña.) */
  async passwordBlocked(email: string): Promise<boolean> {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return false;
    const [p] = await this.db.raw('SELECT * FROM oidc_provider_by_domain($1)', [domain]);
    return Boolean(p?.enforce);
  }

  async start(email: string): Promise<{ url: string; cookie: string }> {
    const domain = email.split('@')[1]?.toLowerCase();
    const [p] = domain ? await this.db.raw('SELECT * FROM oidc_provider_by_domain($1)', [domain]) : [];
    if (!p) throw new NotFoundException('Este email no usa inicio de sesión con proveedor externo');
    const prov = await this.db.tx(p.tenant_id, null, (tx) => tx.one('SELECT * FROM oidc_provider WHERE id = $1', [p.provider_id]));
    const d = await this.discovery(prov.issuer);
    const flow: Flow = { tid: p.tenant_id, pid: p.provider_id, nonce: b64url(randomBytes(16)), verifier: b64url(randomBytes(32)), state: b64url(randomBytes(16)) };
    const challenge = b64url(createHash('sha256').update(flow.verifier).digest());
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: prov.client_id,
      response_type: 'code',
      redirect_uri: this.redirectUri(),
      scope: 'openid email profile',
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      login_hint: email,
    }).toString();
    // El estado viaja en una cookie firmada de 10 minutos, ligada a este navegador.
    const cookie = jwt.sign({ ...flow, typ: 'oidc' }, config.jwtSecret, { expiresIn: '10m', algorithm: 'HS256' });
    return { url: url.toString(), cookie };
  }

  async callback(cookie: string | undefined, query: { code?: string; state?: string; error?: string }): Promise<SessionUser> {
    if (query.error) throw new UnauthorizedException('El proveedor ha rechazado el inicio de sesión');
    let flow: Flow & { typ: string };
    try {
      flow = jwt.verify(cookie ?? '', config.jwtSecret, { algorithms: ['HS256'] }) as any;
    } catch {
      throw new UnauthorizedException('El inicio de sesión ha caducado; vuelve a intentarlo');
    }
    if (flow.typ !== 'oidc' || !query.state || query.state !== flow.state || !query.code) throw new UnauthorizedException('Respuesta del proveedor no válida');
    const prov = await this.db.tx(flow.tid, null, (tx) => tx.maybeOne('SELECT * FROM oidc_provider WHERE id = $1 AND enabled', [flow.pid]));
    if (!prov) throw new UnauthorizedException('Proveedor desactivado');
    const d = await this.discovery(prov.issuer);
    const tokenRes = await fetch(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: query.code,
        redirect_uri: this.redirectUri(),
        client_id: prov.client_id,
        client_secret: decrypt(prov.client_secret_enc),
        code_verifier: flow.verifier,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenRes.ok) throw new UnauthorizedException('El proveedor no ha aceptado el código');
    const { id_token } = (await tokenRes.json()) as { id_token?: string };
    if (!id_token) throw new UnauthorizedException('El proveedor no ha devuelto identidad');

    const jose = await import('jose');
    const jwks = jose.createRemoteJWKSet(new URL(d.jwks_uri));
    let claims: Record<string, any>;
    try {
      // Entra ID multi-inquilino publica un emisor con {tenantid}: se compara con el del documento.
      ({ payload: claims } = await jose.jwtVerify(id_token, jwks, { issuer: d.issuer, audience: prov.client_id, clockTolerance: 60 }));
    } catch (err) {
      throw new UnauthorizedException(`Identidad no válida: ${(err as Error).message}`);
    }
    if (claims.nonce !== flow.nonce) throw new UnauthorizedException('Identidad no válida (nonce)');
    const email = String(claims.email ?? claims.preferred_username ?? claims.upn ?? '').toLowerCase();
    if (!email || !prov.domains.includes(email.split('@')[1])) throw new ForbiddenException('El email de la identidad no pertenece a un dominio permitido');
    if (claims.email_verified === false) throw new ForbiddenException('El proveedor no ha verificado este email');

    const [u] = await this.db.raw('SELECT * FROM auth_find_user($1)', [email]);
    if (!u || u.tenant_id !== flow.tid || !u.is_active) throw new ForbiddenException('No hay ninguna cuenta activa de OpenHR con este email. Pide a RR. HH. que te dé de alta.');
    const user = { userId: u.user_id as string, tenantId: u.tenant_id as string };
    await this.db.tx(user.tenantId, user.userId, async (tx) => {
      await tx.query('UPDATE app_user SET last_login_at = now() WHERE id = $1', [user.userId]);
      await audit(tx, 'auth.oidc_login', 'app_user', user.userId, { issuer: prov.issuer });
    });
    return user;
  }
}
