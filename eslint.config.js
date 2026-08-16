import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

// Lint exists here for one reason: `vite build` proves the syntax parses and
// nothing more. Four separate times a reference to something that no longer
// existed survived a clean build and shipped — `queueable`, `drmMessage`
// swallowed by an unterminated comment, `trackUrl` after a rename, `gate` left
// behind when the email path was removed. Every one of those was a runtime
// crash sitting behind a green tick.
//
// So this is deliberately not a style checker. Nothing here argues about
// formatting; every rule is either "this will throw" or "this is dead".

const shared = {
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
  rules: {
    // The whole point.
    'no-undef': 'error',
    // Catches the other half: the leftovers after a removal, which is how the
    // dangling references got introduced in the first place.
    'no-unused-vars': ['error', {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      // A caught error you deliberately ignore is idiomatic here — half the
      // fallback chain is `catch { }` on purpose.
      caughtErrors: 'none',
    }],
    'no-const-assign': 'error',
    'no-dupe-keys': 'error',
    'no-dupe-args': 'error',
    'no-unreachable': 'error',
    // `if (x = 1)` and friends.
    'no-cond-assign': 'error',
    'no-self-assign': 'error',
    // Promise-returning work dropped on the floor is exactly the class of bug
    // that made downloads fail silently.
    'no-async-promise-executor': 'error',
  },
};

export default [
  { ignores: ['src/vendor/**', 'dist/**', 'node_modules/**', '.updater/**'] },

  // Panel and content scripts: a browser, plus the extension APIs.
  {
    ...shared,
    files: ['src/**/*.js', 'src/**/*.jsx'],
    languageOptions: {
      ...shared.languageOptions,
      globals: { ...globals.browser, ...globals.webextensions },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...shared.rules,
      // Stale closures in a panel that repaints canvases on every frame are
      // expensive to debug and invisible in review.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // The service worker has no DOM.
  {
    ...shared,
    files: ['src/background.js'],
    languageOptions: {
      ...shared.languageOptions,
      globals: { ...globals.serviceworker, ...globals.webextensions },
    },
  },

  // Tests and build config run in Node.
  {
    ...shared,
    files: ['test/**/*.mjs', '*.config.js'],
    languageOptions: { ...shared.languageOptions, globals: { ...globals.node } },
  },
];
