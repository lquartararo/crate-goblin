// Shared seed palette for the dither chart family. Mirrors the seeds in
// `dither-chart.tsx` so a series rendered through the composable engine reads
// with the exact same fill / line / star hues as the legacy sparkline.

export type Rgb = [number, number, number]

export type DitherColor =
  | "crate"
  | "crate2"
  | "crate3"
  | "crate4"
  | "crate5"
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "orange"
  | "red"
  | "grey"

export type Seed = { fill: Rgb; line: Rgb; star: Rgb }

// Each seed: the area-fill hue, the bright series line, and the star sparkle.
export const PALETTE: Record<DitherColor, Seed> = {
  // LOCAL ADDITION. The stock seeds are saturated hues for a dark UI; this
  // panel is plum on blush, and a chart in someone else's brand colours reads
  // as an embed rather than as part of the page. Taken from --color-accent and
  // --color-ink in theme.css, so a change there is a one-line change here.
  crate: { fill: [122, 30, 75], line: [29, 18, 25], star: [240, 216, 228] },
  // A tonal family rather than five hues. A pie needs its slices told apart and
  // the stock seeds are saturated colours for a dark UI — dropping them in
  // would make one chart the only place this palette does not apply. These walk
  // from the ink to the wash through the accent, which is the range the rest of
  // the interface already uses.
  crate2: { fill: [29, 18, 25], line: [122, 30, 75], star: [240, 216, 228] },
  crate3: { fill: [168, 74, 118], line: [122, 30, 75], star: [246, 237, 240] },
  crate4: { fill: [88, 52, 70], line: [29, 18, 25], star: [240, 216, 228] },
  crate5: { fill: [206, 140, 174], line: [122, 30, 75], star: [246, 237, 240] },
  green: { fill: [40, 210, 110], line: [150, 255, 180], star: [200, 255, 220] },
  blue: { fill: [53, 143, 243], line: [150, 200, 255], star: [205, 228, 255] },
  purple: {
    fill: [150, 110, 255],
    line: [200, 175, 255],
    star: [225, 210, 255],
  },
  pink: { fill: [240, 90, 190], line: [255, 170, 220], star: [255, 205, 235] },
  orange: {
    fill: [255, 150, 50],
    line: [255, 195, 130],
    star: [255, 220, 175],
  },
  red: { fill: [240, 70, 70], line: [255, 150, 140], star: [255, 195, 185] },
  // No-data: a muted grey so empty metrics read as "nothing here".
  grey: { fill: [92, 92, 100], line: [140, 140, 150], star: [165, 165, 175] },
}

export const rgb = ([r, g, b]: Rgb, k = 1, a = 1) =>
  `rgba(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)},${a})`

export const seedOfColor = (color: DitherColor): Seed => PALETTE[color]

export const isDitherColor = (value: unknown): value is DitherColor =>
  typeof value === "string" && value in PALETTE
