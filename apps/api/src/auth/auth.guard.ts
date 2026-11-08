import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from '../common/http';
import { Db } from '../db/db.service';
import { sessionState } from './session-state';
import { SESSION_COOKIE, verifySession } from './session';

/**
 * Exige una sesión válida en todas las rutas salvo las marcadas con @Public().
 * Además de la firma del JWT comprueba en la base de datos que la cuenta sigue activa y
 * que la sesión no se ha revocado (cambio de contraseña, MFA, desactivación…).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: Db,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest();
    const token = req.cookies?.[SESSION_COOKIE];
    const session = token ? verifySession(token) : null;
    if (!session) throw new UnauthorizedException('Inicia sesión');
    const state = await sessionState(this.db, session);
    if (!state || !state.isActive || state.sessionVersion !== session.sessionVersion) {
      throw new UnauthorizedException('Tu sesión ha caducado, vuelve a iniciar sesión');
    }
    req.user = { userId: session.userId, tenantId: session.tenantId };
    return true;
  }
}
