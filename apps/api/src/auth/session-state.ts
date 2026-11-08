import { SessionUser } from '../common/http';
import { Db } from '../db/db.service';

export interface SessionState {
  isActive: boolean;
  sessionVersion: number;
}

/** Estado de la cuenta para validar una sesión (función SECURITY DEFINER, sin tenant). */
export async function sessionState(db: Db, user: SessionUser): Promise<SessionState | null> {
  const [row] = await db.raw<{ is_active: boolean; session_version: number }>('SELECT * FROM auth_session_check($1, $2)', [
    user.userId,
    user.tenantId,
  ]);
  return row ? { isActive: row.is_active, sessionVersion: row.session_version } : null;
}
