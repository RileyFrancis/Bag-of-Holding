// =============================================================================
// INTERACTION-PLACING — PLACING mode: ghost follows cursor, click to drop
// =============================================================================
'use strict';

// ─── PLACING MODE ────────────────────────────────────────────────────────────
// Enter PLACING mode for a template: the ghost follows the cursor until a click
// drops a copy, a right-click or Escape cancels.
function startPlacing(templateId) {
  if (isReadOnly()) return;
  if (state.db[templateId]?.abstract) return; // a magic family's header — see items.js
  cancelPlacing();
  state.mode = 'placing';
  state.placing = { templateId, rotation: 0 };
  document.body.style.cursor = 'crosshair';
  document.body.style.userSelect = 'none';
  renderItemList();

  // Attach document-level handlers
  document.addEventListener('mousemove', _onPlacingMouseMove);
  document.addEventListener('click', _onPlacingClick, true);
  document.addEventListener('contextmenu', _onPlacingRightClick, true);
}

// Leave PLACING mode, if active, and remove its document handlers.
function cancelPlacing() {
  if (state.mode !== 'placing') return;
  state.mode = 'idle';
  state.placing = null;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  hideGhost();
  clearHighlights();
  document.removeEventListener('mousemove', _onPlacingMouseMove);
  document.removeEventListener('click', _onPlacingClick, true);
  document.removeEventListener('contextmenu', _onPlacingRightClick, true);
  renderItemList();
  renderStash();
}

// ─── STASH ───────────────────────────────────────────────────────────────────
// Add one unplaced instance of a template to the stash.
function addToStash(templateId) {
  if (isReadOnly()) return;
  const t = state.db[templateId];
  if (!t) return;
  const id = createInstanceId();
  state.instances[id] = { id, templateId, rotation: 0, row: null, col: null, stackCount: 1, containerId: state.activeContainer ?? null };
  renderStash();
  updateWeightDisplay();
  scheduleSaveAndSync();
}

// Move every item placed in the active grid into the stash.
function stashAllItems() {
  const activeContainerId = state.activeContainer;
  const placed = Object.values(state.instances).filter(i =>
    (i.containerId ?? null) === activeContainerId && i.row !== null && i.row !== undefined
  );
  if (!placed.length) return;
  placed.forEach(inst => {
    removeFromGrid(inst.id);
    inst.row = null;
    inst.col = null;
  });
  renderAllItems();
  updateWeightDisplay();
  scheduleSaveAndSync();
}

// Draw the stash: the unplaced items of the active grid, with their controls.
function renderStash() {
  const section = document.getElementById('stash-section');
  const list    = document.getElementById('stash-list');
  if (!section || !list) return;

  const activeContainerId = state.activeContainer;
  const unplaced = Object.values(state.instances).filter(i =>
    (i.containerId ?? null) === activeContainerId && (i.row === null || i.row === undefined)
  );
  const hasPlaced = Object.values(state.instances).some(i =>
    (i.containerId ?? null) === activeContainerId && i.row !== null && i.row !== undefined
  );

  // Shown while anything is unplaced, or placed (for the Stash All button)
  section.classList.toggle('hidden', unplaced.length === 0 && !hasPlaced);

  const countEl = document.getElementById('stash-count');
  countEl.textContent = unplaced.length;
  countEl.classList.toggle('hidden', unplaced.length === 0);

  document.getElementById('stash-all-btn').disabled = !hasPlaced;
  document.getElementById('stash-delete-all-btn').classList.toggle('hidden', unplaced.length === 0);

  list.innerHTML = '';
  unplaced.forEach(inst => {
    const t = state.db[inst.templateId];
    if (!t) return;
    const color = getRarityColor(t.rarity);

    const card = document.createElement('div');
    card.className = 'stash-card';
    card.title = 'Drag onto the grid to place · click for details';

    const shape = normalizeShape(isStackable(t) ? [[1]] : t.shape);
    const { rows, cols } = getShapeDims(shape);
    const preview = document.createElement('div');
    preview.className = 'stash-shape';
    preview.style.gridTemplateColumns = `repeat(${cols}, 10px)`;
    preview.style.gridTemplateRows    = `repeat(${rows}, 10px)`;
    shape.forEach(row => row.forEach(v => {
      const c = document.createElement('div');
      c.className = 'stash-cell' + (v ? ' filled' : '');
      if (v) c.style.background = color;
      preview.appendChild(c);
    }));

    const nameEl = document.createElement('span');
    nameEl.className = 'stash-name';
    nameEl.textContent = t.name + (inst.stackCount > 1 ? ` ×${inst.stackCount}` : '');

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-icon danger stash-remove';
    removeBtn.title = 'Remove';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', e => {
      e.stopPropagation();
      delete state.instances[inst.id];
      renderStash();
      updateWeightDisplay();
      scheduleSaveAndSync();
    });

    card.appendChild(preview);
    card.appendChild(nameEl);
    card.appendChild(removeBtn);
    card.addEventListener('pointerdown', e => {
      if (e.target === removeBtn || removeBtn.contains(e.target)) return;
      onStashPointerDown(e, inst.id);
    });
    card.addEventListener('click', e => {
      if (e.target === removeBtn || removeBtn.contains(e.target)) return;
      if (state.mode === 'idle') showInstanceDetails(inst.id);
    });
    list.appendChild(card);
  });
}

// ─── PLACING HANDLERS ────────────────────────────────────────────────────────
function _onPlacingMouseMove(e) {
  if (state.mode !== 'placing') return;
  const { templateId, rotation } = state.placing;
  const t = state.db[templateId];
  if (!t) return;

  const shape = getRotatedShape(t.shape, rotation);
  const dims  = getShapeDims(shape);
  initGhostEl(shape, t.rarity); // no-op if shape and rarity are unchanged

  const pos = getGridPosAtCursor(e.clientX, e.clientY, 0, 0);

  if (pos) {
    const { row: gr, col: gc } = pos;
    const screenPos = getGhostScreenPos(0, 0, gr, gc);
    const isValid = canPlace(shape, gr, gc);
    setGhostVisibility(true);
    moveGhost(screenPos.x, screenPos.y, isValid);
    highlightCells(shape, gr, gc, isValid);
  } else {
    setGhostVisibility(false);
    clearHighlights();
  }
}

function _onPlacingClick(e) {
  if (state.mode !== 'placing') return;
  const { templateId, rotation } = state.placing;
  const t = state.db[templateId];
  if (!t) { cancelPlacing(); return; }

  const pos = getGridPosAtCursor(e.clientX, e.clientY, 0, 0);
  if (!pos) { cancelPlacing(); return; }

  const shape = getRotatedShape(t.shape, rotation);
  if (!canPlace(shape, pos.row, pos.col)) return; // invalid: stay in placing mode

  e.stopPropagation();

  if (isStackable(t)) {
    openStackModal(getItemStackSize(t), count => finalizePlacement(t, shape, rotation, pos.row, pos.col, count));
    cancelPlacing();
  } else {
    finalizePlacement(t, shape, rotation, pos.row, pos.col, 1);
    // Stay in placing mode for quick multi-placement
  }
}

function _onPlacingRightClick(e) {
  e.preventDefault();
  e.stopPropagation();
  cancelPlacing();
}

// Create an instance of `template` at (row, col) on the active grid and redraw.
function finalizePlacement(template, shape, rotation, row, col, stackCount) {
  const id = createInstanceId();
  state.instances[id] = { id, templateId: template.id, rotation, row, col, stackCount, containerId: state.activeContainer ?? null };
  placeOnGrid(id, shape, row, col);
  // A newly placed container needs its own grid
  if (template.container && !state.containerGrids[id]) initContainerGrid(id);
  renderPlacedItem(state.instances[id]);
  updateGridFade();
  renderContainerTabs();
  renderStash();
  renderEquipPanel();
  updateWeightDisplay();
  scheduleSaveAndSync();
}
