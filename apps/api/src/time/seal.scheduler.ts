import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { config } from '../config';
import { Db } from '../db/db.service';
import { TimeService } from './time.service';

/** Mes anterior (AAAA-MM) al de `now`, en UTC. */
export function previousPeriod(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Sellado automático: al empezar cada mes sella el registro de jornada de todas las
 * sociedades con fichajes, sin esperar a que RR. HH. se acuerde. Se comprueba al arrancar
 * y cada pocas horas; un índice único impide dos sellos automáticos de la misma sociedad y
 * mes aunque haya varias réplicas. Se desactiva con OUTBOX_WORKER=false, como el resto de
 * procesos automáticos.
 */
@Injectable()
export class SealScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Sellos');
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly db: Db,
    private readonly time: TimeService,
  ) {}

  onApplicationBootstrap() {
    if (!config.outboxWorker) return;
    const run = () => void this.runDue().catch((err) => this.log.error((err as Error).message));
    this.timers.push(setTimeout(run, 60_000), setInterval(run, 6 * 3600 * 1000));
  }

  onApplicationShutdown() {
    this.timers.forEach((t) => clearTimeout(t));
  }

  /** Sella el mes anterior en las sociedades que aún no lo tienen. Devuelve cuántos sellos ha creado. */
  async runDue(now = new Date()): Promise<number> {
    const period = previousPeriod(now);
    let created = 0;
    const tenants = await this.db.raw<{ id: string }>('SELECT system_tenant_ids() AS id');
    for (const t of tenants) {
      const companies = await this.db.tx(t.id, null, (tx) =>
        tx.query<{ id: string }>(
          `SELECT c.id FROM company c
            WHERE EXISTS (SELECT 1 FROM employment e WHERE e.company_id = c.id AND e.time_chain_seq > 0)
              AND NOT EXISTS (SELECT 1 FROM time_chain_seal s WHERE s.company_id = c.id AND s.automatic AND s.period = $1)`,
          [period],
        ),
      );
      for (const c of companies) {
        try {
          const seal = await this.db.tx(t.id, null, (tx) => this.time.sealCompany(tx, c.id, period));
          if (seal) created++;
        } catch (err) {
          this.log.error(`Sociedad ${c.id}: ${(err as Error).message}`);
        }
      }
    }
    if (created) this.log.log(`${created} sello(s) automático(s) de ${period}`);
    return created;
  }
}
