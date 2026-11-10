import { ApiError, type Portrait, type Style, type User } from './api';

/**
 * In-browser stand-in for the API, used by the GitHub Pages build (VITE_DEMO=1), which has
 * no server. It mirrors the server's behaviour that matters for the UI: OTP sign-in, the
 * per-user active-job limit, and queued → running → succeeded transitions. Portraits are
 * rendered with canvas filters instead of an AI model.
 */

const STYLES: Style[] = [
  { id: 'watercolor', label: 'Watercolor' },
  { id: 'pop-art', label: 'Pop art' },
  { id: 'sketch', label: 'Pencil sketch' },
];
const FILTERS: Record<string, string> = {
  watercolor: 'saturate(0.75) brightness(1.1) sepia(0.15) blur(1.5px)',
  'pop-art': 'saturate(2.2) contrast(1.4) brightness(1.05)',
  sketch: 'grayscale(1) contrast(1.6) brightness(1.1)',
};
const MAX_ACTIVE = 2;
const SIZE = 1024;

let user: User | null = null;
const portraits: Portrait[] = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function render(photo: File, name: string, style: string): Promise<string> {
  const bitmap = await createImageBitmap(photo);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  // Centre-crop to a square, like the server's `fit: cover`.
  const side = Math.min(bitmap.width, bitmap.height);
  ctx.filter = FILTERS[style] ?? 'none';
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
  ctx.filter = 'none';
  const band = Math.round(SIZE * 0.12);
  ctx.fillStyle = 'rgba(17,24,39,0.72)';
  ctx.fillRect(0, SIZE - band, SIZE, band);
  ctx.fillStyle = '#fff';
  ctx.font = `${Math.round(band * 0.42)}px Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`Portrait of ${name}`, SIZE / 2, SIZE - band / 2);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
  return URL.createObjectURL(blob);
}

function update(id: string, patch: Partial<Portrait>) {
  const p = portraits.find((x) => x.id === id);
  if (p) Object.assign(p, patch);
}

async function process(id: string, photo: File, name: string, style: string) {
  await wait(1200);
  update(id, { status: 'running' });
  await wait(1800);
  try {
    update(id, { status: 'succeeded', imageUrl: await render(photo, name, style), finishedAt: new Date().toISOString() });
  } catch {
    update(id, { status: 'failed', error: 'We could not create this portrait. Please try another photo.' });
  }
}

export const demoApi = {
  me: async () => ({ user }),
  requestOtp: async (phone: string) => {
    if (!/^(?:\+?84|0)[35789]\d{8}$/.test(phone.replace(/[\s.-]/g, ''))) {
      throw new ApiError(400, 'Enter a valid Vietnamese mobile number');
    }
  },
  verifyOtp: async (phone: string, code: string) => {
    if (!/^\d{6}$/.test(code)) throw new ApiError(400, 'Incorrect code');
    user = { id: 'demo', phone };
    return { user };
  },
  logout: async () => {
    user = null;
  },
  styles: async () => ({ styles: STYLES }),
  portraits: async () => ({ portraits: portraits.map((p) => ({ ...p })) }),
  createPortrait: async (form: FormData) => {
    const photo = form.get('photo');
    const name = String(form.get('name') ?? '').trim();
    const style = String(form.get('style') ?? '');
    if (!(photo instanceof File)) throw new ApiError(400, 'Attach a photo');
    if (!name) throw new ApiError(400, 'Enter a name');
    if (portraits.filter((p) => p.status === 'queued' || p.status === 'running').length >= MAX_ACTIVE) {
      throw new ApiError(409, `You already have ${MAX_ACTIVE} portraits in progress`);
    }
    const portrait: Portrait = {
      id: crypto.randomUUID(), name, style, status: 'queued', error: null, imageUrl: null,
      createdAt: new Date().toISOString(), finishedAt: null,
    };
    portraits.unshift(portrait);
    void process(portrait.id, photo, name, style);
    return { portrait: { ...portrait } };
  },
};
