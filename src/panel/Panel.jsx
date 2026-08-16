import { useEffect, useRef, useState } from 'react';
import { BUCKET } from '../lib/triage.js';
import { serviceOf } from '../lib/paths.js';
import { Button } from './ui/button.jsx';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select.jsx';
import { StatStrip } from './components/StatStrip.jsx';
import { Guide } from './components/Guide.jsx';
import { Row } from './components/Row.jsx';
import { Wash } from './components/Wash.jsx';
import { Meter } from './components/Meter.jsx';
import { Goblin } from './components/Goblin.jsx';
import { About } from './components/About.jsx';
import { Haul } from './components/Haul.jsx';
import { maskStyle, LEVELS } from './ditherMask.js';
import { useCrate } from './state/useCrate.js';
import { useJobs, loadDrmBlocked } from './state/useJobs.js';
import { useSettings } from './state/useSettings.js';
import { cn } from './ui/cn.js';
import { icon } from './icons.js';
import { decrypt } from './reveal.js';
import { useSmoothScroll } from './useSmoothScroll.js';

const FORMAT_HINT = {
  aiff: 'Highest quality.',
  m4a: 'AIFF quality for a tenth of the size.',
  mp3: 'Highest compatibility.',
};

const Glyph = ({ name, size = 16 }) => (
  <span className="inline-flex flex-none" style={{ width: size, height: size }}
        dangerouslySetInnerHTML={{ __html: icon(name, size) }} />
);

const Field = ({ label, children, className = '' }) => (
  <label className={`grid gap-[7px] ${className}`}>
    <span className="label-caps opacity-80">{label}</span>
    {children}
  </label>
);

/** The title is the only thing that animates in — everything else paints final.
 *
 * The final string is always in the document, holding the box; the animating
 * copy sits on top of it and out of flow. Animating the h1's own text meant the
 * title's height was whatever the current frame happened to wrap to, and
 * everything below it moved for the length of the reveal. */
function CrateTitle({ title, tight }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current && title) decrypt(ref.current, title); }, [title]);
  return (
    <h1 className={cn(
          'relative m-0 font-display font-normal leading-[1.02] tracking-[-.015em] max-w-[20ch]',
          'transition-[font-size,opacity] duration-300 ease-out overflow-hidden',
          tight ? 'text-[17px] opacity-0 h-0' : 'text-[clamp(30px,4.4vw,50px)]',
        )}>
      <span className="invisible" aria-hidden="true">{title || ' '}</span>
      <span ref={ref} className="absolute inset-0" />
    </h1>
  );
}

// Two thresholds, not one, and the gap between them is the whole point.
//
// Collapsing shortens the header, which shortens the document, which drags
// scrollY back down — and with a single threshold that lands you back under it,
// so it expands, grows, and crosses again. The result is a header flickering
// several times a second at one exact scroll position.
//
// Hysteresis breaks the loop: once collapsed it takes a deliberate scroll back
// toward the top to expand, and the band between the two is wider than the
// height the collapse removes, so the feedback can never close.
const COLLAPSE_AT = 90;
const EXPAND_AT = 32;

/**
 * Resolve the panel out of the dither on open.
 *
 * A side panel appears the instant it is asked for, fully drawn, which is the
 * one moment this interface still felt like browser chrome rather than
 * something built. It cannot be preloaded — the document does not exist until
 * the panel is opened — so it arrives the same way every row does instead.
 */
function useEntrance() {
  const [level, setLevel] = useState(LEVELS - 1);

  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return setLevel(0);

    let raf = 0;
    const DURATION = 460;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / DURATION);
      // Ease-out, so most of the panel is legible almost immediately and only
      // the last cells take their time. Ease-in would read as a slow reveal.
      const eased = 1 - Math.pow(1 - t, 3);
      setLevel(Math.round((1 - eased) * (LEVELS - 1)));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Once clear, drop the mask entirely. Leaving it applied keeps every repaint
  // on the compositor's masked path for the life of the panel.
  return level > 0 ? maskStyle(level) : null;
}

export function Panel() {
  useSmoothScroll();
  const entrance = useEntrance();
  const [tight, setTight] = useState(false);

  useEffect(() => {
    // A plain scroll listener rather than anything Lenis-specific, so the
    // header still collapses under reduced motion, where Lenis never starts.
    //
    // Reads the previous state rather than deriving from scrollY alone: which
    // threshold applies depends on which side you are already on.
    const onScroll = () => setTight((was) => {
      if (!was && window.scrollY > COLLAPSE_AT) return true;
      if (was && window.scrollY < EXPAND_AT) return false;
      return was;
    });
    onScroll();
    addEventListener('scroll', onScroll, { passive: true });
    return () => removeEventListener('scroll', onScroll);
  }, []);

  const { state, crate, error } = useCrate();
  const { jobs, active, pending, fraction, run, haul, clearHaul } = useJobs();
  const { settings, set, opts } = useSettings();

  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);

  const [drmBlocked, setDrmBlocked] = useState(() => new Set());
  const [session, setSession] = useState(null);

  const [bridge, setBridge] = useState(null);
  const [about, setAbout] = useState(false);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'session:get' }).then(setSession).catch(() => {});
  }, []);

  // Only asked when it matters. On SoundCloud the bridge is irrelevant, and
  // probing it spawns a process to learn nothing.
  const needsBridge = crate.rows.some((r) => r.source === 'native');
  // Every row goes to yt-dlp, so the controls describing SoundCloud's fallback
  // chain have nothing to act on.
  const isNative = crate.rows.length > 0 && crate.rows.every((r) => r.source === 'native');
  useEffect(() => {
    if (!needsBridge) return;
    chrome.runtime.sendMessage({ type: 'bridge:probe' }).then(setBridge).catch(() => {});
  }, [needsBridge]);

  useEffect(() => {
    loadDrmBlocked().then(setDrmBlocked);
  }, []);

  // Re-read once a batch settles, so tracks that just turned out to be DRM drop
  // out of the next queue instead of failing again identically.
  useEffect(() => { if (!active) loadDrmBlocked().then(setDrmBlocked); }, [active]);

  const isDrm = (r) => r.drmOnly || drmBlocked.has(r.id);

  // The queue, oldest first. This is the list now — not the crate. The playlist
  // is already on screen behind the panel; repeating it here only buried the
  // handful of rows that were actually doing something.
  const queue = [...jobs.values()].filter((j) => j.row);



  async function onDownload() {
    setBusy(true);
    // Mark what's known to be DRM, so routing can send it straight to the
    // fallback instead of walking a chain that cannot serve it.
    //
    // There are two ways to know, and only one of them survives the trip:
    // triage sets `row.drmOnly` for tracks offering nothing but encrypted
    // streams, while the tracks that advertise plain transcodings and then 404
    // on them are known only to the remembered set here. Folding that in means
    // a track which revealed itself as DRM last run doesn't rediscover it.
    //
    // Nothing is filtered out any more — the fallback can take a DRM track, so
    // every row queues and the marking is purely about *where* it gets routed.
    const queued = crate.rows.map((r) => (isDrm(r) ? { ...r, drmOnly: true } : r));

    // Ask for gate origins while the click's gesture is still live —
    // chrome.permissions.request is refused without one, and there's no gesture
    // later inside the batch. Covers white-label hosts the manifest can't list.
    if (opts.mode !== 'stream' && opts.gatedPolicy === 'auto') {
      const origins = [...new Set(queued
        .filter((r) => r.bucket === BUCKET.GATED && r.url)
        .map((r) => { try { return `${new URL(r.url).origin}/*`; } catch { return null; } })
        .filter(Boolean))];
      if (origins.length) {
        const granted = await chrome.permissions.request({ origins }).catch(() => false);
        if (!granted) setLog((l) => [...l, 'gate access declined — gated tracks will use streams']);
      }
    }

    // A folder per crate, and nothing for a single track. Filing one file under
    // a directory named after itself just adds a click to reach it — and on a
    // SoundCloud single the title was the literal string "Single track", so the
    // folder was not even named after the song.
    const { skipped } = await run(
      queued, crate.tracks,
      { ...opts, folder: crate.collection ? crate.title : null },
      crate.title,
    );
    if (skipped) setLog((l) => [...l, `${skipped} already downloading — left alone`]);
    setBusy(false);
  }


  const idle = state === 'idle' || state === 'error';
  // Which site the tab is on, whether or not this page has anything on it. An
  // idle SoundCloud page and an idle YouTube page are different situations and
  // used to share one answer aimed at the first of them.
  const service = serviceOf(crate.url);

  const IDLE_EYEBROW = {
    soundcloud: 'Nothing to dig through here',
    youtube: 'Nothing to take here',
  };
  const IDLE_TITLE = { soundcloud: 'Open a crate', youtube: 'Open a video' };

  return (
    <div className="relative px-10 pt-[34px] pb-18" style={entrance ?? undefined}>
      {about && <About onClose={() => setAbout(false)} />}
      {/* Total progress, pinned to the very top edge and spanning the full
          width. Above everything rather than below it: the queue scrolls, and a
          summary that scrolls away stops being a summary. */}
      {pending > 0 && (
        <div className="fixed top-0 left-0 right-0 z-20 h-[7px] bg-wash/70
                        border-b-[1.5px] border-ink/20">
          <Meter progress={active ? fraction : null} cell={2} className="h-[5px]" />
        </div>
      )}

      {/* Bleeds past the padding to the panel edges — a wash that stopped at
          the content gutter would read as a box, not as the ground.

          Was 190px at 0.5 opacity, which put a dense plum dot field directly
          behind the masthead and the stat strip and made both hard to read. A
          background that competes with the text on top of it has stopped being
          a background. Shorter and much fainter, so it's spent well before the
          title and reads as texture on the ground rather than as content. */}
      <div className={cn(
        'absolute -top-px -left-10 -right-10 -z-10 overflow-hidden',
        'transition-[height,opacity] duration-300 ease-out',
        tight ? 'h-[64px] opacity-0' : 'h-[132px] opacity-100',
      )}>
        <Wash direction="down" tone={1} opacity={0.22} />
      </div>

      <header className={cn(
        'sticky top-0 z-10 flex items-end justify-between gap-7 border-b-[1.5px] border-ink',
        'transition-[padding,background-color] duration-300 ease-out',
        // Opaque once it's stuck, or rows scroll through the title.
        tight ? 'pt-2 pb-2 bg-paper' : 'pb-5',
      )}>
        {/* Energy is the share of the queue still moving, so the mark thickens
            as work piles up and settles as it drains. It reads as a state, not
            as a spinner, which is the point: a spinner says "wait", this says
            "busy". */}
        {/* The mark is the way in. There is nowhere else to put an about box
            in a panel with no chrome, and a goblin is worth poking. */}
        <button type="button" onClick={() => setAbout(true)} aria-label="About Crate Goblin"
                className="self-start mt-[3px] flex-none bg-transparent border-0 p-0 cursor-pointer">
          <Goblin
            size={tight ? 30 : 46}
            energy={pending ? Math.min(1, (active || 0) / 4) : 0}
            className="transition-all duration-300"
          />
        </button>
        <div className="mr-auto">
          <div className={cn(
            'flex items-center gap-3 label-caps tracking-[.18em] text-accent',
            'transition-[margin] duration-300 ease-out',
            tight ? 'mb-0' : 'mb-[13px]',
          )}>
            <span>
              {state === 'loading' ? 'Loading' : idle
                ? (IDLE_EYEBROW[service] ?? 'Nowhere to dig')
                : `${crate.rows.length} ${crate.rows.length === 1 ? 'track' : 'tracks'}`}
            </span>
            {/* Counts the whole queue, not this crate — work continues after you
                navigate away, and without this it becomes invisible. */}
            {pending > 0 && (
              <span className="px-2.5 py-[3px] rounded-pill bg-accent text-paper tracking-[.12em]">
                {pending} in queue{active ? ` · ${active} running` : ''}
              </span>
            )}
            {/* Only the tier that explains a difference you can hear. Reporting
                a signed-out session described SoundCloud's stream quality, so on
                a page it does not apply to it answered a question nobody asked. */}
            {session?.goPlus && <span className="opacity-70">Go+ · 256k</span>}
            {/* Only when it is broken. A version number in the masthead was
                trivia you cannot act on; "not installed" is the one bridge
                state that changes what you do next. */}
            {needsBridge && bridge && !bridge.ok && (
              <span className="text-err">downloader not installed</span>
            )}
          </div>
          <CrateTitle tight={tight} title={
            state === 'loading' ? '' : idle
              ? (state === 'error' ? 'That did not go well' : IDLE_TITLE[service] ?? 'Pick a site')
              : crate.title
          } />
        </div>
      </header>

      {idle && !queue.length && (
        <Guide service={service} running={active} error={state === 'error' ? error : null} />
      )}

      <Haul tally={haul} onDone={clearHaul} />

      {state === 'ready' && (
        <>
          {/* Free, gated and stream are SoundCloud's triage. yt-dlp has no
              such thing and every native row is hardcoded to STREAM, so on
              YouTube this was a row of constants under a heading. */}
          {!isNative && <StatStrip rows={crate.rows} />}

          <section className="flex flex-wrap items-end gap-x-4 gap-y-3 py-3.5 border-b-[1.5px] border-ink">
            {!isNative && (
            <Field label="Mode">
              <Select value={settings.mode} onValueChange={(v) => set('mode', v)}>
                <SelectTrigger className="min-w-[160px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="best">Best available</SelectItem>
                  <SelectItem value="stream">Stream only</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            )}

            {!isNative && settings.mode !== 'stream' && (
              <Field label="Gated">
                <Select value={settings['gated-policy']} onValueChange={(v) => set('gated-policy', v)}>
                  <SelectTrigger className="min-w-[190px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Unlock, else stream</SelectItem>
                    <SelectItem value="stream">Always stream</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}


            {isNative && (
              <Field label="Take">
                <Select value={settings.media} onValueChange={(v) => set('media', v)}>
                  <SelectTrigger className="min-w-[130px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="audio">Audio only</SelectItem>
                    <SelectItem value="video">Video</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}

            {/* `media` persists across sites, so it is only allowed to hide
                this where it means anything. Otherwise picking Video on YouTube
                would take the format away from SoundCloud too. */}
            {!(isNative && settings.media === 'video') && (
            <Field label="Format">
              {/* Hint beside the control, never beneath: the row aligns on
                  flex-end, so anything stacked under one select lifts it clear
                  of the others. */}
              <span className="flex items-center gap-2.5">
                <Select value={settings.container} onValueChange={(v) => set('container', v)}>
                  <SelectTrigger className="min-w-[100px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="aiff">AIFF</SelectItem>
                    <SelectItem value="m4a">M4A</SelectItem>
                    <SelectItem value="mp3">MP3</SelectItem>
                  </SelectContent>
                </Select>
                <span className="max-w-[22ch] font-mono text-[10px] leading-[1.4]
                                 tracking-[.04em] normal-case opacity-60">
                  {FORMAT_HINT[settings.container]}
                </span>
              </span>
            </Field>
            )}

            <div className="flex gap-2.5 ml-auto">
              <Button size="sm" variant="primary" onClick={onDownload}
                      disabled={busy || !crate.rows.length || (needsBridge && bridge && !bridge.ok)}>
                <Glyph name="download" />
                <span>Queue {crate.rows.length}</span>
              </Button>
            </div>
          </section>
        </>
      )}

      {/* The container the rows measure against. A side panel is dragged to
          any width and the viewport never moves with it, so a media query
          would be answering a question nobody asked. */}
      <div className="@container mt-1">
        {queue.map((job) => (
          <Row key={job.row.id} row={job.row} job={job} crateTitle={crate.title} />
        ))}
      </div>

      {!queue.length && state === 'ready' && (
        <p className="py-24 text-center label-caps tracking-[.18em] opacity-55">
          Nothing queued yet
        </p>
      )}

      {log.length > 0 && (
        <div className="mt-5 grid gap-1.5 opacity-70 font-mono text-[11px]
                        leading-[1.4] tracking-[.06em] uppercase">
          {log.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      )}
    </div>
  );
}
