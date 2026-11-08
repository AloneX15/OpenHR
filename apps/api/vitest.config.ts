import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // Los tests de integración comparten una base de datos: se ejecutan en serie.
    fileParallelism: false,
    testTimeout: 30000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://openhr_app:openhr_app@localhost:5434/openhr_test',
      MIGRATION_DATABASE_URL: process.env.TEST_MIGRATION_DATABASE_URL ?? 'postgres://openhr_owner:openhr_owner@localhost:5434/openhr_test',
      OPENHR_APP_DB_PASSWORD: 'openhr_app',
      JWT_SECRET: 'test-secret-test-secret-test-secret-123',
      OUTBOX_WORKER: 'false',
      STORAGE_DIR: './.test-storage',
      PUBLIC_URL: 'http://localhost:3000',
      // Claves VAPID solo para los tests.
      VAPID_PUBLIC_KEY: 'BMivgr7ioWu1ZvY0BfSahhHb3jHzQwBm9Sybfou5-A37eIWQ00nVUWPznU8fI5YGILbcockGwYPMFhMDm1XNScM',
      VAPID_PRIVATE_KEY: 'aoRTYXKt_gnQNsayeo0OxsmX4oMamn28ei_98BDThtI',
    },
    hookTimeout: 60000,
  },
});
