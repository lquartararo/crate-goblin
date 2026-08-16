// Cleaning up what SoundCloud calls a track.
//
// Two jobs, both governed by one rule: never remove anything that might be
// load-bearing. A wrong tag is worse than an untidy one, because it follows the
// file into the library and you find it mid-set.
//
// So everything here is deliberately timid. It acts only on patterns that are
// unambiguous, and when a case is even slightly uncertain it leaves the string
// exactly as it found it.

// Promo noise that channels bolt onto titles. Matched against the *entire*
// contents of a bracketed group, never as a substring, which is what stops
// "Free" being clipped out of a track called "Free" or "Freefall".
//
// Deliberately absent: "premiere", "out now on <label>", "original mix". The
// first two are how a listener finds the release again, and "original mix" is a
// real distinction from a remix on the same record.
const PROMO = [
  /^free\s*(download|dl)$/i,
  /^free\s*(download|dl)\s*(in|via|link\s*in)\s*(the\s*)?(description|bio|link)$/i,
  /^(click\s*)?buy\s*(=|for|→|->)\s*free\s*(download|dl)$/i,
  /^(download|dl)\s*(link\s*)?(in|via)\s*(the\s*)?(description|bio)$/i,
  /^free\s*(download|dl)\s*!*$/i,
  /^\**\s*free\s*(download|dl)\s*\**$/i,
];

// Bracket pairs a title might use. Nested groups are left alone entirely —
// "Isaw (feat. DJ Love (Sherwin Tuna))" is one unit and slicing into it would
// produce a mangled title, which is worse than an untidy one.
const GROUP = /\s*[([{]([^()[\]{}]*)[)\]}]\s*/g;

/**
 * Strip promo brackets from a title.
 *
 * Only whole bracketed groups, only when their entire contents match a known
 * promo phrase, and never if the result would be empty. A title that *is*
 * nothing but "(FREE DOWNLOAD)" keeps it, because an empty title is worse than
 * a silly one.
 */
export function cleanTitle(title) {
  const raw = (title ?? '').trim();
  if (!raw) return raw;

  const stripped = raw
    .replace(GROUP, (whole, inner) => (PROMO.some((p) => p.test(inner.trim())) ? ' ' : whole))
    // Trailing "| free download" and friends, which some channels use instead
    // of brackets. Anchored to the end so an interior pipe is untouched.
    .replace(/\s*[|·–-]\s*(free\s*(download|dl))\s*!*\s*$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*[-–|·,]\s*$/, '')
    .trim();

  return stripped || raw;
}

// An artist credit is short. A long left-hand side is far more likely to be
// half of a title that happens to contain a dash than it is a list of artists.
const MAX_ARTIST_WORDS = 6;

// Words that mark a parenthetical as naming a *version* rather than a feature.
// Whoever is named inside one of these is the remixer, not the artist.
const VERSION = /\b(re-?mix|re-?edit|\bedit\b|bootleg|mash-?up|flip|vip|rework|refix|remaster|version|\bmix\b)\b/i;

/** Contents of every top-level bracketed group in a title. */
function groups(title) {
  return [...String(title ?? '').matchAll(/[([{]([^()[\]{}]*)[)\]}]/g)].map((m) => m[1]);
}

/**
 * Is the declared artist credited as the remixer rather than the artist?
 *
 * The strong, checkable signal. If SoundCloud says the artist is X, and the
 * title carries "(… X … Remix)", then X made *this version* and whoever is
 * named before the dash made the record. That is also how Beatport and
 * Rekordbox expect it: artist is the original act, the remixer lives in the
 * title's parenthetical.
 */
function declaredIsRemixer(title, artist) {
  if (!artist) return false;
  const needle = artist.trim().toLowerCase();
  if (needle.length < 2) return false;
  return groups(title).some(
    (g) => VERSION.test(g) && g.toLowerCase().includes(needle),
  );
}

/**
 * Work out the real artist and title.
 *
 * Three situations, each needing something to corroborate it:
 *
 * 1. The declared artist is named inside a version parenthetical, so they are
 *    the remixer and the act is whoever sits before the dash.
 * 2. The artist is repeated as a prefix of the title. Unambiguous duplication,
 *    so the prefix goes.
 * 3. Nothing declared an artist and the title reads "Artist - Title" — the
 *    promo-channel case, where the uploader is a label or a mix series.
 *
 * Anything else is left exactly as SoundCloud gave it.
 */
export function splitArtistTitle({ title, artist, artistDeclared }) {
  const cleanedTitle = cleanTitle(title);
  const known = (artist ?? '').trim();

  // 1. Declared artist is the remixer: the credit before the dash is the act.
  //
  // This used to be refused outright, on the reasoning that a declared artist
  // must be trusted. That left "Skrillex & Damian Marley - Make It Bun Dem
  // (Pablito Mix … Remix)" tagged as by Pablito Mix, which is the remixer, and
  // is not what you would search the library for.
  if (known && declaredIsRemixer(cleanedTitle, known)) {
    const m = cleanedTitle.match(/^(.{2,}?)\s+[-–—]\s+(.+)$/);
    if (m && !/[([{]/.test(m[1]) && m[1].split(/\s+/).length <= MAX_ARTIST_WORDS) {
      return { artist: m[1].trim(), title: m[2].trim(), split: 'remix' };
    }
  }

  // 2. Drop a duplicated artist prefix.
  if (known) {
    const prefix = new RegExp(`^${escapeRe(known)}\\s*[-–—:]\\s*`, 'i');
    if (prefix.test(cleanedTitle)) {
      const rest = cleanedTitle.replace(prefix, '').trim();
      if (rest) return { artist: known, title: rest, split: 'prefix' };
    }
    // A declared artist that isn't a prefix is trusted as-is.
    if (artistDeclared) return { artist: known, title: cleanedTitle, split: null };
  }

  // 3. Nobody declared an artist: try to read one out of the title.
  const m = cleanedTitle.match(/^(.{2,}?)\s+[-–—]\s+(.+)$/);
  if (m) {
    const [, left, right] = m;
    const plausible =
      left.split(/\s+/).length <= MAX_ARTIST_WORDS
      // Brackets on the left mean the dash is inside the title, not between
      // artist and title: "Foo (Live - 2019) - Bar" must not split at the first.
      && !/[([{]/.test(left)
      && right.trim().length > 0
      // A leading track number is a tracklist, not a credit.
      && !/^\d{1,2}[.)]?$/.test(left.trim());

    if (plausible) return { artist: left.trim(), title: right.trim(), split: 'title' };
  }

  return { artist: known || 'Unknown', title: cleanedTitle, split: null };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
