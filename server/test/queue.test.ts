import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ActiveLimitError, claim, complete, enqueue, fail, heartbeat, reclaimExpired, retryDelaySeconds,
} from '../src/queue.js';
import { createTestDb, createUser, type TestDb } from './helpers.js';

const opts = { maxActivePerUser: 2, maxAttempts: 3 };
let t: TestDb;
let userId: string;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.drop());
beforeEach(async () => {
  await t.db.query('TRUNCATE portraits, users RESTART IDENTITY CASCADE');
  userId = await createUser(t.db);
});

const newJob = (name = 'An') => ({ userId, name, style: 'sketch', photoKey: 'photos/x.jpg' });

describe('enqueue', () => {
  it('enforces the per-user active limit', async () => {
    await enqueue(t.db, newJob(), opts);
    await enqueue(t.db, newJob(), opts);
    await expect(enqueue(t.db, newJob(), opts)).rejects.toBeInstanceOf(ActiveLimitError);
  });

  it('holds the limit under concurrent requests', async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => enqueue(t.db, newJob(), opts)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
  });

  it('frees a slot once a job finishes', async () => {
    await enqueue(t.db, newJob(), opts);
    await enqueue(t.db, newJob(), opts);
    const job = (await claim(t.db, 60))!;
    await complete(t.db, job, 'portraits/done.png');
    await expect(enqueue(t.db, newJob(), opts)).resolves.toMatchObject({ status: 'queued' });
  });
});

describe('claim', () => {
  it('never hands the same job to two workers', async () => {
    const others = await Promise.all([createUser(t.db, '+84901111111'), createUser(t.db, '+84902222222')]);
    for (const id of [userId, ...others]) {
      await enqueue(t.db, { ...newJob(), userId: id }, opts);
      await enqueue(t.db, { ...newJob(), userId: id }, opts);
    }
    const claims = await Promise.all(Array.from({ length: 10 }, () => claim(t.db, 60)));
    const ids = claims.filter((c) => c !== null).map((c) => c!.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  it('returns null when nothing is runnable', async () => {
    expect(await claim(t.db, 60)).toBeNull();
  });
});

describe('fencing', () => {
  it('rejects writes from a worker whose lease was taken over', async () => {
    await enqueue(t.db, newJob(), opts);
    const first = (await claim(t.db, 60))!;
    await t.db.query("UPDATE portraits SET lease_expires_at = now() - interval '1 second'");
    expect(await reclaimExpired(t.db)).toBe(1);
    const second = (await claim(t.db, 60))!;
    expect(second.id).toBe(first.id);

    expect(await heartbeat(t.db, first, 60)).toBe(false);
    expect(await complete(t.db, first, 'portraits/stale.png')).toBe(false);
    expect(await complete(t.db, second, 'portraits/fresh.png')).toBe(true);

    const { rows } = await t.db.query('SELECT status, result_key, attempts FROM portraits');
    expect(rows[0]).toEqual({ status: 'succeeded', result_key: 'portraits/fresh.png', attempts: 2 });
  });
});

describe('retries', () => {
  it('re-queues with backoff and fails after max attempts', async () => {
    await enqueue(t.db, newJob(), opts);
    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
      await t.db.query('UPDATE portraits SET run_after = now()');
      const job = (await claim(t.db, 60))!;
      expect(job.attempts).toBe(attempt);
      const status = await fail(t.db, job, `boom ${attempt}`);
      expect(status).toBe(attempt < opts.maxAttempts ? 'queued' : 'failed');
    }
    const { rows } = await t.db.query('SELECT status, last_error, finished_at FROM portraits');
    expect(rows[0]).toMatchObject({ status: 'failed', last_error: 'boom 3' });
    expect(rows[0].finished_at).not.toBeNull();
  });

  it('does not retry permanent errors', async () => {
    await enqueue(t.db, newJob(), opts);
    const job = (await claim(t.db, 60))!;
    expect(await fail(t.db, job, 'bad input', { retryable: false })).toBe('failed');
  });

  it('waits for the backoff before a retry is claimable', async () => {
    await enqueue(t.db, newJob(), opts);
    await fail(t.db, (await claim(t.db, 60))!, 'transient');
    expect(await claim(t.db, 60)).toBeNull();
  });

  it('backs off exponentially with a cap', () => {
    expect([1, 2, 3, 4].map(retryDelaySeconds)).toEqual([5, 10, 20, 40]);
    expect(retryDelaySeconds(20)).toBe(300);
  });
});
