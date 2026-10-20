import type { Env } from '../env.js';
import { MockProvider } from './mock.js';
import { OpenAiProvider } from './openai.js';
import type { PortraitProvider } from './types.js';

export function createProvider(env: Env): PortraitProvider {
  switch (env.IMAGE_PROVIDER) {
    case 'openai':
      return new OpenAiProvider({ apiKey: env.OPENAI_API_KEY!, model: env.OPENAI_IMAGE_MODEL });
    case 'mock':
      return new MockProvider(1500);
  }
}

export type { PortraitProvider } from './types.js';
