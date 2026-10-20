import sharp, { type Metadata } from 'sharp';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp']);
const MIN_SIDE = 256;
const MAX_SIDE = 2048;

export class InvalidPhotoError extends Error {}

/**
 * Validates an uploaded photo by decoding it (never trusting the file name or MIME type),
 * applies EXIF rotation, strips metadata (GPS, camera info) and re-encodes to a bounded JPEG.
 */
export async function normalizePhoto(input: Buffer): Promise<Buffer> {
  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new InvalidPhotoError('File is not a readable image');
  }
  if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) {
    throw new InvalidPhotoError('Only JPEG, PNG or WebP photos are accepted');
  }
  const width = meta.autoOrient?.width ?? meta.width ?? 0;
  const height = meta.autoOrient?.height ?? meta.height ?? 0;
  if (Math.min(width, height) < MIN_SIDE) {
    throw new InvalidPhotoError(`Photo must be at least ${MIN_SIDE}px on each side`);
  }
  return sharp(input)
    .rotate()
    .resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}
