import { useEffect, useRef } from 'react';
import { paintGradient, prefersReducedMotion } from '../dither-kit.js';
import { roles } from '../palette.js';
import { useThemeTick } from '../useThemeTick.js';

// Repaint rate for the drift.
//
// Not 60fps, on purpose. The motion is a slow breath — at 60 it costs three
// times as much for a change too small to perceive between frames, behind text
// someone is trying to read. 20 is past the point where it stops reading as
// steps.
const FPS = 20;

/**
 * A dithered gradient wash.
 *
 * The panel's surfaces were flat while only the artwork and the progress bar
 * were dithered, which read as two decorated objects sitting on plain paper.
 * This puts the texture into the ground itself: a solid edge dissolving into
 * scattered cells, rather than the smooth ramp a CSS gradient would give.
 *
 * Drifts rather than sitting still. Theirs is explicitly static — a background
 * you paint once — but static is what made this read as wallpaper.
 */
export function Wash({
  direction = 'down',
  // Named, not an index. It used to index the levels() ramp, which is sorted by
  // luminance — so on a dark theme the same number picked a different colour and
  // the masthead wash came out in the wrong one.
  tone = 'accent',
  cell = 3,
  opacity = 0.28,
  amplitude = 0.07,  // how far the dissolve edge travels
  period = 14,       // seconds for one full breath
  className = '',
}) {
  const ref = useRef(null);
  const theme = useThemeTick();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const from = roles()[tone] ?? roles().accent;

    let raf = 0;
    let last = 0;
    let size = { width: 0, height: 0 };

    const paint = (phase) => {
      paintGradient(canvas, size.width, size.height, {
        from, direction, cell, opacity, phase,
      });
    };

    const measure = () => {
      const { width, height } = canvas.getBoundingClientRect();
      size = { width, height };
    };
    measure();

    if (prefersReducedMotion()) {
      paint(0);
    } else {
      const started = performance.now();
      const tick = (now) => {
        raf = requestAnimationFrame(tick);
        if (now - last < 1000 / FPS) return;
        last = now;
        paint(amplitude * Math.sin(((now - started) / 1000) * (2 * Math.PI / period)));
      };
      raf = requestAnimationFrame(tick);
    }

    // The panel is a side panel — the user drags it wider constantly, and a
    // wash measured once would stay at its first width and stretch.
    const ro = new ResizeObserver(() => { measure(); if (raf === 0) paint(0); });
    ro.observe(canvas);

    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [direction, tone, cell, opacity, amplitude, period, theme]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className={`absolute inset-0 w-full h-full block pointer-events-none
                  [image-rendering:pixelated] ${className}`}
    />
  );
}
