import { useCallback, useEffect, useRef, useState } from 'react';
import { BUCKET } from '../lib/triage.js';
import { Button } from './ui/button.jsx';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select.jsx';
import { StatStrip } from './components/StatStrip.jsx';
import { Guide } from './components/Guide.jsx';
import { Row } from './components/Row.jsx';
import { Wash } from './components/Wash.jsx';
import { Meter } from './components/Meter.jsx';
import { useCrate } from './state/useCrate.js';
import { useJobs, loadDrmBlocked } from './state/useJobs.js';
import { useSettings, useGateEmail } from './state/useSettings.js';
import { icon } from './icons.js';
import { decrypt } from './reveal.js';

const FORMAT_HINT = {
  aiff: 'Decoded PCM. Safest on club CDJs, ~10× the size.',
  m4a: 'The same audio, kept as AAC. A tenth the size.',
  mp3: "SoundCloud's own 128k encode. Lowest quality, widest reach.",
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

/** The title is the only thing that animates in — everything else paints final. */
function CrateTitle({ title }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current && title) decrypt(ref.current, title); }, [title]);
  return (
    <h1 ref={ref}
        className="m-0 font-display font-normal text-[clamp(30px,4.4vw,50px)]
                   leading-[1.02] tracking-[-.015em] max-w-[20ch]">
      &nbsp;
    </h1>
  );
}

export function Panel() {
  const { state, crate, error } = useCrate();
  const { jobs, active, pending, fraction, run, setStatus } = useJobs();
  const { settings, set, opts } = useSettings();
  const [email, setEmail] = useGateEmail();

  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);

  const [drmBlocked, setDrmBlocked] = useState(() => new Set());

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

    const { skipped } = await run(queued, crate.tracks, opts, crate.title);
    if (skipped) setLog((l) => [...l, `${skipped} already downloading — left alone`]);
    setBusy(false);
  }


  const idle = state === 'idle' || state === 'error';
  const onSoundcloud = Boolean(crate.url?.startsWith('https://soundcloud.com/'));

  return (
    <div className="relative px-10 pt-[34px] pb-18">
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
      <div className="absolute -top-px -left-10 -right-10 h-[132px] -z-10 overflow-hidden">
        <Wash direction="down" tone={1} opacity={0.22} />
      </div>

      <header className="flex items-end justify-between gap-7 pb-5 border-b-[1.5px] border-ink">
        <div>
          <div className="flex items-center gap-3 mb-[13px] label-caps tracking-[.18em] text-accent">
            <span>
              {state === 'loading' ? 'Loading' : idle
                ? (onSoundcloud ? 'No playlist on this page' : 'Not on SoundCloud')
                : `${crate.rows.length} ${crate.rows.length === 1 ? 'track' : 'tracks'}`}
            </span>
            {/* Counts the whole queue, not this crate — work continues after you
                navigate away, and without this it becomes invisible. */}
            {pending > 0 && (
              <span className="px-2.5 py-[3px] rounded-pill bg-accent text-paper tracking-[.12em]">
                {pending} in queue{active ? ` · ${active} running` : ''}
              </span>
            )}
          </div>
          <CrateTitle title={
            state === 'loading' ? '' : idle
              ? (state === 'error' ? 'Something went wrong' : onSoundcloud ? 'Open a crate' : 'Open SoundCloud')
              : crate.title
          } />
        </div>
      </header>

      {idle && !queue.length && (
        <Guide onSoundcloud={onSoundcloud} running={active} error={state === 'error' ? error : null} />
      )}

      {state === 'ready' && (
        <>
          <StatStrip rows={crate.rows} />

          <section className="flex flex-wrap items-end gap-x-4 gap-y-3 py-3.5 border-b-[1.5px] border-ink">
            <Field label="Mode">
              <Select value={settings.mode} onValueChange={(v) => set('mode', v)}>
                <SelectTrigger className="min-w-[160px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="best">Best available</SelectItem>
                  <SelectItem value="stream">Stream only</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {settings.mode !== 'stream' && (
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

            <Field label="Email for gates (optional)">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you+crate@gmail.com"
                className="min-w-[215px] px-3 py-[10px] rounded-[3px] border-[1.5px] border-ink
                           bg-paper text-ink font-sans text-[13px] leading-none normal-case
                           tracking-normal transition-colors duration-150 hover:border-accent
                           placeholder:opacity-50
                           focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
              />
            </Field>

            <div className="flex gap-2.5 ml-auto">
              <Button size="sm" variant="primary" onClick={onDownload}
                      disabled={busy || !crate.rows.length}>
                <Glyph name="download" />
                <span>Queue {crate.rows.length}</span>
              </Button>
            </div>
          </section>
        </>
      )}

      <div className="mt-1">
        {queue.map((job) => (
          <Row key={job.row.id} row={job.row} job={job} crateTitle={crate.title} />
        ))}
      </div>

      {!queue.length && state === 'ready' && (
        <p className="py-24 text-center label-caps tracking-[.18em] opacity-55">
          Nothing queued — hit Queue {crate.rows.length} to start
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
