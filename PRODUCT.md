# Crate Goblin

**register:** product

## Product purpose

Takes a SoundCloud playlist and comes back with the whole thing: unlocked where
it can be, converted to one format, tagged, with artwork, named so Rekordbox
sorts it correctly. The job it replaces is clicking through download gates one
track at a time.

## Users

Louis, a DJ, and two friends. That's the entire user base and it should stay
that way in every decision. Files get played out on club CDJs, so audio quality
is a real constraint and a broken file is worse than a missing one, because you
find out mid-set.

## Anti-references

- **Not a product.** No onboarding, no settings sprawl, no telemetry, no upsell,
  no empty-state illustrations explaining what a playlist is. Bundle size and
  dependency count barely matter next to it working.
- **Not a dashboard.** Nothing that restates a number you already read.
- **No dark theme.** Explicitly rejected. It's used in daylight, beside a
  browser, not in a dim room at 2am.
- **Not neutral.** Big personality was the brief. A grey utility panel is a
  failure state here.

## Tone

Blunt, slightly feral, never cute. The name is a joke that's also literally
accurate: it gets into gated downloads and takes the record. Status copy states
what happened and stops, because it's read mid-task by someone who wants a
number and a format, not a sentence.

Error copy states the fact and refuses to guess at causes. "Sign in and retry"
was removed twice for exactly this: unfalsifiable advice sends someone auditing
their own account for a fault that isn't there.

## Strategic principles

- **The requested format always wins.** Picking MP3 means MP3 everywhere,
  because something downstream has to read it.
- **Never guess metadata.** Write only what SoundCloud states. A plausible wrong
  year propagates into a library as fact.
- **DJs re-download the same track** for different sets, drives and machines.
  Never suppress a download as "already have it".
- **Degrade, don't fail.** A worse file beats a gap in the crate. Every path
  ends in a fallback, and the row says which one it took.
