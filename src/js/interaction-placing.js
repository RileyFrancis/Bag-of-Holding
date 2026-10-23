// =============================================================================
// INTERACTION-PLACING — PLACING mode: ghost follows cursor, click to drop
// =============================================================================
'use strict';

function startPlacing(templateId) {
  if (isReadOnly()) return;
  if (state.db[templateId]?.abstract) return; // a magic family's header — see items.js
  cancelPlacing();
  state.mode = 'placing';
  state.placing = { templateId, rotation: 0 };
  document.body.style.cursor = 'crosshair';
  document.body.style.userSelect = 'none';
  renderItemList();
  showTemplateDetails(templateId);

  // Attach document-level handlers
  document.addEventListener('mousemove', onPlacingMouseMove);
  document.addEventListener('click', onPlacingClick, true);
  document.addEventListener('contextmenu', onPlacingRightClick, true);
}

function cancelPlacing() {
  if (state.mode !== 'placing') return;
  state.mode = 'idle';
  state.placing = null;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  hideGhost();
  clearHighlights();
  document.removeEventListener('mousemove', onPlacingMouseMove);
  document.removeEventListener('click', onPlacingClick, true);
  document.removeEventListener('contextmenu', onPlacingRightClick, true);
  renderItemList();
  renderStash();
}

function addToStash(templateId) {
  if (isReadOnly()) return;
  const t = state.db[templateId];
  if (!t) return;
  const id = newId();
  state.instances[id] = { id, templateId, rotation: 0, row: null, col: null, stackCount: 1, containerId: state.activeContainer ?? null };
  renderStash();
  updateWeightDisplay();
  debouncedSync();
}

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
  debouncedSync();
}

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

  // Always show when there are unplaced items; also show when there are placed items (for Stash All button)
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
    const color = rarityColor(t.rarity);

    const card = document.createElement('div');
    card.className = 'stash-card';
    card.title = 'Drag onto the grid to place · click for details';

    const shape = normalizeShape(isStackable(t) ? [[1]] : t.shape);
    const { rows, cols } = shapeDims(shape);
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
      debouncedSync();
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

function onPlacingMouseMove(e) {
  if (state.mode !== 'placing') return;
  const { templateId, rotation } = state.placing;
  const t = state.db[templateId];
  if (!t) return;

  const shape = getRotatedShape(t.shape, rotation);
  const dims  = shapeDims(shape);
  initGhostEl(shape, t.rarity); // No-op if shape/rarity unchanged

  const pos = cursorToGridPos(e.clientX, e.clientY, 0, 0);

  if (pos) {
    const { row: gr, col: gc } = pos;
    const screenPos = getGhostScreenPos(0, 0, gr, gc);
    const valid = canPlace(shape, gr, gc);
    setGhostVisibility(true);
    moveGhost(screenPos.x, screenPos.y, valid);
    highlightCells(shape, gr, gc, valid);
  } else {
    setGhostVisibility(false);
    clearHighlights();
  }
}

function onPlacingClick(e) {
  if (state.mode !== 'placing') return;
  const { templateId, rotation } = state.placing;
  const t = state.db[templateId];
  if (!t) { cancelPlacing(); return; }

  const pos = cursorToGridPos(e.clientX, e.clientY, 0, 0);
  if (!pos) { cancelPlacing(); return; }

  const shape = getRotatedShape(t.shape, rotation);
  if (!canPlace(shape, pos.row, pos.col)) return; // Invalid — stay in placing mode

  e.stopPropagation();

  if (isStackable(t)) {
    openStackModal(stackSizeOf(t), count => finalizePlacement(t, shape, rotation, pos.row, pos.col, count));
    cancelPlacing();
  } else {
    finalizePlacement(t, shape, rotation, pos.row, pos.col, 1);
    // Stay in placing mode for quick multi-placement
  }
}

function onPlacingRightClick(e) {
  e.preventDefault();
  e.stopPropagation();
  cancelPlacing();
}

function finalizePlacement(template, shape, rotation, row, col, stackCount) {
  const id = newId();
  state.instances[id] = { id, templateId: template.id, rotation, row, col, stackCount, containerId: state.activeContainer ?? null };
  placeOnGrid(id, shape, row, col);
  // Initialize container grid for newly placed container items
  if (template.container && !state.containerGrids[id]) initContainerGrid(id);
  renderPlacedItem(state.instances[id]);
  updateGridFade();
  renderContainerTabs();
  renderStash();
  renderEquipPanel();
  updateWeightDisplay();
  debouncedSync();
}
