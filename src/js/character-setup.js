// =============================================================================
// CHARACTER SETUP — the modal that edits what a character *is*
// =============================================================================
'use strict';

// One dialog, three jobs: the sheet's gear, a roster card's Edit, New Character.
// It edits what describes a character — name, species, background, alignment, and
// the classes they have taken levels in — never what the sheet owns (ability
// scores, which all start at 10). `charModalTargetId` names the roster slot to
// edit; null means the character on screen, which is not always one of yours (a
// GM editing a player via the gear).

let charModalTargetId = null;
let charModalIsNew = false;

// A working copy of the class rows, written to the character only on Save
// (Cancel has to mean something, and the target may not be the character on
// screen).
let charModalClasses = [];

const charClassRowsEl = document.getElementById('char-class-rows');
const charLevelFieldEl = document.getElementById('char-level-field');
const charTotalLevelEl = document.getElementById('char-total-level');
const charClassDuplicateMsgEl = document.getElementById('char-class-duplicate-msg');
const saveCharBtnEl = document.getElementById('save-char-btn');
const charModalBoxEl = document.querySelector('#character-modal .modal-box');
const charPickerEl = document.getElementById('char-picker');
const charPickerListEl = document.getElementById('char-picker-list');

const CHAR_PICKER_WIDTH = 200;  // px, matches .char-picker in character-setup.css
const CHAR_PICKER_GAP = 14;     // px between the picker and the dialog
const CHAR_PICKER_MARGIN = 8;   // px kept clear of the viewport edge
const CHAR_PICKER_FADE = 32;    // px of fade at an edge options have scrolled past

// The `data-options` field the picker serves (null when closed), the highlighted
// row (-1 for none), and whether a pick is writing to the field right now.
let charPickerInput = null;
let charPickerActiveIndex = -1;
let isCharPickerSelecting = false;

// ─── OPENING AND SAVING ───
// Opens Character Setup for a roster slot, the character on screen (null), or a new character.
function openCharModal(targetId = null, { isNew = false } = {}) {
  _closeCharPicker();
  charModalIsNew = isNew;
  charModalTargetId = isNew ? null : targetId;

  const c = charModalIsNew
    ? createBlankCharacterMeta('')
    : (charModalTargetId ? state.characters[charModalTargetId]?.character : null) ?? state.character;

  document.getElementById('character-modal-title').textContent =
    charModalIsNew ? 'New Character' : 'Character Setup';
  document.getElementById('char-name-input').value       = charModalIsNew ? '' : c.name;
  document.getElementById('char-race-input').value       = c.race ?? '';
  document.getElementById('char-background-input').value = c.background ?? '';
  document.getElementById('char-alignment-input').value  = c.alignment ?? '';
  document.getElementById('char-level-input').value      = c.level ?? 1;
  document.getElementById('char-spells-input').checked   = isSpellSheetEnabled(c);
  document.getElementById('save-char-btn').textContent   = charModalIsNew ? 'Create' : 'Save';

  // A copy, not the character's own array — nothing here may reach the model
  // before Save.
  charModalClasses = getClassEntries(c).map(e => ({ ...e }));

  // Hints, refreshed on open rather than once at load: custom classes and
  // species will arrive through the registries, and this is where they show up.
  fillDatalist(document.getElementById('class-options'), getAllClasses().map(d => d.name));
  fillDatalist(document.getElementById('species-options'), getAllSpecies().map(d => d.name));
  fillDatalist(document.getElementById('background-options'), getUsableHomebrewOfKind('background').map(d => d.name));
  fillDatalist(document.getElementById('alignment-options'), ALIGNMENTS);

  renderCharClassRows();
  showModal('character-modal');
  setTimeout(() => document.getElementById('char-name-input').focus(), 0);
}

// `abilities` is deliberately NOT returned — every caller merges this over the
// character, so omitting the key carries the existing scores through (and on New
// Character, `normalizeAbilities()` fills all six with 10). `level` is a mirror
// of the class sum when there are classes, so it only matters for a classless
// character — the only time the box is on screen.
function _readCharModalFields(current) {
  const level = parseInt(document.getElementById('char-level-input').value, 10);
  return {
    name: document.getElementById('char-name-input').value.trim() || 'Unnamed Hero',
    race: document.getElementById('char-race-input').value.trim(),
    background: document.getElementById('char-background-input').value.trim(),
    alignment: document.getElementById('char-alignment-input').value.trim(),
    classLevels: charModalClasses,
    level: Number.isFinite(level) ? level : (current?.level ?? 1),
    spellsEnabled: document.getElementById('char-spells-input').checked,
  };
}

saveCharBtnEl.addEventListener('click', () => {
  if (_hasDuplicateCharClass()) return;
  const current = charModalIsNew ? null
    : (charModalTargetId ? state.characters[charModalTargetId]?.character : state.character);
  const fields = _readCharModalFields(current);
  _closeCharPicker();
  hideModal('character-modal');

  if (charModalIsNew) {
    const id = createCharacter(fields);
    // Straight into the new character, unless you are the GM — they have no
    // character in play, so creating one only adds it to the roster.
    // After activateCharacter(), which moves the working copy off the placeholder.
    if (canSelectCharacter()) { activateCharacter(id); dropUntouchedSlotsExcept(id); closeHomeScreen(); }
    else { dropUntouchedSlotsExcept(id); renderHomeScreen(); }
    scheduleSaveAndSync();
  } else if (charModalTargetId) {
    // A card on the home screen — the slot, which may not be the one on screen.
    updateCharacterMeta(charModalTargetId, fields);
  } else {
    // The sheet's gear: whoever is on screen, yours or a player's.
    applyMetaToLiveCharacter(fields);
  }
  charModalTargetId = null;
  charModalIsNew = false;
});

document.getElementById('sheet-setup-btn').addEventListener('click', () => openCharModal());

// The header name opens the same dialog from any view, gated like the sheet's gear.
const charNameDisplayEl = document.getElementById('char-name-display');
function _openCharModalFromHeader() {
  if (isReadOnly()) return;
  openCharModal();
}
charNameDisplayEl.addEventListener('click', _openCharModalFromHeader);
charNameDisplayEl.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  _openCharModalFromHeader();
});

// ─── THE CLASS ROWS ───
// One row per class: name, level, and (once that class's level has unlocked one)
// subclass. Rows are built once and written into, never rebuilt on a keystroke;
// only a removal rebuilds the list (every index below the gap shifts).

// Rebuilds every class row from the modal's working copy.
function renderCharClassRows() {
  charClassRowsEl.textContent = '';
  charModalClasses.forEach((entry, i) => charClassRowsEl.appendChild(_buildCharClassRow(entry, i)));
  _syncCharClassSummary();
}

function _buildCharClassRow(entry, index) {
  const row = document.createElement('div');
  row.className = 'class-row';
  row.dataset.index = index;

  row.append(
    _buildCharRowField('Class', _buildCharTextInput(entry.name, 'class-row-name', {
      options: 'class-options', maxLength: 40, placeholder: 'e.g. Warlock',
    })),
    _buildCharRowField('Level', _buildCharLevelInput(entry.level), 'class-row-field-level'),
  );

  // The subclass field is the row's own — `_syncCharClassRow()` decides whether
  // to show it (a Warlock 5 has a patron, the Bard 2 beside them does not).
  const sub = _buildCharRowField('Subclass', _buildCharTextInput(entry.subclass, 'class-row-subclass', {
    maxLength: 40, placeholder: 'Not yet chosen',
  }));
  sub.classList.add('class-row-sub');
  const dl = document.createElement('datalist');
  dl.id = `subclass-options-${index}`;
  sub.querySelector('input').dataset.options = dl.id;
  sub.appendChild(dl);
  row.appendChild(sub);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'class-row-remove btn-sm icon-only';
  remove.title = 'Remove this class';
  remove.setAttribute('aria-label', 'Remove this class');
  remove.textContent = '×';
  row.appendChild(remove);

  _syncCharClassRow(row, entry);
  return row;
}

function _buildCharRowField(label, input, extraClass = '') {
  const field = document.createElement('label');
  field.className = 'field class-row-field' + (extraClass ? ' ' + extraClass : '');
  const span = document.createElement('span');
  span.textContent = label;
  field.append(span, input);
  return field;
}

function _buildCharTextInput(value, className, { options, maxLength, placeholder } = {}) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = className;
  input.value = value ?? '';
  if (options) { input.dataset.options = options; input.autocomplete = 'off'; }
  if (maxLength) input.maxLength = maxLength;
  if (placeholder) input.placeholder = placeholder;
  return input;
}

function _buildCharLevelInput(value) {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'class-row-level';
  input.min = 1;
  input.max = MAX_LEVEL;
  input.value = value;
  return input;
}

// The subclasses this class offers, and whether to ask for one at all. An
// unknown class SHOWS the field — `getClassUnlockKeys()` returns null, and hiding a
// box we cannot reason about reads as the app having eaten a field.
function _syncCharClassRow(row, entry) {
  const def = findClassByName(entry.name);
  const keys = getClassUnlockKeys(def, entry.subclass, entry.level);
  const sub = row.querySelector('.class-row-sub');

  sub.classList.toggle('hidden', !!keys && !keys.has('subclass'));
  fillDatalist(row.querySelector('.class-row-sub datalist'),
    (def?.subclasses ?? []).map(sc => sc.name));
}

// The total under the rows is derived (the sum). With no classes there is
// nothing to sum, so the plain Level box appears instead.
function _syncCharClassSummary() {
  const none = charModalClasses.length === 0;
  charLevelFieldEl.classList.toggle('hidden', !none);
  charTotalLevelEl.textContent = none
    ? ''
    : `Level ${getTotalLevel(sanitizeClassLevels(charModalClasses), 1)}`;
  _syncCharClassDuplicates();
}

// Indexes of rows naming a class an earlier row already has.
function _getDuplicateCharClassIndexes() {
  const seen = new Set();
  const duplicates = new Set();
  charModalClasses.forEach((entry, i) => {
    const key = getClassNameKey(entry.name);
    if (!key) return;
    if (seen.has(key)) duplicates.add(i);
    else seen.add(key);
  });
  return duplicates;
}

function _hasDuplicateCharClass() { return _getDuplicateCharClassIndexes().size > 0; }

// Marks repeated classes and disables Save while any remain.
function _syncCharClassDuplicates() {
  const duplicates = _getDuplicateCharClassIndexes();
  charClassRowsEl.querySelectorAll('.class-row').forEach(row => {
    const isDuplicate = duplicates.has(parseInt(row.dataset.index, 10));
    row.classList.toggle('duplicate', isDuplicate);
    row.querySelector('.class-row-name').setAttribute('aria-invalid', String(isDuplicate));
  });

  const firstName = duplicates.size ? charModalClasses[[...duplicates][0]].name.trim() : '';
  charClassDuplicateMsgEl.textContent = firstName
    ? `${firstName} is already on this character. Raise that row's level instead.`
    : '';
  charClassDuplicateMsgEl.classList.toggle('hidden', !firstName);
  saveCharBtnEl.disabled = duplicates.size > 0;
}

// One listener for the whole list (the list is rebuilt on a removal).
charClassRowsEl.addEventListener('input', e => {
  const row = e.target.closest('.class-row');
  if (!row) return;
  const entry = charModalClasses[parseInt(row.dataset.index, 10)];
  if (!entry) return;

  if (e.target.classList.contains('class-row-name')) entry.name = e.target.value;
  else if (e.target.classList.contains('class-row-subclass')) entry.subclass = e.target.value;
  else if (e.target.classList.contains('class-row-level')) {
    const n = parseInt(e.target.value, 10);
    entry.level = Number.isFinite(n) ? clampLevel(n) : 1;
  }

  _syncCharClassRow(row, entry);
  _syncCharClassSummary();
});

charClassRowsEl.addEventListener('click', e => {
  const btn = e.target.closest('.class-row-remove');
  if (!btn) return;
  charModalClasses.splice(parseInt(btn.closest('.class-row').dataset.index, 10), 1);
  renderCharClassRows();   // every index below the gap has moved
});

document.getElementById('char-add-class-btn').addEventListener('click', () => {
  charModalClasses.push(createBlankClassEntry());
  const row = _buildCharClassRow(charModalClasses[charModalClasses.length - 1], charModalClasses.length - 1);
  charClassRowsEl.appendChild(row);
  _syncCharClassSummary();
  row.querySelector('.class-row-name').focus();
});

// ─── THE OPTION PICKER ───
// Every `data-options` field gets its suggestions from one parchment slip beside
// the dialog. The field stays free text (homebrew names need not be listed); the
// datalist named by `data-options` is only where the options are read from.

function _getCharPickerNames(input, showAll) {
  const dl = document.getElementById(input.dataset.options);
  const names = dl ? [...dl.options].map(o => o.value) : [];
  const query = input.value.trim().toLowerCase();
  if (showAll || !query) return names;
  return names.filter(n => n.toLowerCase().includes(query));
}

// Fills the list for the current field. `showAll` ignores what is typed, so a
// field opened on a chosen value still offers the rest. Returns the row count.
function _renderCharPicker(showAll) {
  const current = charPickerInput.value.trim().toLowerCase();
  charPickerListEl.textContent = '';
  charPickerActiveIndex = -1;
  charPickerInput.removeAttribute('aria-activedescendant');

  _getCharPickerNames(charPickerInput, showAll).forEach((name, i) => {
    const opt = document.createElement('div');
    opt.className = 'char-picker-option';
    opt.id = `char-picker-opt-${i}`;
    opt.setAttribute('role', 'option');
    opt.dataset.value = name;
    opt.textContent = name;
    const isSelected = name.toLowerCase() === current;
    opt.classList.toggle('selected', isSelected);
    opt.setAttribute('aria-selected', String(isSelected));
    charPickerListEl.appendChild(opt);
  });

  charPickerListEl.scrollTop = 0;
  const selected = charPickerListEl.querySelector('.selected');
  if (selected) {
    charPickerListEl.scrollTop = selected.offsetTop - (charPickerListEl.clientHeight - selected.offsetHeight) / 2;
  }
  _syncCharPickerFades();
  return charPickerListEl.children.length;
}

function _setCharPickerVisible(isVisible) {
  charPickerEl.classList.toggle('open', isVisible);
  charPickerEl.setAttribute('aria-hidden', String(!isVisible));
  charPickerInput?.setAttribute('aria-expanded', String(isVisible));
}

function _isCharPickerVisible() { return charPickerEl.classList.contains('open'); }

function _openCharPicker(input) {
  charPickerInput = input;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-controls', charPickerListEl.id);
  if (!_renderCharPicker(true)) { _setCharPickerVisible(false); return; }
  _positionCharPicker();
  _setCharPickerVisible(true);
}

// Fades the picker out and slides the dialog back to where it sat.
function _closeCharPicker() {
  _setCharPickerVisible(false);
  charPickerInput?.removeAttribute('aria-activedescendant');
  charPickerInput = null;
  charPickerActiveIndex = -1;
  charModalBoxEl.style.transform = '';
}

// Sits the picker left of the dialog, beside the field. The dialog moves right
// only by what the left side lacks, and only as far as the right side has room;
// past that the picker overlaps the dialog's edge.
function _positionCharPicker() {
  if (!charPickerInput) return;
  // Measured mid-slide, so the box's current offset is taken back out first.
  const currentShift = new DOMMatrixReadOnly(getComputedStyle(charModalBoxEl).transform).m41;
  const box = charModalBoxEl.getBoundingClientRect();
  const baseLeft = box.left - currentShift;
  const baseRight = box.right - currentShift;

  const needed = CHAR_PICKER_WIDTH + CHAR_PICKER_GAP + CHAR_PICKER_MARGIN - baseLeft;
  const room = window.innerWidth - CHAR_PICKER_MARGIN - baseRight;
  const shift = Math.max(0, Math.min(needed, room));
  charModalBoxEl.style.transform = shift ? `translateX(${shift}px)` : '';

  const left = Math.max(CHAR_PICKER_MARGIN, baseLeft + shift - CHAR_PICKER_GAP - CHAR_PICKER_WIDTH);
  const field = charPickerInput.getBoundingClientRect();
  const height = charPickerEl.offsetHeight;
  const centred = field.top + field.height / 2 - height / 2;
  const top = Math.max(CHAR_PICKER_MARGIN,
    Math.min(centred, window.innerHeight - CHAR_PICKER_MARGIN - height));
  charPickerEl.style.left = `${left}px`;
  charPickerEl.style.top = `${top}px`;
}

// Fades only the edges an option can scroll past, so a short list has none.
function _syncCharPickerFades() {
  const list = charPickerListEl;
  const below = list.scrollHeight - list.clientHeight - list.scrollTop;
  list.style.setProperty('--fade-top', list.scrollTop > 1 ? `${CHAR_PICKER_FADE}px` : '0px');
  list.style.setProperty('--fade-bottom', below > 1 ? `${CHAR_PICKER_FADE}px` : '0px');
}

function _setCharPickerActive(index) {
  const options = charPickerListEl.children;
  if (!options.length) return;
  charPickerActiveIndex = (index + options.length) % options.length;
  [...options].forEach((opt, i) => opt.classList.toggle('active', i === charPickerActiveIndex));
  const active = options[charPickerActiveIndex];
  active.scrollIntoView({ block: 'nearest' });
  charPickerInput.setAttribute('aria-activedescendant', active.id);
}

// Writes the pick into the field (through an `input` event, so the class rows
// hear it) and fades the picker out, leaving focus where it was.
function _selectCharPickerOption(name) {
  if (!charPickerInput) return;
  isCharPickerSelecting = true;
  charPickerInput.value = name;
  charPickerInput.dispatchEvent(new Event('input', { bubbles: true }));
  isCharPickerSelecting = false;
  _setCharPickerVisible(false);
}

charModalBoxEl.addEventListener('focusin', e => {
  if (e.target.dataset?.options) _openCharPicker(e.target);
});

charModalBoxEl.addEventListener('focusout', e => {
  if (e.target === charPickerInput) _closeCharPicker();
});

// A field still focused after a pick reopens on a second click.
charModalBoxEl.addEventListener('click', e => {
  if (e.target === charPickerInput && !_isCharPickerVisible()) _openCharPicker(e.target);
});

// Typing narrows the list; nothing matching fades it out until something does.
charModalBoxEl.addEventListener('input', e => {
  if (e.target !== charPickerInput || isCharPickerSelecting) return;
  const count = _renderCharPicker(false);
  if (count) _positionCharPicker();
  _setCharPickerVisible(count > 0);
});

charModalBoxEl.addEventListener('keydown', e => {
  if (e.target !== charPickerInput) return;
  const isVisible = _isCharPickerVisible();

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!isVisible) { _openCharPicker(charPickerInput); return; }
    _setCharPickerActive(charPickerActiveIndex + (e.key === 'ArrowDown' ? 1 : -1));
  } else if (e.key === 'Enter' && isVisible && charPickerActiveIndex >= 0) {
    e.preventDefault();
    _selectCharPickerOption(charPickerListEl.children[charPickerActiveIndex].dataset.value);
  } else if (e.key === 'Escape' && isVisible) {
    e.preventDefault();
    e.stopPropagation(); // closes the picker, not whatever else listens for Escape
    _setCharPickerVisible(false);
  }
});

// A press on the slip must not blur the field, or focusout closes it mid-pick.
charPickerEl.addEventListener('mousedown', e => e.preventDefault());
charPickerListEl.addEventListener('click', e => {
  const opt = e.target.closest('.char-picker-option');
  if (opt) _selectCharPickerOption(opt.dataset.value);
});
charPickerListEl.addEventListener('scroll', _syncCharPickerFades, { passive: true });

charModalBoxEl.addEventListener('scroll', _positionCharPicker, { passive: true });
window.addEventListener('resize', _positionCharPicker);
