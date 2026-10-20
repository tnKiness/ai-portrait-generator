import type { Db, Queryable } from './db.js';
import { withTransaction } from './db.js';

export type PortraitStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface PortraitRow {
  id: string;
  user_id: string;
  name: string;
  style: string;
  photo_key: string;
  result_key: string | null;
  status: PortraitStatus;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  lease_token: string | null;
  lease_expires_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

export interface NewPortrait {
  userId: string;
  name: string;
  style: string;
  photoKey: string;
}

export interface QueueOptions {
  maxActivePerUser: number;
  maxAttempts: number;
}

export class ActiveLimitError extends Error {
  constructor(readonly limit: number) {
    super(`You already have ${limit} portraits in progress`);
  }
}

/** A claimed job. `leaseToken` is the fencing token every later write must present. */
export type ClaimedJob = PortraitRow & { lease_token: string };

/**
 * Enqueues a portrait unless the user already has `maxActivePerUser` jobs queued or running.
 * A per-user advisory lock serialises the count-then-insert so two parallel requests
 * cannot both slip under the limit.
 */
export async function enqueue(db: Db, input: NewPortrait, opts: QueueOptions): Promise<PortraitRow> {
  return withTransaction(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`portrait-user:${input.userId}`]);
    const { rows } = await tx.query<{ active: number }>(
      `SELECT count(*)::int AS active FROM portraits
       WHERE user_id = $1 AND status IN ('queued', 'running')`,
      [input.userId],
    );
    if (rows[0]!.active >= opts.maxActivePerUser) throw new ActiveLimitError(opts.maxActivePerUser);
    const inserted = await tx.query<PortraitRow>(
      `INSERT INTO portraits (user_id, name, style, photo_key, max_attempts)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.userId, input.name, input.style, input.photoKey, opts.maxAttempts],
    );
    return inserted.rows[0]!;
  });
}

/**
 * Atomically claims the oldest runnable job. `FOR UPDATE SKIP LOCKED` lets many workers
 * poll the same table without blocking each other or claiming the same row twice.
 */
export async function claim(db: Queryable, leaseSeconds: number): Promise<ClaimedJob | null> {
  const { rows } = await db.query<ClaimedJob>(
    `UPDATE portraits SET
       status = 'running',
       attempts = attempts + 1,
       lease_token = gen_random_uuid(),
       lease_expires_at = now() + make_interval(secs => $1),
       updated_at = now()
     WHERE id = (
       SELECT id FROM portraits
       WHERE status = 'queued' AND run_after <= now()
       ORDER BY run_after, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [leaseSeconds],
  );
  return rows[0] ?? null;
}

/** Extends a lease while a long generation is still running. Returns false if the lease was lost. */
export async function heartbeat(db: Queryable, job: ClaimedJob, leaseSeconds: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE portraits SET lease_expires_at = now() + make_interval(secs => $3), updated_at = now()
     WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [job.id, job.lease_token, leaseSeconds],
  );
  return rowCount === 1;
}

/**
 * Marks a job done. The lease token acts as a fencing token: a worker whose lease expired
 * (and whose job was handed to someone else) can no longer overwrite the result.
 */
export async function complete(db: Queryable, job: ClaimedJob, resultKey: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE portraits SET
       status = 'succeeded', result_key = $3, last_error = NULL,
       lease_token = NULL, lease_expires_at = NULL, finished_at = now(), updated_at = now()
     WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [job.id, job.lease_token, resultKey],
  );
  return rowCount === 1;
}

/** Exponential backoff: 5s, 10s, 20s… capped at 5 minutes. */
export function retryDelaySeconds(attempt: number): number {
  return Math.min(5 * 2 ** Math.max(attempt - 1, 0), 300);
}

/**
 * Records a failed attempt: re-queues with backoff, or fails permanently once attempts
 * are exhausted or the error is not retryable.
 */
export async function fail(
  db: Queryable,
  job: ClaimedJob,
  error: string,
  { retryable = true }: { retryable?: boolean } = {},
): Promise<PortraitStatus | null> {
  const { rows } = await db.query<{ status: PortraitStatus }>(
    `UPDATE portraits SET
       status = CASE WHEN $4 AND attempts < max_attempts THEN 'queued' ELSE 'failed' END::portrait_status,
       run_after = now() + make_interval(secs => $5),
       finished_at = CASE WHEN $4 AND attempts < max_attempts THEN NULL ELSE now() END,
       last_error = left($3, 1000),
       lease_token = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE id = $1 AND lease_token = $2 AND status = 'running'
     RETURNING status`,
    [job.id, job.lease_token, error, retryable, retryDelaySeconds(job.attempts)],
  );
  return rows[0]?.status ?? null;
}

/**
 * Recovers jobs whose worker died mid-run (lease expired without complete/fail).
 * Returns how many jobs were re-queued or failed.
 */
export async function reclaimExpired(db: Queryable): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE portraits SET
       status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END::portrait_status,
       finished_at = CASE WHEN attempts < max_attempts THEN NULL ELSE now() END,
       last_error = 'Worker lease expired',
       lease_token = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE status = 'running' AND lease_expires_at < now()`,
  );
  return rowCount ?? 0;
}
