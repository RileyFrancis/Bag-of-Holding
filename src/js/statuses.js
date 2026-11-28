// =============================================================================
// STATUSES — the conditions a character is under, and the sheet section
// =============================================================================
'use strict';

// A registry over `data/statuses.json` (content, not code, like classes.json)
// and a section that draws it as chips. Two kinds of status:
//
//   picked   — `character.statuses`, an id list the player edits from the
//              picker. Saved and synced like any other sheet field. A status
//              with `maxLevel` (Exhaustion) stacks: each extra level is the id
//              repeated, so picking it again is just adding another instance —
//              ['exhaustion','exhaustion'] is Exhaustion 2.
//   derived  — `derived:` in the data file; worked out on every render from a
//              fact the app already knows (encumbrance, via `getEncumbranceLevel()`
//              in render-stats.js). Never saved and never offered in the picker:
//              a stored copy would go stale the moment an item moved.
//
// Hovering a chip shows the item tooltip's card (tooltip.js), same delay.

// ─── LOADING THE STATUSES ───
let DEFAULT_STATUSES = [];

function _loadDefaultStatuses() {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'data/statuses.json', false); // synchronous, like classes.json
    xhr.send();
    if (xhr.status !== 200) throw new Error(`HTTP ${xhr.status}`);
    // A host answering unknown paths with its index page — the same guard as
    // species-traits.js.
    const body = xhr.responseText.trim();
    if (body.startsWith('<')) throw new Error('not JSON');
    DEFAULT_STATUSES = _sanitizeStatusList(JSON.parse(body).statuses);
  } catch (e) {
    DEFAULT_STATUSES = []; // not fatal — the section just has nothing to offer
  }
}

function _sanitizeStatusList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(s => {
    const id = String(s?.id ?? '').trim();
    const name = String(s?.name ?? '').trim();
    if (!id || !name) return null;
    return {
      id, name,
      derived: s.derived ? String(s.derived) : null,
      maxLevel: Math.max(1, Math.min(99, parseInt(s.maxLevel, 10) || 1)),
      description: normalizeDescription(s.description), // class-features.js
    };
  }).filter(Boolean);
}

_loadDefaultStatuses();

// The status with this id, or null.
function getStatusById(id) {
  return DEFAULT_STATUSES.find(s => s.id === id) ?? null;
}

function _getPickableStatuses() {
  return DEFAULT_STATUSES.filter(s => !s.derived);
}

// Only the heavier of the two — Heavily Encumbered already says Encumbered.
function _getDerivedStatusIds() {
  const level = getEncumbranceLevel();
  const key = level >= 2 ? 'heavilyEncumbered' : level >= 1 ? 'encumbered' : null;
  return key ? DEFAULT_STATUSES.filter(s => s.derived === key).map(s => s.id) : [];
}

// Each picked status once, in the order first picked. An id the data file doesn't
// know is kept in the save but not drawn (filtered, not deleted).
function _getPickedStatusIds(c = state.character) {
  const raw = Array.isArray(c.statuses) ? c.statuses : [];
  return [...new Set(raw)].filter(id => { const s = getStatusById(id); return s && !s.derived; });
}

function _isLeveledStatus(status) {
  return status.maxLevel > 1;
}

// How many times the id is in the list, capped at the status's own maximum.
function _getStatusLevel(id, c = state.character) {
  const s = getStatusById(id);
  if (!s) return 0;
  const n = (Array.isArray(c.statuses) ? c.statuses : []).filter(x => x === id).length;
  return Math.min(n, s.maxLevel);
}

// ─── THE SECTION ───
const statusListEl   = document.getElementById('sheet-statuses');
const statusAddBtn   = document.getElementById('status-add-btn');
const statusPickerEl = document.getElementById('status-picker');

// renderCharacterSheet() runs on every keystroke and roster sync; rebuilding the
// chips each time would also orphan an open tooltip (its chip gone, no
// pointerleave ever coming), so only a real change redraws.
let statusSignature = null;

// Redraws the status chips, only when what they show has changed.
function renderStatuses() {
  const readOnly = isReadOnly();
  statusAddBtn.classList.toggle('hidden', readOnly);
  if (readOnly) _closeStatusPicker();

  const derived = _getDerivedStatusIds();
  const picked  = _getPickedStatusIds();
  const sig = JSON.stringify([derived, picked.map(id => [id, _getStatusLevel(id)]), readOnly]);
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

  derived.forEach(id => statusListEl.appendChild(_createStatusChip(getStatusById(id), { derived: true })));
  picked.forEach(id => statusListEl.appendChild(_createStatusChip(getStatusById(id), { removable: !readOnly })));

  if (isStatusPickerOpen()) _renderStatusPicker();
}

function _createStatusChip(status, { derived = false, removable = false } = {}) {
  const chip = document.createElement('span');
  chip.className = 'status-chip' + (derived ? ' derived' : '');
  chip.dataset.status = status.id;

  const name = document.createElement('span');
  name.className = 'status-chip-name';
  name.textContent = status.name;
  chip.appendChild(name);

  const level = derived ? 0 : _getStatusLevel(status.id);
  if (_isLeveledStatus(status) && level) {
    const lv = document.createElement('span');
    lv.className = 'status-chip-level';
    lv.textContent = level;
    chip.appendChild(lv);
  }

  // Takes one level off a stacking status, the whole status otherwise.
  if (removable) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'status-chip-remove';
    x.title = _isLeveledStatus(status) && level > 1
      ? `Remove a level of ${status.name}`
      : `Remove ${status.name}`;
    x.textContent = '×';
    x.addEventListener('click', () => _removeStatusLevel(status.id));
    chip.appendChild(x);
  }

  chip.addEventListener('pointerenter', e => {
    const { clientX: x, clientY: y } = e;
    startTooltipTimerWith(() => _showStatusTooltip(status, x, y, derived));
  });
  chip.addEventListener('pointerleave', clearTooltip);
  return chip;
}

// The item tooltip's card, with a status's fields.
function _showStatusTooltip(status, x, y, derived) {
  const el = document.getElementById('item-tooltip');
  el.innerHTML = `
    <div class="tip-header">
      <span class="tip-name"></span>
      <span class="tip-rarity"></span>
    </div>
    <div class="tip-desc"></div>
  `;
  el.querySelector('.tip-name').textContent = status.name;
  el.querySelector('.tip-rarity').textContent = derived ? 'From inventory'
    : _isLeveledStatus(status) ? `Level ${_getStatusLevel(status.id)} of ${status.maxLevel}`
    : 'Status';
  renderMarkdownInto(el.querySelector('.tip-desc'), status.description);
  showTooltipAt(el, x, y);
}

// Every edit rewrites the list whole from what is drawn, which also drops any
// unknown id or over-cap repeat a save may carry.
function _writeStatuses(levels) {
  state.character.statuses = levels.flatMap(([id, n]) => Array(n).fill(id));
  commitSheetEdit('statuses'); // re-renders the sheet, and so this section
}

function _getCurrentStatusLevels() {
  return _getPickedStatusIds().map(id => [id, _getStatusLevel(id)]);
}

// One more instance: a new status, or the next level of a stacking one.
function _addStatus(id) {
  const s = getStatusById(id);
  if (isReadOnly() || !s || s.derived) return;
  const levels = _getCurrentStatusLevels();
  const entry = levels.find(([x]) => x === id);
  if (!entry) levels.push([id, 1]);
  else if (entry[1] < s.maxLevel) entry[1]++;
  else return;
  _writeStatuses(levels);
}

function _removeStatusLevel(id) {
  if (isReadOnly()) return;
  const levels = _getCurrentStatusLevels()
    .map(([x, n]) => [x, x === id ? n - 1 : n])
    .filter(([, n]) => n > 0);
  _writeStatuses(levels);
}

function _removeStatus(id) {
  if (isReadOnly()) return;
  _writeStatuses(_getCurrentStatusLevels().filter(([x]) => x !== id));
}

// ─── THE PICKER ───
// Stays open across picks, so several can be added in one go; a click outside,
// a key, or a scroll closes it.

// Whether the status picker is showing.
function isStatusPickerOpen() {
  return !statusPickerEl.classList.contains('hidden');
}

function _openStatusPicker() {
  if (isReadOnly()) return;
  clearTooltip();
  _renderStatusPicker();
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

function _closeStatusPicker() {
  if (!isStatusPickerOpen()) return;
  statusPickerEl.classList.add('hidden');
  statusAddBtn.setAttribute('aria-expanded', 'false');
}

// Every pickable status with its description, the active ones ticked. A
// stacking status is never un-ticked from here — another click is another
// level, up to its maximum; the chip's × takes levels back off.
function _renderStatusPicker() {
  const picked = _getPickedStatusIds();
  statusPickerEl.innerHTML = '';

  if (!_getPickableStatuses().length) {
    const none = document.createElement('p');
    none.className = 'feature-note';
    none.textContent = 'No statuses loaded (data/statuses.json).';
    statusPickerEl.appendChild(none);
    return;
  }

  _getPickableStatuses().forEach(s => {
    const isPicked = picked.includes(s.id);
    const isLeveled = _isLeveledStatus(s);
    const level = _getStatusLevel(s.id);
    const isMaxed = isLeveled && level >= s.maxLevel;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'status-option' + (isPicked ? ' active' : '') + (isMaxed ? ' maxed' : '');
    row.setAttribute('role', isLeveled ? 'menuitem' : 'menuitemcheckbox');
    if (!isLeveled) row.setAttribute('aria-checked', String(isPicked));
    row.title = !isLeveled ? '' : isMaxed ? `At its maximum, level ${s.maxLevel}`
              : isPicked ? `Add a level (now ${level} of ${s.maxLevel})` : 'Add at level 1';

    const head = document.createElement('span');
    head.className = 'status-option-head';
    const tick = document.createElement('span');
    tick.className = 'status-option-tick';
    tick.textContent = isPicked ? '✓' : '';
    const name = document.createElement('span');
    name.className = 'status-option-name';
    name.textContent = s.name;
    head.append(tick, name);
    if (isLeveled) {
      const lv = document.createElement('span');
      lv.className = 'status-option-level';
      lv.textContent = isPicked ? `Level ${level} / ${s.maxLevel}` : `Up to level ${s.maxLevel}`;
      head.appendChild(lv);
    }

    const desc = document.createElement('span');
    desc.className = 'status-option-desc tip-desc';
    renderMarkdownInto(desc, s.description);

    row.append(head, desc);
    row.addEventListener('click', () => {
      if (isLeveled) _addStatus(s.id);
      else if (isPicked) _removeStatus(s.id);
      else _addStatus(s.id);
    });
    statusPickerEl.appendChild(row);
  });
}

// ─── WIRING ───
statusAddBtn.addEventListener('click', () => {
  if (isStatusPickerOpen()) _closeStatusPicker();
  else _openStatusPicker();
});

document.addEventListener('pointerdown', e => {
  if (!isStatusPickerOpen()) return;
  if (statusPickerEl.contains(e.target) || statusAddBtn.contains(e.target)) return;
  _closeStatusPicker();
});

// Any key, not just Escape: C/I/S switch the view out from under the picker.
document.addEventListener('keydown', _closeStatusPicker);
registerEscapeLayer(ESCAPE_TIER.POPUP, isStatusPickerOpen, _closeStatusPicker);

// Fixed-position, so a scroll of the sheet under it would leave it floating
// away from its button.
document.addEventListener('scroll', e => {
  if (isStatusPickerOpen() && !statusPickerEl.contains(e.target)) _closeStatusPicker();
}, { capture: true });
window.addEventListener('resize', _closeStatusPicker);
