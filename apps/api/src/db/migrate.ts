import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

/**
 * Aplica las migraciones SQL pendientes con el rol propietario y se asegura de que el
 * rol de aplicación (sin privilegios de propietario, sujeto a RLS) existe.
 */
export async function runMigrations(ownerUrl: string, appPassword: string, log = console.log) {
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['openhr_migrate']);
    const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'openhr_app'");
    const pwd = (await client.query('SELECT quote_literal($1) AS q', [appPassword])).rows[0].q;
    if (exists.rowCount === 0) {
      await client.query(`CREATE ROLE openhr_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pwd}`);
      log('Rol openhr_app creado');
    } else {
      await client.query(`ALTER ROLE openhr_app WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pwd}`);
    }
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);

    const applied = new Map<string, string>(
      (await client.query('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]),
    );
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = applied.get(file);
      if (previous) {
        if (previous !== checksum) {
          throw new Error(`La migración ${file} ya aplicada ha cambiado. Crea una migración nueva.`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        log(`Migración aplicada: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Error en ${file}: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['openhr_migrate']).catch(() => undefined);
    await client.end();
  }
}

if (require.main === module) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('Falta MIGRATION_DATABASE_URL');
    process.exit(1);
  }
  runMigrations(url, process.env.OPENHR_APP_DB_PASSWORD ?? 'openhr_app')
    .then(() => console.log('Base de datos al día'))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
