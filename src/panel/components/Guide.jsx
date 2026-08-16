/**
 * Shown instead of the working surface when there's no crate.
 *
 * Every control is inert on a page with no track list — format, gated policy
 * and email all describe a download that can't happen, and a Download button
 * with nothing to download invites a click that does nothing. So they're gone,
 * replaced with what to do instead.
 */
export function Guide({ onSoundcloud, running, error }) {
  const lead = error
    ?? (onSoundcloud
      ? 'This page has no track list. The panel follows you — open any of these and it will pick it up automatically:'
      : 'Open SoundCloud in this tab. The panel stays docked and follows you as you navigate.');

  return (
    <section className="pt-7 max-w-[46ch]">
      <p className="m-0 mb-4.5 text-[15px] leading-normal">{lead}</p>

      {!error && (
        <ul className="m-0 p-0 list-none grid gap-2.5 font-mono text-[11px]
                       leading-[1.4] tracking-[.12em] uppercase">
          {[
            <>A playlist — <code className="font-mono bg-wash px-1.5 py-px tracking-[.06em]">/sets/…</code></>,
            'An album',
            'An artist profile, or its tracks tab',
            'A single track',
          ].map((item, i) => (
            // A filled cell rather than a bullet glyph, which would pull in a
            // system font on a page that deliberately has none.
            <li key={i} className="relative pl-4
                                   before:content-[''] before:absolute before:left-0 before:top-[.42em]
                                   before:w-1.5 before:h-1.5 before:bg-accent">
              {item}
            </li>
          ))}
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
