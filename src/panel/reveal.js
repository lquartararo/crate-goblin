// Text that resolves out of scrambled glyphs.
//
// Borrowed from Canvas UI's "Decrypt Reveal", rebuilt in plain JS. The library
// itself can't ship here: it needs Chrome's html-in-canvas API, which is behind
// a flag or a production origin trial, and an origin trial token binds to a web
// origin — a chrome-extension:// page gets a random per-install id, so no token
// would ever match. It also wants a bundler and a framework. The effect,
// though, is forty lines and no dependency.

// Plain ASCII, no block-drawing characters. Redaction is already a halftoned
// face, so block glyphs render as solid slabs — the scramble stopped reading as
// "text resolving" and started reading as a broken font. Letterforms of roughly
// the title's own width keep the effect legible as type throughout.
// Letters only. Punctuation in a halftoned face reads as noise rather than as
// text mid-resolve — and since the title is already the hardest thing on the
// page to read, the animation shouldn't be making it briefly harder still.
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const pick = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];

/**
 * Scramble `el`'s text, then settle it left-to-right into `text`.
 *
 * Characters lock in progressively rather than all at once, so the word reads
 * as arriving rather than flickering. Spaces are never scrambled — losing the
 * word boundaries makes it look like noise instead of text.
 *
 * @param {HTMLElement} el
 * @param {string} text
 * @param {object} opts  speed: ms per frame, settle: frames a char churns for
 */
// Deliberately brief. The title is the playlist name — the one thing you opened
// the panel to read — so a long scramble is withholding information and calling
// it delight. ~500ms reads as intentional without making you wait for it.
export function decrypt(el, text, { speed = 18, settle = 5 } = {}) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = text;
    return Promise.resolve();
  }

  const chars = [...text];
  // Stagger each character's lock-in point across the run.
  const lockAt = chars.map((_, i) => i * 1.15 + Math.random() * settle);
  const total = Math.max(...lockAt, 0) + settle;

  return new Promise((resolve) => {
    let frame = 0;
    const tick = () => {
      el.textContent = chars
        .map((c, i) => (c === ' ' ? ' ' : frame >= lockAt[i] ? c : pick()))
        .join('');

      if (++frame > total) {
        el.textContent = text;      // guarantee the exact string lands
        return resolve();
      }
      setTimeout(tick, speed);
    };
    tick();
  });
}

/**
 * Roll a number up to its value. Used for the bucket counts, where the figure
 * is the point — a scramble would obscure it while it's still readable.
 */
export function countTo(el, value, { duration = 520 } = {}) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || value <= 0) {
    el.textContent = String(value);
    return;
  }

  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = String(Math.round(value * eased));
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = String(value);
  };
  requestAnimationFrame(step);
}
