import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import {
  deleteSession, findSessionUser, normalizePhone, OtpError, requestOtp, verifyOtp,
  SESSION_TTL_DAYS, type CurrentUser, type OtpSender,
} from './auth.js';
import type { Db } from './db.js';
import { InvalidPhotoError, MAX_UPLOAD_BYTES, normalizePhoto } from './photo.js';
import { ActiveLimitError, enqueue, type PortraitRow, type QueueOptions } from './queue.js';
import type { Storage } from './storage.js';
import { findStyle, STYLES } from './styles.js';

export interface AppDeps {
  db: Db;
  storage: Storage;
  otpSender: OtpSender;
  queue: QueueOptions;
  secureCookies: boolean;
  /** Built web app to serve (production). Omit in dev, where Vite serves the UI. */
  webDir?: string;
  logger?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: CurrentUser | null;
  }
}

const SESSION_COOKIE = 'sid';

const phoneBody = z.object({ phone: z.string().max(20) });
const verifyBody = z.object({ phone: z.string().max(20), code: z.string().regex(/^\d{6}$/) });
const portraitFields = z.object({
  name: z.string().trim().min(1).max(40),
  style: z.string().refine((s) => findStyle(s) !== undefined, 'Unknown style'),
});

class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function parsePhone(raw: string): string {
  const phone = normalizePhone(raw);
  if (!phone) throw new HttpError(400, 'Enter a valid Vietnamese mobile number');
  return phone;
}

function toDto(p: PortraitRow) {
  return {
    id: p.id,
    name: p.name,
    style: p.style,
    status: p.status,
    // Internal provider errors stay in the database; users get a generic message.
    error: p.status === 'failed' ? 'We could not create this portrait. Please try another photo.' : null,
    imageUrl: p.status === 'succeeded' ? `/api/portraits/${p.id}/image` : null,
    createdAt: p.created_at,
    finishedAt: p.finished_at,
  };
}

export type PortraitDto = ReturnType<typeof toDto>;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: true });
  const { db, storage } = deps;

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4 } });

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    req.user = token ? await findSessionUser(db, token) : null;
  });

  const requireUser = async (req: FastifyRequest) => {
    if (!req.user) throw new HttpError(401, 'Sign in first');
  };

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: err.issues[0]?.message ?? 'Invalid request' });
    }
    if (err instanceof OtpError) {
      if (err.retryAfterSeconds) reply.header('retry-after', err.retryAfterSeconds);
      return reply.status(err.code === 'TOO_SOON' ? 429 : 400).send({ error: err.message, code: err.code });
    }
    if (err instanceof ActiveLimitError) return reply.status(409).send({ error: err.message });
    if (err instanceof InvalidPhotoError) return reply.status(422).send({ error: err.message });
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.status(413).send({ error: 'Photo is larger than 10 MB' });
    if (err instanceof HttpError || (err.statusCode && err.statusCode < 500)) {
      return reply.status(err.statusCode ?? 400).send({ error: err.message });
    }
    req.log.error(err);
    return reply.status(500).send({ error: 'Something went wrong' });
  });

  // ---- health -------------------------------------------------------------
  app.get('/api/health', async () => {
    await db.query('SELECT 1');
    return { ok: true };
  });

  // ---- auth ---------------------------------------------------------------
  app.post('/api/auth/otp', async (req, reply) => {
    const phone = parsePhone(phoneBody.parse(req.body).phone);
    await requestOtp(db, deps.otpSender, phone);
    return reply.status(204).send();
  });

  app.post('/api/auth/verify', async (req, reply) => {
    const body = verifyBody.parse(req.body);
    const session = await verifyOtp(db, parsePhone(body.phone), body.code);
    reply.setCookie(SESSION_COOKIE, session.token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: deps.secureCookies,
      maxAge: SESSION_TTL_DAYS * 24 * 3600,
    });
    return { user: await findSessionUser(db, session.token) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await deleteSession(db, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.get('/api/me', async (req) => ({ user: req.user }));

  // ---- portraits ----------------------------------------------------------
  app.get('/api/styles', async () => ({ styles: STYLES.map(({ id, label }) => ({ id, label })) }));

  app.post('/api/portraits', { preHandler: requireUser }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.isMultipart()) throw new HttpError(415, 'Send the form as multipart/form-data');
    const fields: Record<string, string> = {};
    let photo: Buffer | undefined;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'photo') throw new HttpError(400, `Unexpected file field "${part.fieldname}"`);
        photo = await part.toBuffer();
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }
    if (!photo) throw new HttpError(400, 'Attach a photo');
    const { name, style } = portraitFields.parse(fields);

    const normalized = await normalizePhoto(photo);
    const photoKey = `photos/${req.user!.id}/${randomUUID()}.jpg`;
    await storage.put(photoKey, normalized);
    const portrait = await enqueue(db, { userId: req.user!.id, name, style, photoKey }, deps.queue);
    return reply.status(202).send({ portrait: toDto(portrait) });
  });

  app.get('/api/portraits', { preHandler: requireUser }, async (req) => {
    const { rows } = await db.query<PortraitRow>(
      'SELECT * FROM portraits WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user!.id],
    );
    return { portraits: rows.map(toDto) };
  });

  const loadOwned = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) throw new HttpError(404, 'Portrait not found');
    const { rows } = await db.query<PortraitRow>(
      'SELECT * FROM portraits WHERE id = $1 AND user_id = $2',
      [id.data, req.user!.id],
    );
    // Same 404 for "missing" and "someone else's" so ids cannot be probed.
    if (!rows[0]) throw new HttpError(404, 'Portrait not found');
    return rows[0];
  };

  app.get<{ Params: { id: string } }>('/api/portraits/:id', { preHandler: requireUser }, async (req) => ({
    portrait: toDto(await loadOwned(req)),
  }));

  app.get<{ Params: { id: string } }>('/api/portraits/:id/image', { preHandler: requireUser }, async (req, reply) => {
    const portrait = await loadOwned(req);
    if (!portrait.result_key) throw new HttpError(404, 'Portrait is not ready yet');
    return reply
      .type('image/png')
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(await storage.get(portrait.result_key));
  });

  // ---- web app (production build) -----------------------------------------
  if (deps.webDir && existsSync(deps.webDir)) {
    await app.register(fastifyStatic, { root: deps.webDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
