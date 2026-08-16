import { useEffect, useState } from 'react';
import { AreaChart } from '../../vendor/dither-kit/area-chart';
import { Area } from '../../vendor/dither-kit/area';
import { BarChart } from '../../vendor/dither-kit/bar-chart';
import { Bar } from '../../vendor/dither-kit/bar';
import { PieChart } from '../../vendor/dither-kit/pie-chart';
import { Pie } from '../../vendor/dither-kit/pie';
import { readLog, summarize } from '../../lib/stats.js';

// Three charts, because there are three different questions.
//
// A chart earns its place by answering something a number cannot, and picking a
// form is picking which question gets asked:
//
//   area   how the digging is going — a shape over time, where the gaps are the
//          point. Twelve bars drew twelve separate facts; an area draws one
//          continuous habit, which is what a run of weeks actually is.
//
//   pie    where the tracks come from — a proportion, and the one statistic
//          unique to this tool. "Two thirds of that crate came through gates"
//          is not something another downloader could tell you.
//
//   bar    what you dig for — genres, ranked. Discrete, unordered, compared by
//          length, which is the thing a bar does better than anything else.
//
// Radar was the tempting one and it is not here: with five sources it would
// draw a striking shape and answer the pie's question less clearly.

const WEEKS = 12;

const WEEKLY = { tracks: { label: 'Tracks', color: 'crate' } };
const GENRE = { n: { label: 'Tracks', color: 'crate' } };

// Slices told apart by tone rather than hue, in the order the routes are worth
// noticing.
const ROUTE = {
  free: { label: 'Free', color: 'crate' },
  gate: { label: 'Gates', color: 'crate3' },
  stream: { label: 'Streams', color: 'crate2' },
  lucida: { label: 'Elsewhere', color: 'crate5' },
  'yt-dlp': { label: 'YouTube', color: 'crate4' },
};

const Figure = ({ value, label }) => (
  <div className="grid gap-1">
    <span className="font-figure text-[26px] leading-none tabular-nums">{value}</span>
    <span className="font-mono text-[10px] leading-none tracking-[.12em] uppercase opacity-55">
      {label}
    </span>
  </div>
);

const Caption = ({ children, right }) => (
  <div className="flex items-baseline justify-between gap-4 mb-3">
    <span className="font-mono text-[10px] tracking-[.14em] uppercase opacity-55">{children}</span>
    {right && (
      <span className="font-mono text-[10px] tracking-[.14em] uppercase opacity-40">{right}</span>
    )}
  </div>
);

/**
 * The dig, once there is a dig to show.
 *
 * With no history this rendered nothing at all, on the reasoning that an empty
 * chart looks broken. It does — but a blank space looks like a feature that was
 * never built, which is worse, and is exactly how it read while the recording
 * was quietly failing.
 */
export function Stats() {
  const [data, setData] = useState(null);

  useEffect(() => {
    readLog().then((log) => setData(log.length ? summarize(log, WEEKS) : null));
  }, []);

  if (!data) {
    return (
      <p className="mt-7 pt-5 border-t-[1.5px] border-ink
                    font-mono text-[10px] tracking-[.14em] uppercase opacity-40">
        Your first track starts the chart
      </p>
    );
  }

  // Newest on the right, empty weeks kept. A gap where you did not dig is part
  // of the shape; dropping it would draw a busy month and a quiet one alike.
  const weekly = data.weeks.map((tracks, i) => ({
    week: i === data.weeks.length - 1 ? 'now' : `${data.weeks.length - 1 - i}w`,
    tracks,
  }));

  const routes = Object.entries(data.bySource)
    .filter(([, n]) => n > 0)
    .map(([key, n]) => ({ route: key, n }));

  const genres = (data.topGenres ?? []).map((g) => ({
    // Long enough to recognise, short enough not to collide under the axis.
    name: g.name.length > 12 ? `${g.name.slice(0, 11)}…` : g.name,
    n: g.n,
  }));

  return (
    <section className="mt-7 pt-5 border-t-[1.5px] border-ink grid gap-8">
      <div>
        <Caption right={`last ${WEEKS}`}>Tracks a week</Caption>
        <div className="h-[104px]">
          <AreaChart data={weekly} config={WEEKLY} interactive={false}>
            <Area dataKey="tracks" variant="gradient" />
          </AreaChart>
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-x-8 gap-y-6">
        {routes.length > 1 && (
          <div className="min-w-[190px] flex-1">
            <Caption>Where they came from</Caption>
            <div className="h-[168px]">
              {/* A donut: the hole is what stops five slices in one hue reading
                  as a single blob, and it leaves the eye an edge to follow. */}
              <PieChart data={routes} config={ROUTE} dataKey="n" nameKey="route"
                        innerRadius={0.55}>
                <Pie variant="gradient" />
              </PieChart>
            </div>
          </div>
        )}

        {genres.length > 1 && (
          <div className="min-w-[190px] flex-1">
            <Caption right={`top ${genres.length}`}>What you dig for</Caption>
            <div className="h-[168px]">
              <BarChart data={genres} config={GENRE} interactive={false}>
                <Bar dataKey="n" variant="gradient" />
              </BarChart>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-x-9 gap-y-4">
        <Figure value={data.total} label="tracks kept" />
        {data.mb > 0 && (
          <Figure value={data.mb >= 1000 ? `${(data.mb / 1000).toFixed(1)} GB` : `${data.mb} MB`}
                  label="on disk" />
        )}
        {data.top && (
          <Figure value={data.bySource[data.top]}
                  label={`via ${(ROUTE[data.top]?.label ?? data.top).toLowerCase()}`} />
        )}
      </div>

      {/* Only once it has happened. A permanent zero invites you to fix
          something that is not broken. */}
      {data.failed > 0 && (
        <p className="font-mono text-[10px] tracking-[.1em] uppercase opacity-45">
          {data.failed} did not make it
        </p>
      )}
    </section>
  );
}
