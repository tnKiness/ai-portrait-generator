import type { Style } from '../styles.js';

export interface PortraitRequest {
  photo: Buffer;
  name: string;
  style: Style;
}

export interface PortraitProvider {
  readonly id: string;
  /** Returns a square PNG. Must honour `signal` so the worker can cancel on shutdown. */
  generate(request: PortraitRequest, signal: AbortSignal): Promise<Buffer>;
}

/** Errors that will fail the same way on retry (bad input, content policy…). */
export class PermanentProviderError extends Error {}
