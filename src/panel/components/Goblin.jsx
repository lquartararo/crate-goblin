import { useEffect, useRef } from 'react';
import { BAYER4, clamp01, prefersReducedMotion } from '../dither-kit.js';
import { levels } from '../palette.js';

// The mark, as cells rather than a picture.
//
// Same 16x16 lattice the toolbar icon is cut from and the same one icons.js
// draws its glyphs on, so the brand mark and the interface come out of one
// system instead of an illustration being pasted next to a pixel-art UI.
//
//   #  silhouette      o  knockout (eyes, teeth)      .  halftone ground
const CELLS = [
  '................', '.#............#.', '..##........##..', '..###......###..',
  '..##..####..##..', '..##.######.##..', '...##########...', '...##########...',
  '...#oo####oo#...', '...#oo####oo#...', '...##########...', '...##########...',
  '...#oooooooo#...', '...#o#oo#o#o#...', '....########....', '......#oo#......',
];

const N = CELLS.length;

/**
 * @param {number} size    rendered edge in CSS px
 * @param {number} energy  0..1. Thickens the ground behind the mark while work
 *   is in flight. Not a spinner: the goblin doesn't spin, it gets busier.
 */
export function Goblin({ size = 44, energy = 0, className = '' }) {
  const ref = useRef(null);
  // Read through a ref so a changing energy doesn't tear down the loop and
  // restart the clock every time a track finishes.
  const target = useRef(energy);
  target.current = energy;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const [ink, accent, wash] = levels();
    const cell = size / N;
    // Halftone cells scale with the mark, so it reads as the same grain at 44px
    // as the 128px icon does rather than dissolving into noise.
    const dcell = Math.max(1, Math.round(size / 32));

    let raf = 0;
    let shown = target.current;

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
      ctx.putImageData(img, 0, 0);
    };

    if (prefersReducedMotion()) {
      shown = target.current;
      paint(0);
      return;
    }

    const started = performance.now();
    let last = 0;
    const tick = (now) => {
      raf = requestAnimationFrame(tick);
      // 20fps. The motion is a slow breath; three times the frames would cost
      // three times as much to be imperceptibly smoother.
      if (now - last < 50) return;
      last = now;
      // Ease toward the target rather than snapping, so finishing a track
      // settles the mark instead of making it flinch.
      shown += (target.current - shown) * 0.08;
      paint((now - started) / 1000);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      role="img"
      aria-label="Crate Goblin"
      className={`block flex-none rounded-[2px] [image-rendering:pixelated] ${className}`}
    />
  );
}
