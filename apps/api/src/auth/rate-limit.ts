import { HttpException, HttpStatus } from '@nestjs/common';

/** Limitador en memoria (suficiente para una sola instancia de API). */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly max: number, private readonly windowMs: number) {}

  check(key: string) {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      throw new HttpException('Demasiados intentos. Espera unos minutos.', HttpStatus.TOO_MANY_REQUESTS);
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.hits.clear();
  }

  reset(key: string) {
    this.hits.delete(key);
  }
}
