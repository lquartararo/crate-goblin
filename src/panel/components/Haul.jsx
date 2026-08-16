import { useEffect, useRef, useState } from 'react';
import { maskStyle, LEVELS } from '../ditherMask.js';

// Long enough to read a short line, short enough that it's gone before you
// reach for the mouse. The delight guidance is right that a celebration which
// outstays its welcome becomes a thing to dismiss.
const HOLD_MS = 2400;
const FADE_MS = 520;

/**
 * What the run brought back.
 *
 * Not confetti. Coloured paper over a plum halftone would read as a different
 * product bolted on, and this interface already has a vocabulary for things
 * arriving and leaving. So the haul resolves out of the dither and dissolves
 * back into it, the same way every row does.
 *
 * Only for whole runs. Firing on each track would make a twenty-track crate
 * into twenty interruptions, which is noise rather than delight.
 */
export function Haul({ tally, onDone }) {
  const [level, setLevel] = useState(LEVELS - 1);
  const raf = useRef(0);

  useEffect(() => {
    if (!tally) return;

    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setLevel(0);
      const t = setTimeout(onDone, HOLD_MS);
      return () => clearTimeout(t);
    }

    let stop = false;
    const start = performance.now();

    // In, hold, out. One loop rather than chained timeouts so an unmount
    // mid-flight leaves nothing running.
    const tick = (now) => {
      if (stop) return;
      const t = now - start;
      if (t < FADE_MS) {
        setLevel(Math.round((1 - t / FADE_MS) * (LEVELS - 1)));
      } else if (t < FADE_MS + HOLD_MS) {
        setLevel(0);
      } else if (t < FADE_MS * 2 + HOLD_MS) {
        const out = (t - FADE_MS - HOLD_MS) / FADE_MS;
        setLevel(Math.round(out * out * (LEVELS - 1)));
      } else {
        return onDone();
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { stop = true; cancelAnimationFrame(raf.current); };
  }, [tally, onDone]);

  if (!tally) return null;

  const { ok = 0, warn = 0, err = 0 } = tally;
  // Plain counts. A line that says what happened beats one that congratulates
  // you for it, and the goblin's job is to bring things back, not to cheer.
  const parts = [`${ok} ${ok === 1 ? 'track' : 'tracks'}`];
  if (warn) parts.push(`${warn} the hard way`);
  if (err) parts.push(`${err} got away`);

  return (
    <div
      style={maskStyle(level)}
      className="sticky top-0 z-20 -mt-px flex items-baseline gap-2.5 px-1 py-2
                 border-b-[1.5px] border-ink bg-paper
                 font-mono text-[11px] leading-none tracking-[.14em] uppercase"
    >
      <span className="text-accent">Haul</span>
      <span className="opacity-80">{parts.join(' · ')}</span>
    </div>
  );
}
