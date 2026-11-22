// =============================================================================
// /firebase-env — Serves the Firebase settings from the host's environment
// =============================================================================
'use strict';

// A Cloudflare Pages Function: deployed as a Worker automatically, routed by its
// file name, with the variables from Pages → Settings → Variables and Secrets in
// `context.env`. It exists because the deployed site has no `.env` (gitignored,
// and Cloudflare Pages skips dot-paths anyway). The response is the same
// KEY=value text `.env` holds, so firebase-config.js parses one format.
//
// This does NOT make the config secret: the browser must receive it to connect.
// Realtime Database rules guard the data; this only keeps the values out of the repo.

const FIREBASE_ENV_KEYS = [
  'FIREBASE_API_KEY',
  'FIREBASE_AUTH_DOMAIN',
  'FIREBASE_DATABASE_URL',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_STORAGE_BUCKET',
  'FIREBASE_MESSAGING_SENDER_ID',
  'FIREBASE_APP_ID',
];

const TEXT_HEADERS = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };

// GET /firebase-env: the set FIREBASE_* variables as KEY=value lines, or a 404
// when FIREBASE_DATABASE_URL is missing.
export function onRequestGet(context) {
  const env = context.env ?? {};
  const lines = [];

  for (const key of FIREBASE_ENV_KEYS) {
    const value = String(env[key] ?? '').trim();
    if (value) lines.push(`${key}=${value}`);
  }

  // databaseURL is the one value party sync cannot work without — the same test
  // firebase-config.js applies in the browser. Without it, answer as if this
  // route did not exist, which is exactly what an unconfigured deploy means.
  if (!env.FIREBASE_DATABASE_URL) {
    return new Response(
      '# FIREBASE_DATABASE_URL is not set for this deployment.\n' +
      '# Add the FIREBASE_* variables under Pages → Settings → Variables and Secrets.\n',
      { status: 404, headers: TEXT_HEADERS },
    );
  }

  return new Response(lines.join('\n') + '\n', { headers: TEXT_HEADERS });
}
