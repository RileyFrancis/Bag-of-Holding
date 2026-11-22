// =============================================================================
// MAIN — Entry point: wires everything together and boots the app
// =============================================================================
'use strict';

// Read from the `VERSION` file at the project root, fetched async so it never
// holds up the boot.
let appVersion = '';

function _loadAppVersion() {
  fetch('VERSION')
    .then(res => (res.ok ? res.text() : Promise.reject(new Error(res.status))))
    .then(text => {
      const version = text.trim().split('\n')[0].trim();
      // A host answering a missing path with its index page returns 200 and HTML.
      if (!version || version.startsWith('<')) return;
      appVersion = version;
      document.getElementById('app-version').textContent = 'v' + version;
    })
    .catch(() => { /* no VERSION file: the footer stays empty */ });
}

// Fades and removes the boot-time loading screen. transitionend doesn't fire in
// a background tab, so the timeout, not the event, is what clears it.
function _hideLoadingScreen() {
  const el = document.getElementById('loading-screen');
  if (!el) return;
  el.classList.add('loading-done');
  setTimeout(() => el.remove(), 450);
}

// ─── INITIALIZATION ───

function _initApp() {
  _loadAppVersion(); // async; everything below runs without waiting for it
  initTheme();       // before any render: rarity colours are read from the active palette
  loadPanelLayout(); // side-panel widths / collapsed state, stored per browser
  loadDefaultItems();
  DEFAULT_ITEMS.forEach(t => { state.db[t.id] = t; });
  autoLoad();        // restore the whole roster of characters
  ensureCharacter(); // never no character: a first run mints one
  loadFolders();     // Browse-list folders, stored per browser, not in the save file
  loadItemSort();    // Browse-list sort order, likewise per browser
  loadSlotConfig();  // migrate old config or apply defaults if layout not yet set
  rebuildGrid();     // sizes grid from restored character.strength, places saved instances
  renderItemList();
  renderEquipPanel();
  syncCharacterViewUI(); // character tabs; solo, that is the one own-tab
  applyBootRoute();  // /home, or the character the URL names (router.js)
  initFirebase();
  initAuth();        // restores a previous session, which then starts cloud sync
  _hideLoadingScreen();
}

_initApp();
