import { useEffect, useRef } from 'react';
import { paintMeter } from '../meter.js';
import { prefersReducedMotion } from '../dither-kit.js';
import { duotone } from '../palette.js';

/**
 * A dithered progress bar.
 *
 * Strictly two-tone: a cell is lit or it isn't. Intermediate levels work on a
 * photograph, where the eye resolves them back into an image, but here there's
 * nothing to resolve them into and they'd read as a rendering fault.
 *
 * Used at both scales — the thin bar under a working row and the full-width one
 * across the top — because one texture for one idea beats two that nearly
 * match.
 */
export function Meter({ progress = null, cell = 2, className = '' }) {
  const ref = useRef(null);
  // Read through a ref so a progress change doesn't tear down the loop and
  // restart the animation clock on every segment that lands.
  const value = useRef(progress);
  value.current = progress;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const { ink } = duotone();

    let raf = 0;
    let size = { width: 0, height: 0 };
    const measure = () => {
      const r = canvas.getBoundingClientRect();
      size = { width: r.width, height: r.height };
    };
    measure();

    const paint = (t) =>
      paintMeter(canvas, size.width, size.height, { ink, progress: value.current, t, cell });

    if (prefersReducedMotion()) {
      // Still has to repaint when the value moves — it just doesn't shimmer.
      paint(0);
      const id = setInterval(() => paint(0), 250);
      const ro = new ResizeObserver(() => { measure(); paint(0); });
      ro.observe(canvas);
      return () => { clearInterval(id); ro.disconnect(); };
    }

    const started = performance.now();
    const tick = (now) => {
      paint((now - started) / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const ro = new ResizeObserver(measure);
    ro.observe(canvas);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [cell]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      // width:100% is explicit because canvas is a *replaced* element: an
      // absolutely positioned replaced box with width:auto uses its intrinsic
      // size and ignores left/right entirely, which left this 4px wide.
      className={`block w-full [image-rendering:pixelated] pointer-events-none ${className}`}
    />
  );
}
