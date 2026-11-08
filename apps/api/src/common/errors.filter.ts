import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { NotFoundInDb } from '../db/db.service';

/** Traduce errores de PostgreSQL a respuestas HTTP comprensibles. */
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');

  catch(err: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (err instanceof HttpException) {
      const body = err.getResponse();
      return res.status(err.getStatus()).json(typeof body === 'string' ? { message: body } : body);
    }
    if (err instanceof NotFoundInDb) return res.status(404).json({ message: 'No encontrado' });
    const pg: Record<string, [number, string]> = {
      '22P02': [400, 'Identificador o valor no válido'],
      '22007': [400, 'Fecha no válida'],
      '22008': [400, 'Fecha fuera de rango'],
      '23505': [409, 'Ya existe un registro con esos datos'],
      '23503': [400, 'Hace referencia a un registro que no existe o está en uso'],
      '23514': [400, 'Los datos no cumplen las reglas'],
      '42501': [403, 'Operación no permitida'],
    };
    const mapped = err?.code ? pg[err.code] : undefined;
    // No se devuelve err.detail: puede revelar datos (p. ej. que un email existe en otra organización).
    if (mapped) return res.status(mapped[0]).json({ message: mapped[1] });
    this.log.error(err?.stack ?? String(err));
    return res.status(500).json({ message: 'Error interno' });
  }
}
