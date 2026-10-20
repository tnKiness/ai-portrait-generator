import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { buildApp } from '../src/app.js';
import { OTP_MAX_ATTEMPTS } from '../src/auth.js';
import { MockProvider } from '../src/providers/mock.js';
import { processNext } from '../src/worker-core.js';
import { CapturingOtpSender, createTempStorage, createTestDb, samplePhoto, type TestDb } from './helpers.js';

let t: TestDb;
let app: FastifyInstance;
let tmp: Awaited<ReturnType<typeof createTempStorage>>;
const otp = new CapturingOtpSender();

beforeAll(async () => {
  t = await createTestDb();
  tmp = await createTempStorage();
  app = await buildApp({
    db: t.db,
    storage: tmp.storage,
    otpSender: otp,
    queue: { maxActivePerUser: 2, maxAttempts: 3 },
    secureCookies: false,
  });
});
afterAll(async () => {
  await app.close();
  await t.drop();
  await tmp.cleanup();
});

async function signIn(phone: string): Promise<string> {
  const req = await app.inject({ method: 'POST', url: '/api/auth/otp', payload: { phone } });
  expect(req.statusCode).toBe(204);
  const normalized = `+84${phone.slice(1)}`;
  const res = await app.inject({
    method: 'POST', url: '/api/auth/verify', payload: { phone, code: otp.codes.get(normalized) },
  });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === 'sid')!;
  expect(cookie.httpOnly).toBe(true);
  return `sid=${cookie.value}`;
}

function multipart(fields: Record<string, string>, photo?: Buffer) {
  const boundary = '----portrait-test';
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (photo) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="me.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
    ));
    chunks.push(photo, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('auth', () => {
  it('rejects invalid phone numbers', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/otp', payload: { phone: '12345' } });
    expect(res.statusCode).toBe(400);
  });

  it('enforces the resend cooldown', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/otp', payload: { phone: '0911000001' } });
    const again = await app.inject({ method: 'POST', url: '/api/auth/otp', payload: { phone: '0911000001' } });
    expect(again.statusCode).toBe(429);
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('locks a code after too many wrong guesses', async () => {
    const phone = '0911000002';
    await app.inject({ method: 'POST', url: '/api/auth/otp', payload: { phone } });
    const real = otp.codes.get('+84911000002')!;
    const wrong = real === '000000' ? '111111' : '000000';
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { phone, code: wrong } });
      expect(res.json()).toMatchObject({ code: 'INVALID' });
    }
    const res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { phone, code: real } });
    expect(res.json()).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
  });

  it('signs in and out', async () => {
    const cookie = await signIn('0911000003');
    const me = await app.inject({ url: '/api/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ user: { phone: '+84911000003' } });
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    const after = await app.inject({ url: '/api/me', headers: { cookie } });
    expect(after.json()).toEqual({ user: null });
  });
});

describe('portraits', () => {
  it('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/portraits' });
    expect(res.statusCode).toBe(401);
  });

  it('runs the full flow: upload → queue → worker → image', async () => {
    const cookie = await signIn('0922000001');
    const form = multipart({ name: 'Linh', style: 'watercolor' }, await samplePhoto());
    const created = await app.inject({ method: 'POST', url: '/api/portraits', headers: { cookie, ...form.headers }, payload: form.payload });
    expect(created.statusCode).toBe(202);
    const { portrait } = created.json();
    expect(portrait).toMatchObject({ name: 'Linh', status: 'queued', imageUrl: null });

    const worked = await processNext({ db: t.db, storage: tmp.storage, provider: new MockProvider(), leaseSeconds: 30 });
    expect(worked).toBe(true);

    const fetched = await app.inject({ url: `/api/portraits/${portrait.id}`, headers: { cookie } });
    expect(fetched.json().portrait).toMatchObject({ status: 'succeeded', imageUrl: `/api/portraits/${portrait.id}/image` });

    const image = await app.inject({ url: `/api/portraits/${portrait.id}/image`, headers: { cookie } });
    expect(image.headers['content-type']).toBe('image/png');
    expect(await sharp(image.rawPayload).metadata()).toMatchObject({ width: 1024, height: 1024, format: 'png' });
  });

  it('hides other users\' portraits', async () => {
    const owner = await signIn('0922000002');
    const form = multipart({ name: 'Minh', style: 'sketch' }, await samplePhoto());
    const { portrait } = (await app.inject({ method: 'POST', url: '/api/portraits', headers: { cookie: owner, ...form.headers }, payload: form.payload })).json();

    const stranger = await signIn('0922000003');
    const res = await app.inject({ url: `/api/portraits/${portrait.id}`, headers: { cookie: stranger } });
    expect(res.statusCode).toBe(404);
    const list = await app.inject({ url: '/api/portraits', headers: { cookie: stranger } });
    expect(list.json().portraits).toEqual([]);
  });

  it('returns 409 above the active job limit', async () => {
    const cookie = await signIn('0922000004');
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const form = multipart({ name: `N${i}`, style: 'pop-art' }, await samplePhoto());
      statuses.push((await app.inject({ method: 'POST', url: '/api/portraits', headers: { cookie, ...form.headers }, payload: form.payload })).statusCode);
    }
    expect(statuses).toEqual([202, 202, 409]);
  });

  it('validates the upload', async () => {
    const cookie = await signIn('0922000005');
    const cases: [Record<string, string>, Buffer | undefined, number][] = [
      [{ name: 'A', style: 'watercolor' }, undefined, 400],
      [{ name: 'A', style: 'cubism' }, await samplePhoto(), 400],
      [{ name: '', style: 'watercolor' }, await samplePhoto(), 400],
      [{ name: 'A', style: 'watercolor' }, Buffer.from('not an image'), 422],
      [{ name: 'A', style: 'watercolor' }, await samplePhoto(100, 100), 422],
    ];
    for (const [fields, photo, expected] of cases) {
      const form = multipart(fields, photo);
      const res = await app.inject({ method: 'POST', url: '/api/portraits', headers: { cookie, ...form.headers }, payload: form.payload });
      expect(res.statusCode, JSON.stringify(fields)).toBe(expected);
    }
  });
});
