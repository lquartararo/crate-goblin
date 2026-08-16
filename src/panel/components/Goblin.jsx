import { useEffect, useRef } from 'react';
import { BAYER4, clamp01, prefersReducedMotion } from '../dither-kit.js';
import { roles } from '../palette.js';
import { useThemeTick } from '../useThemeTick.js';
import { CELLS, N, EYES } from '../../lib/goblin.js';

/**
 * @param {number} size    rendered edge in CSS px
 * @param {number} energy  0..1. Thickens the ground behind the mark while work
 *   is in flight. Not a spinner: the goblin doesn't spin, it gets busier.
 */
export function Goblin({ size = 44, energy = 0, className = '' }) {
  const ref = useRef(null);
  const theme = useThemeTick();
  // Where the pupils point, in -1..1 on each axis. A ref rather than state
  // because this changes on every mouse move and none of it belongs in React's
  // render path.
  const gaze = useRef({ x: 0, y: 0 });
  // Read through a ref so a changing energy doesn't tear down the loop and
  // restart the clock every time a track finishes.
  const target = useRef(energy);
  target.current = energy;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const { ink, accent, wash } = roles();
    const cell = size / N;
    // Halftone cells scale with the mark, so it reads as the same grain at 44px
    // as the 128px icon does rather than dissolving into noise.
    const dcell = Math.max(1, Math.round(size / 32));

    // Track the cursor against the mark's own centre, so the pupils point at
    // the pointer rather than at some fixed idea of where the panel is.
    const onMove = (e) => {
      const r = canvas.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      // Saturates quickly: past roughly a panel-width away the answer is just
      // "over there", and scaling linearly to the far edge would leave the eyes
      // almost centred for most of the screen.
      const reach = 180;
      gaze.current = {
        x: Math.max(-1, Math.min(1, dx / reach)),
        y: Math.max(-1, Math.min(1, dy / reach)),
      };
    };
    addEventListener('pointermove', onMove, { passive: true });

    let raf = 0;
    let shown = target.current;
    let look = { x: 0, y: 0 };

    const paint = (t) => {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const img = ctx.createImageData(size, size);
      const px = img.data;

      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const ch = CELLS[Math.min((y / cell) | 0, N - 1)][Math.min((x / cell) | 0, N - 1)];
          const i = (y * size + x) << 2;
          let c;
          if (ch === '#') c = ink;
          else if (ch === 'o') c = wash;
          else {
            // Ground: a ramp that thickens with energy and breathes slowly, so
            // an idle goblin still looks awake without demanding attention.
            const base = 0.16 + 0.34 * (y / size);
            const lift = 0.42 * shown * (0.85 + 0.15 * Math.sin(t * 1.6 + y * 0.09));
            const density = clamp01(base + lift);
            c = density > BAYER4[((y / dcell) | 0) & 3][((x / dcell) | 0) & 3] ? accent : wash;
          }
          px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
        }
      }

      // Eyes last, straight onto the buffer, so they sit over the silhouette
      // rather than being cut out of the cell grid.
      for (const eye of EYES) {
        const pupilX = eye.x + Math.round((look.x + 1) / 2 * (eye.w - 1));
        const pupilY = eye.y + Math.round((look.y + 1) / 2 * (eye.h - 1));
        for (let cy = 0; cy < eye.h; cy++) {
          for (let cx = 0; cx < eye.w; cx++) {
            const on = (eye.x + cx) === pupilX && (eye.y + cy) === pupilY;
            const c = on ? ink : wash;
            for (let y = 0; y < cell; y++) {
              for (let x = 0; x < cell; x++) {
                const py = Math.round((eye.y + cy) * cell) + y;
                const pxx = Math.round((eye.x + cx) * cell) + x;
                if (py >= size || pxx >= size) continue;
                const i = (py * size + pxx) << 2;
                px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
              }
            }
          }
        }
      }
      ctx.putImageData(img, 0, 0);
    };

    if (prefersReducedMotion()) {
      shown = target.current;
      paint(0);
      return () => removeEventListener('pointermove', onMove);
    }

    const started = performance.now();
    let last = 0;
    const tick = (now) => {
      raf = requestAnimationFrame(tick);
      // ~40fps. The breathing alone would be fine at 20, but the pupils track
      // a cursor, and at 20 that reads as lag rather than as attention.
      if (now - last < 25) return;
      last = now;
      // Ease toward the target rather than snapping, so finishing a track
      // settles the mark instead of making it flinch.
      shown += (target.current - shown) * 0.08;
      // Eases toward the cursor rather than snapping. Snapping made it read as
      // a readout; a little lag makes it read as something looking.
      look = {
        x: look.x + (gaze.current.x - look.x) * 0.22,
        y: look.y + (gaze.current.y - look.y) * 0.22,
      };
      paint((now - started) / 1000);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener('pointermove', onMove);
    };
  }, [size, theme]);

  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      role="img"
      aria-label="crate goblin"
      className={`block flex-none rounded-[2px] [image-rendering:pixelated] ${className}`}
    />
  );
}
