// =============================================================================
// PERSISTENCE — localStorage save/load
// =============================================================================
'use strict';

const SAVE_KEY = 'dnd_inventory_v1';

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
  debouncedSync();
});

// Account state (not browser state): the roster, which character is in play, and
// the campaign bookmarks. One builder, so the localStorage and cloud copies
// cannot drift — cloud-save.js stores the JSON of exactly this. The character on
// screen is flushed back to its slot first (`commitActiveCharacter()` declines
// for someone else's sheet or the GM placeholder). Version 3 adds `campaigns`
// (an account fact — it follows you across machines); v2 simply has none, so the
// bump needs no migration. Version 4 adds `homebrew` the same way — an older
// save just has none yet (normalizeHomebrew() hands back an empty tree).
const SAVE_VERSION = 4;

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

// The inverse. `normalizeSavePayload` in characters.js reads every shape (a v1
// save is a single character at the top level). Renders are the caller's job.
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

function autoSave() {
  localStorage.setItem(SAVE_KEY, JSON.stringify(buildSavePayload()));
}

function hasLocalSave() {
  return !!localStorage.getItem(SAVE_KEY);
}

function autoLoad() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return;
  try {
    applySavePayload(JSON.parse(raw));
  } catch {}
}

function flashButton(btn, text) {
  const orig = btn.textContent;
  btn.textContent = text;
  setTimeout(() => btn.textContent = orig, 1500);
}
