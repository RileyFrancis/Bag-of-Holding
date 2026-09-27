// =============================================================================
// HOMEBREW — The account's custom content, and the home screen's file tree
// =============================================================================
'use strict';

// Everything the player has made for themselves — classes, subclasses, species,
// backgrounds, items, spells — shown on the home screen as one file tree they
// can fold into folders of their own. Two sources, one tree:
//   • custom items, which already live per character (each slot's `db`) and are
//     collected from every slot here, deduplicated by template id;
//   • `state.homebrew.entries`, the account-level store every other kind lands
//     in (and an item made from the New Homebrew button, which has no character).
// The folders and who-sits-in-which are `state.homebrew.folders` / `placement`,
// in the save file and synced — this is the account's own content, organised
// the way they chose, not how one browser happens to show it. Which folders are
// folded open is furniture, on its own localStorage key. Who each folder or
// file is enabled for (`state.homebrew.enabled`), and what that makes usable,
// is homebrew-share.js.

const HOMEBREW_KINDS = [
  { id: 'class',      label: 'Class' },
  { id: 'subclass',   label: 'Subclass' },
  { id: 'species',    label: 'Species' },
  { id: 'background', label: 'Background' },
  { id: 'item',       label: 'Item' },
  { id: 'spell',      label: 'Spell' },
];

const HOMEBREW_OPEN_KEY = 'dnd_inventory_homebrew_open';
const HOMEBREW_ROOT = null; // a node with no placement sits at the top level

// =============================================================================
// MODEL
// =============================================================================
function blankHomebrew() {
  return { entries: {}, folders: {}, placement: {}, enabled: {} };
}

// Whatever the save held (nothing, for anything older than v4), made safe to
// read: a folder whose parent is gone moves to the top level, a placement
// naming a missing folder is dropped, and a parent chain that loops is cut.
function normalizeHomebrew(raw) {
  const hb = blankHomebrew();
  if (!raw || typeof raw !== 'object') return hb;

  Object.values(raw.entries ?? {}).forEach(e => {
    if (!e || !e.id || !HOMEBREW_KINDS.some(k => k.id === e.kind)) return;
    hb.entries[e.id] = { ...e, name: String(e.name ?? 'Untitled') };
  });
  Object.values(raw.folders ?? {}).forEach(f => {
    if (!f || !f.id) return;
    hb.folders[f.id] = { id: String(f.id), name: String(f.name ?? 'Folder'), parentId: f.parentId ?? null };
  });
  Object.values(hb.folders).forEach(f => {
    if (f.parentId && !hb.folders[f.parentId]) f.parentId = null;
  });
  Object.values(hb.folders).forEach(f => {
    const seen = new Set([f.id]);
    for (let p = f.parentId; p; p = hb.folders[p]?.parentId) {
      if (seen.has(p)) { f.parentId = null; break; }
      seen.add(p);
    }
  });
  Object.entries(raw.placement ?? {}).forEach(([key, folderId]) => {
    if (hb.folders[folderId]) hb.placement[key] = folderId;
  });
  // Kept for any key — a custom item's `item:<id>` can't be checked against
  // the roster from here, and a stale target only ever matches nothing.
  Object.entries(raw.enabled ?? {}).forEach(([key, a]) => {
    const characters = Array.isArray(a?.characters) ? a.characters.map(String) : [];
    const campaigns  = Array.isArray(a?.campaigns)  ? a.campaigns.map(String)  : [];
    if (characters.length || campaigns.length) hb.enabled[key] = { characters, campaigns };
  });
  return hb;
}

function newHomebrewId(prefix) {
  return prefix + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function homebrewKindLabel(kind) {
  return HOMEBREW_KINDS.find(k => k.id === kind)?.label ?? kind;
}

// The seam the New Homebrew flow writes through. Lands at the top level.
function addHomebrewEntry(kind, data) {
  const id = newHomebrewId('hb_');
  state.homebrew.entries[id] = { ...data, id, kind, name: String(data?.name ?? 'Untitled') };
  onHomebrewChanged();
  return id;
}

function updateHomebrewEntry(id, data) {
  const entry = state.homebrew.entries[id];
  if (!entry) return;
  state.homebrew.entries[id] = { ...data, id, kind: entry.kind, name: String(data?.name ?? entry.name) };
  onHomebrewChanged();
}

function deleteHomebrewEntry(id) {
  if (!state.homebrew.entries[id]) return;
  delete state.homebrew.entries[id];
  delete state.homebrew.placement[id];
  delete state.homebrew.enabled[id];
  onHomebrewChanged();
}

// The seam class-features.js / species-traits.js / spells.js read through once
// homebrew of that kind is usable at the table.
function homebrewEntriesOf(kind) {
  return Object.values(state.homebrew.entries).filter(e => e.kind === kind);
}

// Every file in the tree, as { key, kind, name, detail, template | entryId }. A
// custom item's key is its template id under `item:`, so the same item carried
// by two characters is one file. The active slot is read from the working copy,
// which is newer. A `_homebrew` template is someone's homebrew in use by this
// character (homebrew-share.js), not an item they made — never a file here.
function collectHomebrewFiles() {
  const files = new Map();
  const items = new Map(); // templateId → { template, owners[] }

  characterList().forEach(slot => {
    const live = slot.character.id === state.activeCharacterId && liveStateIsOwnCharacter();
    const db = live ? getCustomDb() : (slot.db ?? {});
    const owner = live ? state.character.name : slot.character.name;
    Object.values(db).forEach(t => {
      if (!t || !t.id || t.variantOf || t._homebrew) return;
      const seen = items.get(t.id) ?? { template: t, owners: [] };
      if (!seen.owners.includes(owner)) seen.owners.push(owner);
      items.set(t.id, seen);
    });
  });

  items.forEach(({ template, owners }, id) => {
    const key = 'item:' + id;
    files.set(key, { key, kind: 'item', name: template.name || 'Untitled item', detail: owners.join(', '), template });
  });
  Object.values(state.homebrew.entries).forEach(e => {
    files.set(e.id, { key: e.id, kind: e.kind, name: e.name, detail: '', entryId: e.id });
  });
  return [...files.values()];
}

function homebrewParentOf(key) {
  if (state.homebrew.folders[key]) return state.homebrew.folders[key].parentId ?? HOMEBREW_ROOT;
  return state.homebrew.placement[key] ?? HOMEBREW_ROOT;
}

// True when `folderId` is `ancestorId` or sits somewhere inside it — a folder
// may not be dropped into itself or its own descendants.
function isHomebrewFolderWithin(folderId, ancestorId) {
  for (let p = folderId; p; p = state.homebrew.folders[p]?.parentId) {
    if (p === ancestorId) return true;
  }
  return false;
}

function canMoveHomebrewNode(key, targetFolderId) {
  if (targetFolderId && !state.homebrew.folders[targetFolderId]) return false;
  if (homebrewParentOf(key) === targetFolderId) return false;
  if (state.homebrew.folders[key] && targetFolderId && isHomebrewFolderWithin(targetFolderId, key)) return false;
  return true;
}

function moveHomebrewNode(key, targetFolderId) {
  if (!canMoveHomebrewNode(key, targetFolderId)) return;
  const folder = state.homebrew.folders[key];
  if (folder) folder.parentId = targetFolderId;
  else if (targetFolderId) state.homebrew.placement[key] = targetFolderId;
  else delete state.homebrew.placement[key];
  // Dropping into a closed folder opens it, so the thing just moved is visible.
  if (targetFolderId) setHomebrewFolderOpen(targetFolderId, true);
  onHomebrewChanged();
}

function createHomebrewFolder(name, parentId = HOMEBREW_ROOT) {
  const id = newHomebrewId('hbf_');
  state.homebrew.folders[id] = { id, name, parentId };
  if (parentId) setHomebrewFolderOpen(parentId, true);
  onHomebrewChanged();
  return id;
}

function renameHomebrewFolder(id, name) {
  const folder = state.homebrew.folders[id];
  if (!folder) return;
  folder.name = name;
  onHomebrewChanged();
}

// Deleting a folder never deletes homebrew: whatever was in it — files and
// folders both — moves up into the folder it sat in.
function deleteHomebrewFolder(id) {
  const folder = state.homebrew.folders[id];
  if (!folder) return;
  const parentId = folder.parentId ?? HOMEBREW_ROOT;
  Object.values(state.homebrew.folders).forEach(f => {
    if (f.parentId === id) f.parentId = parentId;
  });
  Object.keys(state.homebrew.placement).forEach(key => {
    if (state.homebrew.placement[key] !== id) return;
    if (parentId) state.homebrew.placement[key] = parentId;
    else delete state.homebrew.placement[key];
  });
  delete state.homebrew.folders[id];
  delete state.homebrew.enabled[id];
  delete homebrewOpen[id];
  saveHomebrewOpen();
  onHomebrewChanged();
}

// =============================================================================
// WHICH FOLDERS ARE OPEN — browser furniture
// =============================================================================
let homebrewOpen = {};
try { homebrewOpen = JSON.parse(localStorage.getItem(HOMEBREW_OPEN_KEY)) ?? {}; } catch { homebrewOpen = {}; }

function saveHomebrewOpen() {
  try { localStorage.setItem(HOMEBREW_OPEN_KEY, JSON.stringify(homebrewOpen)); } catch { /* private mode */ }
}

function isHomebrewFolderOpen(id) { return !!homebrewOpen[id]; }

function setHomebrewFolderOpen(id, open) {
  if (open) homebrewOpen[id] = true;
  else delete homebrewOpen[id];
  saveHomebrewOpen();
}

// =============================================================================
// THE TREE
// =============================================================================
const homebrewTreeEl = document.getElementById('homebrew-tree');

const byHomebrewName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

// A file explorer's order: folders first, then files, each by name. There is
// no hand ordering inside a folder — dragging files where they belong is what
// the tree is for.
function renderHomebrewSection() {
  if (!homebrewTreeEl) return;
  const files = collectHomebrewFiles();
  const folders = Object.values(state.homebrew.folders);

  const childFolders = new Map();
  const childFiles = new Map();
  folders.forEach(f => {
    const p = f.parentId ?? HOMEBREW_ROOT;
    if (!childFolders.has(p)) childFolders.set(p, []);
    childFolders.get(p).push(f);
  });
  files.forEach(file => {
    const p = homebrewParentOf(file.key);
    if (!childFiles.has(p)) childFiles.set(p, []);
    childFiles.get(p).push(file);
  });

  // Files inside a folder, however deep — what its count reports.
  const countIn = id => (childFiles.get(id)?.length ?? 0) +
    (childFolders.get(id) ?? []).reduce((n, f) => n + countIn(f.id), 0);

  homebrewTreeEl.innerHTML = '';

  if (!files.length && !folders.length) {
    const empty = document.createElement('p');
    empty.className = 'home-empty homebrew-empty';
    empty.textContent = 'Nothing homebrewed yet. Anything custom you make — an item, a spell, a class — shows up here.';
    homebrewTreeEl.appendChild(empty);
    return;
  }

  const renderLevel = (parentId, depth) => {
    (childFolders.get(parentId) ?? []).sort(byHomebrewName).forEach(f => {
      homebrewTreeEl.appendChild(homebrewFolderRow(f, depth, countIn(f.id)));
      if (isHomebrewFolderOpen(f.id)) renderLevel(f.id, depth + 1);
    });
    (childFiles.get(parentId) ?? []).sort(byHomebrewName).forEach(file => {
      homebrewTreeEl.appendChild(homebrewFileRow(file, depth));
    });
  };
  renderLevel(HOMEBREW_ROOT, 0);
}

function homebrewRow(key, depth) {
  const row = document.createElement('div');
  row.className = 'hb-row';
  row.dataset.key = key;
  row.style.setProperty('--depth', depth);
  row.draggable = true;
  return row;
}

function homebrewFolderRow(folder, depth, count) {
  const open = isHomebrewFolderOpen(folder.id);
  const row = homebrewRow(folder.id, depth);
  row.classList.add('hb-folder');
  row.dataset.folderId = folder.id;
  row.setAttribute('aria-expanded', String(open));

  const caret = document.createElement('span');
  caret.className = 'hb-caret';
  caret.textContent = open ? '▾' : '▸';

  const name = document.createElement('span');
  name.className = 'hb-name';
  name.textContent = folder.name;

  const countEl = document.createElement('span');
  countEl.className = 'hb-count';
  countEl.textContent = count;

  const actions = document.createElement('span');
  actions.className = 'hb-actions';
  const btn = (text, title, onClick, danger) => {
    const b = document.createElement('button');
    b.className = 'hb-btn' + (danger ? ' danger' : '');
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.draggable = false;
    b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
    actions.appendChild(b);
  };
  btn('', 'Enable for campaigns or characters', () => openHomebrewAccess(folder.id));
  actions.lastChild.appendChild(iconEl('show'));
  btn('+', 'New folder inside', () => {
    openFolderNameModal({ title: 'New Folder', value: '', confirmLabel: 'Create' },
      name => createHomebrewFolder(name, folder.id));
  });
  btn('✎', 'Rename folder', () => {
    openFolderNameModal({ title: 'Rename Folder', value: folder.name, confirmLabel: 'Rename' },
      name => renameHomebrewFolder(folder.id, name));
  });
  btn('✕', 'Delete folder', () => {
    const note = count ? `\n\nIts ${count} homebrew file${count === 1 ? '' : 's'} move up a level — nothing is deleted.` : '';
    if (confirm(`Delete the folder “${folder.name}”?${note}`)) deleteHomebrewFolder(folder.id);
  }, true);

  row.append(caret, name, homebrewAccessChips(folder.id), countEl, actions);
  row.addEventListener('click', () => {
    setHomebrewFolderOpen(folder.id, !open);
    renderHomebrewSection();
  });
  return row;
}

function homebrewFileRow(file, depth) {
  const row = homebrewRow(file.key, depth);
  row.classList.add('hb-file');

  const name = document.createElement('span');
  name.className = 'hb-name';
  name.textContent = file.name;
  row.appendChild(name);

  if (file.detail) {
    const detail = document.createElement('span');
    detail.className = 'hb-detail';
    detail.textContent = file.detail;
    row.appendChild(detail);
  }

  const kind = document.createElement('span');
  kind.className = 'hb-kind';
  kind.dataset.kind = file.kind;
  kind.textContent = homebrewKindLabel(file.kind);
  row.append(homebrewAccessChips(file.key), kind);

  const actions = document.createElement('span');
  actions.className = 'hb-actions';
  const access = document.createElement('button');
  access.className = 'hb-btn';
  access.title = 'Enable for campaigns or characters';
  access.setAttribute('aria-label', access.title);
  access.draggable = false;
  access.appendChild(iconEl('show'));
  access.addEventListener('click', e => { e.stopPropagation(); openHomebrewAccess(file.key); });
  actions.appendChild(access);
  row.appendChild(actions);

  // An account entry opens in the homebrew editor. A character's custom item
  // is edited from that character's Browse list, where its catalogue lives.
  if (file.entryId) {
    row.classList.add('hb-editable');
    row.title = 'Click to edit, drag to move';
    row.addEventListener('click', () => openHomebrewEntry(file.entryId));
  }
  return row;
}

// Who a row is enabled for, as small chips — a campaign's filled, a
// character's outlined, one inherited from a folder dimmed. Two at most, then
// a count, so a widely shared folder doesn't push its name off the row.
function homebrewAccessChips(key) {
  const box = document.createElement('span');
  box.className = 'hb-chips';
  const all = homebrewAccessSummary(key);
  all.slice(0, 2).forEach(a => {
    const chip = document.createElement('span');
    chip.className = 'hb-chip' + (a.campaign ? ' campaign' : '') + (a.inherited ? ' inherited' : '');
    chip.textContent = a.text;
    chip.title = (a.campaign ? 'Campaign' : 'Character') + (a.inherited ? ' — from a folder above' : '');
    box.appendChild(chip);
  });
  if (all.length > 2) {
    const more = document.createElement('span');
    more.className = 'hb-chip more';
    more.textContent = '+' + (all.length - 2);
    more.title = all.slice(2).map(a => a.text).join(', ');
    box.appendChild(more);
  }
  return box;
}

// =============================================================================
// DRAG TO REORGANISE
// =============================================================================
// Native drag and drop — a home-screen list, not the inventory's grid, so none
// of the ghost machinery applies. A folder row takes the drop into itself; a
// file row takes it into the folder that file sits in; the tree's empty space
// and the section header take it to the top level.
let homebrewDragKey = null;

function homebrewDropTargetOf(el) {
  const row = el.closest?.('.hb-row');
  if (row && homebrewTreeEl.contains(row)) {
    return row.dataset.folderId ?? homebrewParentOf(row.dataset.key);
  }
  if (homebrewTreeEl.contains(el) || document.getElementById('homebrew-header').contains(el)) return HOMEBREW_ROOT;
  return undefined;
}

function clearHomebrewDropHighlight() {
  document.querySelectorAll('#homebrew-section .hb-drop').forEach(el => el.classList.remove('hb-drop'));
}

function highlightHomebrewDrop(target) {
  clearHomebrewDropHighlight();
  if (target === HOMEBREW_ROOT) homebrewTreeEl.classList.add('hb-drop');
  else homebrewTreeEl.querySelector(`.hb-folder[data-folder-id="${CSS.escape(target)}"]`)?.classList.add('hb-drop');
}

if (homebrewTreeEl) {
  const section = document.getElementById('homebrew-section');

  homebrewTreeEl.addEventListener('dragstart', e => {
    const row = e.target.closest('.hb-row');
    if (!row) return;
    homebrewDragKey = row.dataset.key;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.dataset.key);
    requestAnimationFrame(() => row.classList.add('hb-dragging'));
  });

  homebrewTreeEl.addEventListener('dragend', () => {
    homebrewDragKey = null;
    clearHomebrewDropHighlight();
    homebrewTreeEl.querySelectorAll('.hb-dragging').forEach(el => el.classList.remove('hb-dragging'));
  });

  section.addEventListener('dragover', e => {
    if (!homebrewDragKey) return;
    const target = homebrewDropTargetOf(e.target);
    if (target === undefined || !canMoveHomebrewNode(homebrewDragKey, target)) {
      clearHomebrewDropHighlight();
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    highlightHomebrewDrop(target);
  });

  section.addEventListener('dragleave', e => {
    if (!section.contains(e.relatedTarget)) clearHomebrewDropHighlight();
  });

  section.addEventListener('drop', e => {
    if (!homebrewDragKey) return;
    e.preventDefault();
    const target = homebrewDropTargetOf(e.target);
    const key = homebrewDragKey;
    homebrewDragKey = null;
    clearHomebrewDropHighlight();
    if (target !== undefined) moveHomebrewNode(key, target);
  });

  document.getElementById('homebrew-new-folder-btn').addEventListener('click', () => {
    openFolderNameModal({ title: 'New Folder', value: '', confirmLabel: 'Create' },
      name => createHomebrewFolder(name));
  });

  // The panel itself is homebrew-editor.js.
  document.getElementById('homebrew-new-btn').addEventListener('click', () => openHomebrewPanel());
}
