// =============================================================================
// THEME — Light / dark palette switching, persisted across sessions
// =============================================================================
'use strict';

// `<html data-theme>` is always 'light' | 'dark' (the inline script in <head>
// sets it before first paint). The stored preference may also be 'system',
// re-resolved whenever the OS setting changes. Not in the save file: the theme
// belongs to the browser and must be readable before app state loads.

const THEME_KEY = 'dnd_inventory_theme';
const THEME_CHOICES = ['light', 'dark', 'system'];

const systemDarkQuery = window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;

// The stored theme preference: 'light', 'dark' or 'system' (the default).
function getThemePreference() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return THEME_CHOICES.includes(stored) ? stored : 'system';
  } catch (e) {
    return 'system'; // private mode / storage disabled
  }
}

function _doesSystemPreferDark() {
  return !!(systemDarkQuery && systemDarkQuery.matches);
}

// 'system' → whichever palette the OS is asking for right now
function _resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return _doesSystemPreferDark() ? 'dark' : 'light';
}

// Paint the resolved palette and bring rarity-coloured DOM back in sync.
function _applyTheme(pref, { rerender = true } = {}) {
  document.documentElement.setAttribute('data-theme', _resolveTheme(pref));
  // A custom accent is per-palette, so this must run after `data-theme` and
  // before anything reads a colour out of CSS.
  applyAccentVars();
  clearRarityColorCache();
  updateThemePickerUI(pref);
  updateAppearanceUI();
  if (rerender) _rerenderThemedContent();
}

function _setThemePreference(pref) {
  if (!THEME_CHOICES.includes(pref)) return;
  try { localStorage.setItem(THEME_KEY, pref); } catch (e) { /* non-fatal */ }
  _applyTheme(pref);
}

// Rarity colours are read from CSS and baked into inline styles when these
// render, so a palette swap means re-running them.
function _rerenderThemedContent() {
  renderAllItems();
  renderItemList();
  renderStash();
  renderEquipPanel();
  renderShopPanel(); // rarity swatches and coin colours are inlined there too
  clearHostilityColorCache(); // the map bakes hostility colours into a canvas
  renderMapPanel();
  drawBattlemap();
  renderInitiativePanel();   // its rows are edged in the hostility colours too

  // Repaint the details card in place (a no-op while it is closed, since
  // closing clears the selection), not via show*Details(), which rewires it.
  const sel = state.selected;
  if (sel && sel.type === 'instance') {
    const inst = state.instances[sel.id];
    const t = inst && state.db[inst.templateId];
    if (t) populateDetailsPanel(t, inst);
  } else if (sel && sel.type === 'template') {
    const t = state.db[sel.id];
    if (t) populateDetailsPanel(t);
  }
}

// Highlight the chosen theme button and describe what the choice means.
function updateThemePickerUI(pref) {
  document.querySelectorAll('#theme-picker .seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.themeChoice === pref);
  });
  const hint = document.getElementById('theme-hint');
  if (!hint) return;
  hint.textContent = pref === 'system'
    ? `Following your device, which is currently ${_doesSystemPreferDark() ? 'dark' : 'light'}.`
    : `Always ${pref}, on this browser.`;
}

// Load the accent and theme, paint them, and wire the theme picker and OS tracking.
function initTheme() {
  // The colour has to be loaded before the first _applyTheme(), which paints it.
  initAppearance();

  const pref = getThemePreference();
  _applyTheme(pref, { rerender: false }); // _initApp() renders everything right after

  document.querySelectorAll('#theme-picker .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => _setThemePreference(btn.dataset.themeChoice));
  });

  // Track the OS setting while the preference is 'system'
  if (systemDarkQuery) {
    const onSystemChange = () => {
      if (getThemePreference() === 'system') _applyTheme('system');
    };
    if (systemDarkQuery.addEventListener) systemDarkQuery.addEventListener('change', onSystemChange);
    else systemDarkQuery.addListener(onSystemChange); // older Safari
  }
}

function _openSettingsModal() {
  showModal('settings-modal');
}

document.getElementById('settings-btn').addEventListener('click', _openSettingsModal);
document.getElementById('home-settings-btn').addEventListener('click', _openSettingsModal);

// The info pages replace the settings modal (a backdrop click closes every open
// modal). Appearance's button is wired in appearance.js instead, because this
// file's listeners run at load time, before appearance.js is parsed.
document.getElementById('how-to-btn').addEventListener('click', () => {
  hideModal('settings-modal');
  showModal('how-to-modal');
});
document.querySelectorAll('.settings-back-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const modal = btn.closest('.modal');
    if (modal) hideModal(modal.id);
    _openSettingsModal();
  });
});
