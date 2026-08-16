import { useEffect, useRef } from 'react';
import { loadBitmap, revealDither, liftDither, CELL } from '../dither.js';
import { levels } from '../palette.js';

// The tile's on-screen size in CSS px.
const BOX = 64;
// ...and its backing resolution, in dither cells — one canvas pixel per cell,
// drawn 1:1. This was 128 before, shrunk by CSS into the 64px box, which
// averaged every cell into its neighbours and turned the crosshatch to mush:
// all the cost of dithering, none of the look.
const SIZE = Math.round(BOX / CELL);

/**
 * Dithered artwork.
 *
 * Painted through a ref rather than as JSX: the canvas holds pixels, not
 * markup, and React has no business re-running a quantisation pass every time a
 * sibling's status text changes. The effect is keyed to the artwork URL alone,
 * so a row that re-renders mid-download doesn't flicker.
 */
export function Thumb({ src, alt = '' }) {
  const ref = useRef(null);
  // Held so hover can requantise without re-fetching. Cleared with the URL.
  const bitmapRef = useRef(null);
  const paletteRef = useRef(null);
  const intensityRef = useRef(0);
  const cancelRef = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const palette = levels();
    paletteRef.current = palette;
    // The flag has to be on *this* call, not just dither.js's. A canvas keeps
    // the attributes from whichever getContext() ran first and silently ignores
    // them on every later call — so this plain request was overriding the one
    // in dither.js and pushing each tile onto the GPU-backed path, only for
    // getImageData to read it straight back. Across a 300-track crate that's
    // 300 needless readbacks.
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // A flat ink tile is the resting state and the failure state both — it's
    // on-palette, so a track with no artwork needs no placeholder image.
    ctx.fillStyle = `rgb(${palette[0].join(',')})`;
    ctx.fillRect(0, 0, SIZE, SIZE);

    bitmapRef.current = null;
    intensityRef.current = 0;
    if (!src) return;

    let cancelled = false;
    loadBitmap(src)
      .then(async (bitmap) => {
        if (cancelled) return;
        bitmapRef.current = bitmap;
        await revealDither(bitmap, canvas, { levels: palette });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      cancelRef.current?.();
      cancelRef.current = null;
    };
  }, [src]);

  function lift(to) {
    const bitmap = bitmapRef.current;
    const canvas = ref.current;
    if (!bitmap || !canvas) return;
    cancelRef.current?.();
    cancelRef.current = liftDither(
      bitmap,
      canvas,
      { levels: paletteRef.current, intensity: intensityRef.current },
      { to, onValue: (v) => { intensityRef.current = v; } }
    );
  }

  return (
    <span
      className="block w-16 h-16 flex-none"
      onPointerEnter={() => lift(1)}
      onPointerLeave={() => lift(0)}
    >
      <canvas
        ref={ref}
        width={SIZE}
        height={SIZE}
        role="img"
        aria-label={alt}
        className="block w-16 h-16 rounded-[2px] [image-rendering:pixelated]
                   transition-transform duration-150 group-hover:scale-[1.04]"
      />
    </span>
  );
}
