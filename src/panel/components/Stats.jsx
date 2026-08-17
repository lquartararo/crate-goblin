import { useEffect, useRef, useState } from 'react';
import { AreaChart } from '../../vendor/dither-kit/area-chart';
import { Area } from '../../vendor/dither-kit/area';
import { BarChart } from '../../vendor/dither-kit/bar-chart';
import { Bar } from '../../vendor/dither-kit/bar';
import { PieChart } from '../../vendor/dither-kit/pie-chart';
import { XAxis } from '../../vendor/dither-kit/x-axis';
import { Pie } from '../../vendor/dither-kit/pie';
import { PALETTE } from '../../vendor/dither-kit/palette';
import { BAYER4 } from '../dither-kit.js';
import { readLog, summarize, SOURCES, STATS_EVENT } from '../../lib/stats.js';
import { useThemeTick } from '../useThemeTick.js';

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

// Built from SOURCES rather than written out beside it.
//
// It was written out, with `free` where the data says `original` — so the pie
// looked up a key that did not exist and fell back to grey while the key fell
// back to plum. The two could not have agreed, and nothing anywhere said so.
// Derived from the same list the recorder uses, a route without a colour is now
// impossible rather than merely unlikely.
const ROUTE_LABEL = {
  original: 'Free', gate: 'Gates', stream: 'Streams',
  lucida: 'Elsewhere', 'yt-dlp': 'YouTube',
};
const TONES = ['crate', 'crate3', 'crate2', 'crate5', 'crate4'];
const ROUTE = Object.fromEntries(SOURCES.map((name, i) => [name, {
  label: ROUTE_LABEL[name] ?? name,
  color: TONES[i % TONES.length],
}]));

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
/**
 * A swatch drawn the way the slice is drawn.
 *
 * A flat square was the wrong key for a dithered slice: the slice is a scatter
 * of cells in one colour and reads as a lighter tone than the colour itself, so
 * a solid chip beside it looked like a different entry. Same seed, same Bayer
 * threshold, same coverage — the two now agree because they are made the same
 * way.
 */
function Swatch({ color }) {
  const ref = useRef(null);
  const theme = useThemeTick();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const [r, g, b] = PALETTE[color]?.fill ?? PALETTE.crate.fill;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) << 2;
        // The coverage a slice averages, so the chip reads at the same weight.
        if (0.72 <= BAYER4[y & 3][x & 3]) { img.data[i + 3] = 0; continue; }
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [color, theme]);

  return <canvas ref={ref} width={10} height={10}
                 className="block flex-none [image-rendering:pixelated]" />;
}

const Key = ({ items }) => (
  <ul className="m-0 p-0 list-none grid gap-1.5">
    {items.map(({ key, label, n }) => (
      <li key={key} className="flex items-center gap-2 font-mono text-[10px]
                               tracking-[.1em] uppercase leading-none">
        <Swatch color={ROUTE[key]?.color ?? 'crate'} />
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
  // Keyed on this, so a palette change remounts the canvases. They paint once
  // from the seeds and nothing about a mutated table tells them to look again.
  const theme = useThemeTick();

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

  // The axis centres a label under each bar and does nothing about overlap, so
  // shortening happens here. Gentler than it was: names are folded now, so two
  // bars can no longer end up reading the same word, and "Drum & Bass" fits
  // where it used to be cut to "Drum". Only genuinely long names lose anything.
  // Eight, not eleven. The axis label inherits font-mono, which in this theme
  // is Redaction — a serif, with proper varying widths — so a character count
  // is a rough proxy for a width and eleven of them still collided.
  const shorten = (name) => {
    if (name.length <= 8) return name;
    const first = name.split(/[\s&/]+/)[0];
    return first.length >= 3 && first.length <= 8 ? first : `${name.slice(0, 7)}…`;
  };
  const genres = (data.topGenres ?? []).map((g) => ({ name: shorten(g.name), n: g.n }));

  return (
    <section className="mt-7 pt-5 border-t-[1.5px] border-ink grid gap-8">
      <div>
        <Caption right={`last ${WEEKS}`}>Tracks a week</Caption>
        <div className="h-[104px]">
          <AreaChart key={theme} data={weekly} config={WEEKLY} interactive={false}>
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
                <PieChart key={theme} data={routes} config={ROUTE} dataKey="n" nameKey="route"
                          innerRadius={0.55}>
                  {/* Dotted: a real halftone with gaps, rather than the smooth
                      ramp of "gradient" or the flat fill of "solid". The colour
                      stays constant across a slice and only the coverage
                      varies, which is what lets a dithered swatch match it. */}
                  <Pie variant="dotted" />
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
              {/* Without an XAxis the bars draw and say nothing — six unlabelled
                  columns are a shape, not a breakdown. The genre is the whole
                  content of this chart. */}
              <BarChart key={theme} config={GENRE} data={genres} interactive={false}>
                <XAxis dataKey="name" />
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
