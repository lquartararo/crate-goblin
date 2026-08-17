// Ordered (Bayer) dithering — the real thing, on a canvas.
//
// Quantises a photo to a small fixed palette using a threshold that varies
// per-pixel in a repeating matrix. That's what produces the crunchy crosshatch,
// and it's why a CSS noise overlay never lands: an overlay sits *on top* of a
// full-colour image, where this replaces it. Every pixel commits to a palette
// entry, which is why it stays crisp at any zoom.
//
// The matrix, the cell size, the hover lift and the easings come from Dither
// Kit (MIT) — see dither-kit.js. The quantiser below is ours: their kit dithers
// shapes it draws itself and has no image path, so there was nothing upstream
// to take for this part.

import {
  BAYER4,
  CELL,
  INTENSITY_THRESHOLD,
  clamp01,
  easeOutCubic,
  prefersReducedMotion,
} from './dither-kit.js';

const N = 4;

// Rec. 709 luma. Using a plain RGB average makes blues read far too bright,
// which matters here because the palette is not neutral.
const luma = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/**
 * Multi-level ordered dithering.
 *
 * Two tones is the classic 1-bit look, but it throws away everything between
 * black and white — a photo becomes noise wherever it's mid-grey, because every
 * pixel has to commit to one extreme. Quantising to several levels and using
 * the Bayer threshold to choose between the two *nearest* levels keeps the
 * crunch while letting midtones actually resolve.
 *
 * The levels are the palette itself — ink, accent, wash, paper — so the
 * artwork is dithered into the same four tones the interface is built from
 * rather than into arbitrary greys.
 *
 * @param {number[][]} levels  ordered dark→light; two entries reproduces the
 *   original 1-bit behaviour exactly.
 */
function quantise(value, threshold, levels) {
  const scaled = value * (levels.length - 1);
  const low = Math.floor(scaled);
  // The fractional part is the probability of rounding up; the ordered matrix
  // turns that probability into a stable spatial pattern instead of noise.
  const up = scaled - low > threshold ? 1 : 0;
  const i = low + up;
  return levels[i < 0 ? 0 : i >= levels.length ? levels.length - 1 : i];
}

/**
 * @param {number} intensity  0..1 hover lift. Drops the dither threshold so
 *   more cells round up to the brighter level — the picture gains density and
 *   lifts toward the light end of the palette without any colour changing.
 *   This is Dither Kit's hover behaviour; it replaces the `phase` parameter
 *   that used to sit here, which nothing ever drove.
 */
export function dither(
  source,
  canvas,
  { ink, paper, levels, bias = 0, contrast = 1.35, intensity = 0 } = {}
) {
  const palette = levels ?? [ink, paper];
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h) return;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  // Cover-fit rather than stretch: artwork is square but the tile may not be.
  const sw = source.width;
  const sh = source.height;
  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh);

  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;

  const lift = INTENSITY_THRESHOLD * intensity;

  for (let y = 0; y < h; y++) {
    const row = BAYER4[y & (N - 1)];
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) << 2;

      let l = luma(px[i], px[i + 1], px[i + 2]);
      l = clamp01((l - 0.5) * contrast + 0.5 + bias);

      // The matrix arrives pre-normalised to 0..1 from dither-kit, already
      // centred by its `(v + 0.5) / 16` so a flat mid-grey dithers to ~50%
      // coverage rather than skewing dark.
      const threshold = row[x & (N - 1)] - lift;
      const c = quantise(l, threshold, palette);
      px[i] = c[0];
      px[i + 1] = c[1];
      px[i + 2] = c[2];
      px[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Stretch a picture's own tonal range to fill the ramp. Modifies `data`.
 *
 * A quantiser is only as good as the range handed to it: a photo shot dark
 * occupies a third of the ramp, so two of the four palette levels never get
 * used and the result is mud with a crosshatch on it. Album artwork is mastered
 * and mostly arrives full-range, which is why this was never needed for the
 * tiles — a picture someone drops on the darkroom is whatever came off a phone.
 *
 * The alternative was a contrast slider, and this is better than one for the
 * same reason a limiter is better than a volume knob: the person with the
 * problem does not know the fix is a number.
 *
 * @param {Uint8ClampedArray} data  RGBA, as it comes off getImageData
 * @returns {boolean}  whether anything was changed
 */
export function stretchTones(data, { ignore = 0.02, minRange = 24 } = {}) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    hist[Math.round(luma(data[i], data[i + 1], data[i + 2]) * 255)]++;
  }

  // Percentiles rather than the outright darkest and lightest pixel. One blown
  // highlight or one black speck is enough to make the range look full while
  // almost all of the picture is squeezed into the middle of it — and those are
  // not rare, they are what a phone camera does to a light fitting.
  const cut = Math.max(1, Math.round((data.length / 4) * ignore));
  let lo = 0;
  let hi = 255;
  for (let v = 0, n = 0; v < 256; v++) { n += hist[v]; if (n >= cut) { lo = v; break; } }
  for (let v = 255, n = 0; v >= 0; v--) { n += hist[v]; if (n >= cut) { hi = v; break; } }

  // A genuinely flat image — a scan of paper, a screenshot of one colour — has
  // no range to recover, and stretching one would amplify sensor noise into a
  // field of dots that was never in the picture.
  if (hi - lo < minRange) return false;

  const scale = 255 / (hi - lo);
  // Clamped by the array's own type, which is the whole reason for using it:
  // both ends of the ramp map outside 0..255 by design.
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round((v - lo) * scale);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]];
    data[i + 1] = lut[data[i + 1]];
    data[i + 2] = lut[data[i + 2]];
  }
  return true;
}

/** Parse "#rrggbb" or "r, g, b" out of a CSS custom property. */
export function readColor(el, prop, fallback) {
  const v = getComputedStyle(el).getPropertyValue(prop).trim();
  const hex = v.match(/^#?([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const nums = v.match(/\d+/g);
  return nums && nums.length >= 3 ? nums.slice(0, 3).map(Number) : fallback;
}

/**
 * Fetch cross-origin artwork without tainting the canvas.
 *
 * Setting img.src directly on an sndcdn URL would taint it and make
 * getImageData throw. Going through fetch + createImageBitmap keeps the pixels
 * readable — the extension already holds host permissions for that origin.
 */
export async function loadBitmap(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`artwork ${res.status}`);
  return createImageBitmap(await res.blob());
}

/**
 * Animate the reveal: bias sweeps up so the image emerges from solid ink.
 * Returns a promise that settles when the sweep finishes.
 */
export function revealDither(source, canvas, colors, { duration = 620 } = {}) {
  return new Promise((resolve) => {
    // Respect a stated preference for less motion — draw the final frame only.
    if (prefersReducedMotion()) {
      dither(source, canvas, { ...colors, bias: 0 });
      return resolve();
    }

    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      // Ease-out so most of the picture lands early and the last few
      // percent of grain settles slowly.
      const eased = easeOutCubic(t);
      dither(source, canvas, { ...colors, bias: -0.85 * (1 - eased) });
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

/**
 * The reveal, run backwards: bias sweeps up until every cell has quantised to
 * the lightest level and the picture has dissolved into the paper.
 *
 * Used when a finished download leaves the queue. Fading the row with CSS would
 * have been simpler, but a dither has an honest way to disappear — losing its
 * darkest cells first, thinning to scattered dots, then nothing — and using it
 * here means the row exits in the same language it arrived in.
 */
export function dissolveDither(source, canvas, colors, { duration = 620 } = {}) {
  return new Promise((resolve) => {
    if (prefersReducedMotion()) return resolve();

    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      // Ease-in here, against the reveal's ease-out: the picture should hold
      // long enough to be read, then go quickly, rather than smearing out.
      const eased = t * t * t;
      dither(source, canvas, { ...colors, bias: 0.95 * eased });
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

/**
 * Ramp `intensity` 0→1 (or back) and repaint each frame.
 *
 * The hover lift from Dither Kit. Runs only for the tile under the cursor, so
 * the cost is one 32x32 requantisation per frame — not the 300 tiles a
 * continuously-animating crate would need. Returns a cancel function; call it
 * when the pointer leaves mid-ramp so the two directions can't fight.
 */
export function liftDither(
  source,
  canvas,
  colors,
  { to = 1, duration = 220, onValue } = {}
) {
  if (prefersReducedMotion()) {
    dither(source, canvas, { ...colors, intensity: to });
    onValue?.(to);
    return () => {};
  }

  let raf = 0;
  // Ramps from wherever the last one stopped, not from 0. Sweeping the pointer
  // across a list interrupts every tile mid-ramp; without this the tile snaps
  // back to its resting grain before easing out again, which flickers.
  const from = colors.intensity ?? 0;
  const start = performance.now();

  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const value = from + (to - from) * easeOutCubic(t);
    dither(source, canvas, { ...colors, intensity: value });
    onValue?.(value);
    if (t < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);

  return () => cancelAnimationFrame(raf);
}

export { CELL };
