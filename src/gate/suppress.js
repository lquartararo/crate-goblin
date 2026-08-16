// Runs at document_start in the page's own JS context (world: MAIN).
//
// Gate pages call window.open() to throw up a SoundCloud follow/like prompt.
// Left alone, unlocking ten tracks buries you in ten popups. We hand the page
// back a plausible-looking stub so its own code carries on unbothered, and
// record that a popup was attempted so unlock.js can tell "the gate wanted a
// social step" apart from "nothing happened".

(() => {
  const realOpen = window.open.bind(window);
  let attempts = 0;

  // A no-op object shaped enough like a Window that gate scripts calling
  // .focus() or .close() on the result don't throw and abort their flow.
  const stub = () => ({
    closed: false,
    focus() {},
    blur() {},
    close() { this.closed = true; },
    postMessage() {},
    document: { write() {}, close() {} },
    location: { href: '', replace() {}, assign() {} },
  });

  window.open = function (url, ..._rest) {
    attempts++;
    window.dispatchEvent(new CustomEvent('crate:popup-blocked', { detail: { url: String(url ?? '') } }));
    return stub();
  };

  // Let the extension read the count without exposing the counter globally.
  window.addEventListener('crate:popup-query', () => {
    window.dispatchEvent(new CustomEvent('crate:popup-count', { detail: { attempts } }));
  });

  // Some gates open the prompt with a synthesised <a target="_blank"> click
  // instead of window.open. Neutralise that too, but only for anchors that
  // point off-site — in-page anchors are how you reach the download itself.
  document.addEventListener(
    'click',
    (e) => {
      const a = e.target?.closest?.('a[target="_blank"]');
      if (!a) return;
      try {
        if (new URL(a.href, location.href).origin !== location.origin) {
          attempts++;
          e.preventDefault();
          e.stopPropagation();
        }
      } catch {
        // relative or malformed href — leave it alone
      }
    },
    true, // capture, so we win before the page's own handler
  );

  // Escape hatch: if the gate genuinely needs a real window later, restore it.
  window.__crateRestoreOpen = () => { window.open = realOpen; };
})();
