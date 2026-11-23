// =============================================================================
// FEATURE CHOICES — the picks a class feature or species trait asks for
// =============================================================================
'use strict';

// A feature asks for a pick in one of three ways:
//   - its data lists `options` (species traits whose prose names the choices);
//   - its description says "You gain one of the following options." followed by
//     paragraphs that open with a bold name (**Protector.**);
//   - it is an Ability Score Improvement (two +1s, or a feat instead).
// The pick is saved in `character.featureChoices[cardKey]`: an option name, or
// `{ abilities: ['wis', 'wis'] }` / `{ feat: true }` for an ASI. Feature cards draw
// the picker; pending-choices.js reminds the player until every one is made.

// "You gain one of the following options" and "Choose one of the following".
const CHOICE_TRIGGER_RE = /\b(?:gain|choose|pick|select|learn)\s+one\s+of\s+the\s+following\b/i;
// A choice made at the table each time (Channel Divinity, Starry Form) is not a pick to save.
const CHOICE_PER_USE_RE = /\b(?:each time|whenever|when you|choosing which)\b/i;
// An option paragraph opens with its bold name, optionally as a list item.
const CHOICE_OPTION_RE = /^\s*(?:[-*]\s+)?\*\*(.+?)\*\*/;
const ASI_FEATURE_RE = /^ability score improvement$/i;
const ASI_MAX_SCORE = 20; // an Ability Score Improvement never raises a score past this

// Parsed option names keyed by raw description; a feature's text never changes.
const choiceOptionCache = new Map();

// ─── READING A FEATURE'S CHOICE ───

// What a feature asks the player to pick: { kind: 'options', options } or
// { kind: 'asi' }, or null when it asks for nothing.
function getFeatureChoice(row) {
  if (row?.options?.length) return { kind: 'options', options: row.options };
  if (ASI_FEATURE_RE.test(String(row?.name ?? '').trim())) return { kind: 'asi' };
  const options = _getDescriptionChoiceOptions(row?.description);
  return options.length >= 2 ? { kind: 'options', options } : null;
}

// The bold-named paragraphs that follow a "one of the following" sentence.
function _getDescriptionChoiceOptions(description) {
  const key = String(description ?? '');
  if (choiceOptionCache.has(key)) return choiceOptionCache.get(key);

  const blocks = key.split(/\n\s*\n/);
  const at = blocks.findIndex(b => CHOICE_TRIGGER_RE.test(b) && !CHOICE_PER_USE_RE.test(b));
  const options = [];
  if (at !== -1) {
    for (const block of blocks.slice(at + 1)) {
      const match = block.match(CHOICE_OPTION_RE);
      if (!match) break;
      options.push(match[1].trim().replace(/[.:]$/, ''));
    }
  }
  choiceOptionCache.set(key, options);
  return options;
}

function _getSavedFeatureChoice(character, key) {
  return character?.featureChoices?.[key];
}

// Whether the saved pick still answers this feature (an option renamed in the
// data no longer does).
function _isFeatureChoiceMade(choice, saved) {
  if (choice.kind === 'asi') {
    return !!saved && typeof saved === 'object' && (saved.feat === true || Array.isArray(saved.abilities));
  }
  return typeof saved === 'string' && choice.options.includes(saved);
}

// Card keys of every reached feature or trait whose pick has not been made.
function getPendingFeatureChoiceKeys(character) {
  const pending = [];
  const collect = (rows, scope) => rows.forEach(row => {
    const choice = getFeatureChoice(row);
    if (!choice) return;
    const key = getFeatureCardKey(row, scope);
    if (!_isFeatureChoiceMade(choice, _getSavedFeatureChoice(character, key))) pending.push(key);
  });
  collect(getOwnedSpeciesTraitRows(character), 'species');
  collect(getOwnedClassFeatureRows(character), 'class');
  return pending;
}

// Part of the feature sections' redraw signatures: a pick, or a change in who may pick.
function getFeatureChoicesSignature(character) {
  return JSON.stringify(character?.featureChoices ?? {}) + (isReadOnly() ? '·ro' : '');
}

// ─── THE PICKER ON A CARD ───

// The picker for a card, or null when the feature asks for nothing.
function buildFeatureChoiceBlock(row, key) {
  const choice = getFeatureChoice(row);
  if (!choice) return null;

  const block = document.createElement('div');
  block.className = 'feature-choice';
  block.dataset.choiceKey = key;
  const saved = _getSavedFeatureChoice(state.character, key);
  const readOnly = isReadOnly();

  if (choice.kind === 'asi') _fillAsiChoice(block, saved, readOnly);
  else _fillOptionChoice(block, choice.options, saved, readOnly);
  return block;
}

function _fillOptionChoice(block, options, saved, readOnly) {
  const isMade = options.includes(saved);
  block.appendChild(_createChoiceLabel(isMade ? 'Chosen' : 'Choose one'));

  const row = document.createElement('div');
  row.className = 'feature-choice-options';
  options.forEach(option => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'feature-choice-btn';
    btn.dataset.option = option;
    btn.textContent = option;
    btn.setAttribute('aria-pressed', String(option === saved));
    btn.disabled = readOnly;
    row.appendChild(btn);
  });
  block.appendChild(row);
}

function _fillAsiChoice(block, saved, readOnly) {
  if (saved?.feat === true || Array.isArray(saved?.abilities)) {
    block.appendChild(_createChoiceLabel('Chosen'));
    const row = document.createElement('div');
    row.className = 'feature-choice-options';
    const text = document.createElement('span');
    text.className = 'feature-choice-summary';
    text.textContent = saved.feat === true ? 'Took a feat instead' : _getAsiSummary(saved.abilities);
    row.appendChild(text);
    row.appendChild(_createChoiceButton('Undo', 'feature-choice-undo', readOnly,
      saved.feat === true ? 'Clear this choice' : 'Take these points back off and choose again'));
    block.appendChild(row);
    return;
  }

  block.appendChild(_createChoiceLabel('Raise two scores by 1, or one score by 2'));
  const row = document.createElement('div');
  row.className = 'feature-choice-options';
  [0, 1].forEach(i => row.appendChild(_createAsiSelect(i, readOnly)));
  const apply = _createChoiceButton('Apply', 'feature-choice-apply', true, 'Pick two scores first');
  row.appendChild(apply);
  row.appendChild(_createChoiceButton('Took a feat instead', 'feature-choice-feat', readOnly,
    'Choose a feat in place of the ability scores'));
  block.appendChild(row);
}

function _createChoiceLabel(text) {
  const label = document.createElement('span');
  label.className = 'feature-choice-label';
  label.textContent = text;
  return label;
}

function _createChoiceButton(text, className, disabled, title) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `btn-sm ${className}`;
  btn.textContent = text;
  btn.disabled = disabled;
  if (title) btn.title = title;
  return btn;
}

function _createAsiSelect(index, readOnly) {
  const select = document.createElement('select');
  select.className = 'asi-pick';
  select.setAttribute('aria-label', index === 0 ? 'First +1' : 'Second +1');
  select.disabled = readOnly;
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '+1 to…';
  select.appendChild(blank);
  ABILITIES.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.label;
    select.appendChild(opt);
  });
  return select;
}

// "+2 Wisdom" or "+1 Strength, +1 Constitution".
function _getAsiSummary(picks) {
  const counts = new Map();
  picks.forEach(id => counts.set(id, (counts.get(id) ?? 0) + 1));
  return [...counts].map(([id, n]) =>
    `+${n} ${ABILITIES.find(a => a.id === id)?.label ?? id}`).join(', ');
}

function _getAsiPicks(block) {
  return [...block.querySelectorAll('.asi-pick')].map(s => s.value);
}

// Why these picks cannot be applied, or '' when they can.
function _getAsiPickProblem(picks) {
  if (picks.some(p => !p)) return 'Pick two scores first';
  const over = ABILITIES.find(a =>
    (state.character.abilities?.[a.id] ?? 10) + picks.filter(p => p === a.id).length > ASI_MAX_SCORE);
  return over ? `${over.label} can't go above ${ASI_MAX_SCORE}` : '';
}

// ─── SAVING A PICK ───

// Writes (or with `value` null, clears) one pick and runs the sheet's usual commit.
function _writeFeatureChoice(key, value, touchesStrength) {
  const choices = { ...(state.character.featureChoices ?? {}) };
  if (value === null) delete choices[key];
  else choices[key] = value;
  state.character.featureChoices = choices;
  commitSheetEdit(touchesStrength ? 'abilities.str' : 'featureChoices');
}

// Adds `step` to each picked score; the ASI is the only writer besides the score boxes.
function _shiftAbilityScores(picks, step) {
  const abilities = { ...state.character.abilities };
  picks.forEach(id => {
    abilities[id] = Math.max(0, Math.min(30, (abilities[id] ?? 10) + step));
  });
  state.character.abilities = abilities;
}

function _onFeatureChoiceClick(e) {
  const block = e.target.closest('.feature-choice');
  const btn = e.target.closest('button');
  if (!block || !btn || btn.disabled || isReadOnly()) return;
  const key = block.dataset.choiceKey;
  const saved = _getSavedFeatureChoice(state.character, key);

  if (btn.classList.contains('feature-choice-btn')) {
    // Pressing the chosen option again un-chooses it.
    _writeFeatureChoice(key, saved === btn.dataset.option ? null : btn.dataset.option, false);
  } else if (btn.classList.contains('feature-choice-apply')) {
    const picks = _getAsiPicks(block);
    if (_getAsiPickProblem(picks)) return;
    _shiftAbilityScores(picks, 1);
    _writeFeatureChoice(key, { abilities: picks }, picks.includes('str'));
  } else if (btn.classList.contains('feature-choice-feat')) {
    _writeFeatureChoice(key, { feat: true }, false);
  } else if (btn.classList.contains('feature-choice-undo')) {
    const picks = Array.isArray(saved?.abilities) ? saved.abilities : [];
    _shiftAbilityScores(picks, -1);
    _writeFeatureChoice(key, null, picks.includes('str'));
  }
}

// Apply stays disabled, with the reason as its tooltip, until two valid scores are picked.
function _onAsiPickChange(e) {
  if (!e.target.classList.contains('asi-pick')) return;
  const block = e.target.closest('.feature-choice');
  const apply = block?.querySelector('.feature-choice-apply');
  if (!apply) return;
  const problem = _getAsiPickProblem(_getAsiPicks(block));
  apply.disabled = !!problem || isReadOnly();
  apply.title = problem || 'Add these to your ability scores';
}

['sheet-features', 'sheet-species-traits'].forEach(id => {
  const box = document.getElementById(id);
  if (!box) return;
  box.addEventListener('click', _onFeatureChoiceClick);
  box.addEventListener('change', _onAsiPickChange);
});
