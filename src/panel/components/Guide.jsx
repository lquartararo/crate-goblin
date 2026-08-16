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

// What counts on each site, named the way the site names them. These used to
// carry the URL patterns they map to, which described the routing accurately
// and told the person reading it nothing: someone who has never looked at an
// address bar on purpose does not recognise a page by its path.
const WORKS_ON = {
  soundcloud: [
    'A playlist',
    'An album',
    'An artist profile, or its tracks tab',
    'A single track',
  ],
  // A video opened from a mix takes just that video, not the two hundred
  // behind it. That used to be spelled out here and it does not need to be:
  // it is what anyone would assume, so the note only reassured someone who had
  // already thought to worry about it, and gave everyone else something new to
  // wonder about.
  youtube: [
    'Any video',
    'A playlist',
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
    <section className="pt-7">
      {/* No measure on this. A 46ch cap is the textbook line length and it was
          the wrong call here: everything else in the panel — the rules, the
          buttons, the list — runs the full width, so the one capped element
          stopped short of every edge around it and read as a paragraph that had
          failed to fill rather than one that had been set. At the width this
          panel actually opens at, 46ch was never the binding constraint
          anyway. */}
      <p className="m-0 mb-4.5 text-[15px] leading-normal">{lead}</p>

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
          must not hide the fact that work is in flight.

          The rule comes with the message rather than standing on its own. This
          rendered unconditionally, so the usual case — no error, nothing in
          flight — was a horizontal rule with four pixels of padding and then
          nothing, separating the content from the bottom of the panel. A
          divider is a relationship between two things; with one thing it is
          just a line. */}
      {(error || running > 0) && (
        <p className="mt-5.5 pt-4 border-t-[1.5px] border-ink opacity-70
                      font-mono text-[11px] leading-[1.5] tracking-[.1em] uppercase">
          {error ? 'Reload the page, or open a different crate' : `${running} still downloading`}
        </p>
      )}
    </section>
  );
}
