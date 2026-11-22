// =============================================================================
// BATTLEMAP INITIATIVE — the turn order: the model, the panel, the group roll
// =============================================================================
'use strict';

// Initiative belongs to the map: it lives at
// `parties/<code>/battlemap/maps/<mapId>/initiative`, rides
// `subscribeToBattlemap`, and is thrown away with the map.
//
//   initiative
//     round   1, 2, 3 …
//     turn    <entryId>   whose turn it is, named rather than numbered
//     entries { <id>: { id, kind, name, score, at, uid?, tokens?, icon?, hostility?, moveUsed? } }
//
// The turn is an entry id, never an index: late rollers drop in mid-fight and
// the GM removes groups. `_getInitiativeActiveEntry()` heals a dangling turn.

const INITIATIVE_PC_PREFIX = 'pc_';

// The GM's group roll dialog.
let initiativeModalMapId = null;
let initiativeModalPicked = new Set();

// The panel's collapsed state, session only.
let initiativeCollapsed = false;

// What the reader is pointing at, as an ENTRY id. The panel and the board are
// two views of one list, so one piece of state keeps them from disagreeing.
let initiativeHoverId = null;

// ─── THE MODEL ──────────────────────────────────────────────────────────────

function _getMapInitiative(map) {
  const init = map?.initiative ?? {};
  return { round: init.round ?? 1, turn: init.turn ?? null, entries: init.entries ?? {} };
}

function _getInitiativeEntries(map) {
  return Object.values(_getMapInitiative(map).entries).filter(e => e && e.id);
}

// Score, then the moment of the roll (arbitrary but STABLE, so every client
// sorts the same way), then the id.
function _getInitiativeOrder(map) {
  return _getInitiativeEntries(map).sort((a, b) =>
    (b.score ?? 0) - (a.score ?? 0)
    || (a.at ?? 0) - (b.at ?? 0)
    || String(a.id).localeCompare(String(b.id)));
}

function _isInitiativeRunning(map) {
  return _getInitiativeEntries(map).length > 0;
}

// Whose turn it is. The entry named may have left the fight, and a tracker
// highlighting nobody looks broken, so the top of the order is the fallback.
function _getInitiativeActiveEntry(map) {
  const order = _getInitiativeOrder(map);
  if (!order.length) return null;
  const turn = _getMapInitiative(map).turn;
  return order.find(e => e.id === turn) || order[0];
}

// Whether an entry speaks for a token. A group lists its tokens; a player's
// entry matches by `ownerUid`, so a re-added token is still theirs. The
// `hostility === 'party'` check keeps a GM who also plays from claiming the
// whole ambush.
function _doesInitiativeEntryClaimToken(entry, token) {
  if (!entry || !token) return false;
  if (entry.tokens) return !!entry.tokens[token.id];
  return !!entry.uid && entry.uid === token.ownerUid && token.hostility === 'party';
}

function _getInitiativeEntryTokens(map, entry) {
  if (!entry) return [];
  return getMapTokens(map).filter(t => _doesInitiativeEntryClaimToken(entry, t));
}

function _getInitiativeEntryOfToken(map, tokenId) {
  const token = (map?.tokens ?? {})[tokenId];
  if (!token) return null;
  return _getInitiativeOrder(map).find(e => _doesInitiativeEntryClaimToken(e, token)) || null;
}

// ─── WRITING ────────────────────────────────────────────────────────────────

function _getInitiativeRef(mapId, rest) {
  return getMapRef(mapId, 'initiative' + (rest ? '/' + rest : ''));
}

// One write, not two: a fight's first entry and its round go up together, or
// the order lands with nobody's turn in it.
function _addInitiativeEntry(mapId, entry) {
  if (!firebaseDb || !state.party.active) return;
  const map = getMapById(mapId);
  if (!map) return;
  const patch = { ['entries/' + entry.id]: entry };
  if (!_isInitiativeRunning(map)) { patch.round = 1; patch.turn = entry.id; }
  _getInitiativeRef(mapId).update(patch);
}

function _removeInitiativeEntry(mapId, entryId) {
  if (!firebaseDb) return;
  const map = getMapById(mapId);
  const entry = map ? _getMapInitiative(map).entries[entryId] : null;
  // The GM runs the fight; a player may still take themselves out of it.
  if (!canEditMap() && !(entry && entry.uid && entry.uid === getOwnPlayerId())) return;
  _getInitiativeRef(mapId, 'entries/' + entryId).remove();
}

function _clearInitiative(mapId) {
  if (!canEditMap() || !firebaseDb) return;
  if (!confirm('End the fight and clear the initiative order?')) return;
  _getInitiativeRef(mapId).remove();
}

// Wrapping past the end is the next round, the only place `round` changes.
// Shared by the GM's step buttons and Pass Turn, which differ only in who may call.
function _advanceInitiativeTurn(map, dir) {
  const order = _getInitiativeOrder(map);
  if (!order.length) return;
  const init = _getMapInitiative(map);
  const active = _getInitiativeActiveEntry(map);
  const at = order.findIndex(e => e.id === active.id);
  const next = at + dir;
  const wrapped = (next + order.length) % order.length;
  let round = init.round ?? 1;
  if (next >= order.length) round += 1;
  if (next < 0) round = Math.max(1, round - 1);
  // A fresh turn is a full tank of movement (see MOVEMENT).
  _getInitiativeRef(map.id).update({
    turn: order[wrapped].id,
    round,
    ['entries/' + order[wrapped].id + '/moveUsed']: 0,
  });
}

// Stepping either way is the GM's: running the fight.
function _stepInitiative(mapId, dir) {
  if (!canEditMap() || !firebaseDb) return;
  const map = getMapById(mapId);
  if (!map) return;
  _advanceInitiativeTurn(map, dir);
}

// Whether the active turn is this reader's to end. Not gated by canEditMap():
// passing your own turn is leaving the fight, not running it. A GM speaks for
// every non-player entry, since a monster group has no uid.
function isMyInitiativeTurn(map) {
  if (!map || !_isInitiativeRunning(map)) return false;
  const active = _getInitiativeActiveEntry(map);
  if (!active) return false;
  if (canEditMap()) return active.kind !== 'pc';
  return active.kind === 'pc' && !!active.uid && active.uid === getOwnPlayerId();
}

function _passInitiativeTurn(mapId) {
  if (!firebaseDb) return;
  const map = getMapById(mapId);
  if (!map || !isMyInitiativeTurn(map)) return;
  _advanceInitiativeTurn(map, 1);
}

// Toggles the sitewide my-turn glow. Checked against the party's actual map
// (getMapForViewer()), not whichever one a GM has open, so a player on their sheet
// is still told it is their move.
function syncMyTurnBorder() {
  document.body.classList.toggle('my-turn', isMyInitiativeTurn(getMapForViewer()));
}

// ─── A ROLL THAT JOINS THE ORDER ────────────────────────────────────────────

// Called from `performRoll()` for every roll; joins the order on the reader's
// own first Initiative roll. Own, because a GM reading a player's sheet rolls as
// the GM; first, so rolling twice can't pick the better number.
function noteRollForInitiative(roll) {
  if (!roll || roll.kind !== 'initiative') return;
  if (!state.party.active || typeof isSignedIn !== 'function' || !isSignedIn()) return;
  if (typeof isLiveStateOwnCharacter === 'function' && !isLiveStateOwnCharacter()) return;

  const map = getMapForViewer();
  if (!map) return;
  const uid = getOwnPlayerId();
  if (!uid) return;

  const id = INITIATIVE_PC_PREFIX + uid;
  if (_getMapInitiative(map).entries[id]) return;

  _addInitiativeEntry(map.id, {
    id, kind: 'pc', uid,
    name: (state.character && state.character.name) || 'Adventurer',
    score: roll.total,
    at: Date.now(),
    hostility: 'party',
  });
}

// ─── THE GM'S GROUP ROLL ────────────────────────────────────────────────────
// Any number of creatures ticked, one d20 for the lot, one shared place in the
// order. The modifier is typed here: this app has no monster stats.

// Creatures not already in the order; a creature has one place in it.
function _getInitiativeCandidates(map) {
  return getMapTokens(map).filter(t => !_getInitiativeEntryOfToken(map, t.id));
}

function _openInitiativeModal(mapId) {
  const map = getMapById(mapId);
  if (!map || !canEditMap()) return;
  initiativeModalMapId = mapId;
  initiativeModalPicked = new Set();

  // Preselect the creature selected on the board, or else the hostile ones.
  const candidates = _getInitiativeCandidates(map);
  const selected = candidates.find(t => t.id === mapSelectedTokenId);
  if (selected) initiativeModalPicked.add(selected.id);
  else candidates.filter(t => t.hostility === 'hostile').forEach(t => initiativeModalPicked.add(t.id));

  document.getElementById('init-group-mod').value = '0';
  renderInitiativeModal();
  showModal('initiative-modal');
}

// Rebuilds the group roll dialog's creature checklist.
function renderInitiativeModal() {
  const map = getMapById(initiativeModalMapId);
  const list = document.getElementById('init-creature-list');
  const nameInput = document.getElementById('init-group-name');
  const rollBtn = document.getElementById('init-roll-btn');
  list.innerHTML = '';
  if (!map) return;

  const candidates = _getInitiativeCandidates(map);
  if (!candidates.length) {
    const note = document.createElement('p');
    note.className = 'modal-note';
    note.textContent = 'Every creature on this map already has a place in the order.';
    list.appendChild(note);
  }

  candidates.forEach(t => {
    const row = document.createElement('label');
    row.className = 'init-pick';
    row.style.setProperty('--hc', getHostilityColor(t.hostility));

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = initiativeModalPicked.has(t.id);
    cb.addEventListener('change', () => {
      if (cb.checked) initiativeModalPicked.add(t.id); else initiativeModalPicked.delete(t.id);
      _syncInitiativeModalName();
    });

    const dot = document.createElement('span');
    dot.className = 'init-pick-dot';
    const icon = document.createElement('span');
    icon.className = 'init-pick-icon';
    icon.textContent = t.icon || '';
    const name = document.createElement('span');
    name.className = 'init-pick-name';
    name.textContent = t.name || 'Creature';

    row.appendChild(cb);
    row.appendChild(dot);
    if (t.icon) row.appendChild(icon);
    row.appendChild(name);
    list.appendChild(row);
  });

  // The name is a suggestion, rewritten only while the GM has not typed one.
  nameInput.dataset.touched = '';
  nameInput.value = '';
  nameInput.placeholder = _getSuggestedGroupName(map);
  rollBtn.disabled = !initiativeModalPicked.size;
}

function _syncInitiativeModalName() {
  const map = getMapById(initiativeModalMapId);
  const nameInput = document.getElementById('init-group-name');
  if (map && !nameInput.dataset.touched) nameInput.placeholder = _getSuggestedGroupName(map);
  document.getElementById('init-roll-btn').disabled = !initiativeModalPicked.size;
}

// Creatures sharing a name are that name; a mixed handful gets the plainest
// true word. The count is NOT in the name: the row draws it as a badge.
function _getSuggestedGroupName(map) {
  const picked = getMapTokens(map).filter(t => initiativeModalPicked.has(t.id));
  if (!picked.length) return 'Enemies';
  const names = [...new Set(picked.map(t => (t.name || '').trim()).filter(Boolean))];
  if (names.length === 1) return names[0];
  return picked.every(t => t.hostility === 'hostile') ? 'Enemies' : 'Creatures';
}

function _confirmInitiativeRoll() {
  const map = getMapById(initiativeModalMapId);
  if (!map || !canEditMap() || !initiativeModalPicked.size) return;

  const nameInput = document.getElementById('init-group-name');
  const name = (nameInput.value || '').trim() || _getSuggestedGroupName(map);
  const mod = Math.max(-30, Math.min(30, parseInt(document.getElementById('init-group-mod').value, 10) || 0));
  const picked = getMapTokens(map).filter(t => initiativeModalPicked.has(t.id));

  const roll = performRoll({
    label: 'Initiative · ' + name,
    faces: 20, count: 1, mod,
    kind: 'initiative-group',
    parts: mod ? [{ label: 'Modifier', value: mod }] : [],
  });

  const tokens = {};
  picked.forEach(t => { tokens[t.id] = true; });
  _addInitiativeEntry(map.id, {
    id: createPieceId('init'),
    kind: 'group',
    name,
    score: roll.total,
    at: Date.now(),
    tokens,
    icon: picked[0].icon || '',
    // A mixed group takes the loudest hostility in it.
    hostility: picked.some(t => t.hostility === 'hostile') ? 'hostile'
      : picked.some(t => t.hostility === 'neutral') ? 'neutral' : 'party',
  });

  hideModal('initiative-modal');
}

// ─── THE PANEL ──────────────────────────────────────────────────────────────
// Top left of the board. Collapsed it shows only whose turn it is (CSS hides
// the inactive rows); expanded it is the whole order.

// Redraws the initiative panel, or hides it off the map view.
function renderInitiativePanel() {
  const panel = document.getElementById('map-initiative');
  if (!panel) return;
  // Shown even before there is an order: it is how one is started.
  const map = typeof isMapViewShowing === 'function' && isMapViewShowing() ? getViewedMap() : null;
  panel.classList.toggle('hidden', !map);
  document.getElementById('init-pass-btn').classList.toggle('hidden', !map || !isMyInitiativeTurn(map));
  if (!map) return;

  const isRunning = _isInitiativeRunning(map);
  const active = _getInitiativeActiveEntry(map);
  panel.classList.toggle('collapsed', initiativeCollapsed && isRunning);
  panel.classList.toggle('empty', !isRunning);

  document.getElementById('init-round').textContent = isRunning ? 'Round ' + (_getMapInitiative(map).round ?? 1) : 'No fight yet';
  const toggle = document.getElementById('init-toggle');
  toggle.textContent = initiativeCollapsed ? '▸' : '▾';
  toggle.title = initiativeCollapsed ? 'Show the whole order' : 'Show only whose turn it is';
  toggle.setAttribute('aria-expanded', String(!initiativeCollapsed));
  toggle.classList.toggle('hidden', !isRunning);

  _renderInitiativeActions(map, isRunning);
  _renderInitiativeOwnRoll(map);
  _renderInitiativeRows(map, active);
}

// The player's own roll on the board (same `data-roll` and dice.js listeners as
// the sheet's). Offered only when it would do something: not to a GM, not on
// someone else's sheet, not once you are in the order.
function _renderInitiativeOwnRoll(map) {
  const footer = document.getElementById('init-footer');
  const uid = getOwnPlayerId();
  const isOwnCharacter = typeof isLiveStateOwnCharacter !== 'function' || isLiveStateOwnCharacter();
  const hasRolled = !!uid && !!_getMapInitiative(map).entries[INITIATIVE_PC_PREFIX + uid];
  footer.classList.toggle('hidden', canEditMap() || !uid || !isOwnCharacter || hasRolled);
}

function _renderInitiativeActions(map, isRunning) {
  const acts = document.getElementById('init-actions');
  acts.innerHTML = '';
  if (!canEditMap()) return;

  const addButton = (label, title, onClick, cls) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'init-btn' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', onClick);
    acts.appendChild(b);
    return b;
  };

  if (isRunning) {
    addButton('‹', 'Back a turn', () => _stepInitiative(map.id, -1));
    addButton('›', 'Next turn', () => _stepInitiative(map.id, 1));
  }
  addButton('+', 'Roll for creatures on the board', () => _openInitiativeModal(map.id));
  if (isRunning) addButton('✕', 'End the fight and clear the order', () => _clearInitiative(map.id), 'danger');
}

function _renderInitiativeRows(map, active) {
  const list = document.getElementById('init-list');
  list.innerHTML = '';
  const order = _getInitiativeOrder(map);

  if (!order.length) {
    const empty = document.createElement('li');
    empty.className = 'init-empty';
    empty.textContent = canEditMap()
      ? 'Nobody has rolled. Players roll for themselves; + rolls for the board.'
      : 'Nobody has rolled yet.';
    list.appendChild(empty);
    return;
  }

  order.forEach(entry => {
    const row = document.createElement('li');
    row.className = 'init-row';
    row.dataset.entry = entry.id;
    if (active && entry.id === active.id) row.classList.add('active');
    if (entry.id === initiativeHoverId) row.classList.add('hover');
    row.style.setProperty('--hc', getHostilityColor(entry.hostility || 'party'));

    // The live token's glyph first (a player never chose an icon, they placed a
    // token); the stored icon for a group whose creatures left, a shield for a
    // player with no token down.
    const tokens = _getInitiativeEntryTokens(map, entry);
    const icon = document.createElement('span');
    icon.className = 'init-icon';
    icon.textContent = (tokens[0] && tokens[0].icon) || entry.icon || (entry.kind === 'pc' ? '🛡️' : '•');

    const name = document.createElement('span');
    name.className = 'init-name';
    name.textContent = entry.name || 'Someone';

    const count = tokens.length;
    if (entry.kind === 'group' && count > 1) {
      const badge = document.createElement('span');
      badge.className = 'init-count';
      badge.textContent = '×' + count;
      name.appendChild(badge);
    }

    const score = document.createElement('span');
    score.className = 'init-score';
    score.textContent = entry.score ?? '—';

    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(score);

    // Only the GM, or the owner of an entry, can take it out.
    if (canEditMap() || (entry.uid && entry.uid === getOwnPlayerId())) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'init-remove';
      rm.textContent = '✕';
      rm.title = 'Take out of the order';
      rm.addEventListener('click', e => { e.stopPropagation(); _removeInitiativeEntry(map.id, entry.id); });
      row.appendChild(rm);
    }

    row.addEventListener('pointerenter', () => setInitiativeHover(entry.id));
    row.addEventListener('pointerleave', () => setInitiativeHover(null));
    list.appendChild(row);
  });
}

// ─── HOVER, BOTH WAYS ───────────────────────────────────────────────────────
// The panel writes the hover on pointer enter, the map from the creature under
// the cursor; each redraws the other side.

// Sets the hovered entry id (or null) and redraws the panel rows and the board.
function setInitiativeHover(entryId) {
  if (initiativeHoverId === entryId) return;
  initiativeHoverId = entryId;
  _syncInitiativeHoverRows();
  drawBattlemap();
}

// Re-marked in place, not rebuilt: this fires on every pointermove, and
// rebuilding would take the cursor off the button it was over.
function _syncInitiativeHoverRows() {
  document.querySelectorAll('#init-list .init-row').forEach(row => {
    row.classList.toggle('hover', row.dataset.entry === initiativeHoverId);
  });
}

// The board's half: hovers the entry of the creature under the cursor, or
// clears the hover for a creature not in the fight.
function noteMapTokenHover(map, tokenId) {
  if (!map || !_isInitiativeRunning(map)) { setInitiativeHover(null); return; }
  const entry = tokenId ? _getInitiativeEntryOfToken(map, tokenId) : null;
  setInitiativeHover(entry ? entry.id : null);
}

// A Map of token id → 'active' | 'hover' for the board to draw, once per frame.
// Hover beats the turn marker on the same creature.
function getInitiativeMarks(map) {
  const marks = new Map();
  if (!map || !_isInitiativeRunning(map)) return marks;
  const active = _getInitiativeActiveEntry(map);
  if (active) _getInitiativeEntryTokens(map, active).forEach(t => marks.set(t.id, 'active'));
  const hovered = initiativeHoverId ? _getMapInitiative(map).entries[initiativeHoverId] : null;
  if (hovered) _getInitiativeEntryTokens(map, hovered).forEach(t => marks.set(t.id, 'hover'));
  return marks;
}

// ─── MOVEMENT ───────────────────────────────────────────────────────────────
// Only a player's own marker has a speed to spend; the app keeps no monster
// stats. The budget (`moveUsed`, feet) lives on the token's own initiative
// entry, so "whose turn resets this" and "whose budget this is" never disagree.
// _advanceInitiativeTurn() resets it. With no entry yet, movement runs free.

// A party token's Speed in feet, or null for a token with no character behind it.
function getTokenSpeed(token) {
  if (!token || token.hostility !== 'party' || !token.ownerUid) return null;
  const character = getCharacterForUid(token.ownerUid);
  if (!character) return null;
  return Number.isFinite(character.speed) ? character.speed : 30;
}

// The initiative entry a token's movement is tracked against, or null.
function getTokenMoveEntry(map, token) {
  return getTokenSpeed(token) === null ? null : _getInitiativeEntryOfToken(map, token.id);
}

// Feet of movement left this turn. null means "not tracked" (no speed, or not
// in the order), which battlemap-view.js leaves alone rather than reading as zero.
function getTokenMoveRemaining(map, token) {
  const entry = getTokenMoveEntry(map, token);
  if (!entry) return null;
  return Math.max(0, getTokenSpeed(token) - (entry.moveUsed || 0));
}

// Adds `feet` to what a token's entry has spent this turn; call once a drag settles.
function spendTokenMovement(map, token, feet) {
  const entry = getTokenMoveEntry(map, token);
  if (!entry || !(feet > 0) || !firebaseDb) return;
  _getInitiativeRef(map.id, 'entries/' + entry.id + '/moveUsed').set((entry.moveUsed || 0) + feet);
}

// ─── WIRING ─────────────────────────────────────────────────────────────────

document.getElementById('init-toggle').addEventListener('click', () => {
  initiativeCollapsed = !initiativeCollapsed;
  renderInitiativePanel();
});

document.getElementById('init-roll-btn').addEventListener('click', _confirmInitiativeRoll);

document.getElementById('init-pass-btn').addEventListener('click', () => {
  const map = getViewedMap();
  if (map) _passInitiativeTurn(map.id);
});

// The board's Roll Initiative, wired like the sheet's roll targets: dice.js owns
// the gesture, this only says which roll it is.
const initOwnRollEl = document.getElementById('init-roll-own');
initOwnRollEl.addEventListener('pointerdown', e => beginRollGesture(e, initOwnRollEl, () => getSheetRollSpec('initiative')));
initOwnRollEl.addEventListener('click', () => rollFromClick(() => getSheetRollSpec('initiative')));
document.getElementById('init-group-name').addEventListener('input', e => {
  e.target.dataset.touched = e.target.value ? '1' : '';
});
