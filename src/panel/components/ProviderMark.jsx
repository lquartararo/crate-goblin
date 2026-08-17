import { useEffect, useRef, useState } from 'react';
import { BAYER4, clamp01 } from '../dither-kit.js';
import { roles } from '../palette.js';
import { useThemeTick } from '../useThemeTick.js';
import soundcloudSvg from '../marks/soundcloud.svg?raw';
import youtubeSvg from '../marks/youtube.svg?raw';

// Provider marks: the real logos, rasterised and dithered.
//
// These were drawn by hand before this — five times, wrong five times. The
// cloud too tall, the bars too thin, the badge stretched. Every one of those
// was an approximation of a shape from memory, on a lattice also guessed at.
// The artwork is the artwork; the only interesting question is how to get it
// into this panel's material, and that is a rasterise and a threshold.
//
// Two things make this work on any SVG rather than these two in particular:
//
//   The ink is measured, not the viewBox. SoundCloud's box is square while its
//   logo is 2.22:1 — 56% of the stated box is empty — so drawing the box would
//   put a wide mark in a tall frame and shrink it to nothing. The opaque
//   bounding box is found once and everything derives from it, so a replacement
//   file with different padding needs no code change.
//
//   The threshold is on coverage, not colour. These arrive as solid black on
//   transparent; what matters is which cells the shape covers, and the Bayer
//   matrix turns that into the same halftone the artwork and the goblin use.

const SVG = { soundcloud: soundcloudSvg, youtube: youtubeSvg };

// Measured once per mark and kept. The answer cannot change, and a side panel
// mounts these every time it opens.
const measured = new Map();

const toUrl = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/**
 * The opaque bounding box of a rasterised SVG.
 *
 * Measured large so a thin feature — the shortest waveform bar is about one
 * part in eighty of the width — cannot fall below a pixel and be missed.
 */
async function inkBox(svg) {
  const img = new Image();
  img.src = toUrl(svg);
  await img.decode();

  const S = 400;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const scale = Math.min(S / img.naturalWidth, S / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  const offX = (S - w) / 2;
  const offY = (S - h) / 2;
  ctx.drawImage(img, offX, offY, w, h);

  const d = ctx.getImageData(0, 0, S, S).data;
  let x0 = S, y0 = S, x1 = -1, y1 = -1;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (d[((y * S + x) << 2) + 3] <= 24) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) {
    return { img, sx: 0, sy: 0, sw: img.naturalWidth, sh: img.naturalHeight, aspect: 1 };
  }

  // Back into the image's own coordinates. The box was found on a canvas the
  // image had been scaled and centred into, and handing those numbers straight
  // to drawImage as source coordinates crops a different part of a differently
  // sized picture — which drew ten pixels of one corner and nothing else.
  const sw = (x1 - x0 + 1) / scale;
  const sh = (y1 - y0 + 1) / scale;
  return {
    img,
    sx: (x0 - offX) / scale,
    sy: (y0 - offY) / scale,
    sw,
    sh,
    aspect: sw / sh,
  };
}

/**
 * @param {'soundcloud'|'youtube'} name
 * @param {number} height  rendered height in CSS px; the width follows the ink
 */
export function ProviderMark({ name, height = 24, className = '' }) {
  const ref = useRef(null);
  const theme = useThemeTick();
  const [aspect, setAspect] = useState(() => measured.get(name)?.aspect ?? null);

  useEffect(() => {
    let live = true;
    const svg = SVG[name];
    if (!svg) return undefined;

    (async () => {
      const box = measured.get(name) ?? await inkBox(svg);
      measured.set(name, box);
      if (!live) return;
      setAspect(box.aspect);

      const canvas = ref.current;
      if (!canvas) return;

      const width = Math.max(1, Math.round(height * box.aspect));
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      // Drawn straight to the final size rather than downscaled from the
      // measuring pass: a downscale averages neighbouring cells together, which
      // is the one thing that reliably turns a halftone back into mush.
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(box.img, box.sx, box.sy, box.sw, box.sh, 0, 0, width, height);

      const { ink } = roles();
      const img = ctx.getImageData(0, 0, width, height);
      const px = img.data;

      for (let y = 0; y < height; y++) {
        // Shallower than the goblin's, because this is a third of its size. At
        // 0.26 the ramp fell below whole rows of the Bayer matrix and those
        // rows dropped out together — which reads as scanlines across the mark
        // rather than as a halftone in it. The texture is still there; it just
        // no longer takes a row at a time.
        const ramp = clamp01(1 - 0.13 * (y / height));
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) << 2;
          // Coverage, not colour. Anti-aliased edges arrive as partial alpha
          // and this hardens them, which keeps the outline crisp rather than
          // fading it to grey.
          const covered = px[i + 3] / 255;
          const lit = covered > 0.45 && ramp > BAYER4[y & 3][x & 3];
          if (!lit) { px[i + 3] = 0; continue; }
          px[i] = ink[0];
          px[i + 1] = ink[1];
          px[i + 2] = ink[2];
          px[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    })();

    return () => { live = false; };
  }, [name, height, theme]);

  return (
    <canvas
      ref={ref}
      // Sized in CSS before the measurement lands, so a row of marks does not
      // jump when they resolve. Square is the safer guess — too wide would
      // shove the label sideways and snap back.
      style={{ width: Math.round(height * (aspect ?? 1)), height }}
      role="img"
      aria-label={name}
      className={`block flex-none [image-rendering:pixelated] ${className}`}
    />
  );
}
