import { randomBytes } from 'node:crypto';

function required(name: string, fallbackForDev?: string): string {
  const value = process.env[name];
  if (value) return value;
  if (fallbackForDev !== undefined && process.env.NODE_ENV !== 'production') return fallbackForDev;
  throw new Error(`Falta la variable de entorno ${name}`);
}

const devSecret = randomBytes(32).toString('hex');

export const config = {
  port: Number(process.env.PORT ?? 3001),
  databaseUrl: required('DATABASE_URL', 'postgres://openhr_app:openhr_app@localhost:5432/openhr'),
  migrationDatabaseUrl: process.env.MIGRATION_DATABASE_URL ?? '',
  appDbPassword: process.env.OPENHR_APP_DB_PASSWORD ?? 'openhr_app',
  jwtSecret: required('JWT_SECRET', devSecret),
  // 32 bytes en base64. Si falta en desarrollo se deriva del JWT_SECRET.
  encryptionKey: process.env.ENCRYPTION_KEY ?? '',
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  storageDir: process.env.STORAGE_DIR ?? './storage',
  storage: {
    driver: (process.env.STORAGE_DRIVER ?? 'local') as 'local' | 's3' | 'azure',
    localDir: process.env.STORAGE_DIR ?? './storage',
    s3: {
      bucket: process.env.S3_BUCKET ?? '',
      region: process.env.S3_REGION ?? 'eu-west-1',
      endpoint: process.env.S3_ENDPOINT || undefined,
      accessKeyId: process.env.S3_ACCESS_KEY_ID || undefined,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    },
    azure: {
      container: process.env.AZURE_STORAGE_CONTAINER ?? 'openhr',
      connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || undefined,
      account: process.env.AZURE_STORAGE_ACCOUNT || undefined,
    },
  },
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 1025),
    user: process.env.SMTP_USER ?? '',
    password: process.env.SMTP_PASSWORD ?? '',
    from: process.env.SMTP_FROM ?? 'OpenHR <no-reply@openhr.local>',
  },
  // Cookies solo por HTTPS: por defecto, si la URL pública es https.
  secureCookies: process.env.SECURE_COOKIES ? process.env.SECURE_COOKIES === 'true' : (process.env.PUBLIC_URL ?? '').startsWith('https://'),
  // Si se define, la configuración inicial exige este token (evita que otra persona
  // reclame una instalación recién expuesta a la red).
  setupToken: process.env.SETUP_TOKEN ?? '',
  sessionHours: Number(process.env.SESSION_HOURS ?? 12),
  outboxWorker: process.env.OUTBOX_WORKER !== 'false',
};
