// =============================================================================
// EQUIPMENT — Equipment slots, layout editor, equip/unequip
// =============================================================================
'use strict';

// Returns the slot id the instance is equipped in, or null.
function getEquippedSlot(instanceId) {
  return Object.entries(state.equipped).find(([, id]) => id === instanceId)?.[0] ?? null;
}

// Equips an instance into a slot, moving it out of any slot it already holds.
function equipItem(instanceId, slotId) {
  for (const s of Object.keys(state.equipped)) {
    if (state.equipped[s] === instanceId) delete state.equipped[s];
  }
  state.equipped[slotId] = instanceId;
  renderAllItems();
  scheduleSaveAndSync();
}

function _unequipSlot(slotId) {
  delete state.equipped[slotId];
  renderAllItems();
  scheduleSaveAndSync();
}

// Unequips an instance from whichever slot holds it, if any.
function unequipInstance(instanceId) {
  const slotId = getEquippedSlot(instanceId);
  if (slotId) _unequipSlot(slotId);
}

// Draws the equipment pane: slot cards, coin purse and the Configure Slots button.
function renderEquipPanel() {
  // The equipment pane, not the whole left panel — the Shop pane is its sibling.
  const panel = document.getElementById('left-pane-equip');
  if (!panel) return;
  panel.innerHTML = '';

  panel.appendChild(_buildEquipSlotsScroll());
  panel.appendChild(_buildCoinPurse());

  const footer = document.createElement('div');
  footer.id = 'equip-panel-footer';
  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'btn-sm';
  setIconLabel(settingsBtn, 'setting', 'Configure Slots');
  settingsBtn.addEventListener('click', _openEquipSettings);
  footer.appendChild(settingsBtn);
  panel.appendChild(footer);
}

function _buildEquipSlotCard(slot) {
  const instId = state.equipped[slot.id] ?? null;
  const inst   = instId ? state.instances[instId] : null;
  const t      = inst ? state.db[inst.templateId] : null;

  const card = document.createElement('div');
  card.className = 'eq-card' + (t ? ' filled' : '');
  card.dataset.slotId = slot.id;

  const labelEl = document.createElement('span');
  labelEl.className = 'eq-card-label';
  labelEl.textContent = slot.panelLabel || slot.label;

  const itemEl = document.createElement('span');
  itemEl.className = 'eq-card-item';
  itemEl.textContent = t ? t.name : '—';

  card.appendChild(labelEl);
  card.appendChild(itemEl);

  if (t && !isReadOnly()) {
    const unequipBtn = document.createElement('button');
    unequipBtn.className = 'eq-card-unequip';
    unequipBtn.textContent = '×';
    unequipBtn.title = 'Unequip';
    unequipBtn.addEventListener('click', e => { e.stopPropagation(); _unequipSlot(slot.id); });
    card.appendChild(unequipBtn);
  }

  if (inst) {
    card.addEventListener('pointerenter', e => startTooltipTimer(inst.id, e.clientX, e.clientY));
    card.addEventListener('pointerleave', clearTooltip);
  }

  if (!isReadOnly()) {
    card.addEventListener('click', () => _openSlotPicker(slot.id));
  }

  return card;
}

// Lays the visible slots out in sections; consecutive `inRow` slots share one row.
function _buildEquipSlotsScroll() {
  const scrollArea = document.createElement('div');
  scrollArea.id = 'equip-slots-scroll';

  let currentSection = null;
  let rowBuffer = [];

  function flushRowBuffer() {
    if (!rowBuffer.length) return;
    const rowDiv = document.createElement('div');
    rowDiv.className = 'eq-weapons-row';
    rowBuffer.forEach(card => rowDiv.appendChild(card));
    currentSection.appendChild(rowDiv);
    rowBuffer = [];
  }

  state.equipLayout.forEach(item => {
    if (item.type === 'header') {
      flushRowBuffer();
      currentSection = document.createElement('div');
      currentSection.className = 'eq-section';
      const hdr = document.createElement('div');
      hdr.className = 'eq-section-header';
      hdr.textContent = item.label;
      currentSection.appendChild(hdr);
      scrollArea.appendChild(currentSection);
    } else if (item.type === 'slot' && item.visible !== false) {
      if (!currentSection) {
        currentSection = document.createElement('div');
        currentSection.className = 'eq-section';
        scrollArea.appendChild(currentSection);
      }
      const card = _buildEquipSlotCard(item);
      if (item.inRow) {
        rowBuffer.push(card);
      } else {
        flushRowBuffer();
        currentSection.appendChild(card);
      }
    }
  });

  flushRowBuffer();
  return scrollArea;
}

function _buildCoinPurse() {
  const coinPurse = document.createElement('div');
  coinPurse.id = 'coin-purse';
  const cpHdr = document.createElement('div');
  cpHdr.className = 'coin-purse-header';
  cpHdr.textContent = 'Coin Purse';
  coinPurse.appendChild(cpHdr);
  const cpGrid = document.createElement('div');
  cpGrid.className = 'coin-purse-grid';
  const counts = getCoinCounts();
  const coinTemplates = getCoinTemplates();
  const coinDefs = ['pp', 'gp', 'ep', 'sp', 'cp'].map(denom => ({
    templateId: coinTemplates[denom],   // null if the CSV has no coin of this denomination
    label: denom.toUpperCase(),
    count: counts[denom],
    color: getCoinColor(denom),
  }));
  coinDefs.forEach(({ templateId, label, count, color }) => {
    const item = document.createElement('div');
    item.className = 'coin-item' + (count === 0 ? ' empty' : '');
    const lbl = document.createElement('span');
    lbl.className = 'coin-label';
    lbl.style.color = color;
    lbl.textContent = label;
    const cnt = document.createElement('span');
    cnt.className = 'coin-count';
    cnt.textContent = count.toLocaleString();
    item.appendChild(lbl);
    item.appendChild(cnt);
    // No template for this denomination — show the tally, offer no buttons.
    if (!isReadOnly() && templateId) {
      item.classList.add('clickable');
      const actions = document.createElement('div');
      actions.className = 'coin-actions';
      const addBtn = document.createElement('button');
      addBtn.className = 'coin-action-btn';
      addBtn.textContent = '+';
      addBtn.title = `Add ${label}`;
      addBtn.addEventListener('click', e => { e.stopPropagation(); openAddCoinsModal(templateId); });
      const remBtn = document.createElement('button');
      remBtn.className = 'coin-action-btn';
      remBtn.textContent = '−';
      remBtn.title = `Remove ${label}`;
      remBtn.disabled = count === 0;
      remBtn.addEventListener('click', e => { e.stopPropagation(); openRemoveCoinsModal(templateId); });
      actions.appendChild(remBtn);
      actions.appendChild(addBtn);
      item.appendChild(actions);
    }
    cpGrid.appendChild(item);
  });
  coinPurse.appendChild(cpGrid);
  return coinPurse;
}

// A symbol is either a glyph or, prefixed `icon:`, one of the img/icon set.
function _buildSettingsToggle(title, symbol, getter, setter) {
  const lbl = document.createElement('label');
  lbl.className = 'es-toggle';
  lbl.title = title;
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = getter();
  cb.addEventListener('change', () => setter(cb.checked));
  lbl.appendChild(cb);
  let sym;
  if (symbol.startsWith('icon:')) {
    sym = createIconEl(symbol.slice(5));
  } else {
    sym = document.createElement('span');
    sym.textContent = symbol;
  }
  lbl.appendChild(sym);
  return lbl;
}

// Opens the slot layout editor on a draft copy; Apply saves it to localStorage.
function _openEquipSettings() {
  let draft = JSON.parse(JSON.stringify(state.equipLayout));

  const list = document.getElementById('equip-settings-list');

  // Index of the row being dragged — tracked by position in `draft`, not by
  // element (the rows are rebuilt on every crossing).
  let dragIndex = null;

  function renderDraft() {
    list.innerHTML = '';

    draft.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'es-row' + (item.type === 'header' ? ' es-header-row' : '')
        + (idx === dragIndex ? ' es-dragging' : '');

      const grip = document.createElement('span');
      grip.className = 'es-grip';
      grip.title = 'Drag to reorder';
      grip.textContent = '⠿';
      grip.addEventListener('pointerdown', e => startRowDrag(e, idx));

      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.className = 'es-label-input';
      labelInput.value = item.label;
      labelInput.addEventListener('input', e => { draft[idx].label = e.target.value; });

      const delBtn = document.createElement('button');
      delBtn.className = 'btn-icon danger';
      delBtn.title = 'Remove';
      delBtn.textContent = '×';
      delBtn.addEventListener('click', () => { draft.splice(idx, 1); renderDraft(); });

      row.appendChild(grip);
      row.appendChild(labelInput);

      if (item.type === 'slot') {
        row.appendChild(_buildSettingsToggle('Show in panel', 'icon:show', () => item.visible !== false, v => { draft[idx].visible = v; }));
        row.appendChild(_buildSettingsToggle('Side-by-side', '⇔', () => !!item.inRow, v => { draft[idx].inRow = v; }));
        row.appendChild(_buildSettingsToggle('Attunement only', '✦', () => !!item.attuneOnly, v => { draft[idx].attuneOnly = v; }));
      }

      row.appendChild(delBtn);
      list.appendChild(row);
    });
  }

  // The move/up listeners live on the document, not the grip — re-rendering
  // destroys the element the drag started on.
  function startRowDrag(e, idx) {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection, and the label input keeps its focus
    dragIndex = idx;
    document.body.style.userSelect = 'none';
    renderDraft();

    const onMove = me => {
      // Reorder as the cursor passes another row's midpoint.
      const rows = [...list.querySelectorAll('.es-row')];
      let target = rows.findIndex(r => {
        const b = r.getBoundingClientRect();
        return me.clientY < b.top + b.height / 2;
      });
      if (target === -1) target = rows.length - 1;

      // Dragging against either end of a scrolled list pulls it along.
      const box = list.getBoundingClientRect();
      if (me.clientY < box.top + 24)         list.scrollTop -= 8;
      else if (me.clientY > box.bottom - 24) list.scrollTop += 8;

      if (target === dragIndex) return;
      const [moved] = draft.splice(dragIndex, 1);
      draft.splice(target, 0, moved);
      dragIndex = target;
      renderDraft();
    };

    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      dragIndex = null;
      renderDraft();
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  renderDraft();

  // New rows land at the bottom — scroll down so the one just added is on screen.
  function addRow(item) {
    draft.push(item);
    renderDraft();
    list.scrollTop = list.scrollHeight;
  }

  document.getElementById('es-add-header-btn').onclick = () =>
    addRow({ type: 'header', label: 'New Section' });

  document.getElementById('es-add-slot-btn').onclick = () =>
    addRow({ type: 'slot', id: 'slot_' + Math.random().toString(36).slice(2, 6), label: 'New Slot', panelLabel: '', attuneOnly: false, inRow: false, visible: true });

  document.getElementById('es-reset-btn').onclick = () => { draft = getDefaultEquipLayout(); renderDraft(); };

  document.getElementById('equip-settings-apply-btn').onclick = () => {
    state.equipLayout = draft;
    _saveSlotConfig();
    renderEquipPanel();
    hideModal('equip-settings-modal');
  };

  showModal('equip-settings-modal');
}

function _saveSlotConfig() {
  localStorage.setItem('dnd_slot_config', JSON.stringify(state.equipLayout));
}

// Restores the slot layout from localStorage, falling back to the default layout.
function loadSlotConfig() {
  if (state.equipLayout.length) return; // already restored by autoLoad
  try {
    const raw = localStorage.getItem('dnd_slot_config');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.type) {
        state.equipLayout = parsed;
      } else if (Array.isArray(parsed)) {
        // Legacy shape: a list of hidden slot ids.
        const layout = getDefaultEquipLayout();
        parsed.forEach(id => {
          const s = layout.find(item => item.type === 'slot' && item.id === id);
          if (s) s.visible = false;
        });
        state.equipLayout = layout;
      }
    }
  } catch {}
  if (!state.equipLayout.length) state.equipLayout = getDefaultEquipLayout();
}

// Opens the slot chooser for an item (the context menu's "Equip…").
function openEquipModal(instanceId) {
  const inst = state.instances[instanceId];
  const t    = inst ? state.db[inst.templateId] : null;

  document.getElementById('equip-modal').querySelector('h2').textContent = 'Equip to Slot';

  const picker = document.getElementById('equip-slot-picker');
  picker.innerHTML = '';

  const eligibleSlots = state.equipLayout.filter(item =>
    item.type === 'slot' && item.visible !== false && !(item.attuneOnly && !t?.attunement)
  );

  eligibleSlots.forEach(slot => {
    const occupantId   = state.equipped[slot.id];
    const occupantInst = occupantId ? state.instances[occupantId] : null;
    const occupantName = occupantInst ? state.db[occupantInst.templateId]?.name : null;

    const btn = document.createElement('button');
    btn.className = 'btn-sm equip-slot-pick-btn';
    btn.textContent = slot.label + (occupantName ? ` (${occupantName})` : '');
    btn.addEventListener('click', () => { equipItem(instanceId, slot.id); hideModal('equip-modal'); });
    picker.appendChild(btn);
  });

  showModal('equip-modal');
}

// Opens the item chooser for a slot clicked in the equip panel.
function _openSlotPicker(slotId) {
  clearTooltip();
  const slot = getSlotDef(slotId);
  if (!slot) return;

  document.getElementById('equip-modal').querySelector('h2').textContent = slot.label;

  const picker = document.getElementById('equip-slot-picker');
  picker.innerHTML = '';

  const currentId = state.equipped[slotId];
  if (currentId) {
    const unequipBtn = document.createElement('button');
    unequipBtn.className = 'btn-sm equip-slot-pick-btn danger';
    unequipBtn.textContent = 'Unequip';
    unequipBtn.addEventListener('click', () => { _unequipSlot(slotId); hideModal('equip-modal'); });
    picker.appendChild(unequipBtn);
  }

  const candidates = Object.values(state.instances).filter(inst => {
    const tmpl = state.db[inst.templateId];
    if (!tmpl) return false;
    if (slot.attuneOnly && !tmpl.attunement) return false;
    return true;
  });

  if (candidates.length === 0) {
    const msg = document.createElement('p');
    msg.className = 'modal-note';
    msg.textContent = slot.attuneOnly
      ? 'No items requiring attunement in your inventory.'
      : 'No items in your inventory.';
    picker.appendChild(msg);
  } else {
    candidates.forEach(inst => {
      const tmpl         = state.db[inst.templateId];
      const alreadyHere  = state.equipped[slotId] === inst.id;
      const btn = document.createElement('button');
      btn.className = 'btn-sm equip-slot-pick-btn' + (alreadyHere ? ' active' : '');
      btn.textContent = tmpl.name
        + (inst.stackCount > 1 ? ` ×${inst.stackCount}` : '')
        + (alreadyHere ? ' (equipped)' : '');
      btn.addEventListener('click', () => { equipItem(inst.id, slotId); hideModal('equip-modal'); });
      picker.appendChild(btn);
    });
  }

  showModal('equip-modal');
}
