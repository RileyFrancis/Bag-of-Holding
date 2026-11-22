// =============================================================================
// DRAG-GHOST — The floating ghost element shared by placing and dragging
// =============================================================================
'use strict';

const FOLDER_HINT_OFFSET = 16; // px between cursor and folder hint, so it never sits under it

const ghostEl = document.getElementById('drag-ghost');
let lastPointerX = 0, lastPointerY = 0;
let ghostShapeKey = ''; // rarity + shape of the built ghost; '' forces a rebuild
let highlightedCells = [];

// Track pointer position globally so keyboard handlers can reference it
document.addEventListener('pointermove', e => { lastPointerX = e.clientX; lastPointerY = e.clientY; }, { passive: true });

// ─── GHOST ───────────────────────────────────────────────────────────────────
// Build the ghost's cells for a shape and rarity; a no-op when already built.
function initGhostEl(shape, rarity) {
  const key = rarity + '|' + shape.map(r => r.join('')).join('|');
  if (key === ghostShapeKey) return;
  ghostShapeKey = key;
  const dims = getShapeDims(shape);
  ghostEl.style.gridTemplateColumns = `repeat(${dims.cols}, ${CELL}px)`;
  ghostEl.style.width  = dims.cols * CELL + 'px';
  ghostEl.style.height = dims.rows * CELL + 'px';
  ghostEl.className = `rarity-${rarity}`;
  ghostEl.innerHTML = '';

  const outerBorder = 'var(--ghost-outer)';
  const innerBorder = 'var(--ghost-inner)';

  shape.forEach((row, r) => row.forEach((v, c) => {
    const cell = document.createElement('div');
    if (v) {
      cell.className = 'item-cell filled';
      const hasTop    = r > 0 && shape[r-1][c] === 1;
      const hasBottom = r < shape.length - 1 && shape[r+1][c] === 1;
      const hasLeft   = c > 0 && shape[r][c-1] === 1;
      const hasRight  = c < shape[r].length - 1 && shape[r][c+1] === 1;
      cell.style.borderTopColor    = hasTop    ? innerBorder : outerBorder;
      cell.style.borderBottomColor = hasBottom ? innerBorder : outerBorder;
      cell.style.borderLeftColor   = hasLeft   ? innerBorder : outerBorder;
      cell.style.borderRightColor  = hasRight  ? innerBorder : outerBorder;
    } else {
      cell.className = 'item-cell empty';
    }
    ghostEl.appendChild(cell);
  }));
}

// Show the ghost for a shape at screen position (x, y).
function showGhost(shape, rarity, x, y) {
  initGhostEl(shape, rarity);
  ghostEl.style.display = ''; // ensure visible (clears any setGhostVisibility(false))
  ghostEl.style.left = x + 'px';
  ghostEl.style.top  = y + 'px';
}

// Move the ghost; `isValid` true/false tints it, anything else leaves it plain.
function moveGhost(x, y, isValid) {
  ghostEl.style.left = x + 'px';
  ghostEl.style.top  = y + 'px';
  ghostEl.classList.remove('valid', 'invalid');
  if (isValid === true)  ghostEl.classList.add('valid');
  if (isValid === false) ghostEl.classList.add('invalid');
}

// Hide the ghost and forget its shape, so the next show rebuilds it.
function hideGhost() {
  ghostEl.className = 'hidden';
  ghostEl.style.display = ''; // reset any inline visibility set by setGhostVisibility
  ghostShapeKey = '';
}

// Screen position of a grid cell's top-left corner. The anchor arguments are unused.
function getGhostScreenPos(anchorRow, anchorCol, gridRow, gridCol) {
  const rect = gridEl.getBoundingClientRect();
  return {
    x: rect.left + gridCol * CELL,
    y: rect.top  + gridRow * CELL,
  };
}

// Show or hide the ghost without clearing its shape (cursor entering/leaving the grid).
function setGhostVisibility(isVisible) {
  ghostEl.style.display = isVisible ? '' : 'none';
}

// ─── DROP TARGETS ────────────────────────────────────────────────────────────
// Find the equip slot card at a screen point using bounding-rect checks.
// Avoids elementFromPoint, which can return the ghost even with pointer-events:none.
function getEquipCardAtPoint(x, y) {
  for (const card of document.querySelectorAll('.eq-card')) {
    const r = card.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return card;
  }
  return null;
}

// The whole folder is a drop target, not just its header. The list is a flat run
// of headers and cards, so a folder is the BAND from its header to the next,
// found by walking the children in order. Position within the band is ignored.
function _getFolderDropAtPoint(x, y) {
  const listEl = document.getElementById('item-list');
  if (!listEl.classList.contains('foldered')) return null;
  const lr = listEl.getBoundingClientRect();
  if (x < lr.left || x > lr.right || y < lr.top || y > lr.bottom) return null;

  let folderId = null;
  for (const el of listEl.children) {
    if (el.classList.contains('folder-header')) folderId = el.dataset.folderId;
    if (y <= el.getBoundingClientRect().bottom) return folderId;
  }
  // Past the last card: empty space belonging to no folder.
  return null;
}

// The folder a drag would file into, or null. A drop back into the item's own
// folder is NOT a target; it reads as a cancelled drag.
function getFolderDropTarget(templateId, x, y) {
  const id = _getFolderDropAtPoint(x, y);
  if (!id) return null;
  return id === (getItemFolderId(templateId) ?? UNFILED_ID) ? null : id;
}

// The whole band lights, header and cards together. `cls` is `drop-target` (a
// folder the item would move into) or `drop-current` (the one it is in).
function _addFolderBandClass(folderId, cls) {
  if (!folderId) return;
  document.querySelectorAll(
    `#item-list .folder-header[data-folder-id="${folderId}"], ` +
    `#item-list .item-card[data-folder-id="${folderId}"]`
  ).forEach(el => el.classList.add(cls));
}

// Clear every folder band highlight and the drop hint.
function clearFolderDropTargets() {
  document.querySelectorAll('#item-list .drop-target, #item-list .drop-current')
    .forEach(el => el.classList.remove('drop-target', 'drop-current'));
  _hideFolderDropHint();
}

// ─── FOLDER DROP HINT ────────────────────────────────────────────────────────
// A chip at the cursor naming the folder, since a folder taller than the list
// hides its own header.
const folderDropHintEl = document.getElementById('folder-drop-hint');

function _showFolderDropHint(text, isBlocked, x, y) {
  folderDropHintEl.textContent = text;
  folderDropHintEl.classList.remove('hidden');
  folderDropHintEl.classList.toggle('blocked', !!isBlocked);
  // Flip to the other side of the cursor rather than run off the edge; measured
  // after the text is in, since the chip is as wide as the folder's name.
  const w = folderDropHintEl.offsetWidth, h = folderDropHintEl.offsetHeight;
  const left = x + FOLDER_HINT_OFFSET + w > window.innerWidth
    ? x - FOLDER_HINT_OFFSET - w : x + FOLDER_HINT_OFFSET;
  const top = y + FOLDER_HINT_OFFSET + h > window.innerHeight
    ? y - FOLDER_HINT_OFFSET - h : y + FOLDER_HINT_OFFSET;
  folderDropHintEl.style.left = left + 'px';
  folderDropHintEl.style.top  = top + 'px';
}

function _hideFolderDropHint() {
  folderDropHintEl.className = 'hidden';
}

// All of a browse drag's folder feedback in one call, so band, chip and answer
// agree. Returns { folderId, hovering }: `folderId` is where a drop would move the
// item (or null); `hovering` is true over ANY band, the item's own included,
// where the grid preview must stay out.
function showFolderDropFeedback(templateId, x, y) {
  clearFolderDropTargets();
  const hoverId = _getFolderDropAtPoint(x, y);
  if (!hoverId) return { folderId: null, hovering: false };

  const folderId = getFolderDropTarget(templateId, x, y);
  if (folderId) {
    _addFolderBandClass(folderId, 'drop-target');
    _showFolderDropHint('Move to ' + getFolderName(folderId), false, x, y);
  } else {
    // The item's own folder: say so rather than leave a dead patch of list
    _addFolderBandClass(hoverId, 'drop-current');
    _showFolderDropHint('Already in ' + getFolderName(hoverId), true, x, y);
  }
  return { folderId, hovering: true };
}

// ─── CELL HIGHLIGHTS ─────────────────────────────────────────────────────────
// Highlight the grid cells a shape would cover at (gridRow, gridCol).
function highlightCells(shape, gridRow, gridCol, isValid) {
  clearHighlights();
  const cls = isValid ? 'highlight-valid' : 'highlight-invalid';
  getShapeCells(shape, gridRow, gridCol).forEach(({ row, col }) => {
    const cell = gridEl.querySelector(`.grid-cell[data-row="${row}"][data-col="${col}"]`);
    if (cell) { cell.classList.add(cls); highlightedCells.push(cell); }
  });
}

// Remove every cell highlight.
function clearHighlights() {
  highlightedCells.forEach(c => c.classList.remove('highlight-valid', 'highlight-invalid'));
  highlightedCells = [];
}
