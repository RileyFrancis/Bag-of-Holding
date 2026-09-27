// =============================================================================
// STATUSES — the conditions a character is under, and the sheet section
// =============================================================================
'use strict';

// A registry over `data/statuses.json` (content, not code, like classes.json)
// and a section that draws it as chips. Two kinds of status:
//
//   picked   — `character.statuses`, an id list the player edits from the
//              picker. Saved and synced like any other sheet field.
//   derived  — `derived:` in the data file; worked out on every render from a
//              fact the app already knows (today only encumbrance, via
//              `encumbranceLevel()` in render-stats.js). Never saved and never
//              offered in the picker — a stored copy would go stale the moment
//              an item moved.
//
// Hovering a chip shows the item tooltip's card (tooltip.js), same delay.

// =============================================================================
// LOADING THE STATUSES
// =============================================================================
let DEFAULT_STATUSES = [];

function loadDefaultStatuses() {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'data/statuses.json', false); // synchronous, like classes.json
    xhr.send();
    if (xhr.status !== 200) throw new Error(`HTTP ${xhr.status}`);
    // A host answering unknown paths with its index page — the same guard as
    // species-traits.js.
    const body = xhr.responseText.trim();
    if (body.startsWith('<')) throw new Error('not JSON');
    DEFAULT_STATUSES = sanitizeStatusList(JSON.parse(body).statuses);
  } catch (e) {
    DEFAULT_STATUSES = []; // not fatal — the section just has nothing to offer
  }
}

function sanitizeStatusList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(s => {
    const id = String(s?.id ?? '').trim();
    const name = String(s?.name ?? '').trim();
    if (!id || !name) return null;
    return {
      id, name,
      derived: s.derived ? String(s.derived) : null,
      description: normalizeDescription(s.description), // class-features.js
    };
  }).filter(Boolean);
}

loadDefaultStatuses();

function statusById(id) {
  return DEFAULT_STATUSES.find(s => s.id === id) ?? null;
}

function pickableStatuses() {
  return DEFAULT_STATUSES.filter(s => !s.derived);
}

// Only the heavier of the two — Heavily Encumbered already says Encumbered.
function derivedStatusIds() {
  const level = encumbranceLevel();
  const key = level >= 2 ? 'heavilyEncumbered' : level >= 1 ? 'encumbered' : null;
  return key ? DEFAULT_STATUSES.filter(s => s.derived === key).map(s => s.id) : [];
}

// A picked id the data file no longer knows is kept in the save but not drawn —
// the same "filtered, not deleted" rule as knownSpells.
function pickedStatusIds(c = state.character) {
  return (Array.isArray(c.statuses) ? c.statuses : [])
    .filter(id => { const s = statusById(id); return s && !s.derived; });
}

// =============================================================================
// THE SECTION
// =============================================================================
const statusListEl   = document.getElementById('sheet-statuses');
const statusAddBtn   = document.getElementById('status-add-btn');
const statusPickerEl = document.getElementById('status-picker');

// renderCharacterSheet() runs on every keystroke and roster sync; rebuilding the
// chips each time would also orphan an open tooltip (its chip gone, no
// pointerleave ever coming), so only a real change redraws.
let statusSignature = null;

function renderStatuses() {
  const readOnly = isReadOnly();
  statusAddBtn.classList.toggle('hidden', readOnly);
  if (readOnly) closeStatusPicker();

  const derived = derivedStatusIds();
  const picked  = pickedStatusIds();
  const sig = JSON.stringify([derived, picked, readOnly]);
  if (sig === statusSignature) return;
  statusSignature = sig;

  clearTooltip();
  statusListEl.innerHTML = '';

  if (!derived.length && !picked.length) {
    const none = document.createElement('p');
    none.className = 'feature-note';
    none.textContent = 'No statuses.';
    statusListEl.appendChild(none);
  }

  derived.forEach(id => statusListEl.appendChild(statusChip(statusById(id), { derived: true })));
  picked.forEach(id => statusListEl.appendChild(statusChip(statusById(id), { removable: !readOnly })));

  if (statusPickerIsOpen()) renderStatusPicker();
}

function statusChip(status, { derived = false, removable = false } = {}) {
  const chip = document.createElement('span');
  chip.className = 'status-chip' + (derived ? ' derived' : '');
  chip.dataset.status = status.id;

  const name = document.createElement('span');
  name.className = 'status-chip-name';
  name.textContent = status.name;
  chip.appendChild(name);

  if (removable) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'status-chip-remove';
    x.title = `Remove ${status.name}`;
    x.textContent = '×';
    x.addEventListener('click', () => toggleStatus(status.id));
    chip.appendChild(x);
  }

  chip.addEventListener('pointerenter', e => {
    const { clientX: x, clientY: y } = e;
    startTooltipTimerWith(() => showStatusTooltip(status, x, y, derived));
  });
  chip.addEventListener('pointerleave', clearTooltip);
  return chip;
}

// The item tooltip's card, with a status's fields.
function showStatusTooltip(status, x, y, derived) {
  const el = document.getElementById('item-tooltip');
  el.innerHTML = `
    <div class="tip-header">
      <span class="tip-name"></span>
      <span class="tip-rarity"></span>
    </div>
    <div class="tip-desc"></div>
  `;
  el.querySelector('.tip-name').textContent = status.name;
  el.querySelector('.tip-rarity').textContent = derived ? 'From inventory' : 'Status';
  renderMarkdownInto(el.querySelector('.tip-desc'), status.description);
  showTooltipAt(el, x, y);
}

function toggleStatus(id) {
  if (isReadOnly()) return;
  const picked = pickedStatusIds();
  state.character.statuses = picked.includes(id)
    ? picked.filter(p => p !== id)
    : [...picked, id];
  commitSheetEdit('statuses'); // re-renders the sheet, and so this section
}

// =============================================================================
// THE PICKER
// =============================================================================
// Stays open across picks, so several can be added in one go; a click outside,
// Escape, or a scroll closes it.
function statusPickerIsOpen() {
  return !statusPickerEl.classList.contains('hidden');
}

function openStatusPicker() {
  if (isReadOnly()) return;
  clearTooltip();
  renderStatusPicker();
  statusPickerEl.classList.remove('hidden');
  statusAddBtn.setAttribute('aria-expanded', 'true');

  // Under the button, right edges aligned, kept inside the window.
  const r = statusAddBtn.getBoundingClientRect();
  const pad = 8;
  const w = statusPickerEl.offsetWidth;
  const h = statusPickerEl.offsetHeight;
  const left = Math.max(pad, Math.min(r.right - w, window.innerWidth - w - pad));
  let top = r.bottom + 4;
  if (top + h > window.innerHeight - pad) top = Math.max(pad, r.top - h - 4);
  statusPickerEl.style.left = left + 'px';
  statusPickerEl.style.top  = top + 'px';
}

function closeStatusPicker() {
  if (!statusPickerIsOpen()) return;
  statusPickerEl.classList.add('hidden');
  statusAddBtn.setAttribute('aria-expanded', 'false');
}

// Every pickable status with its description, the active ones ticked.
function renderStatusPicker() {
  const picked = pickedStatusIds();
  statusPickerEl.innerHTML = '';

  if (!pickableStatuses().length) {
    const none = document.createElement('p');
    none.className = 'feature-note';
    none.textContent = 'No statuses loaded (data/statuses.json).';
    statusPickerEl.appendChild(none);
    return;
  }

  pickableStatuses().forEach(s => {
    const on = picked.includes(s.id);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'status-option' + (on ? ' active' : '');
    row.setAttribute('role', 'menuitemcheckbox');
    row.setAttribute('aria-checked', String(on));

    const head = document.createElement('span');
    head.className = 'status-option-head';
    const tick = document.createElement('span');
    tick.className = 'status-option-tick';
    tick.textContent = on ? '✓' : '';
    const name = document.createElement('span');
    name.className = 'status-option-name';
    name.textContent = s.name;
    head.append(tick, name);

    const desc = document.createElement('span');
    desc.className = 'status-option-desc tip-desc';
    renderMarkdownInto(desc, s.description);

    row.append(head, desc);
    row.addEventListener('click', () => toggleStatus(s.id));
    statusPickerEl.appendChild(row);
  });
}

// =============================================================================
// WIRING
// =============================================================================
statusAddBtn.addEventListener('click', () => {
  if (statusPickerIsOpen()) closeStatusPicker();
  else openStatusPicker();
});

document.addEventListener('pointerdown', e => {
  if (!statusPickerIsOpen()) return;
  if (statusPickerEl.contains(e.target) || statusAddBtn.contains(e.target)) return;
  closeStatusPicker();
});

// Any key, not just Escape: C/I/S switch the view out from under the picker.
document.addEventListener('keydown', closeStatusPicker);

// Fixed-position, so a scroll of the sheet under it would leave it floating
// away from its button.
document.addEventListener('scroll', e => {
  if (statusPickerIsOpen() && !statusPickerEl.contains(e.target)) closeStatusPicker();
}, { capture: true });
window.addEventListener('resize', closeStatusPicker);
