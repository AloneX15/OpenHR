import { HttpException, HttpStatus } from '@nestjs/common';
import { sha256 } from '../common/crypto';
import { Db } from '../db/db.service';

/**
 * Límite de intentos por clave dentro de una ventana de tiempo. Los intentos se cuentan en
 * PostgreSQL (`rate_limit_try`), así que el límite es el mismo con una réplica de la API o
 * con varias. De la clave solo se guarda una huella.
 */
export class RateLimiter {
  constructor(
    private readonly db: Db,
    private readonly scope: string,
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private key(key: string) {
    return sha256(`${this.scope}:${key}`);
  }

  /** Apunta un intento; lanza 429 si ya se ha alcanzado el máximo. */
  async check(key: string) {
    const [row] = await this.db.raw<{ ok: boolean }>('SELECT rate_limit_try($1, $2, $3) AS ok', [
      this.key(key),
      this.max,
      Math.ceil(this.windowMs / 1000),
    ]);
    if (!row.ok) throw new HttpException('Demasiados intentos. Espera unos minutos.', HttpStatus.TOO_MANY_REQUESTS);
  }

  async reset(key: string) {
    await this.db.raw('SELECT rate_limit_reset($1)', [this.key(key)]);
  }
}
