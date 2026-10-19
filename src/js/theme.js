// =============================================================================
// THEME — Light / dark palette switching, persisted across sessions
// =============================================================================
'use strict';

// `<html data-theme>` is always 'light' | 'dark' (the inline script in <head>
// sets it before first paint). The stored PREFERENCE may also be 'system',
// re-resolved whenever the OS setting changes. Not in the save file — the theme
// belongs to the browser and must be readable before app state loads.

const THEME_KEY = 'dnd_inventory_theme';
const THEME_CHOICES = ['light', 'dark', 'system'];

const systemDarkQuery = window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;

function getThemePreference() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return THEME_CHOICES.includes(stored) ? stored : 'system';
  } catch (e) {
    return 'system'; // private mode / storage disabled
  }
}

function systemPrefersDark() {
  return !!(systemDarkQuery && systemDarkQuery.matches);
}

// 'system' → whichever palette the OS is asking for right now
function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return systemPrefersDark() ? 'dark' : 'light';
}

// Paint the resolved palette and bring rarity-coloured DOM back in sync.
function applyTheme(pref, { rerender = true } = {}) {
  document.documentElement.setAttribute('data-theme', resolveTheme(pref));
  // A custom accent is per-palette, so which half applies just changed — after
  // `data-theme`, before anything reads a colour out of CSS (appearance.js).
  applyAccentVars();
  clearRarityColorCache();
  updateThemePickerUI(pref);
  updateAppearanceUI();
  if (rerender) rerenderThemedContent();
}

function setThemePreference(pref) {
  if (!THEME_CHOICES.includes(pref)) return;
  try { localStorage.setItem(THEME_KEY, pref); } catch (e) { /* non-fatal */ }
  applyTheme(pref);
}

// Rarity colours are read from CSS and baked into inline styles when these
// render, so a palette swap means re-running them.
function rerenderThemedContent() {
  renderAllItems();
  renderItemList();
  renderStash();
  renderEquipPanel();
  renderShopPanel(); // rarity swatches and coin colours are inlined there too
  clearHostilityColorCache(); // the map bakes hostility colours into a canvas
  renderMapPanel();
  drawBattlemap();
  renderInitiativePanel();   // its rows are edged in the hostility colours too

  // Repaint the details panel in place — NOT via show*Details(), which would
  // yank the user to the Details tab.
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

function updateThemePickerUI(pref) {
  document.querySelectorAll('#theme-picker .seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.themeChoice === pref);
  });
  const hint = document.getElementById('theme-hint');
  if (!hint) return;
  hint.textContent = pref === 'system'
    ? `Following your device, which is currently ${systemPrefersDark() ? 'dark' : 'light'}.`
    : `Always ${pref}, on this browser.`;
}

function initTheme() {
  // The colour has to be loaded before the first applyTheme(), which paints it.
  initAppearance();

  const pref = getThemePreference();
  applyTheme(pref, { rerender: false }); // init() renders everything right after

  document.querySelectorAll('#theme-picker .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => setThemePreference(btn.dataset.themeChoice));
  });

  // Track the OS setting while the preference is 'system'
  if (systemDarkQuery) {
    const onSystemChange = () => {
      if (getThemePreference() === 'system') applyTheme('system');
    };
    if (systemDarkQuery.addEventListener) systemDarkQuery.addEventListener('change', onSystemChange);
    else systemDarkQuery.addListener(onSystemChange); // older Safari
  }
}

function openSettingsModal() {
  showModal('settings-modal');
}

document.getElementById('settings-btn').addEventListener('click', openSettingsModal);
document.getElementById('home-settings-btn').addEventListener('click', openSettingsModal);

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const modal = document.getElementById('settings-modal');
  if (modal.classList.contains('hidden')) return;
  hideModal('settings-modal');
});

// The info pages REPLACE the settings modal (a backdrop click closes every open
// modal). Appearance's button is wired in appearance.js instead — this file's
// listeners run at load time, before appearance.js is parsed.
document.getElementById('how-to-btn').addEventListener('click', () => {
  hideModal('settings-modal');
  showModal('how-to-modal');
});
document.querySelectorAll('.settings-back-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const modal = btn.closest('.modal');
    if (modal) hideModal(modal.id);
    openSettingsModal();
  });
});
