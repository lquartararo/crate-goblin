import { useEffect, useState } from 'react';
import { THEME_EVENT } from './themes.js';

/**
 * A counter that changes when the palette does.
 *
 * Canvas components read the theme once, at paint time, and a CSS variable
 * changing underneath them is invisible — the pixels are already written. Put
 * this in the paint effect's deps and the theme picker repaints them.
 */
export function useThemeTick() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    addEventListener(THEME_EVENT, bump);
    return () => removeEventListener(THEME_EVENT, bump);
  }, []);
  return tick;
}
