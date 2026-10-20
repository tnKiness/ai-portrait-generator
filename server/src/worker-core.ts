import { setTimeout as sleep } from 'node:timers/promises';
import type { Db } from './db.js';
import { PermanentProviderError, type PortraitProvider } from './providers/types.js';
import { claim, complete, fail, heartbeat, reclaimExpired, type ClaimedJob } from './queue.js';
import type { Storage } from './storage.js';
import { findStyle } from './styles.js';

export interface WorkerDeps {
  db: Db;
  storage: Storage;
  provider: PortraitProvider;
  leaseSeconds: number;
  log?: (message: string) => void;
}

/** Claims and processes one job. Returns false when the queue is empty. */
export async function processNext(deps: WorkerDeps, signal: AbortSignal = new AbortController().signal): Promise<boolean> {
  const job = await claim(deps.db, deps.leaseSeconds);
  if (!job) return false;
  await runJob(deps, job, signal);
  return true;
}

async function runJob(deps: WorkerDeps, job: ClaimedJob, signal: AbortSignal): Promise<void> {
  const log = deps.log ?? (() => undefined);
  const started = Date.now();

  // Keep the lease alive while the provider works; abort if we lose it.
  const lost = new AbortController();
  const jobSignal = AbortSignal.any([signal, lost.signal]);
  const beat = setInterval(() => {
    heartbeat(deps.db, job, deps.leaseSeconds)
      .then((ok) => { if (!ok) lost.abort(new Error('Lease lost')); })
      .catch(() => undefined);
  }, (deps.leaseSeconds * 1000) / 3);

  try {
    const style = findStyle(job.style);
    if (!style) throw new PermanentProviderError(`Unknown style ${job.style}`);
    const photo = await deps.storage.get(job.photo_key);
    const image = await deps.provider.generate({ photo, name: job.name, style }, jobSignal);
    const resultKey = `portraits/${job.user_id}/${job.id}.png`;
    await deps.storage.put(resultKey, image);
    const ok = await complete(deps.db, job, resultKey);
    log(ok
      ? `job ${job.id} succeeded in ${Date.now() - started}ms`
      : `job ${job.id} finished after its lease was lost; result discarded`);
  } catch (err) {
    if (lost.signal.aborted) {
      log(`job ${job.id} abandoned: lease lost`);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    // Shutdown aborts are retryable too: another worker picks the job up after backoff.
    const status = await fail(deps.db, job, message, { retryable: !(err instanceof PermanentProviderError) });
    log(`job ${job.id} attempt ${job.attempts} failed (${message}) -> ${status ?? 'lease lost'}`);
  } finally {
    clearInterval(beat);
  }
}

export interface RunOptions {
  concurrency: number;
  idleDelayMs?: number;
  reclaimEveryMs?: number;
}

/**
 * Runs `concurrency` polling loops until `signal` aborts, then waits for in-flight jobs.
 * Jobs interrupted by shutdown are re-queued by `fail` (they count as an attempt).
 */
export async function runWorker(deps: WorkerDeps, opts: RunOptions, signal: AbortSignal): Promise<void> {
  const idle = opts.idleDelayMs ?? 1000;
  const log = deps.log ?? (() => undefined);

  const reclaimer = setInterval(() => {
    reclaimExpired(deps.db)
      .then((n) => { if (n) log(`reclaimed ${n} expired job(s)`); })
      .catch((err: Error) => log(`reclaim failed: ${err.message}`));
  }, opts.reclaimEveryMs ?? 30_000);

  const loop = async () => {
    while (!signal.aborted) {
      try {
        if (!(await processNext(deps, signal))) await sleep(idle, undefined, { signal }).catch(() => undefined);
      } catch (err) {
        log(`worker loop error: ${(err as Error).message}`);
        await sleep(idle, undefined, { signal }).catch(() => undefined);
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: opts.concurrency }, loop));
  } finally {
    clearInterval(reclaimer);
  }
}
