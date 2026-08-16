import { useEffect, useState } from 'react';
import { BUCKET } from '../../lib/triage.js';
import { icon } from '../icons.js';
import { Thumb } from './Thumb.jsx';
import { Meter } from './Meter.jsx';
import { cn } from '../ui/cn.js';
import { maskStyle, LEVELS } from '../ditherMask.js';

const BUCKET_META = {
  [BUCKET.FREE]: ['free', 'Free'],
  [BUCKET.GATED]: ['gated', 'Gate'],
  [BUCKET.STREAM]: ['stream', 'Stream'],
};

const STATUS_ICON = { ok: 'check', warn: 'warn', err: 'error', working: 'clock' };

const Glyph = ({ name, size = 15 }) => (
  <span className="inline-flex flex-none" style={{ width: size, height: size }}
        dangerouslySetInnerHTML={{ __html: icon(name, size) }} />
);

const fmtTime = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function Badge({ row }) {
  const isStore = row.kind === 'store' || row.kind === 'smartlink';
  const [glyph, label] = BUCKET_META[row.bucket];
  const name = isStore ? 'store' : glyph;
  const text = isStore ? (row.kind === 'store' ? 'Store' : 'Link') : label;

  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 whitespace-nowrap px-2.5 py-1',
      'rounded-pill border-[1.5px] border-current label-caps text-[9px] tracking-[.14em]',
      row.bucket === BUCKET.FREE && 'bg-accent border-accent text-paper',
      row.bucket === BUCKET.GATED && 'text-accent',
      row.bucket === BUCKET.STREAM && 'bg-wash border-transparent',
    )}>
      <Glyph name={name} size={15} />
      <span>{text}</span>
    </span>
  );
}

function Status({ job, crateTitle }) {
  if (!job) return <div className="min-w-0" />;

  // A job belonging to another crate says so — otherwise a row that's
  // mysteriously already downloading reads as a bug rather than as the queue
  // doing exactly what it was built to do.
  const from = job.crate && job.crate !== crateTitle ? ` · from ${job.crate}` : '';

  return (
    <div className={cn(
      'flex items-start justify-end gap-2 min-w-0 text-right',
      'font-mono text-[11px] leading-[1.3] tracking-[.05em] uppercase tabular-nums',
      job.cls === 'ok' && 'text-accent',
      job.cls === 'warn' && 'text-warn',
      job.cls === 'err' && 'text-err',
      job.cls === 'working' && 'opacity-85',
    )}>
      <span className={cn('inline-flex flex-none mt-px', job.cls === 'working' && 'animate-pulse')}>
        <Glyph name={STATUS_ICON[job.cls] ?? 'clock'} size={16} />
      </span>
      {/* anywhere, not break-word: a failure can carry a signed URL that is one
          continuous token, and only `anywhere` will break inside it. Clamped so
          a long one can't grow the row past the artwork beside it. */}
      <span className="min-w-0 [overflow-wrap:anywhere] line-clamp-3">
        {job.text}{from}
      </span>
    </div>
  );
}

// Matches the removal timer in useJobs — the row has to be gone from the DOM
// no earlier than the mask finishes eating it.
const DISSOLVE_MS = 620;

/**
 * Step the dither mask 0 -> fully dissolved once the row is retired.
 *
 * Returns null while the row is staying put, so a row that never leaves carries
 * no mask at all — masking is compositor work, and there's no reason to pay it
 * on every row in a long crate for an effect that isn't running.
 */
function useDitherOut(leaving) {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!leaving) return setLevel(0);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return setLevel(LEVELS - 1);

    let raf = 0;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / DISSOLVE_MS);
      // Eased so the cells thin slowly and then go — a linear ramp reads as a
      // wipe rather than something dissolving.
      setLevel(Math.round(t * t * (LEVELS - 1)));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [leaving]);

  return leaving ? maskStyle(level) : null;
}

export function Row({ row, job, crateTitle }) {
  const busy = job?.cls === 'working';
  const leaving = Boolean(job?.leaving);
  const mask = useDitherOut(leaving);

  return (
    <div className={cn(
      'group relative grid items-center gap-4.5 p-3 rounded-[3px]',
      // No checkbox column any more: the list is the queue, so everything in it
      // is already going. Choosing what to download happens on the SoundCloud
      // page, which is where the tracks actually are.
      //
      // Both flexible columns are bounded. `auto` on the status let a long
      // failure — they carry a signed URL with no spaces in it, so nothing can
      // wrap — size the column to that one unbreakable token and squeeze the
      // title to a word per line. minmax(0,…) is what actually permits a grid
      // item to shrink below its content; `1fr` alone does not.
      'grid-cols-[64px_minmax(0,1fr)_minmax(0,30%)]',
      'border-b-[1.5px] border-ink/15 transition-colors duration-150',
      // Zebra and hover as fills, never inversion: flipping the whole row would
      // change the artwork outline and badge colour on every mouse move.
      'even:bg-wash/40 hover:bg-wash',
      // The exit. The dither mask above eats the whole block — text, badges,
      // artwork alike — while this collapses the space it occupied so the rows
      // below close the gap rather than jumping. No opacity fade: the mask is
      // doing the disappearing, and a fade on top of it just muddies the cells.
      leaving && 'overflow-hidden !p-0 !max-h-0 !border-transparent',
      'max-h-[140px] transition-[max-height,padding] duration-[620ms] ease-in',
    )} style={mask ?? undefined}>
      <Thumb src={row.artwork} alt="" />

      <div className="min-w-0">
        <div className="font-sans text-[17px] leading-[1.25] transition-colors duration-150
                        group-hover:text-accent">
          {row.title}
        </div>
        <div className="flex flex-wrap items-center gap-2.5 mt-1.5 opacity-75
                        font-mono text-[11px] leading-none tracking-[.08em] uppercase">
          <Badge row={row} />
          <span>{row.artist}</span>
          <span>{fmtTime(row.durationMs)}</span>
          {row.genre && <span>{row.genre}</span>}
          {row.bucket === BUCKET.GATED && row.url && (
            <a href={row.url} target="_blank" rel="noreferrer"
               className="text-accent no-underline border-b border-current hover:opacity-65">
              {row.label ?? 'Buy'}
            </a>
          )}
          {row.previewOnly && <span>Go+ preview only</span>}
          {row.drmOnly && <span className="text-err">DRM only</span>}
        </div>
      </div>

      <Status job={job} crateTitle={crateTitle} />
      {busy && (
        <Meter
          progress={job.progress ?? null}
          className="absolute left-0 bottom-0 h-1.5 col-span-full"
        />
      )}
    </div>
  );
}
