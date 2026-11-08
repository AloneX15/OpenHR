import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow, types } from 'pg';

// Las columnas DATE se devuelven como texto AAAA-MM-DD (sin conversiones de zona horaria).
types.setTypeParser(1082, (v: string) => v);
import { config } from '../config';

/** Cliente de base de datos dentro de una transacción con el tenant ya fijado. */
export interface Tx {
  query<T extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<T>;
  maybeOne<T extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<T | null>;
  readonly tenantId: string;
  readonly userId: string | null;
}

export class NotFoundInDb extends Error {}

function wrap(client: PoolClient, tenantId: string, userId: string | null): Tx {
  return {
    tenantId,
    userId,
    async query(sql, params) {
      const r = await client.query(sql, params as any[]);
      return r.rows;
    },
    async one(sql, params) {
      const r = await client.query(sql, params as any[]);
      if (r.rows.length !== 1) throw new NotFoundInDb(`Se esperaba 1 fila y hay ${r.rows.length}`);
      return r.rows[0];
    },
    async maybeOne(sql, params) {
      const r = await client.query(sql, params as any[]);
      return r.rows[0] ?? null;
    },
  };
}

@Injectable()
export class Db implements OnModuleDestroy {
  readonly pool: Pool;

  constructor() {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 20 });
  }

  /**
   * Ejecuta `fn` en una transacción con el contexto de tenant fijado con SET LOCAL
   * (set_config(..., true)). El contexto muere con la transacción, así que es seguro
   * con poolers en modo transacción. Ver docs/adr/0001.
   */
  async tx<T>(tenantId: string, userId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
        [tenantId, userId ?? ''],
      );
      const result = await fn(wrap(client, tenantId, userId));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Consultas sin tenant: solo sirven para funciones SECURITY DEFINER. */
  async raw<T extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<T[]> {
    const r = await this.pool.query(sql, params as any[]);
    return r.rows;
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
