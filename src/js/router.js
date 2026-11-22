// =============================================================================
// ROUTER — The address bar: which page is on screen, as a URL
// =============================================================================
'use strict';

// Still one page. The URL is a readout of state, written from it — never a
// second source of truth that state is read back out of:
//
//   home                  the home screen
//   character#<charId>    the app, solo, with that roster slot live
//   campaign#<code>       the app, seated at that table (GM or player)
//
// Each is one path segment, written relative to the page, so every relative
// asset path (`data/items.csv`, `src/js/…`) still resolves from the site root,
// and a copy hosted under a sub-folder keeps working. The host has to answer
// those paths with index.html — `_redirects` on Cloudflare Pages, and
// `tools/serve.py` locally (plain `python3 -m http.server` 404s them).
//
// A character# id nobody in this roster answers to gets its own page
// (`state.screen === 'missing'`), not a silent bounce home — and the bad URL is
// left in the bar, the way a 404 leaves it. The roster is local, so "not here"
// may only mean "not pulled from the cloud save yet": a save arriving later
// retries the route (retryMissingRoute()).
//
// `file://` has no paths to rewrite, so there the router is off entirely.

const ROUTER_ON = location.protocol !== 'file:';

// Set while a Back/Forward is being applied, so the screen changes it triggers
// do not push fresh history entries on top of the one being walked to.
let applyingRoute = false;

const missingScreenEl = document.getElementById('missing-screen');

// The route in the address bar: { page: 'home' | 'character' | 'campaign', id?, code? }.
function _parseRoute() {
  const segment = location.pathname.split('/').filter(Boolean).pop() ?? '';
  const arg = decodeURIComponent(location.hash.slice(1));
  if (segment === 'character' && arg) return { page: 'character', id: arg };
  if (segment === 'campaign'  && arg) return { page: 'campaign',  code: arg };
  return { page: 'home' };
}

// The URL the current state should be showing — null to leave it be.
function _getRouteForState() {
  if (state.screen === 'missing') return null; // keep the URL that was asked for
  if (state.screen === 'home') return 'home';
  if (state.party.active && state.party.code) return 'campaign#' + encodeURIComponent(state.party.code);
  return 'character#' + encodeURIComponent(state.activeCharacterId ?? '');
}

// Called after anything that changes which page is on screen. A new page is a
// new history entry (so Back returns to the roster); `replace` corrects the
// current one instead — at boot, and after a route that could not be honoured.
function syncRoute({ replace = false } = {}) {
  if (!ROUTER_ON) return;
  const route = _getRouteForState();
  if (route === null) return;
  const target = new URL(route, location.href);
  if (target.href === location.href) return;
  const shouldPush = !replace && !applyingRoute;
  try {
    history[shouldPush ? 'pushState' : 'replaceState'](null, '', target.href);
  } catch { /* a sandboxed frame may refuse — the app itself does not care */ }
}

// Makes state match a route, as far as it can. An id not in this roster gets the
// not-found page. Anything else it cannot honour — a campaign not currently
// joined, a character while seated at a table — is simply not done, and the
// caller rewrites the URL to whatever is really on screen.
function _applyRoute(route) {
  if (route.page === 'character') {
    if (!state.characters[route.id]) { _openMissingScreen(); return; }
    if (!state.party.active) {
      activateCharacter(route.id); // a no-op when it is already the live one
      if (state.screen !== 'app') closeHomeScreen(); // home, or the not-found page
      return;
    }
  } else if (route.page === 'campaign') {
    // Joining is an async, signed-in affair (campaigns.js); a URL only walks
    // back onto a table this tab is already sitting at.
    if (state.party.active && state.party.code === route.code) {
      if (state.screen !== 'app') closeHomeScreen(); // home, or the not-found page
      return;
    }
  }
  if (state.screen !== 'home') openHomeScreen();
}

// Boot: in place of the unconditional openHomeScreen() — a reload of a
// character's page lands back on that character. A bare `/` becomes `/home`.
function applyBootRoute() {
  if (!ROUTER_ON) { openHomeScreen(); return; }
  state.screen = 'home'; // so a honoured character route runs closeHomeScreen()
  applyingRoute = true;
  try {
    const route = _parseRoute();
    if (route.page === 'character') _applyRoute(route);
    else openHomeScreen(); // a campaign needs a sign-in first; home is where you rejoin
  } finally {
    applyingRoute = false;
  }
  syncRoute({ replace: true });
}

if (ROUTER_ON) {
  // Back/Forward, and a hand-edited hash (`hashchange` alone would miss Back).
  const onNavigate = () => {
    applyingRoute = true;
    try { _applyRoute(_parseRoute()); }
    finally { applyingRoute = false; }
    syncRoute({ replace: true });
  };
  window.addEventListener('popstate', onNavigate);
  window.addEventListener('hashchange', onNavigate);
}

// ─── THE NOT-FOUND PAGE ───

function _openMissingScreen() {
  if (state.party.viewingPlayerId !== null) switchViewToOwn(); // as openHomeScreen()
  cancelPlacing();
  closeCardMenu();
  document.getElementById('home-screen').classList.add('hidden');
  state.screen = 'missing';
  missingScreenEl.classList.remove('hidden');
  renderMissingScreen();
}

// Called by openHomeScreen()/closeHomeScreen(): whichever page comes next
// replaces this one.
function hideMissingScreen() {
  missingScreenEl.classList.add('hidden');
}

// Signing in is the one thing that could make the character turn up, so it is
// offered only while it could — signed out, with accounts available at all.
function renderMissingScreen() {
  if (state.screen !== 'missing') return;
  const canSignIn = !!firebaseAuth && !isSignedIn();
  document.getElementById('missing-signin-note').classList.toggle('hidden', !canSignIn);
  document.getElementById('missing-signin-btn').classList.toggle('hidden', !canSignIn);
}

// The roster just changed under us (a cloud save landed) — the character asked
// for may be in it now.
function retryMissingRoute() {
  if (state.screen !== 'missing') return;
  const route = _parseRoute();
  if (!(route.page === 'character' && state.characters[route.id])) return;
  applyingRoute = true; // same entry, now honoured — not a new one
  try { _applyRoute(route); }
  finally { applyingRoute = false; }
}

document.getElementById('missing-home-btn').addEventListener('click', () => openHomeScreen());

// The action is empty on purpose: the sign-in starts cloud sync, and the save
// it pulls down is what retries the route.
document.getElementById('missing-signin-btn').addEventListener('click', () => {
  requireAuth('Sign in to load your characters from your cloud save.', () => renderMissingScreen());
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || state.screen !== 'missing') return;
  if (document.querySelector('.modal:not(.hidden)')) return;
  openHomeScreen();
});
