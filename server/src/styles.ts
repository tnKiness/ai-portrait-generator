export interface Style {
  id: string;
  label: string;
  /** Prompt sent to real image models. */
  prompt: string;
}

export const STYLES = [
  {
    id: 'watercolor',
    label: 'Watercolor',
    prompt: 'Soft watercolor portrait with loose brush strokes and warm pastel tones.',
  },
  {
    id: 'pop-art',
    label: 'Pop art',
    prompt: 'Bold pop-art portrait with flat saturated colors, thick outlines and halftone dots.',
  },
  {
    id: 'sketch',
    label: 'Pencil sketch',
    prompt: 'Detailed graphite pencil sketch portrait on textured paper.',
  },
] as const satisfies readonly Style[];

export type StyleId = (typeof STYLES)[number]['id'];

export function findStyle(id: string): Style | undefined {
  return STYLES.find((s) => s.id === id);
}
