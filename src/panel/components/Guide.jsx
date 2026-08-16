import { ProviderMark } from './ProviderMark.jsx';

/**
 * Shown instead of the working surface when there's no crate.
 *
 * Every control is inert on a page with no track list — format and gated policy
 * both describe a download that can't happen, and a Download button with
 * nothing to download invites a click that does nothing. So they're gone,
 * replaced with what to do instead.
 *
 * Which "instead" depends on where you already are. On a supported site the
 * useful answer is which pages work; only when you are somewhere else entirely
 * is the answer "go to one of these". Offering a YouTube button to someone
 * standing on youtube.com is answering a question they did not ask.
 */

// Navigating the tab you are looking at, rather than opening another one. The
// panel is docked beside a tab and follows whatever is in it, so a new tab
// would leave the page you were on stranded behind the one you asked for.
async function openSite(url) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (tab?.id) chrome.tabs.update(tab.id, { url });
  else chrome.tabs.create({ url });
}

const SITES = [
  { url: 'https://soundcloud.com/', mark: 'soundcloud', label: 'SoundCloud',
    note: 'Playlists, albums, artists, single tracks' },
  { url: 'https://www.youtube.com/', mark: 'youtube', label: 'YouTube',
    note: 'Any video or playlist' },
];

const Code = ({ children }) => (
  <code className="font-mono bg-wash px-1.5 py-px tracking-[.06em]">{children}</code>
);

// What counts on each site. These are the paths paths.js actually accepts, so
// the list is a description of the routing rather than a promise beside it.
const WORKS_ON = {
  soundcloud: [
    <>A playlist — <Code>/sets/…</Code></>,
    'An album',
    'An artist profile, or its tracks tab',
    'A single track',
  ],
  youtube: [
    'Any video',
    <>A playlist — <Code>/playlist?list=…</Code></>,
    // Worth stating outright: a video opened from a mix carries `list=` and
    // looks like a playlist, and this deliberately takes the one video rather
    // than the two hundred behind it.
    'A video playing inside a mix counts as that one video',
  ],
};

const LEAD = {
  soundcloud: 'Nothing here to dig through. Open any of these and it picks them up on its own:',
  youtube: 'Nothing here to take. Open any of these and it picks them up on its own:',
};

const Bullet = ({ children }) => (
  // A filled cell rather than a bullet glyph, which would pull in a system font
  // on a page that deliberately has none.
  <li className="relative pl-4
                 before:content-[''] before:absolute before:left-0 before:top-[.42em]
                 before:w-1.5 before:h-1.5 before:bg-accent">
    {children}
  </li>
);

/** @param {'soundcloud'|'youtube'|null} service  where the tab already is */
export function Guide({ service, running, error }) {
  const lead = error
    ?? LEAD[service]
    ?? 'Open one of these and it picks up whatever is on the page. The panel stays put and keeps up.';

  const works = service ? WORKS_ON[service] : null;

  return (
    // The measure belongs to the prose, not to the section. Capping the whole
    // thing at 46ch left the buttons ending two thirds of the way across a wide
    // panel, which reads as a layout that failed rather than one that chose.
    <section className="pt-7">
      <p className="m-0 mb-4.5 max-w-[46ch] text-[15px] leading-normal">{lead}</p>

      {!error && !works && (
        <div className="grid gap-2.5">
          {SITES.map((s) => (
            <button key={s.url} type="button" onClick={() => openSite(s.url)}
                    className="group flex items-center gap-3.5 w-full text-left
                               px-4 py-3.5 bg-wash/45 border-[1.5px] border-ink
                               transition-colors duration-150
                               hover:bg-wash
                               focus-visible:outline focus-visible:outline-2
                               focus-visible:outline-offset-2 focus-visible:outline-accent">
              <ProviderMark name={s.mark} size={34} />
              {/* Stacked, so the note has its own line and cannot decide the
                  button's height by wrapping. Both rows are one line each at
                  every width, which is what kept SoundCloud taller than
                  YouTube when the two sat side by side. */}
              <span className="grid gap-1 min-w-0">
                <span className="font-display text-[19px] leading-none">{s.label}</span>
                <span className="font-mono text-[10px] leading-[1.4] tracking-[.08em]
                                 uppercase opacity-60 group-hover:opacity-80 truncate">
                  {s.note}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {!error && works && (
        <ul className="m-0 p-0 list-none grid gap-2.5 font-mono text-[11px]
                       leading-[1.4] tracking-[.12em] uppercase">
          {works.map((item, i) => <Bullet key={i}>{item}</Bullet>)}
        </ul>
      )}

      {/* Downloads started elsewhere keep running. Hiding the working surface
          must not hide the fact that work is in flight. */}
      <p className="mt-5.5 pt-4 border-t-[1.5px] border-ink opacity-70
                    font-mono text-[11px] leading-[1.5] tracking-[.1em] uppercase">
        {error
          ? 'Reload the page, or open a different crate'
          : running ? `${running} still downloading` : ''}
      </p>
    </section>
  );
}
