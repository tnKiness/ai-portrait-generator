/**
 * Renders docs/styles.png: the input photo followed by one portrait per style (mock provider).
 * Usage: npx tsx scripts/render-samples.ts <photo.jpg>
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { MockProvider } from '../src/providers/mock.js';
import { STYLES } from '../src/styles.js';

const TILE = 512;
const GAP = 24;

const photoPath = process.argv[2];
if (!photoPath) throw new Error('Usage: render-samples.ts <photo>');
const photo = await readFile(photoPath);

const tiles = [await sharp(photo).resize(TILE, TILE, { fit: 'cover', position: 'attention' }).png().toBuffer()];
for (const style of STYLES) {
  const out = await new MockProvider().generate({ photo, name: 'Linh', style }, new AbortController().signal);
  tiles.push(await sharp(out).resize(TILE, TILE).png().toBuffer());
}

const strip = await sharp({
  create: { width: TILE * tiles.length + GAP * (tiles.length - 1), height: TILE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite(tiles.map((input, i) => ({ input, left: i * (TILE + GAP), top: 0 })))
  .png()
  .toBuffer();

const target = join(import.meta.dirname, '..', '..', 'docs', 'styles.png');
await writeFile(target, strip);
console.log(`Wrote ${target}`);
