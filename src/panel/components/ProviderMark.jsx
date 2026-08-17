import { useEffect, useRef } from 'react';
import { BAYER4, clamp01 } from '../dither-kit.js';
import { roles } from '../palette.js';
import { useThemeTick } from '../useThemeTick.js';

// Provider marks, drawn as cells and dithered like everything else here.
//
// Rebuilt from scratch after several attempts that all failed the same two
// ways, both decided before a single cell was drawn:
//
//   The grid was square. The SoundCloud logo is about two and a half times
//   wider than it is tall, so a 16x16 lattice left the cloud narrower than it
//   was deep — which reads as a cloud squashed against the frame however its
//   corners are rounded. Adjusting runs cannot fix an aspect ratio, and four
//   goes at rounding corners never touched the actual problem. Each mark
//   carries its own dimensions now.
//
//   The features were one cell wide. A halftone works by removing coverage, so
//   a one-cell bar loses half of itself and becomes a dotted line — the
//   waveform was disintegrating by design. Nothing here is thinner than two
//   cells, which is what lets the dither read as texture rather than as damage.
//
// 32 x 14, so the waveform can be bars rather than hints.
const COLS = 32;
const ROWS = 14;

const MARKS = {
  soundcloud: {
    ink: [
      // Four bars, two cells wide with a gap, ascending toward the cloud.
      [0, 10, 2, 4], [3, 8, 2, 6], [6, 6, 2, 8], [9, 4, 2, 10],
      // The cloud: a crown in three steps onto a body that ends on the same
      // baseline as the bars. Wider than it is tall, which is the whole point.
      [19, 2, 7, 1], [17, 3, 11, 1], [15, 4, 15, 1], [14, 5, 17, 9],
    ],
    knockout: [],
  },
  youtube: {
    // The play triangle is knocked out rather than drawn, so the hole shows
    // whatever the mark sits on — one silhouette instead of two shapes.
    ink: [[3, 1, 26, 1], [1, 2, 30, 10], [3, 12, 26, 1]],
    knockout: [[12, 4, 3, 6], [15, 5, 3, 4], [18, 6, 2, 2]],
  },
};

/**
 * @param {'soundcloud'|'youtube'} name
 * @param {number} width  rendered width in CSS px; the height follows the lattice
 */
export function ProviderMark({ name, width = 44, className = '' }) {
  const ref = useRef(null);
  const theme = useThemeTick();

  const height = Math.round((width * ROWS) / COLS);

  useEffect(() => {
    const canvas = ref.current;
    const mark = MARKS[name];
    if (!canvas || !mark) return;

    const { ink } = roles();
    const cell = width / COLS;

    const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill('.'));
    const stamp = (runs, ch) => {
      for (const [x, y, w = 1, h = 1] of runs) {
        for (let j = y; j < y + h && j < ROWS; j++) {
          for (let i = x; i < x + w && i < COLS; i++) grid[j][i] = ch;
        }
      }
    };
    stamp(mark.ink, '#');
    stamp(mark.knockout, 'o');

    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(width, height);
    const px = img.data;

    for (let y = 0; y < height; y++) {
      // A shallow ramp. The mark is the halftone and the ground is nothing, so
      // this is the whole texture — but much below this the two-cell features
      // start losing rows and it stops looking deliberate.
      const density = clamp01(1 - 0.26 * (y / height));
      for (let x = 0; x < width; x++) {
        const ch = grid[Math.min((y / cell) | 0, ROWS - 1)][Math.min((x / cell) | 0, COLS - 1)];
        const lit = ch === '#' && density > BAYER4[y & 3][x & 3];
        const i = (y * width + x) << 2;
        if (!lit) { px[i + 3] = 0; continue; }   // knockout and ground alike
        px[i] = ink[0]; px[i + 1] = ink[1]; px[i + 2] = ink[2]; px[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [name, width, height, theme]);

  return (
    <canvas
      ref={ref}
      width={width}
      height={height}
      role="img"
      aria-label={name}
      className={`block flex-none [image-rendering:pixelated] ${className}`}
    />
  );
}
