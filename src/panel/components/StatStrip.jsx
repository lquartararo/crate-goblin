import { BUCKET } from '../../lib/triage.js';
import { icon } from '../icons.js';
import { cn } from '../ui/cn.js';

const Glyph = ({ name }) => (
  <span className="inline-flex flex-none self-center opacity-70 w-[15px] h-[15px]"
        dangerouslySetInnerHTML={{ __html: icon(name, 15) }} />
);

/**
 * One inline strip, not four cards.
 *
 * The cards spent ~150px of a side panel's height restating four numbers you
 * read once. Inline they're still scannable, and the track list starts near the
 * top where it belongs.
 */
export function StatStrip({ rows }) {
  const count = (fn) => rows.filter(fn).length;
  const free = count((r) => r.bucket === BUCKET.FREE);

  const stats = [
    { label: 'Free', glyph: 'free', value: free, note: '', lead: free > 0 },
    {
      label: 'Gated', glyph: 'gated',
      value: count((r) => r.bucket === BUCKET.GATED),
      note: '',
    },
    { label: 'Stream', glyph: 'stream', value: count((r) => r.bucket === BUCKET.STREAM), note: '' },
  ];

  return (
    // No rule of its own. The counts and the controls under them are one
    // thought — what is in the crate, and what you are about to do with it —
    // and a line between them cut a 60px band off another 60px band. The
    // controls keep theirs, which is the boundary that means something: setup
    // above, the queue working below.
    <section className="flex flex-wrap items-baseline gap-x-4 gap-y-1 pt-3 pb-1.5">
      {stats.map((s) => (
        <div key={s.label}
             className="inline-flex items-baseline gap-1.5 font-mono text-[11px]
                        leading-none tracking-[.14em] uppercase">
          <Glyph name={s.glyph} />
          {/* The bucket you can act on without further work is the one worth colour. */}
          <span className={cn('font-figure text-[22px] leading-none tabular-nums',
                              s.lead && 'text-accent')}>
            {s.value}
          </span>
          <span>{s.label}</span>
          {s.note && <span className="opacity-60">{s.note}</span>}
        </div>
      ))}
    </section>
  );
}
