# Design

Two-tone plum on blush, everything halftoned. Committed color strategy: the
accent carries the surface rather than sitting in a 10% corner.

## Color

Defined once, in `src/panel/theme.css`, and read from there by the canvas code
so a palette change can't drift between CSS and pixels.

| token | value | role |
|---|---|---|
| `--color-ink` | `#1d1219` | text, rules, the dark end of every dither |
| `--color-accent` | `#7a1e4b` | plum. Fills, links, the lit half of the halftone |
| `--color-wash` | `#f0d8e4` | zebra rows, hover, the light end of the dither |
| `--color-paper` | `#f6edf0` | blush ground |
| `--color-warn` | `#8a5a0f` | away from plum in hue, not just lightness |
| `--color-err` | `#c0261c` | same reason |

Warn and err are deliberately off-hue from the accent because they sit in the
status column directly beside accent-coloured text and have to separate at a
glance.

Light only. See the anti-references in PRODUCT.md.

## Typography

**Redaction** (Titus Kaphar / Reginald Dwayne Betts, via Forest Young), all
three cuts. The family degrades progressively from clean to heavily halftoned,
which is the same move the artwork dithering makes, done in type.

- `--font-display` Redaction 35, masthead only
- `--font-sans` Redaction, anything you actually read
- `--font-mono` Redaction, status and labels

Identity-preserving: this was chosen deliberately and isn't up for a reflex
re-pick.

## Halftone

The house texture, and the thing every surface is built from. One 4×4 Bayer
matrix in `src/panel/dither-kit.js` (vendored from Dither Kit, MIT) feeds all
of it, so artwork, progress and background read as one material.

- **Artwork** quantises to the four palette tones. Four levels, not two: at two,
  every midtone collapses and a photo stops being readable.
- **Never resample a dithered canvas.** Size it in cells and draw 1:1. Halving
  a Bayer field averages each cell into its neighbours and destroys the pattern,
  which is all cost and no texture.
- **Progress** is strictly two-tone, with the edge exactly at the value. The
  texture carries the motion; the boundary never moves to decorate.
- **Wash** drifts on a 14s cycle by displacing the dissolve edge, so cells wink
  along the falloff instead of the field crawling.
- Below roughly 32px there aren't enough pixels for a cell to read as texture
  rather than noise. Small icons go flat. Same mark, no fake grain.

## Motion

Reveal eases out, exit eases in: a picture should land fast and leave decisively.
Artwork dissolves by sweeping dither bias until every cell quantises to paper,
so things disappear in the same language they arrived in. All of it respects
`prefers-reduced-motion`.

## Icon

A goblin head as filled cells on a 16×16 lattice, matching `src/panel/icons.js`,
which draws its glyphs the same way. Ears sit clear of the skull with a shallow
notch; merging them into a V reads as a bat, which the first three drafts did.
