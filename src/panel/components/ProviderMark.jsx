import { useEffect, useRef } from 'react';
import { BAYER4, clamp01 } from '../dither-kit.js';
import { levels } from '../palette.js';

// Provider marks on the same 16x16 lattice the goblin is cut from.
//
// Not the real logos. Those are flat vector artwork with brand colours and
// anti-aliased curves, and dropping either one into this panel would be the
// only smooth, full-colour thing on a page built entirely out of quantised
// cells. These are the same marks redrawn as cells, which is what everything
// else here already is.
//
// Runs rather than ASCII art — [x, y, w, h] on the lattice. A picture made of
// strings is easier to read and much easier to get subtly wrong, and a mark
// that is one column off reads as a mistake rather than as a style.
const MARKS = {
  // Ascending bars running into a cloud: the waveform is the half that survives
  // being cut down to sixteen cells.
  soundcloud: {
    ink: [
      // bars, ascending toward the cloud
      [1, 9, 1, 3], [3, 8, 1, 4], [5, 6, 1, 6], [7, 5, 1, 7],
      // the cloud, crowned in two steps — one step read as a slab with a notch
      [11, 4, 3, 1], [10, 5, 5, 1], [9, 6, 7, 6],
    ],
    knockout: [],
  },
  // The rounded slab with a play triangle knocked out of it.
  youtube: {
    ink: [[2, 3, 12, 1], [1, 4, 14, 8], [2, 12, 12, 1]],
    knockout: [[6, 5, 2, 6], [8, 6, 2, 4], [10, 7, 1, 2]],
  },
};

const N = 16;

/**
 * @param {'soundcloud'|'youtube'} name
 * @param {number} size  rendered edge in CSS px
 */
export function ProviderMark({ name, size = 34, className = '' }) {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    const mark = MARKS[name];
    if (!canvas || !mark) return;

    const [ink, accent, wash] = levels();
    const cell = size / N;
    // Same grain as the goblin at the same size, so two marks sitting near each
    // other on one screen agree about how coarse the halftone is.
    const dcell = Math.max(1, Math.round(size / 32));

    // The lattice, resolved once: which cells are solid and which are cut out.
    const grid = Array.from({ length: N }, () => new Array(N).fill('.'));
    const stamp = (runs, ch) => {
      for (const [x, y, w = 1, h = 1] of runs) {
        for (let j = y; j < y + h && j < N; j++) {
          for (let i = x; i < x + w && i < N; i++) grid[j][i] = ch;
        }
      }
    };
    stamp(mark.ink, '#');
    stamp(mark.knockout, 'o');

    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const px = img.data;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const ch = grid[Math.min((y / cell) | 0, N - 1)][Math.min((x / cell) | 0, N - 1)];
        let c;
        if (ch === '#') c = ink;
        else if (ch === 'o') c = wash;
        else {
          // A ground that thins toward the bottom, same ramp direction as the
          // goblin's, so the two marks sit on the same light.
          const density = clamp01(0.30 - 0.22 * (y / size));
          c = density > BAYER4[((y / dcell) | 0) & 3][((x / dcell) | 0) & 3] ? accent : wash;
        }
        const i = (y * size + x) << 2;
        px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [name, size]);

  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      role="img"
      aria-label={name}
      className={`block flex-none [image-rendering:pixelated] ${className}`}
    />
  );
}
