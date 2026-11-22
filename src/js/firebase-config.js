// =============================================================================
// FIREBASE-CONFIG — Reads Firebase credentials from the project's .env file
// =============================================================================
'use strict';

// Synchronous XHR, the same way items.js loads data/items.csv, so
// FIREBASE_CONFIG is populated before initFirebase() runs. Two sources, same KEY=value
// text, first hit wins: `.env` locally (gitignored), `/firebase-env` on a deploy
// (a Cloudflare Pages Function). The values reach the browser and are public by
// design — never put real secrets in either.

// .env key → Firebase config key
const FIREBASE_ENV_KEYS = {
  FIREBASE_API_KEY:             'apiKey',
  FIREBASE_AUTH_DOMAIN:         'authDomain',
  FIREBASE_DATABASE_URL:        'databaseURL',
  FIREBASE_PROJECT_ID:          'projectId',
  FIREBASE_STORAGE_BUCKET:      'storageBucket',
  FIREBASE_MESSAGING_SENDER_ID: 'messagingSenderId',
  FIREBASE_APP_ID:              'appId',
};

// Ordered by where the page is running, to avoid a request certain to miss (a
// deploy has no `.env`; a plain local server has no /firebase-env).
const FIREBASE_ENV_SOURCES =
  ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname)
    ? ['.env', 'firebase-env']
    : ['firebase-env', '.env'];

// Parse dotenv-style text: KEY=value per line, # comments, optional quotes.
function _parseEnv(text) {
  const env = {};
  text.split('\n').forEach(rawLine => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) return;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    const isQuoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0];
    if (isQuoted) value = value.slice(1, -1);
    if (key) env[key] = value;
  });
  return env;
}

// Null when nothing is there. The `<` guard: a host that answers 404s with its
// index page (Cloudflare Pages does) returns 200 and a pageful of markup.
function _readEnvFile(path) {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', path, false); // synchronous — must resolve before initFirebase()
    xhr.send();
    if (xhr.status !== 200) return null;
    if (xhr.responseText.trimStart().startsWith('<')) return null;
    return _parseEnv(xhr.responseText);
  } catch (err) {
    return null; // file:// or a blocked request — same as absent
  }
}

// The Firebase config from the first env source that has a databaseURL, or null.
function _loadFirebaseConfig() {
  for (const path of FIREBASE_ENV_SOURCES) {
    const env = _readEnvFile(path);
    if (!env) continue;

    const config = {};
    const missing = [];
    Object.entries(FIREBASE_ENV_KEYS).forEach(([envKey, configKey]) => {
      const value = env[envKey];
      if (value) config[configKey] = value;
      else missing.push(envKey);
    });

    // databaseURL is the one value party sync cannot work without — without it,
    // keep looking rather than give up.
    if (!config.databaseURL) {
      console.warn(`${path} is missing ` + missing.join(', ') + ' — ignoring it.');
      continue;
    }
    if (missing.length) {
      console.warn(`${path} is missing ` + missing.join(', ') + ' — party sync may misbehave.');
    }
    return config;
  }

  console.info('No Firebase config found (looked for ' + FIREBASE_ENV_SOURCES.join(', ') + ') — ' +
               'party features disabled. Copy .env.example to .env to enable them locally; ' +
               'when hosting, see functions/firebase-env.js.');
  return null;
}

const FIREBASE_CONFIG = _loadFirebaseConfig();
