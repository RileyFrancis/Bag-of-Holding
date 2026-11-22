// =============================================================================
// PERSISTENCE — localStorage save/load
// =============================================================================
'use strict';

const SAVE_KEY = 'dnd_inventory_v1'; // localStorage key of the account save
// Older saves lack `campaigns` (added in v3) and `homebrew` (v4); both read back as
// empty defaults, so neither bump needs a migration.
const SAVE_VERSION = 4;

document.getElementById('stash-all-btn').addEventListener('click', stashAllItems);
document.getElementById('stash-delete-all-btn').addEventListener('click', () => {
  const activeContainerId = state.activeContainer;
  const unplaced = Object.values(state.instances).filter(i =>
    (i.containerId ?? null) === activeContainerId && (i.row === null || i.row === undefined)
  );
  if (!confirm(`Delete all ${unplaced.length} stashed item${unplaced.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
  unplaced.forEach(inst => { delete state.instances[inst.id]; });
  renderStash();
  updateWeightDisplay();
  scheduleSaveAndSync();
});

// Builds the account save: roster, active character, campaign bookmarks, homebrew.
// One builder, so the localStorage and cloud copies cannot drift (cloud-save.js
// stores exactly this). Flushes the character on screen to its slot first;
// `commitActiveCharacter()` declines for someone else's sheet or the GM placeholder.
function buildSavePayload() {
  commitActiveCharacter();
  return {
    version: SAVE_VERSION,
    activeCharacterId: state.activeCharacterId,
    characters: state.characters,
    campaigns: state.campaigns,
    homebrew: state.homebrew,
  };
}

// Loads a save payload into state, the inverse of buildSavePayload(). Renders are
// the caller's job. `normalizeSavePayload` reads every shape (v1 is a single character).
function applySavePayload(data) {
  if (!data) return;
  const norm = normalizeSavePayload(data);
  state.characters = norm.characters;
  state.activeCharacterId = norm.activeCharacterId;
  state.campaigns = normalizeCampaigns(data.campaigns);
  state.homebrew = normalizeHomebrew(data.homebrew);
  invalidateUsableHomebrew();     // a pulled save may enable different things
  ensureCharacter();              // also loads the active slot into live state
  loadActiveCharacterIntoLive();
}

// Writes the account save to localStorage.
function autoSave() {
  localStorage.setItem(SAVE_KEY, JSON.stringify(buildSavePayload()));
}

// Whether this browser holds an account save.
function hasLocalSave() {
  return !!localStorage.getItem(SAVE_KEY);
}

// Loads the localStorage save into state, if there is one; a corrupt save is ignored.
function autoLoad() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return;
  try {
    applySavePayload(JSON.parse(raw));
  } catch {}
}

// Shows `text` on a button for 1.5 s, then restores its label.
function flashButton(btn, text) {
  const originalText = btn.textContent;
  btn.textContent = text;
  setTimeout(() => btn.textContent = originalText, 1500);
}
