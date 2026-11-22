// =============================================================================
// HOMEBREW — The account's custom content, and the home screen's file tree
// =============================================================================
'use strict';

// One file tree of everything the player has made, from two sources:
//   • custom items, collected from every slot's `db`, deduplicated by template id;
//   • `state.homebrew.entries`, the account-level store for every other kind
//     (and items made from the New Homebrew button, which have no character).
// Folders and placement are in the save file and synced; which folders are open
// is browser furniture on its own localStorage key. Enabling is homebrew-share.js.

const HOMEBREW_OPEN_KEY = 'dnd_inventory_homebrew_open';
const HOMEBREW_ROOT = null; // a node with no placement sits at the top level

// ─── MODEL ─────────────────────────────────────────────────────────────────
function _createBlankHomebrew() {
  return { entries: {}, folders: {}, placement: {}, enabled: {} };
}

// Makes whatever the save held (possibly nothing) safe to read: an orphaned folder
// moves to the top level, a placement naming a missing folder is dropped, and a
// looping parent chain is cut.
function normalizeHomebrew(raw) {
  const hb = _createBlankHomebrew();
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
  // Kept for any key: a custom item's `item:<id>` can't be checked against the
  // roster from here, and a stale target only ever matches nothing.
  Object.entries(raw.enabled ?? {}).forEach(([key, a]) => {
    const characters = Array.isArray(a?.characters) ? a.characters.map(String) : [];
    const campaigns  = Array.isArray(a?.campaigns)  ? a.campaigns.map(String)  : [];
    if (characters.length || campaigns.length) hb.enabled[key] = { characters, campaigns };
  });
  return hb;
}

function _createHomebrewId(prefix) {
  return prefix + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

// Display label for a homebrew kind id ('class' → 'Class').
function getHomebrewKindLabel(kind) {
  return HOMEBREW_KINDS.find(k => k.id === kind)?.label ?? kind;
}

// Adds an account-level homebrew entry at the top level of the tree; returns its id.
function addHomebrewEntry(kind, data) {
  const id = _createHomebrewId('hb_');
  state.homebrew.entries[id] = { ...data, id, kind, name: String(data?.name ?? 'Untitled') };
  onHomebrewChanged();
  return id;
}

// Replaces an entry's data, keeping its id and kind.
function updateHomebrewEntry(id, data) {
  const entry = state.homebrew.entries[id];
  if (!entry) return;
  state.homebrew.entries[id] = { ...data, id, kind: entry.kind, name: String(data?.name ?? entry.name) };
  onHomebrewChanged();
}

// Deletes an entry along with its placement and enabled targets.
function deleteHomebrewEntry(id) {
  if (!state.homebrew.entries[id]) return;
  delete state.homebrew.entries[id];
  delete state.homebrew.placement[id];
  delete state.homebrew.enabled[id];
  onHomebrewChanged();
}

// This account's own entries of one kind.
function getHomebrewEntriesOfKind(kind) {
  return Object.values(state.homebrew.entries).filter(e => e.kind === kind);
}

// Every file in the tree, as { key, kind, name, detail, template | entryId }. A
// custom item's key is `item:<templateId>`, so one item carried by two characters
// is one file. The active slot is read from the working copy, which is newer. A
// `_homebrew` template is someone else's homebrew in use, never a file here.
function collectHomebrewFiles() {
  const files = new Map();
  const items = new Map(); // templateId → { template, owners[] }

  getCharacterSlots().forEach(slot => {
    const isLive = slot.character.id === state.activeCharacterId && isLiveStateOwnCharacter();
    const db = isLive ? getCustomDb() : (slot.db ?? {});
    const owner = isLive ? state.character.name : slot.character.name;
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

// The folder id a node sits in, or HOMEBREW_ROOT at the top level.
function getHomebrewParentId(key) {
  if (state.homebrew.folders[key]) return state.homebrew.folders[key].parentId ?? HOMEBREW_ROOT;
  return state.homebrew.placement[key] ?? HOMEBREW_ROOT;
}

// True when `folderId` is `ancestorId` or sits inside it; a folder may not be
// dropped into itself or its own descendants.
function _isHomebrewFolderWithin(folderId, ancestorId) {
  for (let p = folderId; p; p = state.homebrew.folders[p]?.parentId) {
    if (p === ancestorId) return true;
  }
  return false;
}

function _canMoveHomebrewNode(key, targetFolderId) {
  if (targetFolderId && !state.homebrew.folders[targetFolderId]) return false;
  if (getHomebrewParentId(key) === targetFolderId) return false;
  if (state.homebrew.folders[key] && targetFolderId && _isHomebrewFolderWithin(targetFolderId, key)) return false;
  return true;
}

function _moveHomebrewNode(key, targetFolderId) {
  if (!_canMoveHomebrewNode(key, targetFolderId)) return;
  const folder = state.homebrew.folders[key];
  if (folder) folder.parentId = targetFolderId;
  else if (targetFolderId) state.homebrew.placement[key] = targetFolderId;
  else delete state.homebrew.placement[key];
  // Dropping into a closed folder opens it, so the thing just moved is visible.
  if (targetFolderId) _setHomebrewFolderOpen(targetFolderId, true);
  onHomebrewChanged();
}

function _createHomebrewFolder(name, parentId = HOMEBREW_ROOT) {
  const id = _createHomebrewId('hbf_');
  state.homebrew.folders[id] = { id, name, parentId };
  if (parentId) _setHomebrewFolderOpen(parentId, true);
  onHomebrewChanged();
  return id;
}

function _renameHomebrewFolder(id, name) {
  const folder = state.homebrew.folders[id];
  if (!folder) return;
  folder.name = name;
  onHomebrewChanged();
}

// Deleting a folder never deletes homebrew: its files and folders move up into
// the folder it sat in.
function _deleteHomebrewFolder(id) {
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
  delete homebrewOpenFolders[id];
  _saveHomebrewOpenFolders();
  onHomebrewChanged();
}

// ─── OPEN FOLDERS (browser furniture) ──────────────────────────────────────
let homebrewOpenFolders = {};
try { homebrewOpenFolders = JSON.parse(localStorage.getItem(HOMEBREW_OPEN_KEY)) ?? {}; } catch { homebrewOpenFolders = {}; }

function _saveHomebrewOpenFolders() {
  try { localStorage.setItem(HOMEBREW_OPEN_KEY, JSON.stringify(homebrewOpenFolders)); } catch { /* private mode */ }
}

function _isHomebrewFolderOpen(id) { return !!homebrewOpenFolders[id]; }

function _setHomebrewFolderOpen(id, isOpen) {
  if (isOpen) homebrewOpenFolders[id] = true;
  else delete homebrewOpenFolders[id];
  _saveHomebrewOpenFolders();
}

// ─── THE TREE ──────────────────────────────────────────────────────────────
const homebrewTreeEl = document.getElementById('homebrew-tree');

const _compareHomebrewByName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

// Redraws the home screen's homebrew tree: folders first, then files, each by
// name. There is no hand ordering inside a folder.
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
    const p = getHomebrewParentId(file.key);
    if (!childFiles.has(p)) childFiles.set(p, []);
    childFiles.get(p).push(file);
  });

  // Files inside a folder, however deep: what its count reports.
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
    (childFolders.get(parentId) ?? []).sort(_compareHomebrewByName).forEach(f => {
      homebrewTreeEl.appendChild(_createHomebrewFolderRow(f, depth, countIn(f.id)));
      if (_isHomebrewFolderOpen(f.id)) renderLevel(f.id, depth + 1);
    });
    (childFiles.get(parentId) ?? []).sort(_compareHomebrewByName).forEach(file => {
      homebrewTreeEl.appendChild(_createHomebrewFileRow(file, depth));
    });
  };
  renderLevel(HOMEBREW_ROOT, 0);
}

function _createHomebrewRow(key, depth) {
  const row = document.createElement('div');
  row.className = 'hb-row';
  row.dataset.key = key;
  row.style.setProperty('--depth', depth);
  row.draggable = true;
  return row;
}

function _createHomebrewFolderRow(folder, depth, count) {
  const isOpen = _isHomebrewFolderOpen(folder.id);
  const row = _createHomebrewRow(folder.id, depth);
  row.classList.add('hb-folder');
  row.dataset.folderId = folder.id;
  row.setAttribute('aria-expanded', String(isOpen));

  const caret = document.createElement('span');
  caret.className = 'hb-caret';
  caret.textContent = isOpen ? '▾' : '▸';

  const name = document.createElement('span');
  name.className = 'hb-name';
  name.textContent = folder.name;

  const countEl = document.createElement('span');
  countEl.className = 'hb-count';
  countEl.textContent = count;

  const actions = document.createElement('span');
  actions.className = 'hb-actions';
  const addButton = (text, title, onClick, isDanger) => {
    const b = document.createElement('button');
    b.className = 'hb-btn' + (isDanger ? ' danger' : '');
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.draggable = false;
    b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
    actions.appendChild(b);
  };
  addButton('', 'Enable for campaigns or characters', () => openHomebrewAccess(folder.id));
  actions.lastChild.appendChild(createIconEl('show'));
  addButton('+', 'New folder inside', () => {
    openFolderNameModal({ title: 'New Folder', value: '', confirmLabel: 'Create' },
      name => _createHomebrewFolder(name, folder.id));
  });
  addButton('✎', 'Rename folder', () => {
    openFolderNameModal({ title: 'Rename Folder', value: folder.name, confirmLabel: 'Rename' },
      name => _renameHomebrewFolder(folder.id, name));
  });
  addButton('✕', 'Delete folder', () => {
    const note = count ? `\n\nIts ${count} homebrew file${count === 1 ? '' : 's'} move up a level — nothing is deleted.` : '';
    if (confirm(`Delete the folder “${folder.name}”?${note}`)) _deleteHomebrewFolder(folder.id);
  }, true);

  row.append(caret, name, _createHomebrewAccessChips(folder.id), countEl, actions);
  row.addEventListener('click', () => {
    _setHomebrewFolderOpen(folder.id, !isOpen);
    renderHomebrewSection();
  });
  return row;
}

function _createHomebrewFileRow(file, depth) {
  const row = _createHomebrewRow(file.key, depth);
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
  kind.textContent = getHomebrewKindLabel(file.kind);
  row.append(_createHomebrewAccessChips(file.key), kind);

  const actions = document.createElement('span');
  actions.className = 'hb-actions';
  const access = document.createElement('button');
  access.className = 'hb-btn';
  access.title = 'Enable for campaigns or characters';
  access.setAttribute('aria-label', access.title);
  access.draggable = false;
  access.appendChild(createIconEl('show'));
  access.addEventListener('click', e => { e.stopPropagation(); openHomebrewAccess(file.key); });
  actions.appendChild(access);
  row.appendChild(actions);

  // An account entry opens in the homebrew editor; a character's custom item is
  // edited from that character's Browse list instead.
  if (file.entryId) {
    row.classList.add('hb-editable');
    row.title = 'Click to edit, drag to move';
    row.addEventListener('click', () => openHomebrewEntry(file.entryId));
  }
  return row;
}

// Who a row is enabled for, as chips (campaign filled, character outlined,
// inherited dimmed). Two at most, then a count, so the name stays on the row.
function _createHomebrewAccessChips(key) {
  const box = document.createElement('span');
  box.className = 'hb-chips';
  const all = getHomebrewAccessSummary(key);
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

// ─── DRAG TO REORGANISE ────────────────────────────────────────────────────
// Native drag and drop, not the inventory's ghost machinery. A folder row takes
// the drop into itself, a file row into its own folder, and the tree's empty
// space or the section header to the top level.
let homebrewDragKey = null;

function _getHomebrewDropTarget(el) {
  const row = el.closest?.('.hb-row');
  if (row && homebrewTreeEl.contains(row)) {
    return row.dataset.folderId ?? getHomebrewParentId(row.dataset.key);
  }
  if (homebrewTreeEl.contains(el) || document.getElementById('homebrew-header').contains(el)) return HOMEBREW_ROOT;
  return undefined;
}

function _clearHomebrewDropHighlight() {
  document.querySelectorAll('#homebrew-section .hb-drop').forEach(el => el.classList.remove('hb-drop'));
}

function _highlightHomebrewDrop(target) {
  _clearHomebrewDropHighlight();
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
    _clearHomebrewDropHighlight();
    homebrewTreeEl.querySelectorAll('.hb-dragging').forEach(el => el.classList.remove('hb-dragging'));
  });

  section.addEventListener('dragover', e => {
    if (!homebrewDragKey) return;
    const target = _getHomebrewDropTarget(e.target);
    if (target === undefined || !_canMoveHomebrewNode(homebrewDragKey, target)) {
      _clearHomebrewDropHighlight();
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    _highlightHomebrewDrop(target);
  });

  section.addEventListener('dragleave', e => {
    if (!section.contains(e.relatedTarget)) _clearHomebrewDropHighlight();
  });

  section.addEventListener('drop', e => {
    if (!homebrewDragKey) return;
    e.preventDefault();
    const target = _getHomebrewDropTarget(e.target);
    const key = homebrewDragKey;
    homebrewDragKey = null;
    _clearHomebrewDropHighlight();
    if (target !== undefined) _moveHomebrewNode(key, target);
  });

  document.getElementById('homebrew-new-folder-btn').addEventListener('click', () => {
    openFolderNameModal({ title: 'New Folder', value: '', confirmLabel: 'Create' },
      name => _createHomebrewFolder(name));
  });

  // The panel itself is homebrew-editor.js.
  document.getElementById('homebrew-new-btn').addEventListener('click', () => openHomebrewPanel());
}
