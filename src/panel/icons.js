// Pixel-grid icons, drawn as filled cells on a 12x12 lattice.
//
// The previous attempt used a dither pattern as the *stroke* paint, which was a
// misunderstanding of what dithering is. Dithering varies coverage across an
// area to fake intermediate tone; a 2.5px line has no area to vary, so
// patterning it just deleted random chunks of the line. It didn't read as
// halftone, it read as broken — which is what "kinda weird" was.
//
// Filled cells on a coarse grid get to the same place honestly: hard edges, no
// anti-aliasing, visibly quantised, and it sits in the same 1-bit family as the
// dithered artwork without pretending to be something it isn't. It also scales
// cleanly, because everything lands on integer coordinates.

const GRID = 12;

// Each icon is a list of [x, y] cells, optionally [x, y, w, h] for runs.
const CELLS = {
  // Arrow into a tray — "it's yours, take it".
  free: [
    [5, 1, 2, 5], [3, 4, 2, 2], [7, 4, 2, 2], [4, 6, 4, 2],
    [1, 9, 10, 2],
  ],
  // Padlock, shackle open on one side — a formality, not a vault.
  gated: [
    [3, 1, 2, 2], [5, 0, 3, 2], [8, 2, 2, 3],
    [2, 5, 8, 6], [5, 7, 2, 2],
  ],
  // Waveform — signal, no file.
  stream: [
    [0, 5, 2, 2], [2, 3, 1, 6], [3, 1, 1, 10], [4, 4, 1, 4],
    [5, 0, 1, 12], [6, 4, 1, 4], [7, 2, 1, 8], [8, 5, 1, 2],
    [9, 3, 1, 6], [10, 5, 2, 2],
  ],
  // A note. Money is involved.
  //
  // Was a shopfront awning, which rendered as a solid 10x10 slab: its door was
  // drawn in the same ink as its body, and these icons have no knockout, so the
  // one piece of internal structure was invisible. Every other glyph here reads
  // by its negative space — the arrow's stem, the padlock's shackle, the gaps
  // in the waveform — and that one had none.
  // Two cells thick, like the padlock's body and the arrow's stem. At one cell
  // it was a hairline outline sitting next to glyphs built from solid masses,
  // which read as a different icon set rather than a different icon.
  store: [
    [1, 2, 10, 2], [1, 8, 10, 2], [1, 4, 2, 4], [9, 4, 2, 4], [4, 5, 4, 2],
  ],
  // Two diagonals. `error` is a single one and reads as a slash, which is a
  // different thing to say.
  close: [
    [1, 1, 2, 2], [3, 3, 2, 2], [5, 5, 2, 2], [7, 7, 2, 2], [9, 9, 2, 2],
    [9, 1, 2, 2], [7, 3, 2, 2], [3, 7, 2, 2], [1, 9, 2, 2],
  ],
  check: [[1, 6, 2, 2], [3, 8, 2, 2], [5, 6, 2, 2], [7, 4, 2, 2], [9, 2, 2, 2]],
  error: [
    [1, 1, 2, 2], [3, 3, 2, 2], [5, 5, 2, 2], [7, 7, 2, 2], [9, 9, 2, 2],
    [9, 1, 2, 2], [7, 3, 2, 2], [3, 7, 2, 2], [1, 9, 2, 2],
  ],
  warn: [
    [5, 0, 2, 2], [4, 2, 4, 2], [3, 4, 6, 2], [2, 6, 8, 2], [1, 8, 10, 2],
    [0, 10, 12, 2],
  ],
  clock: [
    [4, 0, 4, 2], [2, 2, 2, 2], [8, 2, 2, 2], [0, 4, 2, 4], [10, 4, 2, 4],
    [2, 8, 2, 2], [8, 8, 2, 2], [4, 10, 4, 2], [5, 3, 2, 4], [7, 5, 2, 2],
  ],
  download: [
    [5, 0, 2, 6], [3, 4, 2, 2], [7, 4, 2, 2], [4, 6, 4, 2],
    [0, 10, 12, 2],
  ],
  gate: [
    [5, 0, 2, 2], [1, 2, 10, 2], [1, 4, 2, 8], [9, 4, 2, 8],
    [4, 7, 4, 5],
  ],
  crate: [
    [0, 2, 12, 2], [0, 4, 2, 8], [10, 4, 2, 8], [0, 10, 12, 2],
    [4, 0, 4, 2], [4, 6, 4, 2],
  ],
  expand: [
    [7, 0, 5, 2], [10, 2, 2, 3], [6, 3, 2, 2], [4, 5, 2, 2],
    [0, 10, 5, 2], [0, 7, 2, 3], [4, 7, 2, 2], [6, 5, 2, 2],
  ],
  mail: [
    [0, 2, 12, 2], [0, 4, 2, 6], [10, 4, 2, 6], [0, 10, 12, 2],
    [2, 4, 2, 2], [8, 4, 2, 2], [4, 6, 4, 2],
  ],
  disc: [
    [4, 0, 4, 2], [2, 2, 2, 2], [8, 2, 2, 2], [0, 4, 2, 4], [10, 4, 2, 4],
    [2, 8, 2, 2], [8, 8, 2, 2], [4, 10, 4, 2], [5, 5, 2, 2],
  ],
};

const rects = (cells) =>
  cells
    .map(([x, y, w = 1, h = 1]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`)
    .join('');

export const ICONS = Object.fromEntries(
  Object.entries(CELLS).map(([name, cells]) => [
    name,
    // shape-rendering: crispEdges keeps the cells from being anti-aliased into
    // grey mush at small sizes, which is the whole point of drawing them this way.
    `<svg viewBox="0 0 ${GRID} ${GRID}" aria-hidden="true" focusable="false"
          fill="currentColor" shape-rendering="crispEdges">${rects(cells)}</svg>`,
  ]),
);

/** Render an icon at a given pixel size. */
export const icon = (name, size = 16) =>
  `<span class="icon" style="--icon-size:${size}px">${ICONS[name] ?? ''}</span>`;

// Kept as a no-op export so callers that injected the old pattern defs keep
// working; the pixel glyphs need no document-level definitions.
export const DITHER_DEFS = '';
