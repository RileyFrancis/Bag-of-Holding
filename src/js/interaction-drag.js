// =============================================================================
// INTERACTION-DRAG — DRAGGING mode for placed items, R-key rotation, Escape
// =============================================================================
'use strict';

const DRAG_THRESHOLD = 6; // px of movement before a press becomes a drag

let dragHoverSlotId = null; // slot id the drag ghost is currently hovering over
let dragIntent = null;      // pending drag: waiting to see if pointer moves enough

// ─── DRAG START ──────────────────────────────────────────────────────────────
// Pointer down on a placed item: arm a drag that starts once the pointer moves
// past DRAG_THRESHOLD; a release before that opens the item's details.
function onItemPointerDown(e) {
  if (e.button !== 0) return;
  if (isReadOnly()) return;
  clearTooltip();
  if (state.mode === 'placing') { cancelPlacing(); return; }

  const el = e.currentTarget;
  const instanceId = el.dataset.instanceId;
  const inst = state.instances[instanceId];
  if (!inst) return;

  const template = state.db[inst.templateId];
  if (!template) return;

  const shape = getRotatedShape(template.shape, inst.rotation);
  const dims  = getShapeDims(shape);

  // The cell under the pointer becomes the drag anchor
  const itemRect  = el.getBoundingClientRect();
  const localX    = e.clientX - itemRect.left;
  const localY    = e.clientY - itemRect.top;
  const anchorCol = Math.floor(localX / CELL);
  const anchorRow = Math.floor(localY / CELL);

  if (!shape[anchorRow]?.[anchorCol]) return;

  // Record intent but don't start the drag until the pointer moves enough
  dragIntent = {
    instanceId, el,
    anchorRow: Math.min(anchorRow, dims.rows - 1),
    anchorCol: Math.min(anchorCol, dims.cols - 1),
    startX: e.clientX, startY: e.clientY,
  };

  document.addEventListener('pointermove', _onDragIntentMove);
  document.addEventListener('pointerup', _onDragIntentUp);
  e.preventDefault();
}

function _onDragIntentMove(e) {
  if (!dragIntent) return;
  const dx = e.clientX - dragIntent.startX;
  const dy = e.clientY - dragIntent.startY;
  if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;

  // Movement threshold crossed: activate the drag
  document.removeEventListener('pointermove', _onDragIntentMove);
  document.removeEventListener('pointerup', _onDragIntentUp);
  const intent = dragIntent;
  dragIntent = null;
  _activateItemDrag(intent, e);
}

function _onDragIntentUp(e) {
  // Pointer released before the threshold: treat as a click
  document.removeEventListener('pointermove', _onDragIntentMove);
  document.removeEventListener('pointerup', _onDragIntentUp);
  if (!dragIntent) return;
  const { instanceId } = dragIntent;
  dragIntent = null;
  const inst = state.instances[instanceId];
  if (inst) showInstanceDetails(instanceId);
}

function _activateItemDrag(intent, e) {
  const { instanceId, el, anchorRow, anchorCol } = intent;
  const inst = state.instances[instanceId];
  if (!inst) return;
  const template = state.db[inst.templateId];
  if (!template) return;
  const shape = getRotatedShape(template.shape, inst.rotation);

  state.mode = 'dragging';
  state.dragging = {
    instanceId, anchorRow, anchorCol,
    origRow: inst.row, origCol: inst.col, origRotation: inst.rotation,
  };

  el.classList.add('dragging-source');
  removeFromGrid(instanceId);

  const initX = e.clientX - anchorCol * CELL;
  const initY = e.clientY - anchorRow * CELL;
  showGhost(shape, template.rarity, initX, initY);

  document.body.style.userSelect = 'none';
  // Hold the cursor near a panel's edge and the panel scrolls, so a grid row or
  // an equip slot below the fold is still reachable without letting go.
  startDragAutoScroll(e.clientX, e.clientY, _replayDragMoveAt);
  document.addEventListener('pointermove', _onDragMove);
  document.addEventListener('pointerup', _onDragEnd);
}

// Pointer down on a stash card: start dragging that instance at once.
function onStashPointerDown(e, instanceId) {
  if (e.button !== 0) return;
  if (isReadOnly()) return;
  clearTooltip();
  if (state.mode === 'placing') { cancelPlacing(); return; }

  const inst = state.instances[instanceId];
  if (!inst) return;
  const template = state.db[inst.templateId];
  if (!template) return;

  const shape = getRotatedShape(template.shape, inst.rotation ?? 0);

  state.mode = 'dragging';
  state.dragging = {
    instanceId,
    anchorRow: 0,
    anchorCol: 0,
    origRow: null,   // null = came from stash, not the grid
    origCol: null,
    origRotation: inst.rotation ?? 0,
  };

  showGhost(shape, template.rarity, e.clientX, e.clientY);
  document.body.style.userSelect = 'none';
  startDragAutoScroll(e.clientX, e.clientY, _replayDragMoveAt);
  document.addEventListener('pointermove', _onDragMove);
  document.addEventListener('pointerup', _onDragEnd);
  e.preventDefault();
}

// Re-run the drag move for a still cursor, on frames where auto-scroll moved
// the content under it instead.
function _replayDragMoveAt(x, y) { _onDragMove({ clientX: x, clientY: y }); }

// ─── DRAG MOVE AND DROP ──────────────────────────────────────────────────────
function _onDragMove(e) {
  if (state.mode !== 'dragging') return;
  updateDragAutoScroll(e.clientX, e.clientY);
  const drag = state.dragging;
  const inst = state.instances[drag.instanceId];
  const template = state.db[inst.templateId];
  const shape = getRotatedShape(template.shape, inst.rotation);

  // Grid preview
  const pos = getGridPosAtCursor(e.clientX, e.clientY, drag.anchorRow, drag.anchorCol);
  if (pos) {
    const { row: gr, col: gc } = pos;
    const screenPos = getGhostScreenPos(0, 0, gr, gc);
    const isValid = canPlace(shape, gr, gc, drag.instanceId) ||
                    !!_getStackMergeTarget(drag.instanceId, gr, gc);
    setGhostVisibility(true);
    moveGhost(screenPos.x, screenPos.y, isValid);
    highlightCells(shape, gr, gc, isValid);
  } else {
    setGhostVisibility(false);
    clearHighlights();
  }

  // Equip slot hover, tracked for the drop
  document.querySelectorAll('.eq-card.drag-hover').forEach(c => c.classList.remove('drag-hover'));
  dragHoverSlotId = null;
  const equipCard = getEquipCardAtPoint(e.clientX, e.clientY);
  if (equipCard) {
    const slot = getSlotDef(equipCard.dataset.slotId);
    if (slot && !(slot.attuneOnly && !template.attunement)) {
      equipCard.classList.add('drag-hover');
      dragHoverSlotId = slot.id;
    }
  }
}

function _onDragEnd(e) {
  if (state.mode !== 'dragging') return;
  document.removeEventListener('pointermove', _onDragMove);
  document.removeEventListener('pointerup', _onDragEnd);
  document.body.style.userSelect = '';
  stopDragAutoScroll();

  const drag = state.dragging;
  const inst = state.instances[drag.instanceId];
  const template = state.db[inst.templateId];
  const shape = getRotatedShape(template.shape, inst.rotation);

  let isPlaced = false;

  // Drop onto the slot highlighted during the drag: the tracked id is more
  // reliable than re-checking at pointerup, where coordinates can be stale.
  if (dragHoverSlotId) {
    // Restore the grid position first (an item from the stash has none)
    if (drag.origRow !== null && drag.origRow !== undefined) {
      inst.row = drag.origRow;
      inst.col = drag.origCol;
      inst.rotation = drag.origRotation;
      const restoreShape = getRotatedShape(template.shape, inst.rotation);
      placeOnGrid(inst.id, restoreShape, inst.row, inst.col);
    }
    equipItem(drag.instanceId, dragHoverSlotId);
    isPlaced = true;
    dragHoverSlotId = null;
  }

  // Otherwise try to drop on the inventory grid
  if (!isPlaced) {
    const pos = getGridPosAtCursor(e.clientX, e.clientY, drag.anchorRow, drag.anchorCol);
    if (pos) {
      const { row: gr, col: gc } = pos;
      const target = _getStackMergeTarget(drag.instanceId, gr, gc);
      if (target) {
        // Top up the stack underneath; whatever doesn't fit falls through to
        // the restore below, back where it came from.
        const moved = Math.min(getItemStackSize(template) - (target.stackCount ?? 1), inst.stackCount ?? 1);
        target.stackCount = (target.stackCount ?? 1) + moved;
        inst.stackCount = (inst.stackCount ?? 1) - moved;
        if (inst.stackCount <= 0) {
          for (const s of Object.keys(state.equipped)) {
            if (state.equipped[s] === inst.id) delete state.equipped[s];
          }
          delete state.instances[inst.id];
          isPlaced = true;
        }
      } else if (canPlace(shape, gr, gc, drag.instanceId)) {
        inst.row = gr;
        inst.col = gc;
        inst.containerId = state.activeContainer ?? null;
        placeOnGrid(inst.id, shape, gr, gc);
        isPlaced = true;
      }
    }
  }

  // Restore the original position (also the leftover of a partial stack merge);
  // an item from the stash stays unplaced
  if (!isPlaced) {
    inst.row = drag.origRow;
    inst.col = drag.origCol;
    inst.rotation = drag.origRotation;
    if (inst.row !== null && inst.row !== undefined) {
      const restoreShape = getRotatedShape(template.shape, inst.rotation);
      placeOnGrid(inst.id, restoreShape, inst.row, inst.col);
    }
  }

  // Tear down
  state.mode = 'idle';
  state.dragging = null;
  dragHoverSlotId = null;
  setGhostVisibility(true);
  hideGhost();
  clearHighlights();
  document.querySelectorAll('.eq-card.drag-hover').forEach(c => c.classList.remove('drag-hover'));
  renderAllItems();
  updateWeightDisplay();
  scheduleSaveAndSync();
}

// The stack a dragged stack would pour into if dropped at (row, col): another
// stack of the same item with room left. A stackable shape is always [[1]], so
// the cell under the anchor is the whole footprint.
function _getStackMergeTarget(instanceId, row, col) {
  const inst = state.instances[instanceId];
  const template = inst && state.db[inst.templateId];
  if (!template || !isStackable(template)) return null;
  const targetId = getActiveGrid()[row]?.[col];
  if (!targetId || targetId === instanceId) return null;
  const target = state.instances[targetId];
  if (!target || target.templateId !== inst.templateId) return null;
  if ((target.stackCount ?? 1) >= getItemStackSize(template)) return null;
  return target;
}

// Convert a cursor position to the grid row/col of the shape's origin, given the
// anchor cell. Returns null when the cursor is outside the visible grid area.
function getGridPosAtCursor(clientX, clientY, anchorRow, anchorCol) {
  const scrollEl = document.getElementById('grid-scroll');
  const scrollRect = scrollEl.getBoundingClientRect();
  if (clientX < scrollRect.left || clientX > scrollRect.right ||
      clientY < scrollRect.top  || clientY > scrollRect.bottom) {
    return null;
  }
  const rect = gridEl.getBoundingClientRect();
  const col = Math.floor((clientX - rect.left) / CELL) - anchorCol;
  const row = Math.floor((clientY - rect.top)  / CELL) - anchorRow;
  return { row, col };
}

// ─── ROTATE (R KEY) AND CANCEL (ESCAPE) ──────────────────────────────────────
// Rotate the item being placed and redraw the ghost at the last pointer position.
function _rotatePlacingItem() {
  const placing = state.placing;
  placing.rotation = (placing.rotation + 1) % 4;
  ghostShapeKey = ''; // force a ghost rebuild on the next mousemove
  const template = state.db[placing.templateId];
  if (!template) return;
  const newShape = getRotatedShape(template.shape, placing.rotation);
  const pos = getGridPosAtCursor(lastPointerX, lastPointerY, 0, 0);
  // Outside the grid the ghost stays hidden; the next mousemove shows it
  if (!pos) return;
  const screenPos = getGhostScreenPos(0, 0, pos.row, pos.col);
  const isValid = canPlace(newShape, pos.row, pos.col);
  showGhost(newShape, template.rarity, screenPos.x, screenPos.y);
  moveGhost(screenPos.x, screenPos.y, isValid);
  highlightCells(newShape, pos.row, pos.col, isValid);
}

// Rotate the dragged item about its anchor cell and redraw ghost and highlights.
function _rotateDraggedItem() {
  const drag = state.dragging;
  const inst = state.instances[drag.instanceId];
  const template = state.db[inst.templateId];
  const { rows, cols } = getShapeDims(getRotatedShape(template.shape, inst.rotation));
  const { row: newAnchorRow, col: newAnchorCol } = getRotatedAnchorCW(drag.anchorRow, drag.anchorCol, rows, cols);
  drag.anchorRow = newAnchorRow;
  drag.anchorCol = newAnchorCol;
  inst.rotation = (inst.rotation + 1) % 4;

  // Rebuild the ghost at the current pointer position
  const newShape = getRotatedShape(template.shape, inst.rotation);
  ghostShapeKey = ''; // force a rebuild
  const ghostX = lastPointerX - drag.anchorCol * CELL;
  const ghostY = lastPointerY - drag.anchorRow * CELL;
  showGhost(newShape, template.rarity, ghostX, ghostY);

  // Update the grid highlights
  const pos = getGridPosAtCursor(lastPointerX, lastPointerY, drag.anchorRow, drag.anchorCol);
  if (pos) {
    const screenPos = getGhostScreenPos(0, 0, pos.row, pos.col);
    const isValid = canPlace(newShape, pos.row, pos.col, drag.instanceId);
    moveGhost(screenPos.x, screenPos.y, isValid);
    highlightCells(newShape, pos.row, pos.col, isValid);
  }
}

// Abort a drag and put the item back where it started.
function _cancelItemDrag() {
  const drag = state.dragging;
  const inst = state.instances[drag.instanceId];
  const template = state.db[inst.templateId];
  inst.rotation = drag.origRotation;
  const shape = getRotatedShape(template.shape, inst.rotation);
  placeOnGrid(inst.id, shape, drag.origRow, drag.origCol);
  inst.row = drag.origRow;
  inst.col = drag.origCol;
  document.removeEventListener('pointermove', _onDragMove);
  document.removeEventListener('pointerup', _onDragEnd);
  stopDragAutoScroll();
  state.mode = 'idle';
  state.dragging = null;
  hideGhost();
  clearHighlights();
  renderAllItems();
}

document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, select')) return;

  if (e.key === 'r' || e.key === 'R') {
    if (state.mode === 'placing') { _rotatePlacingItem(); return; }
    if (state.mode === 'dragging') { _rotateDraggedItem(); return; }
  }
});

registerEscapeLayer(ESCAPE_TIER.GESTURE, () => state.mode !== 'idle', () => {
  cancelPlacing();
  if (state.mode === 'dragging') _cancelItemDrag();
});
