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
// Each mark carries its own lattice, because the two logos are not the same
// shape and one grid cannot serve both. Forcing YouTube onto SoundCloud's wide
// grid stretched a near-square badge into a letterbox; forcing SoundCloud onto
// YouTube's square one squashed the cloud. That was the whole of the problem
// across several attempts.
const MARKS = {
  soundcloud: {
    cols: 36,
    rows: 16,
    // Drawn from the real mark rather than from memory. Two things make it
    // recognisable and neither was there before:
    //
    //   the cloud has a flat vertical left edge where the waveform meets it,
    //   not a rounded crown sitting on a box;
    //
    //   its top domes, then DIPS, then rises again into a smaller right lobe
    //   before falling away. Without that dip it is a hill, which is what every
    //   previous attempt drew.
    //
    // The bars are lozenges in the original. At two cells they read as bars,
    // which is as close as this resolution gets and closer than one cell, where
    // the halftone eats them.
    ink: [
      [0, 7, 2, 3], [3, 6, 2, 5], [6, 5, 2, 7],
      [9, 4, 2, 9], [12, 3, 2, 10], [15, 3, 2, 10],
      // cloud, column by column: the profile is the shape
      [19, 4, 1, 9], [20, 3, 1, 10], [21, 2, 1, 11], [22, 2, 1, 11],
      [23, 2, 1, 11], [24, 2, 1, 11], [25, 3, 1, 10], [26, 4, 1, 9],
      [27, 5, 1, 8], [28, 5, 1, 8],
      [29, 4, 1, 9], [30, 4, 1, 9], [31, 4, 1, 9], [32, 5, 1, 8],
      [33, 6, 1, 7], [34, 7, 1, 5],
    ],
    knockout: [],
  },
  youtube: {
    // Square, as it was. The badge is near enough to square that widening it
    // reads as a stretched logo rather than a wide one.
    cols: 16,
    rows: 16,
    ink: [[2, 3, 12, 1], [1, 4, 14, 8], [2, 12, 12, 1]],
    knockout: [[6, 5, 2, 6], [8, 6, 2, 4], [10, 7, 1, 2]],
  },
};

/**
 * @param {'soundcloud'|'youtube'} name
 * @param {number} height  rendered height in CSS px; the width follows the mark
 *
 * Sized by height rather than width, so a wide mark and a square one sit at the
 * same weight in a row instead of one towering over the other.
 */
export function ProviderMark({ name, height = 22, className = '' }) {
  const ref = useRef(null);
  const theme = useThemeTick();

  const { cols: COLS, rows: ROWS } = MARKS[name] ?? MARKS.youtube;
  const width = Math.round((height * COLS) / ROWS);

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
  }, [name, width, height, COLS, ROWS, theme]);

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
