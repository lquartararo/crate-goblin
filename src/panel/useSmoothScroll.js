import { useEffect } from 'react';
import Lenis from 'lenis';

/**
 * Smooth scrolling for the panel.
 *
 * A side panel is a tall narrow column that gets flicked through, and the
 * native jump between wheel steps is the one place this interface still felt
 * like a browser chrome surface rather than something built.
 *
 * Off entirely under reduced motion. Smooth scrolling is exactly the kind of
 * hijacking that setting exists to refuse, and Lenis running with its easing
 * neutered is worse than not running: it still intercepts the wheel, it just
 * stops paying you back for it.
 */
export function useSmoothScroll() {
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const lenis = new Lenis({
      // Short. The panel is a list you scan, not a landing page you're being
      // walked through, and a long glide means overshooting the row you wanted.
      duration: 0.75,
      // Exponential ease-out, matching the motion rule the rest of the panel
      // follows. No bounce: nothing here should feel springy.
      easing: (t) => 1 - Math.pow(1 - t, 4),
      // Trackpads already produce smooth deltas. Smoothing them again is what
      // makes Lenis feel laggy on a Mac rather than fluid.
      syncTouch: true,
      smoothWheel: true,
    });

    let raf = 0;
    const tick = (time) => {
      lenis.raf(time);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
    };
  }, []);
}
