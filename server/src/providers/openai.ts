import { addCaption } from './caption.js';
import { PermanentProviderError, type PortraitProvider, type PortraitRequest } from './types.js';

interface OpenAiOptions {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}

/** Calls the OpenAI image edit endpoint with the user's photo as the reference image. */
export class OpenAiProvider implements PortraitProvider {
  readonly id = 'openai';
  private readonly fetch: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly opts: OpenAiOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';
  }

  async generate({ photo, name, style }: PortraitRequest, signal: AbortSignal): Promise<Buffer> {
    const form = new FormData();
    form.set('model', this.opts.model);
    form.set('size', '1024x1024');
    form.set(
      'prompt',
      `${style.prompt} Keep the person's face, hair and outfit recognisable. ` +
        'Do not add any text, letters or watermarks.',
    );
    form.set('image', new Blob([new Uint8Array(photo)], { type: 'image/jpeg' }), 'photo.jpg');

    const res = await this.fetch(`${this.baseUrl}/images/edits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.apiKey}` },
      body: form,
      signal,
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      const message = `OpenAI ${res.status}: ${detail}`;
      // 4xx (except rate limiting) will not succeed on retry.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new PermanentProviderError(message);
      throw new Error(message);
    }
    const body = (await res.json()) as { data?: { b64_json?: string }[] };
    const b64 = body.data?.[0]?.b64_json;
    if (!b64) throw new Error('OpenAI response did not include an image');
    // Text rendered by image models is unreliable, so the caption is drawn locally.
    return addCaption(Buffer.from(b64, 'base64'), name);
  }
}
