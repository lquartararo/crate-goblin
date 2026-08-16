import { readColor } from './dither.js';

/**
 * The dither palette, read from the same CSS custom properties the interface
 * uses. One definition, so a colour change can't drift between CSS and canvas.
 *
 * Sorted dark → light by luminance, because that is what multi-level
 * quantisation expects — and with themes it can no longer be assumed. On a dark
 * palette ink is the lightest of the four and paper the darkest, so a fixed
 * order would hand the quantiser an inverted ramp and every dithered image
 * would come out as a negative of itself.
 * Four levels rather than two: at two, every midtone collapses to noise and a
 * photograph stops being readable. At four the crunch survives but faces and
 * edges resolve — and because the levels *are* the interface palette, the
 * artwork sits inside the design rather than beside it.
 */
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * The palette by role, which is a different question to levels().
 *
 * levels() answers "what four tones make a ramp" and is sorted, because a
 * quantiser needs an order. This answers "what colour is the text" and is not,
 * because a mark drawn in ink wants ink on every theme — on a dark palette ink
 * is the lightest of the four, so reading it out of the sorted ramp would draw
 * the goblin in the background colour.
 */
export function roles(el = document.documentElement) {
  return {
    ink: readColor(el, '--color-ink', [29, 18, 25]),
    accent: readColor(el, '--color-accent', [122, 30, 75]),
    wash: readColor(el, '--color-wash', [240, 216, 228]),
    paper: readColor(el, '--color-paper', [246, 237, 240]),
  };
}

export function levels(el = document.documentElement) {
  return [
    readColor(el, '--color-ink', [29, 18, 25]),
    readColor(el, '--color-accent', [122, 30, 75]),
    readColor(el, '--color-wash', [240, 216, 228]),
    readColor(el, '--color-paper', [246, 237, 240]),
  ].sort((a, b) => luma(a) - luma(b));
}

/**
 * Two-tone, for things that must stay strictly 1-bit — the progress wave, where
 * a cell is lit or it isn't and an intermediate tone would read as a rendering
 * artefact rather than as texture.
 */
export function duotone(el = document.documentElement) {
  const l = levels(el);
  return { ink: l[0], paper: l[3] };
}
