import { useEffect, useRef, useState } from 'react';
import { Goblin } from './Goblin.jsx';
import { Button } from '../ui/button.jsx';
import { readLog, summarize } from '../../lib/stats.js';

// What the goblin is hiding.
//
// Half of this is a joke and half of it is the support channel. Two of the
// people using this cannot read a stack trace and will not open a devtools
// console, so "click the goblin, press Copy, send me that" is the entire
// diagnostic story. Everything needed to answer "why did it not work" is in one
// place behind one click, and none of it is on screen the rest of the time.

const QUIPS = [
  'The goblin is working.',
  'Still working.',
  'It has been working this whole time.',
  'You are not helping.',
  'Fine. Take the crate.',
];

/** Everything worth knowing when something has gone wrong, as one blob. */
async function diagnostics() {
  const manifest = chrome.runtime.getManifest();
  const bridge = await chrome.runtime.sendMessage({ type: 'bridge:probe' }).catch(() => null);
  const log = await readLog();
  const s = summarize(log);

  return [
    `Crate Goblin ${manifest.version}`,
    `chrome     ${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? 'unknown'}`,
    `platform   ${navigator.platform}`,
    '',
    `bridge     ${bridge ? (bridge.ok ? 'ok' : 'not installed') : 'not asked'}`,
    `yt-dlp     ${bridge?.version ?? '—'}`,
    `ffmpeg     ${bridge?.ffmpeg ?? '—'}`,
    `js runtime ${bridge?.js ?? '—'}`,
    `host log   ${bridge?.log ?? '—'}`,
    '',
    `tracks     ${s.total} kept, ${s.failed} failed`,
    `sources    ${Object.entries(s.bySource).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'none yet'}`,
  ].join('\n');
}

const Row = ({ k, v, bad }) => (
  <div className="flex gap-3 justify-between">
    <span className="opacity-50">{k}</span>
    <span className={bad ? 'text-err' : ''}>{v}</span>
  </div>
);

export function About({ onClose }) {
  const [pokes, setPokes] = useState(0);
  const [detail, setDetail] = useState(null);
  const [copied, setCopied] = useState(false);
  const panel = useRef(null);

  const version = chrome.runtime.getManifest().version;

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  // Asked once, when opened. The probe spawns a process, so it is not something
  // to do on every render of a panel that is usually shut.
  useEffect(() => {
    (async () => {
      const bridge = await chrome.runtime.sendMessage({ type: 'bridge:probe' }).catch(() => null);
      const log = await readLog();
      setDetail({ bridge, stats: summarize(log) });
    })();
  }, []);

  async function copy() {
    await navigator.clipboard.writeText(await diagnostics()).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6
                    bg-ink/45 backdrop-blur-[2px]"
         onClick={onClose}>
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="About Crate Goblin"
           onClick={(e) => e.stopPropagation()}
           className="w-full max-w-[420px] max-h-full overflow-auto outline-none
                      bg-paper border-[1.5px] border-ink p-6">
        <div className="flex items-start gap-4">
          {/* The one place it is big enough to see that it is watching you. */}
          <button type="button" aria-label="Poke the goblin"
                  onClick={() => setPokes((n) => n + 1)}
                  className="flex-none cursor-pointer bg-transparent border-0 p-0">
            <Goblin size={64} energy={Math.min(1, pokes / QUIPS.length)} />
          </button>
          <div className="min-w-0">
            <h2 className="m-0 font-display text-[28px] leading-none">Crate Goblin</h2>
            <p className="mt-2 mb-0 font-mono text-[10px] tracking-[.14em] uppercase opacity-55">
              v{version}
            </p>
          </div>
          <Button size="sm" onClick={onClose} className="ml-auto">Close</Button>
        </div>

        {/* Says nothing until poked, so the first thing you see is not a joke
            you did not ask for. */}
        {pokes > 0 && (
          <p className="mt-4 mb-0 text-[15px] leading-snug">
            {QUIPS[Math.min(pokes, QUIPS.length) - 1]}
          </p>
        )}

        <div className="mt-5 pt-4 border-t-[1.5px] border-ink
                        font-mono text-[11px] leading-[1.9] tracking-[.06em]">
          <Row k="downloader" v={detail?.bridge?.ok ? `yt-dlp ${detail.bridge.version}` : 'not installed'}
               bad={detail ? !detail.bridge?.ok : false} />
          <Row k="converter" v={detail?.bridge?.ffmpeg ? 'ffmpeg ready' : 'missing'}
               bad={detail ? !detail.bridge?.ffmpeg : false} />
          <Row k="kept" v={detail ? `${detail.stats.total} tracks` : '…'} />
          {detail?.stats.failed > 0 && <Row k="failed" v={detail.stats.failed} />}
        </div>

        <Button size="sm" onClick={copy} className="mt-4 w-full">
          {copied ? 'Copied — send it to Louis' : 'Copy diagnostics'}
        </Button>

        <p className="mt-5 mb-0 text-center font-mono text-[10px] tracking-[.14em]
                      uppercase opacity-45">
          Made with love by Louis
        </p>
      </div>
    </div>
  );
}
