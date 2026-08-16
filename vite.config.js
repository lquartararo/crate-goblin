import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json' with { type: 'json' };

// CRXJS reads the manifest, works out the entry points, and rewrites paths for
// the built output — so the manifest stays the single source of truth rather
// than being duplicated in build config.
//
// Only the panel is React. The service worker, content scripts, gate scripts
// and offscreen document stay plain modules: none of them render anything, and
// pulling a UI framework into a service worker buys nothing.
//
// Known rough edge: CRXJS does not hot-reload the offscreen document. Changes
// to offscreen.js need a rebuild. It changes rarely, so this is liveable.
export default defineConfig({
  plugins: [react(), tailwindcss(), crx({ manifest })],
  build: {
    // Extensions ship every byte; no reason to also ship sourcemap comments
    // pointing at files that aren't there.
    sourcemap: false,
    rollupOptions: {
      // The offscreen document is opened at runtime by
      // chrome.offscreen.createDocument(), not declared in the manifest — so
      // CRXJS has no way to discover it and the first build silently omitted
      // it. Left that way, every one-click download would 404 on a page that
      // isn't there. Declared explicitly so it's built like any other entry.
      input: { offscreen: 'src/offscreen.html' },
      output: {
        // Stable-ish names make it easier to see what actually changed between
        // builds when something breaks after a reload.
        chunkFileNames: 'assets/[name].[hash].js',
      },
    },
  },
});
