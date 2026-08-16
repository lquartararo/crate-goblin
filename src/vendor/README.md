# Vendored dependencies

MV3's CSP forbids remote code, so third-party libraries are committed here
rather than pulled from a CDN at runtime. Nothing is minified beyond what
upstream ships, and there is still no build step.

## lenis.mjs

- **Version** 1.3.26
- **Licence** MIT — https://github.com/darkroomengineering/lenis
- **Source** https://cdn.jsdelivr.net/npm/lenis@1.3.26/dist/lenis.mjs
- **Dependencies** none

Copied verbatim. To update, re-download the same path at the new version and
bump the number above.

## dither-kit/

- **Licence** MIT — https://github.com/Boring-Software-Inc/dither-kit
- **Source** `registry/dither-kit/` at main
- **Dependencies** react, clsx, tailwind-merge, d3-scale, d3-shape, motion

The twelve files a bar chart needs, copied as-is. These are shadcn-style
copy-into-your-project components — there is no importable package for them, so
vendoring is how the library is meant to be used, not a workaround.

`src/panel/dither-kit.js` is a much older, separate hand-port of `dither-paint`
and `pixel` alone. It predates this and drives the goblin, the washes and the
progress meter, none of which are charts.

One local change, marked LOCAL ADDITION in the file: a `crate` colour in
`palette.ts` carrying this panel's plum, since the stock seeds are tuned for a
dark UI.
