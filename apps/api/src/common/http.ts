import { BadRequestException, createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { z } from 'zod';

export interface SessionUser {
  userId: string;
  tenantId: string;
}

export const IS_PUBLIC = 'openhr:public';
/** Marca un endpoint como accesible sin sesión. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): SessionUser => {
  return ctx.switchToHttp().getRequest().user;
});

/** Valida `data` con un esquema zod y devuelve un 400 legible si no encaja. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new BadRequestException({
      message: 'Datos no válidos',
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

export const zUuid = z.string().uuid();
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');
export const zPeriod = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Periodo AAAA-MM');
