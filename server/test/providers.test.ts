import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { normalizePhone } from '../src/auth.js';
import { escapeXml } from '../src/providers/caption.js';
import { MockProvider } from '../src/providers/mock.js';
import { OpenAiProvider } from '../src/providers/openai.js';
import { PermanentProviderError } from '../src/providers/types.js';
import { STYLES } from '../src/styles.js';
import { samplePhoto } from './helpers.js';

const signal = new AbortController().signal;

describe('MockProvider', () => {
  it.each(STYLES)('renders a 1024² PNG for $id', async (style) => {
    const out = await new MockProvider().generate({ photo: await samplePhoto(), name: 'An', style }, signal);
    expect(await sharp(out).metadata()).toMatchObject({ width: 1024, height: 1024, format: 'png' });
  });

  it('can be cancelled', async () => {
    const ctrl = new AbortController();
    const pending = new MockProvider(5_000).generate({ photo: await samplePhoto(), name: 'An', style: STYLES[0] }, ctrl.signal);
    ctrl.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe('OpenAiProvider', () => {
  const make = (res: Response) => new OpenAiProvider({ apiKey: 'test', model: 'gpt-image-1', fetch: async () => res });

  it('decodes the returned image and adds the caption', async () => {
    const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#88aacc' } }).png().toBuffer();
    const provider = make(Response.json({ data: [{ b64_json: png.toString('base64') }] }));
    const out = await provider.generate({ photo: await samplePhoto(), name: 'An', style: STYLES[1] }, signal);
    expect(await sharp(out).metadata()).toMatchObject({ width: 1024, height: 1024 });
  });

  it('treats 4xx as permanent and 5xx / 429 as retryable', async () => {
    const req = { photo: await samplePhoto(), name: 'An', style: STYLES[0] };
    await expect(make(new Response('bad', { status: 400 })).generate(req, signal)).rejects.toBeInstanceOf(PermanentProviderError);
    for (const status of [429, 503]) {
      const err = await make(new Response('busy', { status })).generate(req, signal).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(PermanentProviderError);
    }
  });
});

describe('helpers', () => {
  it('escapes user text before putting it in SVG', () => {
    expect(escapeXml('<b>"Tom" & \'Jerry\'</b>')).not.toMatch(/[<>"']/);
  });

  it.each([
    ['0912345678', '+84912345678'],
    ['+84 912 345 678', '+84912345678'],
    ['84912345678', '+84912345678'],
    ['0212345678', null],
    ['091234567', null],
  ])('normalizes %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });
});
