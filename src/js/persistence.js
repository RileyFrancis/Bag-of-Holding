// =============================================================================
// PERSISTENCE — localStorage save/load and CSV export
// =============================================================================
'use strict';

const SAVE_KEY = 'dnd_inventory_v1';

document.getElementById('save-btn').addEventListener('click', saveState);
document.getElementById('load-btn').addEventListener('click', loadState);
document.getElementById('export-csv-btn').addEventListener('click', exportItemsCSV);

function csvField(val) {
  const s = String(val ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}

function costToCSVStr(cost) {
  const c = parseCostObj(cost);
  const parts = [];
  if (c.pp) parts.push(`${c.pp}pp`);
  if (c.gp) parts.push(`${c.gp}gp`);
  if (c.ep) parts.push(`${c.ep}ep`);
  if (c.sp) parts.push(`${c.sp}sp`);
  if (c.cp) parts.push(`${c.cp}cp`);
  return parts.join(' ');
}

function variantSpecToCSVStr(s) {
  const parens = [];
  if (s.rarity) parens.push(s.rarity.replace(/_/g, ' '));
  if (s.cost) parens.push(s.cost);
  return parens.length ? `${s.label} (${parens.join(', ')})` : s.label;
}

function exportItemsCSV() {
  const headers = ['name','rarity','description','cost','tags','damage','damageType',
                   'attunement','stackSize','image','shape','container','containerRows','containerCols',
                   'properties','mastery','source','variants'];
  const rows = [headers.join(',')];
  Object.values(state.db).forEach(t => {
    const shapeStr = isStackable(t) ? '1' : normalizeShape(t.shape).map(r => r.join('')).join('|');
    rows.push([
      t.name,
      t.rarity,
      t.description || '',
      costToCSVStr(t.cost),
      (t.tags || []).join('|'),
      t.damage || '',
      t.damageType || '',
      t.attunement ? 'true' : '',
      isStackable(t) ? stackSizeOf(t) : '',
      t.image || '',
      shapeStr,
      t.container ? 'true' : '',
      t.containerRows != null ? t.containerRows : '',
      t.containerCols != null ? t.containerCols : '',
      (t.properties || []).join(';'),
      t.mastery || '',
      t.source || '',
      (t.variantSpecs || []).map(variantSpecToCSVStr).join('; '),
    ].map(csvField).join(','));
  });
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'items.csv';
  a.click();
  URL.revokeObjectURL(url);
}
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

function saveState() {
  autoSave();
  flashButton(document.getElementById('save-btn'), 'Saved!');
}

function loadState() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) { alert('No saved data found.'); return; }
  try {
    applySavePayload(JSON.parse(raw));
    renderLiveCharacter();
    flashButton(document.getElementById('load-btn'), 'Loaded!');
  } catch {
    alert('Failed to load save data.');
  }
}

function flashButton(btn, text) {
  const orig = btn.textContent;
  btn.textContent = text;
  setTimeout(() => btn.textContent = orig, 1500);
}
