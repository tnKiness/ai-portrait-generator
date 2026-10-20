import { createPool, migrate } from './db.js';
import { loadEnv } from './env.js';
import { createProvider } from './providers/index.js';
import { LocalStorage } from './storage.js';
import { runWorker } from './worker-core.js';

const env = loadEnv();
const db = createPool(env.DATABASE_URL);
await migrate(db);

const provider = createProvider(env);
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.info(`[worker] ${signal} received, finishing in-flight jobs…`);
    shutdown.abort();
  });
}

console.info(`[worker] started: provider=${provider.id} concurrency=${env.WORKER_CONCURRENCY}`);
await runWorker(
  {
    db,
    storage: new LocalStorage(env.STORAGE_DIR),
    provider,
    leaseSeconds: env.JOB_LEASE_SECONDS,
    log: (m) => console.info(`[worker] ${m}`),
  },
  { concurrency: env.WORKER_CONCURRENCY },
  shutdown.signal,
);
await db.end();
console.info('[worker] stopped');
