// =============================================================================
// INVENTORY-LIST — The inventory drawn as a list, and the grid/list switch
// =============================================================================
'use strict';

// Browser furniture: its own localStorage key, never in the save file.
const INVENTORY_LAYOUT_KEY = 'dnd_inventory_layout';
const INVENTORY_LIST_FLASH_MS = 1200; // how long a just-added row stays lit

const inventoryListEl = document.getElementById('inventory-list');
const inventoryLayoutBtn = document.getElementById('inv-layout-btn');

let isInventoryListLayout = _loadInventoryLayout() === 'list';
let flashInstanceId = null;

// ─── LAYOUT SWITCH ───────────────────────────────────────────────────────────
function _loadInventoryLayout() {
  try {
    return localStorage.getItem(INVENTORY_LAYOUT_KEY);
  } catch (e) {
    return null; // storage disabled: the grid is the default
  }
}

function _saveInventoryLayout() {
  try {
    localStorage.setItem(INVENTORY_LAYOUT_KEY, isInventoryListLayout ? 'list' : 'grid');
  } catch (e) { /* non-fatal */ }
}

// Whether the inventory is showing as a list rather than the spatial grid.
function isInventoryListView() {
  return isInventoryListLayout;
}

function _applyInventoryLayout() {
  document.getElementById('inventory-panel').classList.toggle('list-layout', isInventoryListLayout);
  const label = isInventoryListLayout ? 'Show as a grid' : 'Show as a list';
  inventoryLayoutBtn.title = label;
  inventoryLayoutBtn.setAttribute('aria-label', label);
  inventoryLayoutBtn.setAttribute('aria-pressed', String(isInventoryListLayout));
}

// Swap between the spatial grid and the list.
function toggleInventoryLayout() {
  // A held ghost needs the grid to land on, so it never survives the swap.
  cancelPlacing();
  clearTooltip();
  isInventoryListLayout = !isInventoryListLayout;
  _saveInventoryLayout();
  _applyInventoryLayout();
  renderInventoryList();
}

// ─── LIST ────────────────────────────────────────────────────────────────────
function _getInstanceWeight(inst, template) {
  if (isStackable(template)) return getItemUnitWeight(template) * inst.stackCount;
  return getShapeWeight(template.shape);
}

function _getInstanceValue(inst, template) {
  const unit = parseCostObj(template.cost);
  const count = isStackable(template) ? inst.stackCount : 1;
  const total = {};
  COIN_DENOMS.forEach(d => { total[d] = Math.round(unit[d] * count * 100) / 100; });
  return total;
}

function _buildListCell(className, text) {
  const cell = document.createElement('span');
  cell.className = className;
  cell.textContent = text;
  return cell;
}

function _buildInventoryListHeader() {
  const head = document.createElement('div');
  head.className = 'inv-list-head';
  head.append(
    _buildListCell('inv-list-swatch', ''),
    _buildListCell('inv-list-name', 'Item'),
    _buildListCell('inv-list-qty', 'Qty'),
    _buildListCell('inv-list-weight', 'Weight'),
    _buildListCell('inv-list-value', 'Value'),
  );
  return head;
}

function _buildInventoryListRow(inst, template) {
  const row = document.createElement('div');
  row.className = `inv-list-row rarity-${template.rarity}` + (isSpoiledItem(template) ? ' spoiled' : '');
  if (inst.id === flashInstanceId) row.classList.add('just-added');
  row.dataset.instanceId = inst.id;

  const name = _buildListCell('inv-list-name', template.name);
  if (getEquippedSlot(inst.id)) {
    const badge = _buildListCell('inv-list-equipped', '⚔');
    badge.title = 'Equipped';
    name.appendChild(badge);
  }

  row.append(
    _buildListCell('inv-list-swatch', ''),
    name,
    _buildListCell('inv-list-qty', isStackable(template) ? String(inst.stackCount) : '1'),
    _buildListCell('inv-list-weight', formatWeight(_getInstanceWeight(inst, template)) + ' lb'),
    _buildListCell('inv-list-value', formatCost(_getInstanceValue(inst, template))),
  );

  row.addEventListener('pointerenter', e => startTooltipTimer(inst.id, e.clientX, e.clientY));
  row.addEventListener('pointerleave', clearTooltip);
  row.addEventListener('click', () => {
    clearTooltip();
    if (state.mode === 'idle') showInstanceDetails(inst.id);
  });
  row.addEventListener('contextmenu', onItemContextMenu);
  return row;
}

// Redraw the list of what is placed in the active grid. Unplaced items stay in
// the stash below, the same as in the grid layout.
function renderInventoryList() {
  if (!isInventoryListLayout) return;
  inventoryListEl.innerHTML = '';

  const activeContainerId = state.activeContainer;
  const placed = Object.values(state.instances)
    .filter(inst => (inst.containerId ?? null) === activeContainerId
      && inst.row !== null && inst.row !== undefined && state.db[inst.templateId])
    .sort((a, b) => state.db[a.templateId].name.localeCompare(state.db[b.templateId].name)
      || a.id.localeCompare(b.id));

  if (!placed.length) {
    const empty = document.createElement('div');
    empty.className = 'inv-list-empty';
    empty.textContent = 'Nothing here yet. Pick an item from the Items tab to add it.';
    inventoryListEl.appendChild(empty);
    return;
  }

  inventoryListEl.appendChild(_buildInventoryListHeader());
  placed.forEach(inst => inventoryListEl.appendChild(_buildInventoryListRow(inst, state.db[inst.templateId])));
}

// ─── ADDING ITEMS ────────────────────────────────────────────────────────────
// The first free spot for a template in the active grid, scanning top to bottom
// so it fills the unencumbered rows first; null when nothing fits.
function _findFirstFreeSpot(template) {
  const shapes = [0, 1].map(rotation => ({ rotation, shape: getRotatedShape(template.shape, rotation) }));
  const rows = getActiveGridRows();
  const cols = getActiveGridCols();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const fit = shapes.find(s => canPlace(s.shape, row, col));
      if (fit) return { ...fit, row, col };
    }
  }
  return null;
}

function _addTemplateCopies(template, count) {
  const spot = _findFirstFreeSpot(template);
  if (!spot) {
    // No room: it goes to the stash, as a shrunken grid would send it.
    const id = createInstanceId();
    state.instances[id] = { id, templateId: template.id, rotation: 0, row: null, col: null,
      stackCount: count, containerId: state.activeContainer ?? null };
    renderStash();
    updateWeightDisplay();
    scheduleSaveAndSync();
    return;
  }
  const before = new Set(Object.keys(state.instances));
  finalizePlacement(template, spot.shape, spot.rotation, spot.row, spot.col, count);
  flashInstanceId = Object.keys(state.instances).find(id => !before.has(id)) ?? null;
  renderInventoryList();
  setTimeout(() => {
    flashInstanceId = null;
    inventoryListEl.querySelectorAll('.just-added').forEach(el => el.classList.remove('just-added'));
  }, INVENTORY_LIST_FLASH_MS);
}

// The list layout's stand-in for PLACING mode: put one copy (or a chosen stack)
// of a template in the first free spot of the active grid, else the stash.
function addTemplateToFirstFreeSpot(templateId) {
  const template = state.db[templateId];
  if (!template) return;
  if (isStackable(template)) {
    openStackModal(getItemStackSize(template), count => _addTemplateCopies(template, count));
    return;
  }
  _addTemplateCopies(template, 1);
}

// ─── WIRING ──────────────────────────────────────────────────────────────────
inventoryLayoutBtn.addEventListener('click', toggleInventoryLayout);
_applyInventoryLayout();
