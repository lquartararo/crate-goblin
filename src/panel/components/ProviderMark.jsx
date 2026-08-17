import { useEffect, useRef } from 'react';
import { BAYER4, clamp01 } from '../dither-kit.js';
import { roles } from '../palette.js';
import { useThemeTick } from '../useThemeTick.js';

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
      // Three bars, not four. The fourth cost a column the cloud needed more.
      [1, 10, 1, 2], [3, 9, 1, 3], [5, 7, 1, 5],
      // The cloud, eight columns wide and seven rows tall.
      //
      // It was six wide and nine tall, which is taller than it is wide — and a
      // cloud that is taller than it is wide does not read as a cloud, it reads
      // as a squashed one pressed against the frame. Nothing was being clipped;
      // the proportion was simply wrong, and no amount of rounding the corners
      // fixes that. Widening it meant giving up the fourth bar, which was the
      // cheaper thing to lose.
      //
      // Column 15 stays empty. The lattice has no bleed, so a run reaching the
      // last column genuinely is cut off by the canvas edge.
      //
      // Bars and cloud end on the same row. They did not, briefly, and a cloud
      // floating two rows above the baseline its own waveform sits on is the
      // kind of wrong that is hard to name and impossible to unsee.
      [10, 3, 3, 1], [9, 4, 5, 1], [8, 5, 7, 1], [7, 6, 8, 6],
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
  const theme = useThemeTick();

  useEffect(() => {
    const canvas = ref.current;
    const mark = MARKS[name];
    if (!canvas || !mark) return;

    const { ink } = roles();
    const cell = size / N;

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

    // The mark itself is the halftone, and everything around it is nothing.
    // Painting a dithered square and standing a solid silhouette on top had it
    // backwards: the ground was the only part carrying any texture, so the
    // marks read as logos sitting on a patterned tile rather than as artwork
    // belonging to the same system as the rest of the panel.
    //
    // The ramp only goes to 0.72. Further and the one-cell-wide bars of the
    // SoundCloud waveform come apart into loose dots at the bottom, which stops
    // reading as halftone and starts reading as a mark that failed to draw.
    for (let y = 0; y < size; y++) {
      const density = clamp01(1 - 0.28 * (y / size));
      for (let x = 0; x < size; x++) {
        const ch = grid[Math.min((y / cell) | 0, N - 1)][Math.min((x / cell) | 0, N - 1)];
        const lit = ch === '#' && density > BAYER4[y & 3][x & 3];
        const i = (y * size + x) << 2;
        if (!lit) { px[i + 3] = 0; continue; }   // knockout and ground alike
        px[i] = ink[0]; px[i + 1] = ink[1]; px[i + 2] = ink[2]; px[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [name, size, theme]);

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
