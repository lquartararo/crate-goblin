// Dithering an arbitrary block of DOM away.
//
// The artwork can dissolve honestly because it's a canvas — we own its pixels.
// A row is text, badges and layout, so the same trick doesn't reach it, and the
// old exit faded the row with opacity while only the thumbnail dithered. Two
// different languages for one gesture, and the fade was the louder of them.
//
// A CSS mask fixes that without rasterising anything. The mask is the Bayer
// matrix itself, tiled across the row: at each step the cells whose threshold
// has been passed become transparent, so the whole block — every glyph and
// border included — loses its cells in ordered-dither sequence and thins out to
// nothing. It's the same matrix the artwork and the progress bar use, so the
// row leaves in the language the rest of the interface is written in.

// Raw 4x4 Bayer, in threshold order 0..15. dither-kit exports this
// pre-normalised to 0..1 for quantising; here the integer rank is what's wanted
// — it's the order the cells switch off in.
const BAYER_RANK = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

const N = 4;
// Pixels per cell in the generated mask. Rendered at final size and used 1:1
// rather than scaled up, because a mask *is* resampled when it's scaled and the
// hard cell edges would soften into a blur — the exact failure the artwork tile
// had before CELL was fixed.
const CELL = 4;
export const TILE = N * CELL;

// One more step than the matrix has cells: level 0 is untouched, level 16 has
// switched every cell off.
export const LEVELS = N * N + 1;

let cache = null;

/**
 * Data URLs for every step of the dissolve, built once and reused.
 *
 * Sixteen tiny PNGs rather than a repaint per frame: the browser composites a
 * cached mask on the GPU, where regenerating one each frame would land on the
 * main thread next to whatever else the panel is doing mid-download.
 */
export function ditherMasks() {
  if (cache) return cache;

  const canvas = document.createElement('canvas');
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext('2d');

  cache = Array.from({ length: LEVELS }, (_, level) => {
    ctx.clearRect(0, 0, TILE, TILE);
    // White is opaque in a luminance mask and, being fully opaque, works for an
    // alpha mask too — so this doesn't depend on mask-mode.
    ctx.fillStyle = '#fff';
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (BAYER_RANK[y][x] >= level) ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }
    return canvas.toDataURL('image/png');
  });

  return cache;
}

/** Inline style applying step `level` of the dissolve. */
export function maskStyle(level) {
  const url = `url(${ditherMasks()[Math.max(0, Math.min(LEVELS - 1, level))]})`;
  return {
    maskImage: url,
    WebkitMaskImage: url,
    maskSize: `${TILE}px ${TILE}px`,
    WebkitMaskSize: `${TILE}px ${TILE}px`,
    maskRepeat: 'repeat',
    WebkitMaskRepeat: 'repeat',
  };
}
