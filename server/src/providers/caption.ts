import sharp from 'sharp';

export const OUTPUT_SIZE = 1024;

export function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Adds the "Portrait of <name>" caption band at the bottom of a square image. */
export async function addCaption(image: Buffer, name: string): Promise<Buffer> {
  const band = Math.round(OUTPUT_SIZE * 0.12);
  const svg = `<svg width="${OUTPUT_SIZE}" height="${band}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="rgba(17,24,39,0.72)"/>
    <text x="50%" y="62%" text-anchor="middle" font-family="Georgia, serif" font-size="${Math.round(band * 0.42)}"
      fill="#ffffff">Portrait of ${escapeXml(name)}</text>
  </svg>`;
  return sharp(image)
    .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: 'cover', position: 'attention' })
    .composite([{ input: Buffer.from(svg), gravity: 'south' }])
    .png()
    .toBuffer();
}
