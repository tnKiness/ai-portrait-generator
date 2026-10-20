import sharp, { type Sharp } from 'sharp';
import { setTimeout as sleep } from 'node:timers/promises';
import { addCaption, OUTPUT_SIZE } from './caption.js';
import type { PortraitProvider, PortraitRequest } from './types.js';

/**
 * Offline provider: applies a deterministic image filter per style instead of calling a model.
 * Lets the whole pipeline (queue, worker, storage, UI) run locally and in CI with no API key.
 */
export class MockProvider implements PortraitProvider {
  readonly id = 'mock';

  constructor(private readonly delayMs = 0) {}

  async generate({ photo, name, style }: PortraitRequest, signal: AbortSignal): Promise<Buffer> {
    if (this.delayMs) await sleep(this.delayMs, undefined, { signal });
    const base = sharp(photo).resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: 'cover', position: 'attention' });
    let styled: Sharp;
    switch (style.id) {
      case 'pop-art':
        styled = base.modulate({ saturation: 2.2, brightness: 1.05 }).linear(1.4, -40).median(5);
        break;
      case 'sketch':
        styled = base.greyscale().normalise().sharpen({ sigma: 2 }).linear(1.3, 10);
        break;
      default:
        styled = base.modulate({ saturation: 0.75, brightness: 1.1 }).blur(1.2).tint({ r: 255, g: 236, b: 214 });
    }
    signal.throwIfAborted();
    return addCaption(await styled.png().toBuffer(), name);
  }
}
