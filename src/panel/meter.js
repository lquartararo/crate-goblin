// Progress as a dithered fill.
//
// Rebuilt from scratch. The previous bar displaced its edge with a travelling
// sine, which looked good standing still but lied while working: the boundary
// wandered backwards and forwards by a few percent, so a bar at 40% read as
// somewhere between 35 and 45 and a nearly-finished track looked like it had
// slipped. A progress bar's one job is to be true about a number.
//
// So the edge sits exactly where the value is, and the *texture* carries the
// motion instead — the dissolve at the leading edge shimmers, the fill behind
// it is solid. Movement where it costs nothing, precision where it matters.
//
// Painted through ImageData rather than per-cell fillRect: a full-width bar is
// several hundred cells and this repaints every frame.

import { BAYER4, clamp01 } from './dither-kit.js';

// How wide the leading edge's dissolve is, as a fraction of the bar. Wide
// enough to read as a halftone falloff rather than a soft blur.
const FEATHER = 0.14;
// Width of the sweeping band when there's no total to count against.
const BAND = 0.3;

/**
 * @param {number|null} progress  0..1, or null for indeterminate
 * @param {number} t              seconds, for the shimmer and the sweep
 */
export function paintMeter(canvas, width, height, { ink, progress, t = 0, cell = 2 }) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || width <= 0 || height <= 0) return;

  const cols = Math.max(4, Math.round(width / cell));
  const rows = Math.max(1, Math.round(height / cell));
  if (canvas.width !== cols || canvas.height !== rows) {
    canvas.width = cols;
    canvas.height = rows;
  }

  const img = ctx.createImageData(cols, rows);
  const px = img.data;
  const [r, g, b] = ink;

  // Indeterminate sweeps a band across instead of filling to a point, so it
  // never implies a completeness we don't know.
  const head = progress == null ? ((t * 0.42) % (1 + BAND * 2)) - BAND : progress;

  for (let x = 0; x < cols; x++) {
    const nx = (x + 0.5) / cols;

    // Distance behind the leading edge, normalised over the feather. 1 deep
    // inside the fill, 0 at the edge, negative beyond it.
    let density = (head - nx) / FEATHER;
    // The trailing side of a sweeping band fades too, so it reads as a pulse
    // travelling rather than a bar that keeps growing and snapping back.
    if (progress == null) density = Math.min(density, (nx - (head - BAND)) / FEATHER);
    density = clamp01(density);

    // The shimmer. Only bites where the fill is already partial — deep inside
    // the solid region it's clamped away, so the bar never flickers behind the
    // edge, and the number the edge sits at is never displaced.
    if (density > 0 && density < 1) {
      density = clamp01(density + 0.16 * Math.sin(nx * 26 - t * 5.2));
    }

    for (let y = 0; y < rows; y++) {
      const lit = density > BAYER4[y & 3][x & 3];
      const i = (y * cols + x) << 2;
      px[i] = r; px[i + 1] = g; px[i + 2] = b;
      // Unlit cells stay transparent so the row's own background shows through
      // — a painted "off" colour would band against the zebra striping.
      px[i + 3] = lit ? 255 : 0;
    }
  }
  ctx.putImageData(img, 0, 0);
}
