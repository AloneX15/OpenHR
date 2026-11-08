import jwt from 'jsonwebtoken';
import { config } from '../config';
import { sha256 } from '../common/crypto';
import { SessionUser } from '../common/http';

export const SESSION_COOKIE = 'openhr_session';

export function signSession(user: SessionUser): string {
  return jwt.sign({ tid: user.tenantId, typ: 'session' }, config.jwtSecret, {
    subject: user.userId,
    expiresIn: `${config.sessionHours}h`,
  });
}

export function verifySession(token: string): SessionUser | null {
  try {
    const p = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    if (p.typ !== 'session' || !p.sub || !p.tid) return null;
    return { userId: p.sub, tenantId: p.tid };
  } catch {
    return null;
  }
}

/** Reto intermedio entre contraseña correcta y código MFA (5 minutos). */
export function signMfaChallenge(user: SessionUser): string {
  return jwt.sign({ tid: user.tenantId, typ: 'mfa' }, config.jwtSecret, { subject: user.userId, expiresIn: '5m' });
}

export function verifyMfaChallenge(token: string): SessionUser | null {
  try {
    const p = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    if (p.typ !== 'mfa' || !p.sub) return null;
    return { userId: p.sub, tenantId: p.tid };
  } catch {
    return null;
  }
}

/**
 * Enlace para fijar contraseña (invitación o recuperación). Lleva una huella del hash
 * actual, así que deja de valer en cuanto la contraseña cambia: es de un solo uso.
 */
export function signPasswordToken(user: SessionUser, currentHash: string | null, days = 7): string {
  return jwt.sign(
    { tid: user.tenantId, typ: 'pwd', pwv: sha256(currentHash ?? '').slice(0, 16) },
    config.jwtSecret,
    { subject: user.userId, expiresIn: `${days}d` },
  );
}

export function verifyPasswordToken(token: string): (SessionUser & { pwv: string }) | null {
  try {
    const p = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    if (p.typ !== 'pwd' || !p.sub) return null;
    return { userId: p.sub, tenantId: p.tid, pwv: p.pwv };
  } catch {
    return null;
  }
}
