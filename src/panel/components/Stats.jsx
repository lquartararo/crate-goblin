import { useEffect, useState } from 'react';
import { BarChart } from '../../vendor/dither-kit/bar-chart';
import { Bar } from '../../vendor/dither-kit/bar';
import { readLog, summarize } from '../../lib/stats.js';

// The dig, as an actual dither-kit chart.
//
// The panel already had a hand-port of dither-kit's `dither-paint` and `pixel`,
// which are the two files in that registry that are not charts — everything
// else there is charts. So this uses the real components rather than a bar
// chart improvised out of the two primitives that happened to be vendored.

const WEEKS = 12;

const CONFIG = { tracks: { label: 'Tracks', color: 'crate' } };

const Figure = ({ value, label }) => (
  <div className="grid gap-1">
    <span className="font-figure text-[26px] leading-none tabular-nums">{value}</span>
    <span className="font-mono text-[10px] leading-none tracking-[.12em] uppercase opacity-55">
      {label}
    </span>
  </div>
);

/**
 * Renders nothing until there is something to say.
 *
 * An empty chart on a fresh install is worse than the space it fills: it looks
 * like a feature that is broken rather than one that has not started. Nothing
 * was recorded before 0.18.0 either, so every install begins empty no matter how
 * long it has been in use — and the first track is enough to draw. Waiting for
 * three made a working feature look like a missing one for a week.
 */
export function Stats() {
  const [data, setData] = useState(null);

  useEffect(() => {
    readLog().then((log) => setData(log.length ? summarize(log, WEEKS) : null));
  }, []);

  if (!data) return null;

  // Newest on the right, and the empty weeks kept. A gap where you did not dig
  // is part of the shape; dropping it would draw a busy month and a quiet one
  // identically.
  const series = data.weeks.map((tracks, i) => ({
    week: i === data.weeks.length - 1 ? 'now' : `${data.weeks.length - 1 - i}w`,
    tracks,
  }));

  return (
    <section className="mt-7 pt-5 border-t-[1.5px] border-ink">
      <div className="flex items-baseline justify-between gap-4 mb-3">
        <span className="font-mono text-[10px] tracking-[.14em] uppercase opacity-55">
          Tracks a week
        </span>
        <span className="font-mono text-[10px] tracking-[.14em] uppercase opacity-40">
          last {WEEKS}
        </span>
      </div>

      <div className="h-[92px]">
        <BarChart data={series} config={CONFIG} interactive={false}>
          <Bar dataKey="tracks" variant="gradient" />
        </BarChart>
      </div>

      <div className="flex flex-wrap gap-x-9 gap-y-4 mt-4">
        <Figure value={data.total} label="tracks kept" />
        {data.mb > 0 && (
          <Figure value={data.mb >= 1000 ? `${(data.mb / 1000).toFixed(1)} GB` : `${data.mb} MB`}
                  label="on disk" />
        )}
        {data.top && <Figure value={data.bySource[data.top]} label={`via ${data.top}`} />}
      </div>

      {/* Only once it has happened. A permanent zero invites you to fix
          something that is not broken. */}
      {data.failed > 0 && (
        <p className="mt-3.5 font-mono text-[10px] tracking-[.1em] uppercase opacity-45">
          {data.failed} did not make it
        </p>
      )}
    </section>
  );
}
