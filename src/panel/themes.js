// Five palettes, one shape.
//
// Every colour in the interface comes from four custom properties, and both
// Tailwind and the canvas code read the same four — so a theme is genuinely
// just these numbers, with nothing to keep in sync afterwards.
//
//   ink     text and rules      paper   the ground
//   accent  fills, the goblin   wash    hovers, zebra, panels
//
// warn and err travel with the palette rather than being fixed. They sit in the
// status column next to accent-coloured text, and a pair tuned for blush is
// unreadable on a dark ground — a theme that keeps its errors legible only by
// luck is not finished.

export const THEMES = {
  blush: {
    label: 'Blush',
    swatch: '#7a1e4b',
    vars: {
      '--color-ink': '#1d1219',
      '--color-accent': '#7a1e4b',
      '--color-wash': '#f0d8e4',
      '--color-paper': '#f6edf0',
      '--color-warn': '#84560e',
      '--color-err': '#b8241a',
    },
  },
  cellar: {
    label: 'Cellar',
    swatch: '#1a151d',
    vars: {
      '--color-ink': '#efe4ea',
      '--color-accent': '#d4699b',
      '--color-wash': '#2b2230',
      '--color-paper': '#17131a',
      '--color-warn': '#e0a33c',
      '--color-err': '#f0665c',
    },
  },
  chlorophyll: {
    label: 'Chlorophyll',
    swatch: '#2f6b2a',
    vars: {
      '--color-ink': '#141c13',
      '--color-accent': '#2f6b2a',
      '--color-wash': '#dfe8d4',
      '--color-paper': '#f2f5ec',
      '--color-warn': '#7a5a0c',
      '--color-err': '#b02d16',
    },
  },
  ember: {
    label: 'Ember',
    swatch: '#a8410f',
    vars: {
      '--color-ink': '#241610',
      '--color-accent': '#a8410f',
      '--color-wash': '#f3ddca',
      '--color-paper': '#fbf2e9',
      '--color-warn': '#7d5410',
      '--color-err': '#ab1f24',
    },
  },
  cobalt: {
    label: 'Cobalt',
    swatch: '#1e3f8f',
    vars: {
      '--color-ink': '#101725',
      '--color-accent': '#1e3f8f',
      '--color-wash': '#d9e1f1',
      '--color-paper': '#eff2f9',
      '--color-warn': '#7a560d',
      '--color-err': '#b02420',
    },
  },
};

export const DEFAULT_THEME = 'blush';
const KEY = 'theme';

// Canvases read the palette once and paint. Nothing about a CSS variable change
// tells them to look again, so they are told.
export const THEME_EVENT = 'cg:theme';

export function applyTheme(name) {
  const theme = THEMES[name] ?? THEMES[DEFAULT_THEME];
  for (const [k, v] of Object.entries(theme.vars)) {
    document.documentElement.style.setProperty(k, v);
  }
  dispatchEvent(new Event(THEME_EVENT));
}

export async function loadTheme() {
  try {
    const { [KEY]: name } = await chrome.storage.local.get(KEY);
    return name in THEMES ? name : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function saveTheme(name) {
  applyTheme(name);
  chrome.storage.local.set({ [KEY]: name }).catch(() => {});
}
