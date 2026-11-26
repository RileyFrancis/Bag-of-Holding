// =============================================================================
// RENDER-GRID — Draws the grid cells and the placed-item elements
// =============================================================================
'use strict';

const GRID_FADE_ROWS = 4; // rows of fade-out below the lowest placed item

const gridEl = document.getElementById('inventory-grid');

// ─── GRID CELLS ──────────────────────────────────────────────────────────────
// Rebuild the cell divs of the active grid; the main grid also gets its
// encumbrance zones.
function buildGrid() {
  gridEl.innerHTML = '';
  const cols = getActiveGridCols();
  const totalRows = getActiveGridRows();
  gridEl.style.gridTemplateColumns = `repeat(${cols}, ${CELL}px)`;
  gridEl.style.gridTemplateRows    = `repeat(${totalRows}, ${CELL}px)`;

  if (state.activeContainer) {
    for (let r = 0; r < totalRows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = document.createElement('div');
        cell.className = 'grid-cell';
        cell.dataset.row = r;
        cell.dataset.col = c;
        gridEl.appendChild(cell);
      }
    }
    gridEl.style.height = totalRows * CELL + 'px';
    return;
  }

  const strength = state.character.strength;
  for (let r = 0; r < totalRows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = document.createElement('div');
      cell.className = 'grid-cell';
      cell.dataset.row = r;
      cell.dataset.col = c;
      if (r >= strength && r < strength * 2) {
        cell.classList.add('zone-enc');
        if (r === strength) cell.classList.add('zone-boundary-enc');
      } else if (r >= strength * 2) {
        cell.classList.add('zone-heavy');
        if (r === strength * 2) cell.classList.add('zone-boundary-heavy');
      }
      gridEl.appendChild(cell);
    }
  }
  gridEl.style.height = getNormalRows() * CELL + 'px';
}

// ─── PLACED ITEMS ────────────────────────────────────────────────────────────
// Size the main grid to just past the lowest item and fade out the rows below.
function updateGridFade() {
  if (state.activeContainer) {
    const rows = getActiveGridRows();
    gridEl.style.height = rows * CELL + 'px';
    gridEl.style.maskImage = '';
    gridEl.style.webkitMaskImage = '';
    return;
  }
  const totalRows = getGridRows();
  const totalHeight = totalRows * CELL;
  let lowestPx = getNormalRows() * CELL;

  Object.values(state.instances).forEach(inst => {
    if (inst.row === null || inst.row === undefined) return;
    const t = state.db[inst.templateId];
    if (!t) return;
    const shape = getRotatedShape(t.shape, inst.rotation);
    const bottomPx = (inst.row + shape.length) * CELL;
    if (bottomPx > lowestPx) lowestPx = bottomPx;
  });

  const fadeStartPx = Math.min(lowestPx, totalHeight);
  const fadeEndPx   = Math.min(lowestPx + GRID_FADE_ROWS * CELL, totalHeight);

  gridEl.style.height = fadeEndPx + 'px';

  if (fadeEndPx >= totalHeight) {
    gridEl.style.maskImage = '';
    gridEl.style.webkitMaskImage = '';
    return;
  }

  // Percentages relative to the element's rendered height (fadeEndPx), not totalHeight
  const fadeStartPct = (fadeStartPx / fadeEndPx * 100).toFixed(2);
  const mask = `linear-gradient(to bottom, black ${fadeStartPct}%, transparent 100%)`;
  gridEl.style.maskImage = mask;
  gridEl.style.webkitMaskImage = mask;
}

// Redraw every placed item of the active grid, plus the panels that mirror them.
function renderAllItems() {
  gridEl.querySelectorAll('.placed-item').forEach(el => el.remove());
  const activeContainerId = state.activeContainer;
  Object.values(state.instances).forEach(inst => {
    if ((inst.containerId ?? null) !== activeContainerId) return;
    renderPlacedItem(inst);
  });
  updateGridFade();
  renderInventoryList();
  renderContainerTabs();
  renderEquipPanel();
  renderStash();
}

function _buildItemEl(template, shape, rarity) {
  const dims = getShapeDims(shape);
  const el = document.createElement('div');
  el.className = `placed-item rarity-${rarity}` + (isSpoiledItem(template) ? ' spoiled' : '');
  el.style.width  = dims.cols * CELL + 'px';
  el.style.height = dims.rows * CELL + 'px';
  el.style.gridTemplateColumns = `repeat(${dims.cols}, ${CELL}px)`;
  el.style.display = 'grid';

  const rc = 'var(--rc)'; // resolved from the .rarity-* class on the item element
  const innerBorder = 'var(--item-inner-border)';

  shape.forEach((row, r) => row.forEach((v, c) => {
    const cellEl = document.createElement('div');
    if (v) {
      cellEl.className = 'item-cell filled';
      const hasTop    = r > 0 && shape[r-1][c] === 1;
      const hasBottom = r < shape.length - 1 && shape[r+1][c] === 1;
      const hasLeft   = c > 0 && shape[r][c-1] === 1;
      const hasRight  = c < shape[r].length - 1 && shape[r][c+1] === 1;
      cellEl.style.borderTopColor    = hasTop    ? innerBorder : rc;
      cellEl.style.borderBottomColor = hasBottom ? innerBorder : rc;
      cellEl.style.borderLeftColor   = hasLeft   ? innerBorder : rc;
      cellEl.style.borderRightColor  = hasRight  ? innerBorder : rc;
    } else {
      cellEl.className = 'item-cell empty';
    }
    el.appendChild(cellEl);
  }));

  // Label in the widest filled row (middle one if tied) — guaranteed within filled cells
  const rowCounts = shape.map(row => row.reduce((a, v) => a + v, 0));
  const maxCells = Math.max(...rowCounts);
  const candidates = rowCounts.reduce((acc, n, r) => { if (n === maxCells) acc.push(r); return acc; }, []);
  const labelRow = candidates[Math.floor(candidates.length / 2)];
  let firstC = -1, lastC = -1;
  shape[labelRow].forEach((v, c) => { if (v) { if (firstC < 0) firstC = c; lastC = c; } });

  if (template.image) {
    const imgDiv = document.createElement('div');
    imgDiv.className = 'item-image-bg';
    imgDiv.style.backgroundImage = `url('${template.image}')`;
    el.appendChild(imgDiv);
  }

  const lbl = document.createElement('div');
  lbl.className = 'item-label';
  lbl.textContent = template.name;
  lbl.style.inset  = 'unset';
  lbl.style.left   = (firstC * CELL) + 'px';
  lbl.style.top    = (labelRow * CELL) + 'px';
  lbl.style.width  = ((lastC - firstC + 1) * CELL) + 'px';
  lbl.style.height = CELL + 'px';
  el.appendChild(lbl);

  return el;
}

// Draw one placed instance onto the grid and return its element (none if unplaced).
function renderPlacedItem(inst) {
  if (inst.row === null || inst.row === undefined) return; // unplaced — shown in stash
  const template = state.db[inst.templateId];
  if (!template) return;
  const shape = getRotatedShape(template.shape, inst.rotation);

  const el = _buildItemEl(template, shape, template.rarity);
  el.dataset.instanceId = inst.id;
  el.style.left = inst.col * CELL + 'px';
  el.style.top  = inst.row * CELL + 'px';

  // Badges sit in the bottom-right *filled* cell, not the bounding box corner, so
  // they never float in the hollow of a non-rectangular shape. The CSS rules add
  // their own small inset on top of these.
  const dims = getShapeDims(shape);
  const anchor = getBottomRightFilledCell(shape);
  el.style.setProperty('--badge-bottom', (dims.rows - anchor.row - 1) * CELL + 'px');
  el.style.setProperty('--badge-right',  (dims.cols - anchor.col - 1) * CELL + 'px');

  // Stack badge
  if (isStackable(template) && inst.stackCount > 1) {
    const badge = document.createElement('div');
    badge.className = 'stack-badge';
    badge.textContent = inst.stackCount;
    el.appendChild(badge);
  }

  // Equipped badge
  if (getEquippedSlot(inst.id)) {
    const equipBadge = document.createElement('div');
    equipBadge.className = 'equip-badge';
    equipBadge.textContent = '⚔';
    el.appendChild(equipBadge);
  }

  // Hover tooltip
  el.querySelectorAll('.item-cell.filled').forEach(cell => {
    cell.addEventListener('pointerenter', e => startTooltipTimer(inst.id, e.clientX, e.clientY));
    cell.addEventListener('pointerleave', clearTooltip);
  });

  el.addEventListener('pointerdown', onItemPointerDown);
  el.addEventListener('contextmenu', onItemContextMenu);

  gridEl.appendChild(el);
  return el;
}
