import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Db, Queryable } from './db.js';
import { withTransaction } from './db.js';

export const OTP_TTL_SECONDS = 5 * 60;
export const OTP_RESEND_SECONDS = 60;
export const OTP_MAX_ATTEMPTS = 5;
export const SESSION_TTL_DAYS = 30;

/** Delivers a one-time code. Production would use SMS/Zalo/etc.; dev logs it to the console. */
export interface OtpSender {
  send(phone: string, code: string): Promise<void>;
}

export class ConsoleOtpSender implements OtpSender {
  async send(phone: string, code: string): Promise<void> {
    console.info(`[otp] code for ${phone}: ${code}`);
  }
}

export class OtpError extends Error {
  constructor(
    readonly code: 'TOO_SOON' | 'INVALID' | 'EXPIRED' | 'TOO_MANY_ATTEMPTS',
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Accepts Vietnamese numbers in local (0xxxxxxxxx) or international (+84xxxxxxxxx) form. */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[\s.-]/g, '');
  const match = /^(?:\+?84|0)([35789]\d{8})$/.exec(digits);
  return match ? `+84${match[1]}` : null;
}

export async function requestOtp(db: Db, sender: OtpSender, phone: string): Promise<void> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await withTransaction(db, async (tx) => {
    // Serialise per phone so the resend cooldown cannot be raced.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`otp:${phone}`]);
    const { rows } = await tx.query<{ wait: number }>(
      `SELECT ceil(extract(epoch FROM created_at + make_interval(secs => $2) - now()))::int AS wait
       FROM otp_codes WHERE phone = $1 ORDER BY created_at DESC LIMIT 1`,
      [phone, OTP_RESEND_SECONDS],
    );
    const wait = rows[0]?.wait ?? 0;
    if (wait > 0) throw new OtpError('TOO_SOON', 'Please wait before requesting a new code', wait);
    // A new code invalidates any previous one.
    await tx.query('UPDATE otp_codes SET consumed_at = now() WHERE phone = $1 AND consumed_at IS NULL', [phone]);
    await tx.query(
      `INSERT INTO otp_codes (phone, code_hash, expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3))`,
      [phone, sha256(`${phone}:${code}`), OTP_TTL_SECONDS],
    );
  });
  await sender.send(phone, code);
}

export interface Session {
  token: string;
  userId: string;
  expiresAt: Date;
}

/** Verifies a code and, on success, upserts the user and opens a session. */
export async function verifyOtp(db: Db, phone: string, code: string): Promise<Session> {
  // The transaction returns failures instead of throwing them, so that a wrong guess
  // still commits the incremented attempt counter.
  const result = await withTransaction(db, async (tx): Promise<Session | OtpError> => {
    const { rows } = await tx.query<{ id: string; code_hash: string; attempts: number; expired: boolean }>(
      `SELECT id, code_hash, attempts, expires_at < now() AS expired
       FROM otp_codes WHERE phone = $1 AND consumed_at IS NULL
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [phone],
    );
    const otp = rows[0];
    if (!otp) return new OtpError('INVALID', 'Request a code first');
    if (otp.expired) return new OtpError('EXPIRED', 'Code expired, request a new one');
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      return new OtpError('TOO_MANY_ATTEMPTS', 'Too many attempts, request a new code');
    }

    const expected = Buffer.from(otp.code_hash, 'hex');
    const actual = Buffer.from(sha256(`${phone}:${code}`), 'hex');
    if (!timingSafeEqual(expected, actual)) {
      await tx.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
      return new OtpError('INVALID', 'Incorrect code');
    }

    await tx.query('UPDATE otp_codes SET consumed_at = now() WHERE id = $1', [otp.id]);
    const user = await tx.query<{ id: string }>(
      `INSERT INTO users (phone) VALUES ($1)
       ON CONFLICT (phone) DO UPDATE SET phone = excluded.phone RETURNING id`,
      [phone],
    );
    return createSession(tx, user.rows[0]!.id);
  });
  if (result instanceof OtpError) throw result;
  return result;
}

async function createSession(db: Queryable, userId: string): Promise<Session> {
  const token = randomBytes(32).toString('base64url');
  const { rows } = await db.query<{ expires_at: Date }>(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3)) RETURNING expires_at`,
    [sha256(token), userId, SESSION_TTL_DAYS],
  );
  return { token, userId, expiresAt: rows[0]!.expires_at };
}

export interface CurrentUser {
  id: string;
  phone: string;
}

export async function findSessionUser(db: Queryable, token: string): Promise<CurrentUser | null> {
  const { rows } = await db.query<CurrentUser>(
    `SELECT u.id, u.phone FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

export async function deleteSession(db: Queryable, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}
