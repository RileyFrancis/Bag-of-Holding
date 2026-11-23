// =============================================================================
// PENDING CHOICES — the glow on anything the player still has to choose
// =============================================================================
'use strict';

// Something is pending when the player's own character has reached a choice it
// has not made: a subclass, a feature's pick (feature-choices.js), or spells
// still owed by the class tables (getSpellChoiceShortfall()). Each one glows
// where it is made, or, when that is on another page, along the clicks that
// get there (the header name for a subclass, the own tab and its menu for the
// sheet or spell sheet). A target scrolled out of its scroller lights that
// scroller's top or bottom edge instead.
//
// Recomputed in one animation frame after any input event or view change, so
// no caller has to know which of its edits might settle or create a choice.
// Only ever adds a class and positions an overlay; it owns no state of its own.

const PENDING_GLOW_CLASS = 'needs-choice';
const PENDING_PULSE_MS = 2400;     // one glow cycle, matches pending.css
const PENDING_EDGE_HEIGHT = 28;    // px, matches .pending-edge in pending.css
const PENDING_EDGE_SLACK = 6;      // px a target may sit past its scroller's edge and still count as seen

// The elements glowing now, and the on-page targets watched for scrolling away.
let pendingGlowEls = new Set();
let pendingWatchEls = [];
let pendingEdgeEls = [];
let isPendingSyncScheduled = false;
let isPendingEdgeSyncScheduled = false;

const pendingEdgeLayerEl = document.createElement('div');
pendingEdgeLayerEl.id = 'pending-edges';
pendingEdgeLayerEl.setAttribute('aria-hidden', 'true');
document.body.appendChild(pendingEdgeLayerEl);

// ─── WHAT IS PENDING ───

// Every choice this character has reached and not made, as { kind, key? }.
function getPendingChoices(character) {
  if (!character) return [];
  const pending = [];
  getClassEntries(character).forEach(entry => {
    if (isSubclassChoicePending(entry)) pending.push({ kind: 'subclass' });
  });
  getPendingFeatureChoiceKeys(character).forEach(key => pending.push({ kind: 'feature', key }));
  if (isSpellSheetEnabled(character)) {
    const shortfall = getSpellChoiceShortfall(character);
    if (shortfall.cantrips || shortfall.spells) pending.push({ kind: 'spells' });
  }
  return pending;
}

// The player's own character and whether it is the one on screen; null for a GM,
// who has no character of their own to be reminded about.
function _getOwnCharacterView() {
  const { active, role, viewingPlayerId, players, playerId } = state.party;
  if (!active || (role !== 'gm' && viewingPlayerId === null)) {
    return { character: state.character, isShown: true };
  }
  if (role === 'gm') return null;
  return { character: players?.[playerId]?.character ?? null, isShown: false };
}

// ─── THE ROUTE TO EACH CHOICE ───

// The elements to light right now: `glow` gets the class, `watch` is what the
// edge indicators follow when it scrolls out of sight.
function _getPendingRoute() {
  const route = { glow: [], watch: [] };

  // A dialog covers everything else; Character Setup answers for its own rows.
  const openModals = [...document.querySelectorAll('.modal:not(.hidden)')];
  if (openModals.length) {
    if (openModals.every(m => m.id === 'character-modal')) {
      const inputs = getCharModalPendingSubclassInputs();
      route.glow.push(...inputs);
      route.watch.push(...inputs);
    }
    return route;
  }

  if (state.screen !== 'app') return route;
  const own = _getOwnCharacterView();
  const pending = getPendingChoices(own?.character);
  if (!pending.length) return route;

  // Looking at someone else: the way back is your own tab.
  if (!own.isShown) {
    route.glow.push(_getOwnTabEl());
    return route;
  }

  pending.forEach(choice => {
    if (choice.kind === 'subclass') _addSubclassRoute(route);
    else if (choice.kind === 'feature') _addFeatureRoute(route, choice.key);
    else if (choice.kind === 'spells') _addSpellsRoute(route);
  });
  return route;
}

function _addSubclassRoute(route) {
  route.glow.push(document.getElementById('char-name-display'));
  if (_isInventoryPanelShowing('sheet-view')) route.glow.push(document.getElementById('sheet-setup-btn'));
}

function _addFeatureRoute(route, key) {
  if (!_isInventoryPanelShowing('sheet-view')) { _addViewRoute(route, 'sheet'); return; }
  const card = document.querySelector(`#character-sheet .feature-card[data-feature-key="${CSS.escape(key)}"]`);
  const target = card?.querySelector('.feature-choice') ?? card;
  if (!target) return;
  route.glow.push(target);
  route.watch.push(target);
}

function _addSpellsRoute(route) {
  if (!_isInventoryPanelShowing('spell-view')) { _addViewRoute(route, 'spells'); return; }
  const tabBtn = document.querySelector('#sidebar-tabs .tab-btn[data-tab="spellbook"]');
  if (tabBtn && !tabBtn.classList.contains('active')) { route.glow.push(tabBtn); return; }
  route.glow.push(document.getElementById('spellbook-list'));
}

// Another view of your own character: the own tab, and its menu entry once open.
function _addViewRoute(route, view) {
  route.glow.push(_getOwnTabEl());
  if (getOpenCharacterTabMenuKey() === OWN_TAB) {
    route.glow.push(document.querySelector(`#char-tab-menu .char-view-btn[data-view="${view}"]`));
  }
}

function _getOwnTabEl() {
  return document.querySelector(`#character-tabs .char-tab[data-tab-key="${OWN_TAB}"]`);
}

function _isInventoryPanelShowing(viewClass) {
  return document.getElementById('inventory-panel').classList.contains(viewClass);
}

// ─── APPLYING THE GLOW ───

// Queues one recompute for the next frame. Safe to call from anywhere, any number of times.
function schedulePendingChoicesSync() {
  if (isPendingSyncScheduled) return;
  isPendingSyncScheduled = true;
  requestAnimationFrame(() => _runAfterLoad(_syncPendingChoices));
}

// The scripts after this one define what it reads; a frame can fire between them.
function _runAfterLoad(fn) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
  else fn();
}

function _syncPendingChoices() {
  isPendingSyncScheduled = false;
  const route = _getPendingRoute();
  const next = new Set(route.glow.filter(Boolean));

  pendingGlowEls.forEach(el => {
    if (next.has(el)) return;
    el.classList.remove(PENDING_GLOW_CLASS);
    el.style.removeProperty('animation-delay');
  });
  next.forEach(el => {
    if (el.classList.contains(PENDING_GLOW_CLASS)) return;
    _setPulsePhase(el);
    el.classList.add(PENDING_GLOW_CLASS);
  });

  pendingGlowEls = next;
  pendingWatchEls = route.watch.filter(Boolean);
  _syncPendingEdges();
}

// Starts a new glow partway through the cycle, so every glow pulses together.
function _setPulsePhase(el) {
  el.style.animationDelay = `-${Math.round(performance.now() % PENDING_PULSE_MS)}ms`;
}

// ─── THE EDGE INDICATORS ───

function _schedulePendingEdgeSync() {
  if (isPendingEdgeSyncScheduled) return;
  isPendingEdgeSyncScheduled = true;
  requestAnimationFrame(() => _runAfterLoad(_syncPendingEdges));
}

// Lights the top or bottom of each scroller hiding a watched target past that edge.
function _syncPendingEdges() {
  isPendingEdgeSyncScheduled = false;
  const edges = [];
  const byScroller = new Map();

  pendingWatchEls.forEach(el => {
    if (!el.isConnected || !el.getClientRects().length) return; // gone, or display: none
    const scroller = _getScrollParent(el);
    const view = _getVisibleRect(scroller);
    const rect = el.getBoundingClientRect();
    const side = rect.bottom < view.top + PENDING_EDGE_SLACK ? 'top'
               : rect.top > view.bottom - PENDING_EDGE_SLACK ? 'bottom' : null;
    if (!side) return;
    const sides = byScroller.get(scroller) ?? new Set();
    if (!sides.has(side)) edges.push({ side, view });
    sides.add(side);
    byScroller.set(scroller, sides);
  });

  // Pooled rather than rebuilt, so a scroll does not restart the pulse.
  while (pendingEdgeEls.length < edges.length) {
    const el = document.createElement('div');
    el.className = 'pending-edge';
    _setPulsePhase(el);
    pendingEdgeLayerEl.appendChild(el);
    pendingEdgeEls.push(el);
  }
  pendingEdgeEls.forEach((el, i) => {
    const edge = edges[i];
    el.classList.toggle('hidden', !edge);
    if (!edge) return;
    el.classList.toggle('top', edge.side === 'top');
    el.classList.toggle('bottom', edge.side === 'bottom');
    el.style.left = `${edge.view.left}px`;
    el.style.width = `${Math.max(0, edge.view.right - edge.view.left)}px`;
    el.style.top = `${edge.side === 'top' ? edge.view.top : edge.view.bottom - PENDING_EDGE_HEIGHT}px`;
  });
}

// The nearest ancestor that actually scrolls vertically, or null for the page itself.
function _getScrollParent(el) {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const overflowY = getComputedStyle(p).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

// The part of a scroller inside the window.
function _getVisibleRect(scroller) {
  const width = window.innerWidth;
  const height = window.innerHeight;
  if (!scroller) return { top: 0, bottom: height, left: 0, right: width };
  const r = scroller.getBoundingClientRect();
  return {
    top: Math.max(0, r.top), bottom: Math.min(height, r.bottom),
    left: Math.max(0, r.left), right: Math.min(width, r.right),
  };
}

// ─── WHEN TO LOOK AGAIN ───
// Capture phase so a handler that stops propagation cannot hide an edit; the
// recompute itself waits a frame, after every handler has run.
['click', 'input', 'change', 'keyup', 'focusin'].forEach(type =>
  document.addEventListener(type, schedulePendingChoicesSync, true));
window.addEventListener('popstate', schedulePendingChoicesSync);
window.addEventListener('resize', schedulePendingChoicesSync);
document.addEventListener('scroll', _schedulePendingEdgeSync, { capture: true, passive: true });
