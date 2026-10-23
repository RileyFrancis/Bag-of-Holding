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

// The folders every browser starts with, and the rule that files an item into
// each. First match wins; the last matches everything, so `defaultFolderIdFor`
// always has an answer. Ordinary folders once created — not re-created.
const DEFAULT_FOLDERS = [
  { id: 'folder_magic',   name: 'Magic Items', match: t => hasTagWord(t, 'magic') },
  { id: 'folder_weapons', name: 'Weapons',  match: t => hasTagWord(t, 'weapon') },
  { id: 'folder_armor',   name: 'Armor',    match: t => hasTagWord(t, 'armor') || hasTagWord(t, 'shield') },
  { id: 'folder_currency', name: 'Currency', match: t => hasTagWord(t, 'currency') || hasTagWord(t, 'valuable') },
  { id: 'folder_gear',     name: 'Gear',     match: () => true },
];

// Tags are free-form, so match on whole words: "martial mele weapon" is a weapon.
function hasTagWord(t, word) {
  return (t.tags ?? []).some(tag => String(tag).toLowerCase().split(/\s+/).includes(word));
}

// Whether the default folders have been laid down for this browser. Stored, so
// deleting them all sticks instead of being undone on the next load.
let foldersSeeded = false;

// Defaults added after browsers had already been seeded. Each is laid down once
// (at the top — it matches first), so deleting it sticks like the originals.
const LATE_DEFAULT_FOLDER_IDS = ['folder_magic'];
let lateFoldersSeeded = [];

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
    lateFoldersSeeded = Array.isArray(data.lateSeeded) ? data.lateSeeded : [];
  }

  seedDefaultFolders();
  seedLateDefaultFolders();
}

function seedLateDefaultFolders() {
  const pending = LATE_DEFAULT_FOLDER_IDS.filter(id => !lateFoldersSeeded.includes(id));
  if (!pending.length) return;
  // No folders at all is a choice too (a flat list) — don't break it.
  if (state.folders.length) {
    const taken = new Set(state.folders.map(f => f.name.toLowerCase()));
    pending.forEach(id => {
      const def = DEFAULT_FOLDERS.find(d => d.id === id);
      if (!def || getFolder(id) || taken.has(def.name.toLowerCase())) return;
      state.folders.unshift({ id: def.id, name: def.name });
    });
  }
  lateFoldersSeeded = [...lateFoldersSeeded, ...pending];
  saveFolders();
}

// First run (and once for browsers whose folders predate the defaults) — adds
// any default folder not already there by id or by name.
function seedDefaultFolders() {
  if (foldersSeeded) return;
  foldersSeeded = true;
  lateFoldersSeeded = [...LATE_DEFAULT_FOLDER_IDS]; // a first run gets them all here
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
      lateSeeded: lateFoldersSeeded,
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
  const def = DEFAULT_FOLDERS.find(d => d.match(t));
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
