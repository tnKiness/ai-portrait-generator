import { createPool, migrate } from './db.js';
import { loadEnv } from './env.js';

const env = loadEnv();
const db = createPool(env.DATABASE_URL);
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
await db.end();
