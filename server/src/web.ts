import { join } from 'node:path';
import { buildApp } from './app.js';
import { ConsoleOtpSender } from './auth.js';
import { createPool, migrate } from './db.js';
import { loadEnv } from './env.js';
import { LocalStorage } from './storage.js';

const env = loadEnv();
const db = createPool(env.DATABASE_URL);
await migrate(db);

const app = await buildApp({
  db,
  storage: new LocalStorage(env.STORAGE_DIR),
  otpSender: new ConsoleOtpSender(),
  queue: { maxActivePerUser: env.MAX_ACTIVE_JOBS_PER_USER, maxAttempts: env.JOB_MAX_ATTEMPTS },
  secureCookies: env.NODE_ENV === 'production',
  webDir: join(import.meta.dirname, '..', '..', 'web', 'dist'),
  logger: true,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await db.end();
  });
}

await app.listen({ host: env.HOST, port: env.PORT });
