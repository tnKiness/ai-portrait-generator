import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import { createPool, migrate, type Db } from '../src/db.js';
import { LocalStorage } from '../src/storage.js';
import type { OtpSender } from '../src/auth.js';

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://portrait:portrait@localhost:5432/postgres';

export interface TestDb {
  db: Db;
  drop(): Promise<void>;
}

/** Creates an isolated, migrated database so test files can run in parallel. */
export async function createTestDb(): Promise<TestDb> {
  const name = `test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const db = createPool(url.toString());
  await migrate(db);

  return {
    db,
    async drop() {
      await db.end();
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

export async function createTempStorage() {
  const dir = await mkdtemp(join(tmpdir(), 'portrait-test-'));
  return { storage: new LocalStorage(dir), dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Captures OTP codes instead of sending them. */
export class CapturingOtpSender implements OtpSender {
  readonly codes = new Map<string, string>();
  async send(phone: string, code: string) {
    this.codes.set(phone, code);
  }
}

export function samplePhoto(width = 600, height = 800): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 180, g: 120, b: 90 } } })
    .jpeg()
    .toBuffer();
}

export async function createUser(db: Db, phone = '+84901234567'): Promise<string> {
  const { rows } = await db.query<{ id: string }>('INSERT INTO users (phone) VALUES ($1) RETURNING id', [phone]);
  return rows[0]!.id;
}
