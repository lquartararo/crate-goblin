import { useEffect, useState } from 'react';
import { AreaChart } from '../../vendor/dither-kit/area-chart';
import { Area } from '../../vendor/dither-kit/area';
import { BarChart } from '../../vendor/dither-kit/bar-chart';
import { Bar } from '../../vendor/dither-kit/bar';
import { PieChart } from '../../vendor/dither-kit/pie-chart';
import { Pie } from '../../vendor/dither-kit/pie';
import { PALETTE, rgb } from '../../vendor/dither-kit/palette';
import { readLog, summarize, STATS_EVENT } from '../../lib/stats.js';

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

/**
 * Hours once there are hours, minutes until then.
 *
 * "0.4 hours" is a worse way of saying 24 minutes, and "312 minutes" is a worse
 * way of saying five hours. The unit follows the number rather than being
 * chosen once and made to cover both.
 */
function playtime(seconds) {
  const mins = Math.round(seconds / 60);
  if (mins < 90) return { value: mins, label: mins === 1 ? 'minute of music' : 'minutes of music' };
  const hours = seconds / 3600;
  // One decimal below ten hours, none above: at 47.3 hours the tenth is noise.
  return { value: hours < 10 ? hours.toFixed(1) : Math.round(hours), label: 'hours of music' };
}

const Figure = ({ value, label }) => (
  <div className="grid gap-1">
    <span className="font-figure text-[26px] leading-none tabular-nums">{value}</span>
    <span className="font-mono text-[10px] leading-none tracking-[.12em] uppercase opacity-55">
      {label}
    </span>
  </div>
);

/**
 * Which tone is which.
 *
 * dither-kit ships a Legend, and its own note says it is an absolute overlay
 * suited to two or three entries — five routes in a side panel would sit on top
 * of the chart. Beside it instead, reading the same seeds the slices are painted
 * from so the two can never disagree.
 */
const Key = ({ items }) => (
  <ul className="m-0 p-0 list-none grid gap-1.5">
    {items.map(({ key, label, n }) => (
      <li key={key} className="flex items-center gap-2 font-mono text-[10px]
                               tracking-[.1em] uppercase leading-none">
        <span className="w-2.5 h-2.5 flex-none rounded-[1px]"
              style={{ background: rgb(PALETTE[ROUTE[key]?.color ?? 'crate'].fill) }} />
        <span className="opacity-70">{label}</span>
        <span className="ml-auto tabular-nums opacity-45">{n}</span>
      </li>
    ))}
  </ul>
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
    const read = () => readLog().then((log) => setData(log.length ? summarize(log, WEEKS) : null));
    read();
    addEventListener(STATS_EVENT, read);
    return () => removeEventListener(STATS_EVENT, read);
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

      <div className="flex flex-wrap items-start gap-x-10 gap-y-7">
        {routes.length > 1 && (
          <div>
            <Caption>Where they came from</Caption>
            {/* The donut gets a fixed box rather than a flexible one. Given the
                whole width it centred itself in the panel while every caption
                and figure around it started at the left margin, which read as a
                chart that had come loose. */}
            <div className="flex items-center gap-5">
              <div className="w-[150px] h-[150px] flex-none">
                {/* The hole is what stops five slices of one hue reading as a
                    single blob, and gives the eye an edge to follow. */}
                <PieChart data={routes} config={ROUTE} dataKey="n" nameKey="route"
                          innerRadius={0.55}>
                  <Pie variant="gradient" />
                </PieChart>
              </div>
              <Key items={routes.map((r) => ({
                key: r.route, label: ROUTE[r.route]?.label ?? r.route, n: r.n,
              }))} />
            </div>
          </div>
        )}

        {genres.length > 1 && (
          <div className="min-w-[200px] flex-1">
            <Caption right={`top ${genres.length}`}>What you dig for</Caption>
            <div className="h-[150px]">
              <BarChart data={genres} config={GENRE} interactive={false}>
                <Bar dataKey="n" variant="gradient" />
              </BarChart>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-x-9 gap-y-4">
        <Figure value={data.total} label="tracks kept" />
        {/* Absent rather than zero while the history predates it. Duration is
            measured off the file, so entries recorded before that existed carry
            none and there is nothing to reconstruct them from — a "0 minutes"
            beside 61 tracks would be a wrong answer where no answer is honest. */}
        {data.seconds > 0 && <Figure {...playtime(data.seconds)} />}
        {data.top && (
          <Figure value={data.bySource[data.top]}
                  label={`via ${(ROUTE[data.top]?.label ?? data.top).toLowerCase()}`} />
        )}
      </div>
    </section>
  );
}
