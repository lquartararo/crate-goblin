import { useCallback, useEffect, useState } from 'react';

const KEY = 'settings';
const DEFAULTS = { mode: 'best', 'gated-policy': 'auto', container: 'aiff' };

/**
 * Download settings, persisted.
 *
 * They have to outlive the panel for two reasons: re-picking the same three
 * every time you open it is friction on a tool you use weekly, and the one-click
 * track button has no UI of its own — it reads exactly these values, so this is
 * the only place they can come from.
 */
export function useSettings() {
  const [settings, setSettings] = useState(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    chrome.storage.local.get(KEY).then(({ [KEY]: saved }) => {
      setSettings({ ...DEFAULTS, ...(saved ?? {}) });
      setLoaded(true);
    });
  }, []);

  const set = useCallback((key, value) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      chrome.storage.local.set({ [KEY]: next });
      return next;
    });
  }, []);

  // Shaped for downloadRow(), which takes camelCase rather than the element ids
  // the settings are keyed by.
  const opts = {
    mode: settings.mode,
    gatedPolicy: settings['gated-policy'],
    container: settings.container,
  };

  return { settings, set, opts, loaded };
}
