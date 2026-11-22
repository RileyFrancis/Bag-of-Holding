// =============================================================================
// RENDER-SIDEBAR — Sidebar item list + item details panel
// =============================================================================
'use strict';

// Which base items' variant families are unfolded in the Browse list; a dog-eared
// card's own click toggles its id. Session-only: not saved, not synced.
const expandedVariantIds = new Set();

// The Browse list's search/rarity/tag filter for the render in progress, or null
// with none set. Module-level so _appendVariantRows can prune a family to its
// matching members without threading it through every call.
let listFilter = null;

function _doesItemPassFilter(t) {
  if (!listFilter) return true;
  const { search, rarityF, tagF } = listFilter;
  if (search && !t.name.toLowerCase().includes(search) && !t.description.toLowerCase().includes(search)) return false;
  if (rarityF && t.rarity !== rarityF) return false;
  if (tagF && !t.tags.includes(tagF)) return false;
  return true;
}

function _doesFamilyPassFilter(t) {
  return _doesItemPassFilter(t) || !!t.variantIds?.some(id => state.db[id] && _doesFamilyPassFilter(state.db[id]));
}

// While filtering, a family the filter only reaches inside opens itself and
// shows just the matching members; one that matches as a whole (a search for
// its own name) stays as the reader left it, with everything in it.
function _isFamilyOpen(t) {
  return expandedVariantIds.has(t.id) || (!!listFilter && !_doesItemPassFilter(t) && _doesFamilyPassFilter(t));
}

// Rebuild the Browse list from state.db under the current filters, sort order
// and folders, then refresh the folder toolbar and tag filter.
function renderItemList() {
  const listEl = document.getElementById('item-list');
  const search = document.getElementById('item-search').value.trim().toLowerCase();
  const rarityF = document.getElementById('rarity-filter').value;
  const tagF = document.getElementById('tag-filter').value;

  listFilter = (search || rarityF || tagF) ? { search, rarityF, tagF } : null;

  // A variant is never a top-level entry: it is nested under its base (see
  // _appendVariantRows). A family is listed if anything in it passes, so a
  // search for "Longsword +2" finds it inside Weapon, +1, +2, or +3.
  const items = Object.values(state.db).filter(t => !t.variantOf && _doesFamilyPassFilter(t));

  // The chosen order (item-sort.js); grouping only buckets an already-sorted list.
  sortItems(items);

  // The list is rebuilt from scratch, so restore scrollTop: filing an item is
  // the one render that happens mid-gesture, after auto-scroll carried the
  // reader down to a folder.
  const scrollTop = listEl.scrollTop;

  listEl.innerHTML = '';
  listEl.classList.toggle('foldered', state.folders.length > 0);

  if (state.folders.length === 0) {
    // No folders: the plain flat list.
    items.forEach(t => {
      listEl.appendChild(_buildItemCard(t));
      _appendVariantRows(listEl, t);
    });
  } else {
    const isFiltering = !!(search || rarityF || tagF);
    groupItemsByFolder(items).forEach(group => {
      // While filtering, a folder with no matches is noise; unfiltered, empty
      // folders stay visible so there is something to drop items onto.
      if (group.items.length === 0 && (isFiltering || group.id === UNFILED_ID)) return;
      // A search expands everything: a collapsed folder hiding the only match
      // would read as "no results".
      const isExpanded = !!search || !isFolderCollapsed(group.id);
      listEl.appendChild(_buildFolderHeader(group, isExpanded, !!search));
      // Cards carry their folder so a drag can drop anywhere in the group.
      if (isExpanded) group.items.forEach(t => {
        const card = _buildItemCard(t);
        card.dataset.folderId = group.id;
        listEl.appendChild(card);
        _appendVariantRows(listEl, t, group.id);
      });
    });
  }

  listEl.scrollTop = scrollTop;

  updateFolderToolbar(!!search);

  _populateTagFilter();
}

function _buildFolderHeader(group, isExpanded, isSearchLocked) {
  const el = document.createElement('div');
  el.className = 'folder-header' + (isExpanded ? '' : ' collapsed');
  el.dataset.folderId = group.id;

  const caret = document.createElement('span');
  caret.className = 'folder-caret';
  caret.textContent = isExpanded ? '▾' : '▸';

  const name = document.createElement('span');
  name.className = 'folder-name';
  name.textContent = group.name;

  const count = document.createElement('span');
  count.className = 'folder-count';
  count.textContent = group.items.length;

  el.appendChild(caret);
  el.appendChild(name);

  // Unfiled is virtual: nothing to rename, nothing to delete.
  if (group.id !== UNFILED_ID) {
    const rename = document.createElement('button');
    rename.className = 'folder-btn';
    rename.title = 'Rename folder';
    rename.textContent = '✎';
    rename.addEventListener('click', e => {
      e.stopPropagation();
      openFolderNameModal(
        { title: 'Rename Folder', value: group.name, confirmLabel: 'Rename' },
        newName => { renameFolder(group.id, newName); renderItemList(); }
      );
    });

    const del = document.createElement('button');
    del.className = 'folder-btn danger';
    del.title = 'Delete folder (its items are re-filed, never deleted)';
    del.textContent = '✕';
    del.addEventListener('click', e => {
      e.stopPropagation();
      const n = getFolderItemCount(group.id);
      const msg = n
        ? `Delete the folder “${group.name}”?\n\nIts ${n} item${n > 1 ? 's' : ''} will be re-filed automatically — no items are deleted.`
        : `Delete the folder “${group.name}”?`;
      if (!confirm(msg)) return;
      deleteFolder(group.id);
      renderItemList();
    });

    el.appendChild(rename);
    el.appendChild(del);
  }

  el.appendChild(count); // last, so every folder's count sits flush right

  // A search forces every folder open, so the header stops being a toggle.
  if (isSearchLocked) el.classList.add('search-locked');
  else el.addEventListener('click', () => { toggleFolderCollapsed(group.id); renderItemList(); });

  return el;
}

function _buildItemCard(t, opts = {}) {
  const card = document.createElement('div');
  card.className = 'item-card';
  card.dataset.templateId = t.id;
  if (state.placing && state.placing.templateId === t.id) card.classList.add('placing');
  if (t.variantOf || opts.indent) card.classList.add('item-card-variant');
  if (opts.depth > 1) card.classList.add('item-card-depth-2');
  // opts.indent means this is the base's own row, nested under its dog-ear:
  // it must behave like a plain placeable item there, not a second toggle.
  const hasVariants = !!t.variantIds?.length && !opts.indent;
  if (hasVariants) {
    card.classList.add('has-variants');
    if (_isFamilyOpen(t)) card.classList.add('variants-expanded');
    const tag = document.createElement('div');
    tag.className = 'item-card-variant-tag';
    tag.title = `${t.variantIds.length} variant${t.variantIds.length > 1 ? 's' : ''}`;
    card.appendChild(tag);
  }

  const color = getRarityColor(t.rarity);

  const swatch = document.createElement('div');
  swatch.className = 'item-card-swatch';
  swatch.style.background = color;

  const info = document.createElement('div');
  info.className = 'item-card-info';
  const nameEl = document.createElement('div');
  nameEl.className = 'item-card-name';
  nameEl.textContent = t.name;
  const sub = document.createElement('div');
  sub.className = 'item-card-sub';
  // A magic family's header (items.js) is a choice of items, not one.
  const weightText = t.abstract
    ? `${t.familySize} option${t.familySize === 1 ? '' : 's'}`
    : isStackable(t)
      ? `${formatWeight(getItemUnitWeight(t))} lb ea · stack ×${getItemStackSize(t)}`
      : `${getShapeWeight(t.shape)} lb`;
  const rarity = t.rarityVaries ? 'Rarity varies' : RARITY_META[t.rarity]?.label;
  sub.textContent = `${rarity} · ${weightText}`;

  info.appendChild(nameEl);
  info.appendChild(sub);

  const shapePreview = _buildMiniShapePreview(t.shape, color);

  card.appendChild(swatch);
  card.appendChild(info);
  card.appendChild(shapePreview);

  _attachItemCardPointer(card, t, hasVariants);
  card.addEventListener('pointerenter', e => {
    tooltipTimer = setTimeout(() => showTemplateTooltip(t.id, e.clientX, e.clientY), 1000);
  });
  card.addEventListener('pointerleave', clearTooltip);
  card.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (t.abstract) return; // no item to edit, delete or file on its own
    showTemplateContextMenu(t.id, e.clientX, e.clientY);
  });

  return card;
}

// A press on a Browse card: a click folds a family or starts placing, a drag
// drops the item onto a shop, a folder or the grid.
function _attachItemCardPointer(card, t, hasVariants) {
  card.addEventListener('pointerdown', e => {
    if (e.button !== 0 || isReadOnly()) return;
    e.preventDefault(); // prevent text selection on mousedown
    const tid = t.id;
    const startX = e.clientX, startY = e.clientY;
    let isDragging = false;

    const onMove = me => {
      if (t.abstract) return; // a family header only folds: nothing to drag
      if (!isDragging && Math.hypot(me.clientX - startX, me.clientY - startY) < 5) return;
      if (!isDragging) {
        isDragging = true;
        document.body.style.userSelect = 'none';
        card.classList.add('dragging'); // fade the one left behind
        cancelPlacing();
        startDragAutoScroll(me.clientX, me.clientY, dragRefresh);
      }
      updateDragAutoScroll(me.clientX, me.clientY);
      _showCatalogueDragHover(tid, me.clientX, me.clientY);
    };

    const onUp = ue => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      stopDragAutoScroll();
      if (!isDragging) {
        // A dog-eared card's click is only the fold toggle; the base item is
        // reached as the first row of the unfolded family (see _appendVariantRows).
        if (hasVariants) {
          if (_isFamilyOpen(t)) expandedVariantIds.delete(tid);
          else expandedVariantIds.add(tid);
          renderItemList();
          return;
        }
        startPlacing(tid);
        return;
      }
      _dropCatalogueItem(card, tid, ue.clientX, ue.clientY);
    };

    // Re-runs the hover logic on a cursor that has not moved, for the frames
    // where auto-scroll moved the content under it instead.
    function dragRefresh(x, y) { onMove({ clientX: x, clientY: y }); }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

// Hover feedback for a Browse item dragged to (x, y). A shop or folder under the
// cursor wins over the grid.
function _showCatalogueDragHover(tid, x, y) {
  const tmpl = state.db[tid];
  if (!tmpl) return;
  const shape = getRotatedShape(tmpl.shape, 0);
  initGhostEl(shape, tmpl.rarity);

  // No equip-slot highlighting for new items (not yet placed)
  document.querySelectorAll('.eq-card.drag-hover').forEach(c => c.classList.remove('drag-hover'));

  clearShopDropTargets();
  clearFolderDropTargets();
  const shopDrop = getShopDropTargetAtPoint(x, y);
  if (shopDrop) {
    shopDrop.el.classList.add('drop-target');
    setGhostVisibility(false);
    clearHighlights();
    return;
  }
  // Over any folder band the grid gets no look in.
  if (showFolderDropFeedback(tid, x, y).hovering) {
    setGhostVisibility(false);
    clearHighlights();
    return;
  }

  const pos = getGridPosAtCursor(x, y, 0, 0);
  if (pos) {
    const sp = getGhostScreenPos(0, 0, pos.row, pos.col);
    const isValid = canPlace(shape, pos.row, pos.col);
    setGhostVisibility(true);
    moveGhost(sp.x, sp.y, isValid);
    highlightCells(shape, pos.row, pos.col, isValid);
  } else {
    setGhostVisibility(false);
    clearHighlights();
  }
}

// End of a Browse item drag at (x, y): clean up the ghost and highlights, then
// drop onto a shop, refile into a folder, or place on the grid.
function _dropCatalogueItem(card, tid, x, y) {
  const shopDrop = getShopDropTargetAtPoint(x, y);
  const folderId = getFolderDropTarget(tid, x, y);
  setGhostVisibility(true);
  hideGhost();
  clearHighlights();
  clearShopDropTargets();
  clearFolderDropTargets();
  card.classList.remove('dragging');
  document.querySelectorAll('.eq-card.drag-hover').forEach(c => c.classList.remove('drag-hover'));

  // Dropped on a shop: onto the shelf it goes, nothing enters the grid.
  if (shopDrop) {
    addItemsToShop(shopDrop.shopId, [tid]);
    return;
  }

  // Dropped in another folder: reclassify (Unfiled = a deliberate "no folder").
  if (folderId) {
    setItemFolder(tid, folderId);
    renderItemList();
    return;
  }

  const tmpl = state.db[tid];
  if (!tmpl) return;
  const shape = getRotatedShape(tmpl.shape, 0);
  const pos = getGridPosAtCursor(x, y, 0, 0);
  // Dropped outside or on an invalid spot: silently cancel, no placing mode.
  if (!pos || !canPlace(shape, pos.row, pos.col)) return;
  if (isStackable(tmpl)) {
    openStackModal(getItemStackSize(tmpl),
      count => finalizePlacement(tmpl, shape, 0, pos.row, pos.col, count));
  } else {
    finalizePlacement(tmpl, shape, 0, pos.row, pos.col, 1);
  }
}

// A base item's variants, indented beneath its card while its family is open.
// Full cards, so a variant drags, places and tooltips like any other item. The
// base item leads as a row of itself (opts.indent), since its own card only
// folds. A magic family's header is `abstract` (nothing to place), so it has no
// such row, and its rows may be headers themselves, drawn one level deeper.
function _appendVariantRows(listEl, t, folderId, depth = 1) {
  if (!t.variantIds?.length || !_isFamilyOpen(t)) return;
  if (!t.abstract) {
    const selfCard = _buildItemCard(t, { indent: true, depth });
    if (folderId) selfCard.dataset.folderId = folderId;
    listEl.appendChild(selfCard);
  }
  // The whole family when the header itself matched; otherwise just the hits.
  const doesHeaderPass = _doesItemPassFilter(t);
  t.variantIds.forEach(vid => {
    const variant = state.db[vid];
    if (!variant || (!doesHeaderPass && !_doesFamilyPassFilter(variant))) return;
    const card = _buildItemCard(variant, { depth });
    if (folderId) card.dataset.folderId = folderId;
    listEl.appendChild(card);
    _appendVariantRows(listEl, variant, folderId, depth + 1);
  });
}

function _buildMiniShapePreview(shape, color) {
  const norm = normalizeShape(shape);
  const { rows, cols } = getShapeDims(norm);
  const clampR = Math.min(rows, 6), clampC = Math.min(cols, 6);
  const div = document.createElement('div');
  div.className = 'item-card-shape';
  div.style.gridTemplateColumns = `repeat(${clampC}, 7px)`;
  div.style.gridTemplateRows    = `repeat(${clampR}, 7px)`;
  for (let r = 0; r < clampR; r++) for (let c = 0; c < clampC; c++) {
    const cell = document.createElement('div');
    cell.className = 'card-cell ' + (norm[r]?.[c] ? 'filled' : 'empty');
    if (norm[r]?.[c]) cell.style.background = color;
    div.appendChild(cell);
  }
  return div;
}

function _populateTagFilter() {
  const sel = document.getElementById('tag-filter');
  const current = sel.value;
  const allTags = new Set();
  Object.values(state.db).forEach(t => t.tags.forEach(tag => allTags.add(tag)));
  sel.innerHTML = '<option value="">All Tags</option>';
  [...allTags].sort().forEach(tag => {
    const opt = document.createElement('option');
    opt.value = tag; opt.textContent = tag;
    sel.appendChild(opt);
  });
  sel.value = current;
}

// ─── RENDERING — DETAILS PANEL ───
// Select a catalogue template, show it in the Details tab and wire its actions.
function showTemplateDetails(templateId) {
  state.selected = { type: 'template', id: templateId };
  const t = state.db[templateId];
  if (!t) return;
  populateDetailsPanel(t);
  switchTab('details');

  // _showShopItemDetails() hides these: goods on a shelf are not yours to place.
  document.getElementById('details-actions').classList.remove('hidden');
  document.getElementById('details-place-btn').classList.remove('hidden');
  document.getElementById('details-place-btn').onclick = () => startPlacing(t.id);
  document.getElementById('details-stash-btn').onclick = () => { addToStash(t.id); switchTab('browse'); };
  document.getElementById('details-edit-btn').onclick  = () => openItemModal(t.id);
  document.getElementById('details-delete-btn').textContent = 'Delete';
  document.getElementById('details-delete-btn').onclick = () => deleteTemplate(t.id);
}

// Select a placed or stashed instance, show it in the Details tab and wire its actions.
function showInstanceDetails(instanceId) {
  const inst = state.instances[instanceId];
  if (!inst) return;
  const t = state.db[inst.templateId];
  if (!t) return;

  state.selected = { type: 'instance', id: instanceId };
  populateDetailsPanel(t, inst);
  switchTab('details');

  document.getElementById('details-actions').classList.remove('hidden');
  document.getElementById('details-place-btn').classList.add('hidden');
  document.getElementById('details-stash-btn').onclick = () => {
    if (inst.row !== null && inst.row !== undefined) {
      unequipInstance(instanceId);
      removeFromGrid(instanceId);
      inst.row = null;
      inst.col = null;
      renderAllItems();
      updateWeightDisplay();
      scheduleSaveAndSync();
    }
    switchTab('browse');
  };
  document.getElementById('details-edit-btn').onclick = () => openItemModal(t.id);
  document.getElementById('details-delete-btn').textContent = 'Remove';
  document.getElementById('details-delete-btn').onclick = () => {
    removeInstance(instanceId);
    document.getElementById('details-content').classList.add('hidden');
    document.getElementById('details-placeholder').classList.remove('hidden');
  };
}

// Fill the Details panel for a template, or for one instance of it when `inst` is given.
function populateDetailsPanel(t, inst) {
  const color = getRarityColor(t.rarity);
  const shape = inst ? getRotatedShape(t.shape, inst.rotation ?? 0) : t.shape;
  const weight = isStackable(t)
    ? (inst ? `${formatWeight(getItemUnitWeight(t) * (inst.stackCount ?? 1))} lb (×${inst.stackCount ?? 1})` : `${formatWeight(getItemUnitWeight(t))} lb each`)
    : `${getShapeWeight(shape)} lb`;

  document.getElementById('details-placeholder').classList.add('hidden');
  document.getElementById('details-content').classList.remove('hidden');

  document.getElementById('details-name').textContent = t.name;
  const badge = document.getElementById('details-rarity-badge');
  badge.textContent = RARITY_META[t.rarity]?.label;
  badge.style.background = color + '33';
  badge.style.color = color;
  badge.style.border = `1px solid ${color}66`;

  _renderDetailsShapePreview(shape, color);

  const imgEl = document.getElementById('details-image');
  if (t.image) { imgEl.src = t.image; imgEl.classList.remove('hidden'); }
  else imgEl.classList.add('hidden');

  document.getElementById('details-weight').textContent = weight;
  document.getElementById('details-cost').textContent =
    hasCost(t.cost) ? formatCost(t.cost) : 'Priceless';

  const stackRow = document.getElementById('details-stack-row');
  if (isStackable(t)) {
    stackRow.classList.remove('hidden');
    document.getElementById('details-stack').textContent = inst
      ? `${inst.stackCount ?? 1} / ${getItemStackSize(t)}`
      : `×${getItemStackSize(t)} max`;
  } else {
    stackRow.classList.add('hidden');
  }

  const damageRow = document.getElementById('details-damage-row');
  if (t.damage) {
    damageRow.classList.remove('hidden');
    document.getElementById('details-damage').textContent =
      `${t.damage}${t.damageType ? ' ' + t.damageType : ''}`;
  } else {
    damageRow.classList.add('hidden');
  }

  document.getElementById('details-attunement-row').classList.toggle('hidden', !t.attunement);
  document.getElementById('details-attunement-val').textContent =
    t.attunementNote ? `Required ${t.attunementNote}` : 'Required';

  const sourceRow = document.getElementById('details-source-row');
  if (t.source) {
    sourceRow.classList.remove('hidden');
    document.getElementById('details-source').textContent = t.source;
  } else {
    sourceRow.classList.add('hidden');
  }

  const tagsEl = document.getElementById('details-tags');
  tagsEl.innerHTML = '';
  t.tags.forEach(tag => {
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.textContent = tag;
    tagsEl.appendChild(pill);
  });

  const descEl = document.getElementById('details-desc');
  descEl.textContent = '';
  if (t.description) renderMarkdownInto(descEl, t.description);

  // Only "Label: text" properties (Ability/Utilize/Craft on artisan's tools and
  // the like) are abilities; a bare flag like "Finesse" has no colon.
  const abilitiesEl = document.getElementById('details-abilities');
  abilitiesEl.innerHTML = '';
  const abilities = (t.properties || []).filter(p => p.includes(':'));
  abilitiesEl.classList.toggle('hidden', abilities.length === 0);
  abilities.forEach(p => {
    const idx = p.indexOf(':');
    const row = document.createElement('div');
    row.className = 'ability-row';
    const label = document.createElement('span');
    label.className = 'ability-label';
    label.textContent = p.slice(0, idx).trim() + ': ';
    const text = document.createElement('span');
    text.className = 'ability-text';
    text.textContent = p.slice(idx + 1).trim();
    row.appendChild(label);
    row.appendChild(text);
    abilitiesEl.appendChild(row);
  });
}

function _renderDetailsShapePreview(shape, color) {
  const preview = document.getElementById('details-shape-preview');
  const norm = normalizeShape(shape);
  const { rows, cols } = getShapeDims(norm);
  preview.style.gridTemplateColumns = `repeat(${cols}, 20px)`;
  preview.style.gridTemplateRows    = `repeat(${rows}, 20px)`;
  preview.innerHTML = '';
  norm.forEach(row => row.forEach(v => {
    const cell = document.createElement('div');
    cell.className = 'prev-cell ' + (v ? 'filled' : 'empty');
    if (v) { cell.style.background = color + '55'; cell.style.borderColor = color; }
    preview.appendChild(cell);
  }));
}
