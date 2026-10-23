// =============================================================================
// FOLDERS — User-made grouping of the Browse item list
// =============================================================================
'use strict';

// Folders organise the item CATALOGUE, not the character — their own
// localStorage key, not in the save file, never synced. A folder never owns
// items: `folderAssign` maps templateId → folderId and holds only OVERRIDES
// (including the UNFILED_ID sentinel, "keep out of every folder"). An item with
// no entry files itself into the default folder its type matches. See CLAUDE.md
// § Browse-list folders.

const FOLDERS_KEY = 'dnd_inventory_folders';
const UNFILED_ID = '__unfiled';

// The folders every browser starts with, in display order. `match` files an
// item by what it IS — mundane and magic side by side, so a +1 Longsword sits
// with the longswords. Rules are tried in DEFAULT_FOLDER_MATCH_ORDER, not this
// order: an artifact is an Artifact before it is a weapon, coins and gems are
// Treasure whatever else their tags say, a Necklace of Fireballs is jewelry
// before it is a consumable. The last two split what is left — Gear takes
// anything mundane (and containers), Wondrous Items anything magic — so
// `defaultFolderIdFor` always has an answer. Ordinary folders once created —
// not re-created.
const DEFAULT_FOLDERS = [
  { id: 'folder_weapons',     name: 'Weapons & Ammunition', match: t => hasTagWord(t, 'weapon') || hasTagWord(t, 'ammunition') },
  { id: 'folder_armor',       name: 'Armor & Shields',      match: t => hasTagWord(t, 'armor') || hasTagWord(t, 'shield') },
  { id: 'folder_apparel',     name: 'Apparel',              match: t => APPAREL_NAME.test(t.name) },
  { id: 'folder_jewelry',     name: 'Jewelry',              match: t => hasTagWord(t, 'ring') || JEWELRY_NAME.test(t.name) },
  { id: 'folder_implements',  name: 'Rods, Staffs & Wands', match: t => hasTagWord(t, 'rod') || hasTagWord(t, 'staff') || hasTagWord(t, 'wand') },
  { id: 'folder_consumables', name: 'Consumables',          match: t => !!t.consumable || hasTagWord(t, 'potion') || hasTagWord(t, 'scroll') },
  { id: 'folder_wondrous',    name: 'Wondrous Items',       match: t => hasTagWord(t, 'magic') },
  { id: 'folder_tools',       name: 'Tools & Instruments',  match: t => hasTagWord(t, 'tool') || hasTagWord(t, 'instrument') },
  { id: 'folder_gear',        name: 'Gear & Containers',    match: t => !!t.container || hasTagWord(t, 'container') || !hasTagWord(t, 'magic') },
  { id: 'folder_currency',    name: 'Coins & Treasure',     match: t => hasTagWord(t, 'currency') || hasTagWord(t, 'valuable') || hasTagWord(t, 'trade') },
  { id: 'folder_artifacts',   name: 'Artifacts',            match: t => t.rarity === 'artifact' },
];

const DEFAULT_FOLDER_MATCH_ORDER = [
  'folder_artifacts', 'folder_currency', 'folder_weapons', 'folder_armor',
  'folder_implements', 'folder_tools', 'folder_apparel', 'folder_jewelry',
  'folder_consumables', 'folder_gear', 'folder_wondrous',
];

// Worn things that aren't armor, and small worn things — by name, since the
// data's tags don't say where an item is worn. Rings go by their `ring` tag.
const APPAREL_NAME = /\b(cloak|cape|mantle|robes?|boots|slippers|gloves|gauntlets|bracers|belt|girdle|hat|helm|cap|circlet|headband|goggles|lenses|eyes of|wraps|vestments|clothes|garb|sandals)\b/i;
const JEWELRY_NAME = /\b(amulet|necklace|brooch|periapt|medallion|scarab|talisman|pendant|ioun stone|stone of good luck)\b/i;

// Tags are free-form, so match on whole words: "martial melee weapon" is a weapon.
function hasTagWord(t, word) {
  return (t.tags ?? []).some(tag => String(tag).toLowerCase().split(/\s+/).includes(word));
}

// Whether the default folders have been laid down for this browser. Stored, so
// deleting them all sticks instead of being undone on the next load.
let foldersSeeded = false;

// Which generation of DEFAULT_FOLDERS this browser's folders were laid out
// from. 1 is the original Weapons / Armor / Currency / Gear set; 2 is the
// current one. Stored, so the upgrade below runs once and a folder deleted
// afterwards stays deleted.
const FOLDER_LAYOUT_VERSION = 2;
let folderLayout = FOLDER_LAYOUT_VERSION;

// The v1 defaults, by id — the upgrade renames one only while it still has
// this name (a folder the user renamed is theirs). folder_magic was a v1.5
// addition that the v2 folders replace.
const V1_DEFAULT_NAMES = {
  folder_weapons: 'Weapons', folder_armor: 'Armor', folder_currency: 'Currency',
  folder_gear: 'Gear', folder_magic: 'Magic Items',
};

function loadFolders() {
  let data = null;
  try {
    const raw = localStorage.getItem(FOLDERS_KEY);
    if (raw) data = JSON.parse(raw);
  } catch (e) {
    // Corrupt entry or storage disabled — treat it as a first run.
  }

  if (data) {
    if (Array.isArray(data.folders)) {
      state.folders = data.folders
        .filter(f => f && f.id && typeof f.name === 'string')
        .map(f => ({ id: String(f.id), name: f.name }));
    }
    // Keys are template ids, so pre-slug ones are translated (items.js).
    if (data.assign) state.folderAssign = Object.fromEntries(
      Object.entries(data.assign).map(([id, folderId]) => [currentTemplateId(id), folderId]));
    if (data.collapsed) state.folderCollapsed = { ...data.collapsed };
    foldersSeeded = !!data.seeded;
    folderLayout = Number(data.layout) || 1;
  }

  seedDefaultFolders();
  upgradeFolderLayout();
}

// A browser seeded with the v1 folders gets the v2 set, once: untouched v1
// folders take their new names, Magic Items goes (if nothing was filed into it
// by hand), the new folders are added, and the defaults are put in their
// display order ahead of the user's own folders. A browser with no folders at
// all chose a flat list — that is left alone.
function upgradeFolderLayout() {
  if (folderLayout >= FOLDER_LAYOUT_VERSION) return;
  folderLayout = FOLDER_LAYOUT_VERSION;
  if (state.folders.length) {
    const magic = getFolder('folder_magic');
    const magicUsed = Object.values(state.folderAssign).includes('folder_magic');
    if (magic && magic.name === V1_DEFAULT_NAMES.folder_magic && !magicUsed) {
      state.folders = state.folders.filter(f => f.id !== 'folder_magic');
      delete state.folderCollapsed.folder_magic;
    }
    state.folders.forEach(f => {
      const def = DEFAULT_FOLDERS.find(d => d.id === f.id);
      if (def && f.name === V1_DEFAULT_NAMES[f.id]) f.name = def.name;
    });
    addMissingDefaultFolders();
    const rank = id => {
      const i = DEFAULT_FOLDERS.findIndex(d => d.id === id);
      return i === -1 ? DEFAULT_FOLDERS.length : i;
    };
    state.folders = state.folders
      .map((f, i) => ({ f, i }))
      .sort((a, b) => rank(a.f.id) - rank(b.f.id) || a.i - b.i)
      .map(x => x.f);
  }
  saveFolders();
}

// First run (and once for browsers whose folders predate the defaults) — adds
// any default folder not already there by id or by name.
function seedDefaultFolders() {
  if (foldersSeeded) return;
  foldersSeeded = true;
  addMissingDefaultFolders();
  saveFolders();
}

// Split out of seeding so Restore Defaults can reuse it — it does not touch
// `foldersSeeded`.
function addMissingDefaultFolders() {
  const taken = new Set(state.folders.map(f => f.name.toLowerCase()));
  DEFAULT_FOLDERS.forEach(def => {
    if (getFolder(def.id) || taken.has(def.name.toLowerCase())) return;
    state.folders.push({ id: def.id, name: def.name });
  });
}

function saveFolders() {
  try {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify({
      folders:   state.folders,
      assign:    state.folderAssign,
      collapsed: state.folderCollapsed,
      seeded:    foldersSeeded,
      layout:    folderLayout,
    }));
  } catch (e) { /* non-fatal */ }
}

// Safe to reuse a freed id: deleteFolder() purges its assignments first.
function newFolderId() {
  let n = 1;
  while (state.folders.some(f => f.id === 'folder_' + n)) n++;
  return 'folder_' + n;
}

function getFolder(id) {
  return state.folders.find(f => f.id === id) ?? null;
}

// Unfiled is virtual and never stored, so one place holds its name.
const UNFILED_NAME = 'Unfiled';
function folderNameOf(id) {
  if (id === UNFILED_ID) return UNFILED_NAME;
  return getFolder(id)?.name ?? UNFILED_NAME;
}

function createFolder(name) {
  const clean = (name || '').trim();
  if (!clean) return null;
  const id = newFolderId();
  state.folders.push({ id, name: clean });
  saveFolders();
  return id;
}

function renameFolder(id, name) {
  const folder = getFolder(id);
  const clean = (name || '').trim();
  if (!folder || !clean) return;
  folder.name = clean;
  saveFolders();
}

// Deleting a folder never deletes items — dropping their assignments hands them
// back to their default folder, or to Unfiled if that was the folder deleted.
function deleteFolder(id) {
  const idx = state.folders.findIndex(f => f.id === id);
  if (idx === -1) return;
  state.folders.splice(idx, 1);
  Object.keys(state.folderAssign).forEach(templateId => {
    if (state.folderAssign[templateId] === id) delete state.folderAssign[templateId];
  });
  delete state.folderCollapsed[id];
  saveFolders();
}

// The folder an item was explicitly put in: a folder id, UNFILED_ID if the user
// deliberately kept it out of every folder, or null if it has never been filed
// by hand (and so follows its default folder).
function explicitFolderOf(templateId) {
  const id = state.folderAssign[templateId];
  if (id === UNFILED_ID) return UNFILED_ID;
  return id && getFolder(id) ? id : null;
}

// Where an unfiled item files itself, by type. Null only if the matching folder
// has been deleted — or renamed *and* re-created by hand, hence the name lookup.
function defaultFolderIdFor(templateId) {
  const t = state.db[templateId];
  if (!t) return null;
  const id = DEFAULT_FOLDER_MATCH_ORDER.find(fid => DEFAULT_FOLDERS.find(d => d.id === fid).match(t));
  const def = DEFAULT_FOLDERS.find(d => d.id === id);
  if (!def) return null;
  if (getFolder(def.id)) return def.id;
  const byName = state.folders.find(f => f.name.toLowerCase() === def.name.toLowerCase());
  return byName ? byName.id : null;
}

// Where an item actually shows up: its override if it has one, otherwise its
// default folder. Null — Unfiled — only for an explicit override or an item no
// default folder is left to take.
function folderOf(templateId) {
  const explicit = explicitFolderOf(templateId);
  if (explicit === UNFILED_ID) return null;
  return explicit ?? defaultFolderIdFor(templateId);
}

// `folderId` is a folder id, UNFILED_ID to keep the item out of every folder, or
// null to drop the override and let the item follow its default folder again.
function setItemFolder(templateId, folderId) {
  if (folderId === UNFILED_ID) state.folderAssign[templateId] = UNFILED_ID;
  else if (folderId && getFolder(folderId)) state.folderAssign[templateId] = folderId;
  else delete state.folderAssign[templateId];
  saveFolders();
}

// Called when a template leaves the database, so its assignment doesn't linger.
function forgetItemFolder(templateId) {
  if (!(templateId in state.folderAssign)) return;
  delete state.folderAssign[templateId];
  saveFolders();
}

function isFolderCollapsed(id) {
  return !!state.folderCollapsed[id];
}

function toggleFolderCollapsed(id) {
  if (state.folderCollapsed[id]) delete state.folderCollapsed[id];
  else state.folderCollapsed[id] = true;
  saveFolders();
}

// Unfiled is virtual but still collapsible, so "all" has to reach it too.
function setAllFoldersCollapsed(collapsed) {
  state.folderCollapsed = {};
  if (collapsed) {
    state.folders.forEach(f => { state.folderCollapsed[f.id] = true; });
    state.folderCollapsed[UNFILED_ID] = true;
  }
  saveFolders();
}

// Hands every item back to its type's folder by clearing `folderAssign` whole
// (it holds nothing but hand-filed overrides). Missing default folders are
// re-created first, or `defaultFolderIdFor` has no answer and everything lands
// in Unfiled. Folders the user made are left standing.
function restoreDefaultFolders() {
  addMissingDefaultFolders();
  state.folderAssign = {};
  saveFolders();
}

// Judged on the real folders alone: Unfiled is usually empty and unrendered, so
// letting it decide would strand the button on "Expand All" with nothing open.
function allFoldersCollapsed() {
  return state.folders.length > 0 && state.folders.every(f => isFolderCollapsed(f.id));
}

// The button offers whichever action isn't already done. It goes away without
// folders to fold, and while a search forces every folder open there is nothing
// for it to toggle — same reason the headers stop responding.
function updateFolderToolbar(searchLocked) {
  const btn = document.getElementById('toggle-folders-btn');
  const collapsed = allFoldersCollapsed();
  btn.classList.toggle('hidden', state.folders.length === 0);
  btn.disabled = searchLocked;
  // The caret shows the ACTION, not the state (the folder headers' carets read
  // the other way round), so the title carries the meaning.
  btn.textContent = collapsed ? '▾' : '▸';
  btn.title = searchLocked
    ? 'A search keeps every folder open'
    : (collapsed ? 'Open every folder' : 'Close every folder');
}

document.getElementById('toggle-folders-btn').addEventListener('click', () => {
  setAllFoldersCollapsed(!allFoldersCollapsed());
  renderItemList();
});

// Destructive in the one way that matters — every hand-filed item moves — so it
// says exactly what will happen and what will not before it happens.
document.getElementById('restore-folders-btn').addEventListener('click', () => {
  const filed = Object.keys(state.folderAssign).length;
  const moving = filed > 0
    ? `${filed} item${filed > 1 ? 's' : ''} you filed by hand will move back to the folder its type belongs in.\n\n`
    : '';
  if (!confirm(
    'Restore every item to its default folder?\n\n' + moving +
    'Any missing default folder is re-created. Folders you made yourself are kept, but items will leave them.'
  )) return;
  restoreDefaultFolders();
  renderItemList();
});

// Bucket already-filtered, already-sorted templates into display order:
// the user's folders in their own order, Unfiled last.
function groupItemsByFolder(items) {
  const buckets = new Map(state.folders.map(f => [f.id, []]));
  const unfiled = [];
  items.forEach(t => {
    const id = folderOf(t.id);
    (id ? buckets.get(id) : unfiled).push(t);
  });
  const groups = state.folders.map(f => ({ id: f.id, name: f.name, items: buckets.get(f.id) }));
  groups.push({ id: UNFILED_ID, name: UNFILED_NAME, items: unfiled });
  return groups;
}

// Total items in a folder, ignoring the search/filter controls — the delete
// prompt should report everything that is about to move to Unfiled.
function folderItemCount(folderId) {
  // Variants aren't counted on their own — they ride along with their base
  // item, same as they're excluded from the list itself (see renderItemList).
  return Object.values(state.db).filter(t => !t.variantOf && folderOf(t.id) === folderId).length;
}

// `currentId` is an *explicit* assignment (see explicitFolderOf): the empty
// option means "no override", i.e. file it by type.
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

// =============================================================================
// FOLDER NAME MODAL — shared by create and rename
// =============================================================================
let folderModalCallback = null;

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

function confirmFolderName() {
  const name = document.getElementById('folder-name-input').value.trim();
  if (!name) { alert('Folder name is required.'); return; }
  hideModal('folder-modal');
  const callback = folderModalCallback;
  folderModalCallback = null;
  if (callback) callback(name);
}

document.getElementById('folder-confirm-btn').addEventListener('click', confirmFolderName);
document.getElementById('folder-name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); confirmFolderName(); }
});

document.getElementById('new-folder-btn').addEventListener('click', () => {
  openFolderNameModal({ title: 'New Folder', value: '', confirmLabel: 'Create' }, name => {
    createFolder(name);
    renderItemList();
  });
});

// =============================================================================
// FOLDER PICKER MODAL — reclassify one item
// =============================================================================
function openMoveToFolderModal(templateId) {
  const t = state.db[templateId];
  if (!t) return;

  document.getElementById('folder-picker-desc').textContent = `Move “${t.name}” to:`;
  const list = document.getElementById('folder-picker-list');
  list.innerHTML = '';
  const current = explicitFolderOf(templateId);

  const addChoice = (label, active, onPick, icon) => {
    const btn = document.createElement('button');
    btn.className = 'btn-sm folder-pick-btn' + (active ? ' active' : '');
    if (icon) setIconLabel(btn, icon, label);
    else btn.textContent = label;
    btn.addEventListener('click', () => { hideModal('folder-picker-modal'); onPick(); });
    list.appendChild(btn);
  };

  const auto = getFolder(defaultFolderIdFor(templateId));
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
      setItemFolder(templateId, createFolder(name));
      renderItemList();
    });
  }, 'plus');
  list.lastChild.classList.add('new');

  showModal('folder-picker-modal');
}
