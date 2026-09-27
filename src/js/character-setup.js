// =============================================================================
// CHARACTER SETUP — the modal that edits what a character *is*
// =============================================================================
'use strict';

// One dialog, three jobs: the sheet's gear, a roster card's Edit, New Character.
// It edits what describes a character — name, species, background, alignment, and
// the classes they have taken levels in — never what the sheet owns (ability
// scores, which all start at 10). `charModalTargetId` names the roster slot to
// edit; null means the character on screen, which is not always one of yours (a
// GM editing a player via the gear). See CLAUDE.md § Multiclassing and Character Setup.

let charModalTargetId = null;
let charModalIsNew = false;

// A working copy of the class rows, written to the character only on Save
// (Cancel has to mean something, and the target may not be the character on
// screen).
let charModalClasses = [];

const charClassRowsEl = document.getElementById('char-class-rows');
const charLevelFieldEl = document.getElementById('char-level-field');
const charTotalLevelEl = document.getElementById('char-total-level');

// =============================================================================
// OPENING AND SAVING
// =============================================================================
function openCharModal(targetId = null, { isNew = false } = {}) {
  charModalIsNew = isNew;
  charModalTargetId = isNew ? null : targetId;

  const c = charModalIsNew
    ? blankCharacterMeta('')
    : (charModalTargetId ? state.characters[charModalTargetId]?.character : null) ?? state.character;

  document.getElementById('character-modal-title').textContent =
    charModalIsNew ? 'New Character' : 'Character Setup';
  document.getElementById('char-name-input').value       = charModalIsNew ? '' : c.name;
  document.getElementById('char-race-input').value       = c.race ?? '';
  document.getElementById('char-background-input').value = c.background ?? '';
  document.getElementById('char-alignment-input').value  = c.alignment ?? '';
  document.getElementById('char-level-input').value      = c.level ?? 1;
  document.getElementById('char-spells-input').checked   = spellSheetEnabled(c);
  document.getElementById('save-char-btn').textContent   = charModalIsNew ? 'Create' : 'Save';

  // A copy, not the character's own array — nothing here may reach the model
  // before Save.
  charModalClasses = classEntriesOf(c).map(e => ({ ...e }));

  // Hints, refreshed on open rather than once at load: custom classes and
  // species will arrive through the registries, and this is where they show up.
  fillDatalist(document.getElementById('class-options'), allClasses().map(d => d.name));
  fillDatalist(document.getElementById('species-options'), allSpecies().map(d => d.name));
  fillDatalist(document.getElementById('background-options'), usableHomebrewOf('background').map(d => d.name));
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
function readCharModalFields(current) {
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

document.getElementById('save-char-btn').addEventListener('click', () => {
  const current = charModalIsNew ? null
    : (charModalTargetId ? state.characters[charModalTargetId]?.character : state.character);
  const fields = readCharModalFields(current);
  hideModal('character-modal');

  if (charModalIsNew) {
    const id = createCharacter(fields);
    // Straight into the new character, unless you are the GM — they have no
    // character in play, so creating one only adds it to the roster.
    // After activateCharacter(), which moves the working copy off the placeholder.
    if (canSelectCharacter()) { activateCharacter(id); dropUntouchedSlotsExcept(id); closeHomeScreen(); }
    else { dropUntouchedSlotsExcept(id); renderHomeScreen(); }
    debouncedSync();
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

// =============================================================================
// THE CLASS ROWS
// =============================================================================
// One row per class: name, level, and (once that class's level has unlocked one)
// subclass. Rows are built once and written into, never rebuilt on a keystroke —
// only a removal rebuilds the list (every index below the gap shifts).
function renderCharClassRows() {
  charClassRowsEl.textContent = '';
  charModalClasses.forEach((entry, i) => charClassRowsEl.appendChild(charClassRow(entry, i)));
  syncCharClassSummary();
}

function charClassRow(entry, index) {
  const row = document.createElement('div');
  row.className = 'class-row';
  row.dataset.index = index;

  row.append(
    charRowField('Class', charTextInput(entry.name, 'class-row-name', {
      list: 'class-options', maxLength: 40, placeholder: 'e.g. Warlock',
    })),
    charRowField('Level', charLevelInput(entry.level), 'class-row-field-level'),
  );

  // The subclass field is the row's own — `syncCharClassRow()` decides whether
  // to show it (a Warlock 5 has a patron, the Bard 2 beside them does not).
  const sub = charRowField('Subclass', charTextInput(entry.subclass, 'class-row-subclass', {
    maxLength: 40, placeholder: 'Not yet chosen',
  }));
  sub.classList.add('class-row-sub');
  const dl = document.createElement('datalist');
  dl.id = `subclass-options-${index}`;
  sub.querySelector('input').setAttribute('list', dl.id);
  sub.appendChild(dl);
  row.appendChild(sub);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'class-row-remove btn-sm icon-only';
  remove.title = 'Remove this class';
  remove.setAttribute('aria-label', 'Remove this class');
  remove.textContent = '×';
  row.appendChild(remove);

  syncCharClassRow(row, entry);
  return row;
}

function charRowField(label, input, extraClass = '') {
  const field = document.createElement('label');
  field.className = 'field class-row-field' + (extraClass ? ' ' + extraClass : '');
  const span = document.createElement('span');
  span.textContent = label;
  field.append(span, input);
  return field;
}

function charTextInput(value, className, { list, maxLength, placeholder } = {}) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = className;
  input.value = value ?? '';
  if (list) input.setAttribute('list', list);
  if (maxLength) input.maxLength = maxLength;
  if (placeholder) input.placeholder = placeholder;
  return input;
}

function charLevelInput(value) {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'class-row-level';
  input.min = 1;
  input.max = MAX_LEVEL;
  input.value = value;
  return input;
}

// The subclasses this class offers, and whether to ask for one at all. An
// unknown class SHOWS the field — `classUnlockKeys()` returns null, and hiding a
// box we cannot reason about reads as the app having eaten a field.
function syncCharClassRow(row, entry) {
  const def = findClassByName(entry.name);
  const keys = classUnlockKeys(def, entry.subclass, entry.level);
  const sub = row.querySelector('.class-row-sub');

  sub.classList.toggle('hidden', !!keys && !keys.has('subclass'));
  fillDatalist(row.querySelector('.class-row-sub datalist'),
    (def?.subclasses ?? []).map(sc => sc.name));
}

// The total under the rows is derived (the sum). With no classes there is
// nothing to sum, so the plain Level box appears instead.
function syncCharClassSummary() {
  const none = charModalClasses.length === 0;
  charLevelFieldEl.classList.toggle('hidden', !none);
  charTotalLevelEl.textContent = none
    ? ''
    : `Level ${totalLevelOf(sanitizeClassLevels(charModalClasses), 1)}`;
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

  syncCharClassRow(row, entry);
  syncCharClassSummary();
});

charClassRowsEl.addEventListener('click', e => {
  const btn = e.target.closest('.class-row-remove');
  if (!btn) return;
  charModalClasses.splice(parseInt(btn.closest('.class-row').dataset.index, 10), 1);
  renderCharClassRows();   // every index below the gap has moved
});

document.getElementById('char-add-class-btn').addEventListener('click', () => {
  charModalClasses.push(blankClassEntry());
  const row = charClassRow(charModalClasses[charModalClasses.length - 1], charModalClasses.length - 1);
  charClassRowsEl.appendChild(row);
  syncCharClassSummary();
  row.querySelector('.class-row-name').focus();
});
