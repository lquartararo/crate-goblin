import { readColor } from './dither.js';

/**
 * The dither palette, read from the same CSS custom properties the interface
 * uses. One definition, so a colour change can't drift between CSS and canvas.
 *
 * Ordered dark → light, because that's what multi-level quantisation expects.
 * Four levels rather than two: at two, every midtone collapses to noise and a
 * photograph stops being readable. At four the crunch survives but faces and
 * edges resolve — and because the levels *are* the interface palette, the
 * artwork sits inside the design rather than beside it.
 */
export function levels(el = document.documentElement) {
  return [
    readColor(el, '--color-ink', [29, 18, 25]),
    readColor(el, '--color-accent', [122, 30, 75]),
    readColor(el, '--color-wash', [240, 216, 228]),
    readColor(el, '--color-paper', [246, 237, 240]),
  ];
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
