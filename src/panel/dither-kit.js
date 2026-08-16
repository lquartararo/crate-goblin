// Vendored from Dither Kit — https://github.com/Boring-Software-Inc/dither-kit
// Ported from registry/dither-kit/{dither-paint,pixel}.ts (TypeScript → JS).
//
// MIT License
//
// Copyright (c) Boring Software Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// ---------------------------------------------------------------------------
//
// What is and isn't here, and why.
//
// Their kit dithers *shapes it draws itself* — chart columns filled with a
// density gradient. It has no image path at all: nothing in it takes a bitmap
// and quantises it. Our artwork tiles do exactly that, so the quantiser in
// dither.js stays ours. What's ported here is everything that defines how their
// output *looks*, which is the part worth having:
//
//   - the 4x4 Bayer matrix and its normalisation
//   - CELL: size the canvas in dither cells, never resample it
//   - the hover "intensity" lift, and the constants that tune it
//   - the easings and the reduced-motion check
//
// Kept in one vendored file rather than scattered through ours so the boundary
// between their code and ours stays obvious, and so re-syncing against upstream
// is a diff against a single file.
//
// Two of their primitives were tried and deliberately left out, both because
// our surface is light where theirs is dark:
//
//   Bloom. A blurred copy composited with `plus-lighter`. On a dark chart each
//   hue glows in its own colour; over our blush paper it clips. The top palette
//   level is (246,237,240) — near white already — so *any* additive pass drives
//   it to pure white and the sky in a photo blows out. Tested down to
//   brightness 1.06 / opacity 0.30 and it still flattened. It isn't a tuning
//   problem, it's the wrong operator for this ground.
//
//   CELL = 2. Correct for them: their canvases run to 520 cells wide, so
//   halving resolution is free. Our artwork tile is 64 CSS px, where CELL=2
//   means a 32x32 canvas and the photograph stops being legible — a face or a
//   skyline collapses into blocks. See CELL below.

/**
 * 4x4 ordered (Bayer) matrix, normalised to 0..1 thresholds.
 *
 * We had an 8x8 here before. Both are "correct" — the 8x8 is the finer, more
 * photographic pattern — but at tile size its cells land sub-pixel and the
 * texture greys out into mush. The 4x4 is what gives their output its readable
 * crosshatch.
 */
export const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((v) => (v + 0.5) / 16));

/**
 * CSS px per dither cell.
 *
 * The idea behind this constant is the fix; their value for it isn't. What
 * matters is that the canvas is sized in *cells* and then never resampled. We
 * were rendering a 128x128 canvas into a 64px box, and halving a Bayer field
 * averages each cell into its neighbours — all the cost of dithering and none
 * of the pattern.
 *
 * 1, not their 2, because the tile is only 64 CSS px. At CELL=2 that's a 32x32
 * canvas and the artwork stops resolving (see the note above). At 1 the canvas
 * is 64x64, drawn 1:1, and every cell survives to the screen intact.
 */
export const CELL = 1;

/** Hover lift: how far the dither threshold drops at full intensity. */
export const INTENSITY_THRESHOLD = 0.1;
/** Hover lift: how much cell alpha gains at full intensity. */
export const INTENSITY_ALPHA = 0.22;

export const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

// Easings — gentle start + soft settle so entrances don't feel linear.
export const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
export const easeOutCubic = (t) => 1 - (1 - t) ** 3;

/** 32-bit FNV-1a hash — turns any string seed into a stable uint32. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Tiny deterministic PRNG (xorshift32) — returns floats in [0, 1). */
export function xorshift32(seed) {
  let s = seed || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/** Backing-canvas resolution for a box — low-res, scaled up `pixelated`. */
export function backingSize(width, height) {
  return {
    cols: Math.max(8, Math.round(width / CELL)),
    rows: Math.max(8, Math.round(height / CELL)),
  };
}

// Backing-resolution caps — a background wash never needs more cells than this.
const MAX_COLS = 960;
const MAX_ROWS = 600;

/**
 * Paint an ordered-dither ramp onto a low-res backing canvas.
 *
 * Ported from their `gradient.tsx`. Static — one paint per size or prop change,
 * no animation loop — so it's cheap enough to sit behind a whole panel. This is
 * the piece that makes a surface dithered rather than just the pictures on it:
 * a solid edge that dissolves into scattered cells instead of a CSS gradient's
 * smooth ramp.
 *
 * Colours are [r, g, b]; `to` may be null to dissolve into whatever is behind.
 *
 * @param {'up'|'down'|'left'|'right'} direction  where `to` ends up
 */
export function paintGradient(canvas, width, height, {
  from,
  to = null,
  direction = 'down',
  cell = 3,
  opacity = 1,
  phase = 0,
} = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx || width <= 0 || height <= 0) return;

  const cols = Math.min(MAX_COLS, Math.max(4, Math.round(width / cell)));
  const rows = Math.min(MAX_ROWS, Math.max(4, Math.round(height / cell)));
  if (canvas.width !== cols || canvas.height !== rows) {
    canvas.width = cols;
    canvas.height = rows;
  }

  // Theirs paints cell by cell with fillRect, which is fine for something drawn
  // once. Ours drifts, and ~17k fillRect calls per frame is not something to do
  // sixty times a second — one ImageData write is.
  const img = ctx.createImageData(cols, rows);
  const px = img.data;
  const [fr, fg, fb] = from;
  const [tr, tg, tb] = to ?? from;

  for (let y = 0; y < rows; y++) {
    const brow = BAYER4[y & 3];
    for (let x = 0; x < cols; x++) {
      // t runs 0 at the `from` edge → 1 at the `to` edge.
      const t =
        direction === 'up' ? 1 - (y + 0.5) / rows
        : direction === 'down' ? (y + 0.5) / rows
        : direction === 'left' ? 1 - (x + 0.5) / cols
        : (x + 0.5) / cols;

      // The drift. Displacing the ramp itself rather than swapping matrix cells
      // keeps the texture stable and moves the *edge* — cells wink on and off
      // along the falloff instead of the whole field crawling, which is what
      // makes it read as a slow breath rather than static noise.
      const density = clamp01(1 - t + phase * Math.sin(x * 0.20 + y * 0.11));
      const lit = density > brow[x & 3];

      const i = (y * cols + x) << 2;
      if (to) {
        // Two-tone: every cell is painted, the dither picks which colour.
        px[i] = lit ? fr : tr;
        px[i + 1] = lit ? fg : tg;
        px[i + 2] = lit ? fb : tb;
        px[i + 3] = Math.round(opacity * 255);
      } else {
        // Dissolving into the background: lit cells carry the ramp, off cells
        // keep a faint tint that also fades, so the falloff reads smooth
        // instead of ending on a visible last row of dots.
        px[i] = fr;
        px[i + 1] = fg;
        px[i + 2] = fb;
        px[i + 3] = Math.round((lit ? 0.35 + 0.65 * density : 0.12 * density) * opacity * 255);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Whether the OS asks for reduced motion (snap instead of animating). */
export function prefersReducedMotion() {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
}
