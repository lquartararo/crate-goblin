# Redaction

Typeface by Jeremy Mickel (MCKL) for The Redaction, a project by Titus Kaphar
and Reginald Dwayne Betts. Licensed under the SIL Open Font License — see
`OFL.txt`. Embedding and redistribution are permitted.

Three cuts are bundled, chosen for what they do rather than for weight:

| File | Used for | Why |
|---|---|---|
| `Redaction-Regular` | body, row titles | the clean cut — has to stay readable |
| `Redaction_35-Regular` | figures, badges | lightly degraded; numbers still parse |
| `Redaction_70-Regular` | masthead only | heavily halftoned, at a size that carries it |

The family's whole idea is progressive degradation — 10 through 100 — which is
the same move the artwork dithering makes, in type. The coarser cuts are also
*smaller* files, because the halftone simplifies the outlines.

Only three are bundled: MV3 ships every byte in the package, and the finer
gradations (10 at 123KB) cost the most while reading almost identically to the
clean cut at UI sizes.
