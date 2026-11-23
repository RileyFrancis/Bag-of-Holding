// =============================================================================
// CHARACTER TABS — One tab per character, in the header
// =============================================================================
'use strict';

// One tab per character you can look at (your own, plus every party member).
// Clicking a tab opens a menu of that character's views — sheet, spell sheet
// (when they have not turned it off), inventory. Which character is shown is
// `state.party.viewingPlayerId` (shared with the Party panel); which view is
// `state.view`. Neither is saved. `syncCharacterViewUI()` is the single entry
// point for "who or what we're looking at changed".

const charTabsEl    = document.getElementById('character-tabs');
const charTabMenuEl = document.getElementById('char-tab-menu');

// Key of the tab whose menu is open, held across re-renders so a party sync
// between the click and the choice doesn't snap it shut.
let openTabMenuKey = null;

// The battle map is not a view OF a character, so it is never reached from a
// tab's menu, only from the corner button and the Maps pane.
const INVENTORY_VIEWS = ['inventory', 'sheet', 'spells', 'map'];

// ─── THE TABS ───
function _getCharacterTabList() {
  const { active, role, players, playerId, playerName, viewingPlayerId } = state.party;

  if (!active) return [{ key: OWN_TAB, name: state.character.name, own: true, connected: true }];

  const tabs = [];

  // A GM gets no own-tab. Everyone else leads with themselves.
  if (role === 'player') {
    // While viewing someone else, `state.character` is theirs; our own name
    // comes from the roster copy we published.
    const ownName = viewingPlayerId === null
      ? state.character.name
      : (players[playerId]?.character?.name ?? playerName);
    tabs.push({ key: OWN_TAB, name: ownName, own: true, connected: true });
  }

  Object.entries(players ?? {}).forEach(([id, p]) => {
    if (role === 'player' && id === playerId) return; // already the own-tab
    tabs.push({ key: id, name: p.character?.name ?? p.name, own: false, connected: isPlayerOnline(p) });
  });

  return tabs;
}

// Null for a GM who has not picked a player yet — nobody is being shown.
function _getActiveTabKey() {
  if (!state.party.active) return OWN_TAB;
  if (state.party.viewingPlayerId !== null) return state.party.viewingPlayerId;
  return state.party.role === 'gm' ? null : OWN_TAB;
}

// Rebuilds the header's character tabs and re-anchors an open tab menu.
function renderCharacterTabs() {
  const active = _getActiveTabKey();
  charTabsEl.innerHTML = '';

  _getCharacterTabList().forEach(tab => {
    const btn = document.createElement('button');
    btn.className = 'char-tab' + (tab.key === active ? ' active' : '');
    btn.dataset.tabKey = tab.key;

    // Connection state matters for the other party members, never for yourself.
    if (state.party.active && !tab.own) {
      const dot = document.createElement('span');
      dot.className = 'party-dot ' + (tab.connected ? 'online' : 'offline');
      btn.appendChild(dot);
    }

    const name = document.createElement('span');
    name.className = 'char-tab-name';
    name.textContent = tab.name;
    btn.appendChild(name);

    const caret = document.createElement('span');
    caret.className = 'char-tab-caret';
    caret.textContent = '▾';
    btn.appendChild(caret);

    btn.addEventListener('click', e => {
      e.stopPropagation(); // the document listener below closes on outside clicks
      _toggleCharacterTabMenu(tab.key, btn);
    });

    charTabsEl.appendChild(btn);
  });

  // Put an open menu back under its tab, or drop it if that tab is gone.
  if (openTabMenuKey !== null) {
    const btn = charTabsEl.querySelector(`[data-tab-key="${CSS.escape(openTabMenuKey)}"]`);
    if (btn) _positionCharacterTabMenu(btn);
    else _closeCharacterTabMenu();
  }

  // The buttons above were just rebuilt, so the roll bubbles (dice.js) are
  // re-aimed rather than left pointing at elements that are gone.
  renderTabBubbles();
}

// ─── THE DROPDOWN ───
function _toggleCharacterTabMenu(key, btn) {
  if (openTabMenuKey === key) { _closeCharacterTabMenu(); return; }
  openTabMenuKey = key;
  _updateCharacterTabMenuState();
  _positionCharacterTabMenu(btn);
}

function _positionCharacterTabMenu(btn) {
  const r = btn.getBoundingClientRect();
  charTabMenuEl.classList.remove('hidden'); // measurable only once shown
  const width = charTabMenuEl.offsetWidth;
  charTabMenuEl.style.top  = (r.bottom + 2) + 'px';
  // Clamped so the rightmost tab's menu can't hang off the window edge.
  charTabMenuEl.style.left = Math.max(4, Math.min(r.left, window.innerWidth - width - 4)) + 'px';
}

function _closeCharacterTabMenu() {
  openTabMenuKey = null;
  charTabMenuEl.classList.add('hidden');
}

// The key of the tab whose view menu is open, or null.
function getOpenCharacterTabMenuKey() { return openTabMenuKey; }

// The tick marks the view you are already on, which only means anything on the
// tab of the character currently being shown.
function _updateCharacterTabMenuState() {
  const onShownCharacter = openTabMenuKey === _getActiveTabKey();
  charTabMenuEl.querySelectorAll('.char-view-btn').forEach(b => {
    b.classList.toggle('active', onShownCharacter && b.dataset.view === state.view);
  });
  // The Spell Sheet option is per CHARACTER, not per app — a tab whose
  // character turned it off in Character Setup does not offer it.
  document.getElementById('char-view-spells-btn')
    .classList.toggle('hidden', !isSpellSheetEnabledForTabKey(openTabMenuKey));
}

// The character behind a given tab, without switching to it — used only to
// ask isSpellSheetEnabled() of it. Mirrors _getCharacterTabList()'s own reasoning
// for the own-tab's name while viewing someone else.
function _getCharacterForTabKey(key) {
  if (key === OWN_TAB) {
    const { active, role, players, playerId, viewingPlayerId } = state.party;
    return (active && role === 'player' && viewingPlayerId !== null)
      ? players[playerId]?.character
      : state.character;
  }
  return state.party.players[key]?.character;
}

// Whether the character behind a tab has the spell sheet turned on.
function isSpellSheetEnabledForTabKey(key) {
  return isSpellSheetEnabled(_getCharacterForTabKey(key));
}

charTabMenuEl.querySelectorAll('.char-view-btn').forEach(btn => {
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const key = openTabMenuKey;
    _closeCharacterTabMenu();
    if (key !== null) _selectCharacterView(key, btn.dataset.view);
  });
});

document.addEventListener('click', e => {
  if (openTabMenuKey === null) return;
  if (charTabMenuEl.contains(e.target) || charTabsEl.contains(e.target)) return;
  _closeCharacterTabMenu();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') _closeCharacterTabMenu();
});

// ─── SWITCHING ───
// Picking from a tab's menu can change both halves of the selection at once:
// whose character it is, and which of their views to show.
function _selectCharacterView(key, view) {
  if (key === OWN_TAB) {
    if (state.party.viewingPlayerId !== null) switchViewToOwn();
  } else if (state.party.viewingPlayerId !== key) {
    switchViewToPlayer(key);
  }
  setInventoryPanelView(view);
}

// Sets `state.view` (falling back to the inventory for an unknown view) and redraws.
function setInventoryPanelView(view) {
  state.view = INVENTORY_VIEWS.includes(view) ? view : 'inventory';
  syncCharacterViewUI();
  updateViewingBanner(); // the banner names the view it is talking about
}

// A GM who hasn't picked a player has no character to show a sheet for.
function hasViewedCharacter() {
  return !(state.party.active && state.party.role === 'gm' && state.party.viewingPlayerId === null);
}

// The one entry point for "who or what we're looking at changed". The party UI
// calls it too, so deselecting a player can't leave their sheet on screen.
function syncCharacterViewUI() {
  const showMap = isMapViewShowing();
  const showSheet = !showMap && state.view === 'sheet' && hasViewedCharacter();
  // Also refused once the character on screen has turned it off — a state.view
  // left over from before it was disabled falls back to the inventory, exactly
  // like a GM's leftover 'sheet' does above.
  const showSpells = !showMap && state.view === 'spells' && hasViewedCharacter()
    && isSpellSheetEnabled(state.character);
  const panel = document.getElementById('inventory-panel');
  panel.classList.toggle('map-view', showMap);
  panel.classList.toggle('sheet-view', showSheet);
  panel.classList.toggle('spell-view', showSpells);
  // Arriving back at the inventory is where a Strength typed on the sheet
  // finally resizes the grid (the deferred resize in grid.js) — costs nothing
  // when nothing was edited.
  if (!showSheet && !showSpells && !showMap) rebuildGridIfSizeDirty();
  if (showSheet) renderCharacterSheet();
  if (showSpells) renderSpellSheet();
  // The canvas has no size until the panel is showing it; both halves are
  // no-ops when nothing changed.
  if (showMap) onMapViewShown(); else onMapViewHidden();
  syncMapButton(); // the corner button is the way in, so it stands down once you are there
  renderCharacterTabs();
  syncSidebarTabs(); // the sidebar's tabs answer the same question
  syncLeftPanel();   // and so does the left panel's
  schedulePendingChoicesSync(); // the way to an unmade choice depends on what is showing
}

// ─── KEYBOARD SHORTCUTS ───
// Tab walks the views of whoever is shown (`_getShownCharacterViewCycle()`); Shift+Tab walks
// to the next character; 1–9 walk by absolute position. Off while typing,
// while a modal is up, and mid-drag (a character swap would strand the
// dragged item).
function _areCharacterShortcutsAllowed(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  const t = e.target;
  if (t && t.matches && t.matches('input, textarea, select')) return false;
  if (t && t.isContentEditable) return false;
  if (document.querySelector('.modal:not(.hidden)')) return false;
  if (state.screen !== 'app') return false; // the home screen is a page, not the tabs
  return state.mode === 'idle';
}

// Inventory, then the sheet, then the spell sheet if this character has not
// turned it off — Tab walks this ring one step at a time.
function _getShownCharacterViewCycle() {
  return isSpellSheetEnabled(state.character)
    ? ['inventory', 'sheet', 'spells']
    : ['inventory', 'sheet'];
}

function _cycleShownCharacterView() {
  if (!hasViewedCharacter()) return; // a GM with nobody picked has no sheet to show
  // From the map, this key means "back to the character", not "the other page".
  if (state.view === 'map') { setInventoryPanelView('inventory'); return; }
  const cycle = _getShownCharacterViewCycle();
  const at = cycle.indexOf(state.view);
  setInventoryPanelView(cycle[(Math.max(at, 0) + 1) % cycle.length]);
}

// C / I / S jump straight to a view of whoever is shown, rather than stepping
// _getShownCharacterViewCycle() one place at a time. Same refusals as that cycle: no sheet/
// spell sheet for a GM with nobody picked, no spell sheet once turned off.
function _openCharacterSheetView() {
  if (!hasViewedCharacter()) return;
  setInventoryPanelView('sheet');
}

function _openInventoryView() {
  setInventoryPanelView('inventory');
}

function _openSpellSheetView() {
  if (!hasViewedCharacter() || !isSpellSheetEnabled(state.character)) return;
  setInventoryPanelView('spells');
}

// Keeps the current view (this half is about WHO). From the board, though, it
// means leave the board.
function _showCharacterAt(index) {
  const tab = _getCharacterTabList()[index];
  if (tab) _selectCharacterView(tab.key, state.view === 'map' ? 'inventory' : state.view);
}

function _cycleCharacter(step) {
  const tabs = _getCharacterTabList();
  if (!tabs.length) return;
  // A GM with nobody picked has no active tab (findIndex -1), so the first step
  // lands on the leftmost player.
  const current = tabs.findIndex(t => t.key === _getActiveTabKey());
  const next = (((current + step) % tabs.length) + tabs.length) % tabs.length;
  _showCharacterAt(next);
}

document.addEventListener('keydown', e => {
  if (!_areCharacterShortcutsAllowed(e)) return;

  if (e.key === 'Tab') {
    e.preventDefault(); // a view switch, not focus movement
    _closeCharacterTabMenu();
    if (e.shiftKey) _cycleCharacter(1);
    else _cycleShownCharacterView();
    return;
  }

  if (e.shiftKey) return;
  if (e.key.length === 1 && e.key >= '1' && e.key <= '9') {
    _closeCharacterTabMenu();
    _showCharacterAt(Number(e.key) - 1);
    return;
  }

  if ((e.key === 'm' || e.key === 'M') && state.view !== 'map' && getMapForViewer()) {
    _closeCharacterTabMenu();
    openBattlemap();
    return;
  }

  if (e.key === 'c' || e.key === 'C') {
    _closeCharacterTabMenu();
    _openCharacterSheetView();
    return;
  }

  if (e.key === 'i' || e.key === 'I') {
    _closeCharacterTabMenu();
    _openInventoryView();
    return;
  }

  if (e.key === 's' || e.key === 'S') {
    _closeCharacterTabMenu();
    _openSpellSheetView();
  }
});
