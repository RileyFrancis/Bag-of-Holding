// =============================================================================
// FOLDERS — User-made grouping of the Browse item list
// =============================================================================
'use strict';

// Folders organise the item catalogue, not the character: their own
// localStorage key, not in the save file, never synced. A folder never owns
// items: `folderAssign` maps templateId → folderId and holds only overrides
// (including the UNFILED_ID sentinel, "keep out of every folder"). An item with
// no entry files itself into the default folder its type matches.

const FOLDERS_KEY = 'dnd_inventory_folders';
// Unfiled is virtual and never stored, so one place holds its name.
const UNFILED_NAME = 'Unfiled';

// The default folders, in display order. `match` files an item by what it is,
// mundane and magic side by side. Rules are tried in DEFAULT_FOLDER_MATCH_ORDER,
// not this order: an artifact is an Artifact before a weapon, coins and gems are
// Treasure whatever their other tags, a Necklace of Fireballs is jewelry before a
// consumable. The last two split what is left (Gear takes anything mundane and
// containers, Wondrous Items anything magic), so `_getDefaultFolderIdFor` always
// has an answer.
const DEFAULT_FOLDERS = [
  { id: 'folder_weapons',     name: 'Weapons & Ammunition', match: t => _hasTagWord(t, 'weapon') || _hasTagWord(t, 'ammunition') },
  { id: 'folder_armor',       name: 'Armor & Shields',      match: t => _hasTagWord(t, 'armor') || _hasTagWord(t, 'shield') },
  { id: 'folder_apparel',     name: 'Apparel',              match: t => APPAREL_NAME.test(t.name) },
  { id: 'folder_jewelry',     name: 'Jewelry',              match: t => _hasTagWord(t, 'ring') || JEWELRY_NAME.test(t.name) },
  { id: 'folder_implements',  name: 'Rods, Staffs & Wands', match: t => _hasTagWord(t, 'rod') || _hasTagWord(t, 'staff') || _hasTagWord(t, 'wand') },
  { id: 'folder_consumables', name: 'Consumables',          match: t => !!t.consumable || _hasTagWord(t, 'potion') || _hasTagWord(t, 'scroll') },
  { id: 'folder_food',        name: 'Food & Drink',         match: t => _hasTagWord(t, 'food') || _hasTagWord(t, 'drink') },
  { id: 'folder_wondrous',    name: 'Wondrous Items',       match: t => _hasTagWord(t, 'magic') },
  { id: 'folder_tools',       name: 'Tools & Instruments',  match: t => _hasTagWord(t, 'tool') || _hasTagWord(t, 'instrument') },
  { id: 'folder_gear',        name: 'Gear & Containers',    match: t => !!t.container || _hasTagWord(t, 'container') || !_hasTagWord(t, 'magic') },
  { id: 'folder_currency',    name: 'Coins & Treasure',     match: t => _hasTagWord(t, 'currency') || _hasTagWord(t, 'valuable') || _hasTagWord(t, 'trade') },
  { id: 'folder_artifacts',   name: 'Artifacts',            match: t => t.rarity === 'artifact' },
];

const DEFAULT_FOLDER_MATCH_ORDER = [
  'folder_artifacts', 'folder_currency', 'folder_food', 'folder_weapons', 'folder_armor',
  'folder_implements', 'folder_tools', 'folder_apparel', 'folder_jewelry',
  'folder_consumables', 'folder_gear', 'folder_wondrous',
];

// Worn things that aren't armor, and small worn things, by name, since the
// data's tags don't say where an item is worn. Rings go by their `ring` tag.
const APPAREL_NAME = /\b(cloak|cape|mantle|robes?|boots|slippers|gloves|gauntlets|bracers|belt|girdle|hat|helm|cap|circlet|headband|goggles|lenses|eyes of|wraps|vestments|clothes|garb|sandals)\b/i;
const JEWELRY_NAME = /\b(amulet|necklace|brooch|periapt|medallion|scarab|talisman|pendant|ioun stone|stone of good luck)\b/i;

// Which generation of DEFAULT_FOLDERS a browser's folders were laid out from:
// 1 = Weapons / Armor / Currency / Gear, 2 = sorted by what an item is,
// 3 = adds Food & Drink. Stored, so the upgrade runs once and a folder deleted
// afterwards stays deleted.
const FOLDER_LAYOUT_VERSION = 3;

// The layout-1 default names, by id: the upgrade renames a folder only while it
// still has this name (a folder the user renamed is theirs). folder_magic is a
// layout-1 folder the layout-2 set replaces.
const V1_DEFAULT_NAMES = {
  folder_weapons: 'Weapons', folder_armor: 'Armor', folder_currency: 'Currency',
  folder_gear: 'Gear', folder_magic: 'Magic Items',
};

// Whether the default folders have been laid down for this browser. Stored, so
// deleting them all sticks instead of being undone on the next load.
let hasSeededFolders = false;
let folderLayoutVersion = FOLDER_LAYOUT_VERSION;

let folderModalCallback = null;

// Tags are free-form, so match on whole words: "martial melee weapon" is a weapon.
function _hasTagWord(t, word) {
  return (t.tags ?? []).some(tag => String(tag).toLowerCase().split(/\s+/).includes(word));
}

// Read this browser's folders, assignments and collapse state, then seed or
// upgrade the defaults as needed.
function loadFolders() {
  let data = null;
  try {
    const raw = localStorage.getItem(FOLDERS_KEY);
    if (raw) data = JSON.parse(raw);
  } catch (e) {
    // Corrupt entry or storage disabled: treat it as a first run.
  }

  if (data) {
    if (Array.isArray(data.folders)) {
      state.folders = data.folders
        .filter(f => f && f.id && typeof f.name === 'string')
        .map(f => ({ id: String(f.id), name: f.name }));
    }
    // Keys are template ids, so legacy ones are translated (items.js).
    if (data.assign) state.folderAssign = Object.fromEntries(
      Object.entries(data.assign).map(([id, folderId]) => [getCurrentTemplateId(id), folderId]));
    if (data.collapsed) state.folderCollapsed = { ...data.collapsed };
    hasSeededFolders = !!data.seeded;
    folderLayoutVersion = Number(data.layout) || 1;
  }

  _seedDefaultFolders();
  _upgradeFolderLayout();
}

// A layout-1 browser gets the layout-2 set once: untouched folders take their new
// names, Magic Items goes (unless something was filed into it by hand), the new
// folders are added, and the defaults are put in display order ahead of the
// user's own. A browser with no folders at all chose a flat list and is left alone.
// Each later step adds only the folders that version introduced (a default the
// user deleted must stay deleted), placed after its neighbour.
function _upgradeFolderLayout() {
  if (folderLayoutVersion >= FOLDER_LAYOUT_VERSION) return;
  const fromVersion = folderLayoutVersion;
  folderLayoutVersion = FOLDER_LAYOUT_VERSION;
  if (state.folders.length && fromVersion < 2) _upgradeFolderLayoutToV2(); // adds v3's too
  else if (state.folders.length && fromVersion < 3) _addDefaultFolderAfter('folder_food', 'folder_consumables');
  _saveFolders();
}

// Adds one default folder (unless it, or a folder of its name, already
// exists) just after `afterId`, or at the end without it.
function _addDefaultFolderAfter(id, afterId) {
  const def = DEFAULT_FOLDERS.find(d => d.id === id);
  if (!def || _getFolder(id) || state.folders.some(f => f.name.toLowerCase() === def.name.toLowerCase())) return;
  const at = state.folders.findIndex(f => f.id === afterId);
  state.folders.splice(at === -1 ? state.folders.length : at + 1, 0, { id: def.id, name: def.name });
}

function _upgradeFolderLayoutToV2() {
  const magic = _getFolder('folder_magic');
  const isMagicUsed = Object.values(state.folderAssign).includes('folder_magic');
  if (magic && magic.name === V1_DEFAULT_NAMES.folder_magic && !isMagicUsed) {
    state.folders = state.folders.filter(f => f.id !== 'folder_magic');
    delete state.folderCollapsed.folder_magic;
  }
  state.folders.forEach(f => {
    const def = DEFAULT_FOLDERS.find(d => d.id === f.id);
    if (def && f.name === V1_DEFAULT_NAMES[f.id]) f.name = def.name;
  });
  _addMissingDefaultFolders();
  const getRank = id => {
    const i = DEFAULT_FOLDERS.findIndex(d => d.id === id);
    return i === -1 ? DEFAULT_FOLDERS.length : i;
  };
  state.folders = state.folders
    .map((f, i) => ({ f, i }))
    .sort((a, b) => getRank(a.f.id) - getRank(b.f.id) || a.i - b.i)
    .map(x => x.f);
}

// First run (and once for browsers whose folders predate the defaults): adds
// any default folder not already there by id or by name.
function _seedDefaultFolders() {
  if (hasSeededFolders) return;
  hasSeededFolders = true;
  _addMissingDefaultFolders();
  _saveFolders();
}

// Separate from seeding so Restore Defaults can reuse it; it does not touch
// `hasSeededFolders`.
function _addMissingDefaultFolders() {
  const takenNames = new Set(state.folders.map(f => f.name.toLowerCase()));
  DEFAULT_FOLDERS.forEach(def => {
    if (_getFolder(def.id) || takenNames.has(def.name.toLowerCase())) return;
    state.folders.push({ id: def.id, name: def.name });
  });
}

function _saveFolders() {
  try {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify({
      folders:   state.folders,
      assign:    state.folderAssign,
      collapsed: state.folderCollapsed,
      seeded:    hasSeededFolders,
      layout:    folderLayoutVersion,
    }));
  } catch (e) { /* non-fatal */ }
}

// Safe to reuse a freed id: deleteFolder() purges its assignments first.
function _getNewFolderId() {
  let n = 1;
  while (state.folders.some(f => f.id === 'folder_' + n)) n++;
  return 'folder_' + n;
}

function _getFolder(id) {
  return state.folders.find(f => f.id === id) ?? null;
}

// The display name of a folder id (UNFILED_ID or an unknown id reads as Unfiled).
function getFolderName(id) {
  if (id === UNFILED_ID) return UNFILED_NAME;
  return _getFolder(id)?.name ?? UNFILED_NAME;
}

function _createFolder(name) {
  const clean = (name || '').trim();
  if (!clean) return null;
  const id = _getNewFolderId();
  state.folders.push({ id, name: clean });
  _saveFolders();
  return id;
}

// Rename a folder; a blank name or unknown id is ignored.
function renameFolder(id, name) {
  const folder = _getFolder(id);
  const clean = (name || '').trim();
  if (!folder || !clean) return;
  folder.name = clean;
  _saveFolders();
}

// Delete a folder. Its items are never deleted: dropping their assignments hands
// them back to their default folder, or to Unfiled if that was the one deleted.
function deleteFolder(id) {
  const idx = state.folders.findIndex(f => f.id === id);
  if (idx === -1) return;
  state.folders.splice(idx, 1);
  Object.keys(state.folderAssign).forEach(templateId => {
    if (state.folderAssign[templateId] === id) delete state.folderAssign[templateId];
  });
  delete state.folderCollapsed[id];
  _saveFolders();
}

// The folder an item was explicitly put in: a folder id, UNFILED_ID if the user
// deliberately kept it out of every folder, or null if it has never been filed
// by hand (and so follows its default folder).
function getExplicitFolderId(templateId) {
  const id = state.folderAssign[templateId];
  if (id === UNFILED_ID) return UNFILED_ID;
  return id && _getFolder(id) ? id : null;
}

// Where an unfiled item files itself, by type. Null only if the matching folder
// has been deleted, or renamed and re-created by hand (hence the name lookup).
function _getDefaultFolderIdFor(templateId) {
  const t = state.db[templateId];
  if (!t) return null;
  const id = DEFAULT_FOLDER_MATCH_ORDER.find(fid => DEFAULT_FOLDERS.find(d => d.id === fid).match(t));
  const def = DEFAULT_FOLDERS.find(d => d.id === id);
  if (!def) return null;
  if (_getFolder(def.id)) return def.id;
  const byName = state.folders.find(f => f.name.toLowerCase() === def.name.toLowerCase());
  return byName ? byName.id : null;
}

// Where an item actually shows up: its override if it has one, otherwise its
// default folder. Null (Unfiled) only for an explicit override or an item no
// default folder is left to take.
function getItemFolderId(templateId) {
  const explicit = getExplicitFolderId(templateId);
  if (explicit === UNFILED_ID) return null;
  return explicit ?? _getDefaultFolderIdFor(templateId);
}

// `folderId` is a folder id, UNFILED_ID to keep the item out of every folder, or
// null to drop the override and let the item follow its default folder again.
function setItemFolder(templateId, folderId) {
  if (folderId === UNFILED_ID) state.folderAssign[templateId] = UNFILED_ID;
  else if (folderId && _getFolder(folderId)) state.folderAssign[templateId] = folderId;
  else delete state.folderAssign[templateId];
  _saveFolders();
}

// Called when a template leaves the database, so its assignment doesn't linger.
function forgetItemFolder(templateId) {
  if (!(templateId in state.folderAssign)) return;
  delete state.folderAssign[templateId];
  _saveFolders();
}

// Whether a folder (or Unfiled) is collapsed in the Browse list.
function isFolderCollapsed(id) {
  return !!state.folderCollapsed[id];
}

// Flip a folder's collapse state and store it.
function toggleFolderCollapsed(id) {
  if (state.folderCollapsed[id]) delete state.folderCollapsed[id];
  else state.folderCollapsed[id] = true;
  _saveFolders();
}

// Unfiled is virtual but still collapsible, so "all" has to reach it too.
function _setAllFoldersCollapsed(isCollapsed) {
  state.folderCollapsed = {};
  if (isCollapsed) {
    state.folders.forEach(f => { state.folderCollapsed[f.id] = true; });
    state.folderCollapsed[UNFILED_ID] = true;
  }
  _saveFolders();
}

// Hands every item back to its type's folder by clearing `folderAssign` (it
// holds nothing but hand-filed overrides). Missing default folders are
// re-created first, or `_getDefaultFolderIdFor` has no answer and everything
// lands in Unfiled. Folders the user made are left standing.
function _restoreDefaultFolders() {
  _addMissingDefaultFolders();
  state.folderAssign = {};
  _saveFolders();
}

// Judged on the real folders alone: Unfiled is usually empty and unrendered, so
// letting it decide would strand the button on "Expand All" with nothing open.
function _areAllFoldersCollapsed() {
  return state.folders.length > 0 && state.folders.every(f => isFolderCollapsed(f.id));
}

// Sync the expand/collapse-all button. It offers whichever action isn't done
// already, hides without folders, and is disabled while a search forces every
// folder open (the same reason the headers stop responding).
function updateFolderToolbar(isSearchLocked) {
  const btn = document.getElementById('toggle-folders-btn');
  const areCollapsed = _areAllFoldersCollapsed();
  btn.classList.toggle('hidden', state.folders.length === 0);
  btn.disabled = isSearchLocked;
  // The caret shows the action, not the state (the folder headers' carets read
  // the other way round), so the title carries the meaning.
  btn.textContent = areCollapsed ? '▾' : '▸';
  btn.title = isSearchLocked
    ? 'A search keeps every folder open'
    : (areCollapsed ? 'Open every folder' : 'Close every folder');
}

document.getElementById('toggle-folders-btn').addEventListener('click', () => {
  _setAllFoldersCollapsed(!_areAllFoldersCollapsed());
  renderItemList();
});

// Every hand-filed item moves, so it says exactly what will and will not happen first.
document.getElementById('restore-folders-btn').addEventListener('click', () => {
  const filedCount = Object.keys(state.folderAssign).length;
  const moving = filedCount > 0
    ? `${filedCount} item${filedCount > 1 ? 's' : ''} you filed by hand will move back to the folder its type belongs in.\n\n`
    : '';
  if (!confirm(
    'Restore every item to its default folder?\n\n' + moving +
    'Any missing default folder is re-created. Folders you made yourself are kept, but items will leave them.'
  )) return;
  _restoreDefaultFolders();
  renderItemList();
});

// Bucket already-filtered, already-sorted templates into display order:
// the user's folders in their own order, Unfiled last.
function groupItemsByFolder(items) {
  const buckets = new Map(state.folders.map(f => [f.id, []]));
  const unfiled = [];
  items.forEach(t => {
    const id = getItemFolderId(t.id);
    (id ? buckets.get(id) : unfiled).push(t);
  });
  const groups = state.folders.map(f => ({ id: f.id, name: f.name, items: buckets.get(f.id) }));
  groups.push({ id: UNFILED_ID, name: UNFILED_NAME, items: unfiled });
  return groups;
}

// Total items in a folder, ignoring the search/filter controls, so the delete
// prompt reports everything about to move. Variants ride along with their base
// and aren't counted, as in the list itself.
function getFolderItemCount(folderId) {
  return Object.values(state.db).filter(t => !t.variantOf && getItemFolderId(t.id) === folderId).length;
}

// Fill a folder <select>. `currentId` is an explicit assignment (see
// getExplicitFolderId): the empty option means "no override", i.e. file it by type.
function populateFolderSelect(sel, currentId) {
  sel.innerHTML = '';
  const addOption = (value, label) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    sel.appendChild(opt);
  };
  addOption('', 'Automatic (by type)');
  state.folders.forEach(f => addOption(f.id, f.name));
  addOption(UNFILED_ID, UNFILED_NAME);
  sel.value = currentId ?? '';
}

// ─── FOLDER NAME MODAL (shared by create and rename) ───
// Ask for a folder name; `callback(name)` runs on confirm.
function openFolderNameModal({ title, value, confirmLabel }, callback) {
  folderModalCallback = callback;
  document.getElementById('folder-modal-title').textContent = title;
  document.getElementById('folder-confirm-btn').textContent = confirmLabel;
  const input = document.getElementById('folder-name-input');
  input.value = value ?? '';
  showModal('folder-modal');
  input.focus();
  input.select();
}

function _confirmFolderName() {
  const name = document.getElementById('folder-name-input').value.trim();
  if (!name) { alert('Folder name is required.'); return; }
  hideModal('folder-modal');
  const callback = folderModalCallback;
  folderModalCallback = null;
  if (callback) callback(name);
}

document.getElementById('folder-confirm-btn').addEventListener('click', _confirmFolderName);
document.getElementById('folder-name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); _confirmFolderName(); }
});

document.getElementById('new-folder-btn').addEventListener('click', () => {
  openFolderNameModal({ title: 'New Folder', value: '', confirmLabel: 'Create' }, name => {
    _createFolder(name);
    renderItemList();
  });
});

// ─── FOLDER PICKER MODAL (reclassify one item) ───
// Offer every folder (plus Automatic, Unfiled and New Folder) for one item.
function openMoveToFolderModal(templateId) {
  const t = state.db[templateId];
  if (!t) return;

  document.getElementById('folder-picker-desc').textContent = `Move “${t.name}” to:`;
  const list = document.getElementById('folder-picker-list');
  list.innerHTML = '';
  const current = getExplicitFolderId(templateId);

  const addChoice = (label, isActive, onPick, icon) => {
    const btn = document.createElement('button');
    btn.className = 'btn-sm folder-pick-btn' + (isActive ? ' active' : '');
    if (icon) setIconLabel(btn, icon, label);
    else btn.textContent = label;
    btn.addEventListener('click', () => { hideModal('folder-picker-modal'); onPick(); });
    list.appendChild(btn);
  };

  const auto = _getFolder(_getDefaultFolderIdFor(templateId));
  addChoice(auto ? `Automatic (${auto.name})` : 'Automatic (by type)', current === null, () => {
    setItemFolder(templateId, null);
    renderItemList();
  });
  state.folders.forEach(f => addChoice(f.name, current === f.id, () => {
    setItemFolder(templateId, f.id);
    renderItemList();
  }));
  addChoice(UNFILED_NAME, current === UNFILED_ID, () => {
    setItemFolder(templateId, UNFILED_ID);
    renderItemList();
  });
  addChoice('New Folder…', false, () => {
    openFolderNameModal({ title: 'New Folder', value: '', confirmLabel: 'Create' }, name => {
      setItemFolder(templateId, _createFolder(name));
      renderItemList();
    });
  }, 'plus');
  list.lastChild.classList.add('new');

  showModal('folder-picker-modal');
}
