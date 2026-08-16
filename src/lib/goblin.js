// The mark, as cells rather than a picture.
//
// Same 16x16 lattice the toolbar icon is cut from and the same one icons.js
// draws its glyphs on, so the brand mark and the interface come out of one
// system instead of an illustration being pasted next to a pixel-art UI.
//
// Lives here rather than beside the panel component because the injected
// buttons on SoundCloud and YouTube draw it too, and a mark defined twice is a
// mark that eventually differs in one place.
//
//   #  silhouette      o  knockout (eyes, teeth)      .  halftone ground
export const CELLS = [
  '................', '.#............#.', '..##........##..', '..###......###..',
  '..##..####..##..', '..##.######.##..', '...##########...', '...##########...',
  '...##########...', '...##########...', '...##########...', '...##########...',
  '...#oooooooo#...', '...#o#oo#o#o#...', '....########....', '......#oo#......',
];

export const N = CELLS.length;

// Sockets in cell coordinates. Three wide so a one-cell pupil has somewhere to
// go: at the original two, "looking left" and "looking right" were the same
// picture. Only the panel uses these — the injected buttons draw a still mark.
export const EYES = [{ x: 4, y: 8, w: 3, h: 2 }, { x: 9, y: 8, w: 3, h: 2 }];

/**
 * The mark as a data URI, drawn once and reused.
 *
 * The injected buttons appear once per track, so on a playlist that is fifty of
 * them. Fifty canvases — let alone fifty pointer listeners and paint loops for
 * the panel's eye tracking — is a real cost on someone else's page while audio
 * is playing. One paint, one string, shared by every button on the page.
 *
 * Knockouts are left transparent rather than painted, so the eyes and teeth are
 * whatever the button is sitting on. That is what makes it a face at 16px.
 *
 * The eyes have to be stamped in rather than read off CELLS: the panel paints
 * them separately so the pupils can track the cursor, so the lattice on its own
 * is a goblin with a mouth and no eyes.
 *
 * @param {string} colour  the silhouette, usually the button's own text colour
 */
export function markDataUrl(colour, cellPx = 2) {
  const grid = CELLS.map((row) => [...row]);
  for (const eye of EYES) {
    for (let j = eye.y; j < eye.y + eye.h; j++) {
      for (let i = eye.x; i < eye.x + eye.w; i++) grid[j][i] = 'o';
    }
    grid[eye.y][eye.x + 1] = '#';   // pupil, looking straight at you
  }

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = N * cellPx;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = colour;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (grid[y][x] === '#') ctx.fillRect(x * cellPx, y * cellPx, cellPx, cellPx);
    }
  }
  return canvas.toDataURL();
}
