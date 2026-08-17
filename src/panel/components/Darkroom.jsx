import { useEffect, useRef, useState } from 'react';
import { dither, revealDither, stretchTones } from '../dither.js';
import { duotone, levels } from '../palette.js';
import { useThemeTick } from '../useThemeTick.js';
import { Button } from '../ui/button.jsx';
import { Field } from '../ui/field.jsx';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../ui/select.jsx';
import { cn } from '../ui/cn.js';

// The artwork treatment, pointed at whatever you drop on it.
//
// Every album cover in the queue is quantised to the four colours of the current
// theme with an ordered Bayer threshold, and that quantiser has always been able
// to take any bitmap — it just never had a way in other than a track's artwork
// URL. This is the way in.
//
// Three controls, and the reason there are only three: contrast is the fourth
// thing anyone would ask for and it is better inferred than asked. A photo shot
// dark and a scan washed out both dither to mud at a fixed contrast, and neither
// person knows that the fix is a number — so the source is levelled to its own
// range first (stretchTones) and the knob never has to exist.

// Cells across the longest edge, per grain step. The middle one puts a cell at
// roughly four CSS px at this dialog's width, which is the size the artwork
// tiles run at — so the default is the album-cover look at poster scale.
const CELLS = { fine: 200, medium: 120, coarse: 64 };

// Where the dither threshold sits. Small numbers: the quantiser works on a 0..1
// ramp, so a fifth of it is already a full palette level in the midtones.
const BIAS = { darker: -0.16, normal: 0, brighter: 0.16 };

/**
 * The source, reduced to the dither grid and stretched to its own tonal range.
 *
 * Returned as a canvas rather than as pixels because `dither` wants something
 * drawable. Sized to the image's own aspect so the cover-fit inside `dither`
 * has nothing to crop — a track's artwork is square and its tile is square, but
 * a picture someone drops is neither, and quietly trimming the sides off one is
 * not a thing a tool should do to you.
 */
function plate(bitmap, cols, rows) {
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(bitmap, 0, 0, cols, rows);

  const img = ctx.getImageData(0, 0, cols, rows);
  if (stretchTones(img.data)) ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Safe for chrome.downloads, which refuses separators and reserved characters. */
const fileName = (stem) => {
  const clean = (stem || '').replace(/[^\w \-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${clean || 'darkroom'} (dithered).png`;
};

export function Darkroom({ onClose }) {
  const canvasRef = useRef(null);
  const dialog = useRef(null);
  // Which bitmap has already had its entrance. Anything else is a settings
  // change on a picture that is already on screen, and those repaint flat.
  const revealed = useRef(null);
  const theme = useThemeTick();

  const [bitmap, setBitmap] = useState(null);
  const [stem, setStem] = useState('');
  const [problem, setProblem] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [saved, setSaved] = useState(false);

  const [grain, setGrain] = useState('medium');
  const [exposure, setExposure] = useState('normal');
  const [tones, setTones] = useState('four');

  useEffect(() => { dialog.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!bitmap) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    let live = true;

    // The longest edge takes the cell count, so a panorama and a portrait get
    // the same grain rather than the same width.
    const long = CELLS[grain];
    const wide = bitmap.width >= bitmap.height;
    const ratio = wide ? bitmap.height / bitmap.width : bitmap.width / bitmap.height;
    const short = Math.max(8, Math.round(long * ratio));
    const cols = wide ? long : short;
    const rows = wide ? short : long;

    canvas.width = cols;
    canvas.height = rows;

    const source = plate(bitmap, cols, rows);
    const two = duotone();
    const colors = { levels: tones === 'two' ? [two.ink, two.paper] : levels() };
    const settle = () => { if (live) dither(source, canvas, { ...colors, bias: BIAS[exposure] }); };

    if (revealed.current === bitmap) settle();
    else {
      revealed.current = bitmap;
      // The same entrance a track's artwork makes, for the same reason: a
      // picture that resolves out of solid ink says what was done to it.
      revealDither(source, canvas, colors).then(settle);
    }

    return () => { live = false; };
  }, [bitmap, grain, exposure, tones, theme]);

  async function take(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) return setProblem('That one is not a picture');
    try {
      const next = await createImageBitmap(file);
      setProblem(null);
      setSaved(false);
      setBitmap(next);
      setStem(file.name.replace(/\.[^.]+$/, ''));
    } catch {
      setProblem('Could not read that one');
    }
  }

  async function save() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Blown up nearest-neighbour before it leaves. The working canvas is a few
    // hundred pixels across because that is what a cell count of 120 means, and
    // a file that small is one anything else will resample back into mush —
    // which is the one thing this whole treatment cannot survive.
    const scale = Math.max(1, Math.round(1600 / canvas.width));
    const out = document.createElement('canvas');
    out.width = canvas.width * scale;
    out.height = canvas.height * scale;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, 0, 0, out.width, out.height);

    const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
    if (!blob) return setProblem('Could not save that one');

    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({ url, filename: fileName(stem) });
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    } catch {
      setProblem('Chrome would not take the file');
    } finally {
      // Long enough for the download to have been read off it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }

  return (
    <div
      // Above the about box rather than instead of it: closing this comes back
      // to where it was opened from.
      className="fixed inset-0 z-[60] flex items-center justify-center p-6
                 bg-ink/45 backdrop-blur-[2px]"
      onClick={onClose}
      // On the backdrop rather than on the drop zone, so a picture can be
      // dropped anywhere in the dialog — including onto the one already there,
      // which replaces it. Without the preventDefault the panel navigates to
      // the file instead and the whole extension page is gone.
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => {
        // Crossing into a child fires a leave on the parent. Without this the
        // frame flickers on every element the cursor passes over.
        if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        take(e.dataTransfer?.files?.[0]);
      }}
    >
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Darkroom"
           onClick={(e) => e.stopPropagation()}
           className={cn(
             'w-full max-w-[520px] max-h-full overflow-auto outline-none',
             'bg-paper border-[1.5px] p-6 transition-colors duration-150',
             dragging ? 'border-accent' : 'border-ink',
           )}>
        <div className="flex items-start gap-4">
          <div className="min-w-0">
            <h2 className="m-0 font-display text-[28px] leading-none">darkroom</h2>
            <p className="mt-2 mb-0 font-mono text-[10px] tracking-[.14em] uppercase opacity-55">
              Any picture, in the goblin's colours
            </p>
          </div>
          <Button size="sm" onClick={onClose} className="ml-auto">Close</Button>
        </div>

        <div className="mt-5">
          {bitmap ? (
            <canvas
              ref={canvasRef}
              role="img"
              aria-label="Dithered picture"
              // h-auto keeps the aspect from the canvas's own dimensions; the
              // cap is there so a tall picture cannot push the controls out of
              // the dialog, and object-contain is what makes the cap letterbox
              // rather than squash.
              className="block w-full h-auto max-h-[46vh] object-contain
                         border-[1.5px] border-ink [image-rendering:pixelated]"
            />
          ) : (
            <label className={cn(
              'grid place-items-center content-center gap-2 h-[190px]',
              'cursor-pointer text-center border-[1.5px] border-dashed',
              'transition-colors duration-150',
              dragging ? 'border-accent bg-wash' : 'border-ink/40 bg-wash/40 hover:bg-wash',
            )}>
              <input type="file" accept="image/*" className="sr-only"
                     onChange={(e) => take(e.target.files?.[0])} />
              <span className="font-sans text-[15px] leading-none">Drop a picture here</span>
              <span className="font-mono text-[10px] tracking-[.14em] uppercase opacity-55">
                or click to pick one
              </span>
            </label>
          )}
        </div>

        {problem && (
          <p className="mt-3 mb-0 font-mono text-[11px] tracking-[.06em] uppercase text-err">
            {problem}
          </p>
        )}

        {bitmap && (
          <>
            <section className="flex flex-wrap items-end gap-x-4 gap-y-3
                                mt-4 pt-4 border-t-[1.5px] border-ink">
              <Field label="Grain">
                <Select value={grain} onValueChange={setGrain}>
                  <SelectTrigger className="min-w-[110px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fine">Fine</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="coarse">Coarse</SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Exposure">
                <Select value={exposure} onValueChange={setExposure}>
                  <SelectTrigger className="min-w-[110px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="darker">Darker</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="brighter">Brighter</SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Tones">
                <Select value={tones} onValueChange={setTones}>
                  <SelectTrigger className="min-w-[100px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="four">Four</SelectItem>
                    <SelectItem value="two">Two</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </section>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" onClick={save}
                      className="flex-1 min-w-[150px] justify-center">
                {saved ? 'Saved to Downloads' : 'Save it'}
              </Button>
              <Button size="sm" onClick={() => { setBitmap(null); setSaved(false); }}
                      className="flex-1 min-w-[120px] justify-center">
                Another picture
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
