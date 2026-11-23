// =============================================================================
// CHARACTER SHEET — Page one of the 2024 sheet, rendered from state.character
// =============================================================================
// The other view of a character, opposite the inventory; reads and writes
// `state.character` and owns no data. What the rules derive (modifiers,
// proficiency bonus, skills, saves, passive Perception, initiative) is text;
// what they cannot settle (AC, speed, HP, hit dice) is an input. Boxes are built
// once and written into, never rebuilt, so an input never loses focus mid-keystroke.
'use strict';

const PROF_TITLES = ['Not proficient', 'Proficient', 'Expertise'];

// Whether the ability groups have been built into the page (once per session).
let isSheetBuilt = false;

// ─── THE MODEL ───

// Everything the sheet adds to a character, with defaults. Read by
// `_normalizeCharacterMeta()` so a save missing any of them gains it on load.
function getDefaultSheetFields() {
  return {
    background: '', alignment: '', subclass: '', xp: 0, size: 'Medium',
    spellsEnabled: true, // whether the Spell Sheet view is offered at all — see spells.js
    ac: 10, speed: 30,
    hp: { current: 0, max: 0, temp: 0 },
    hitDice: { die: 'd8', max: 1, spent: 0 },
    deathSaves: { successes: 0, failures: 0 },
    inspiration: false,
    saveProf: {},   // { [abilityId]: true }
    skillProf: {},  // { [skillId]: 0 | 1 | 2 }
    armorTraining: { light: false, medium: false, heavy: false, shields: false },
    weaponProf: '', toolProf: '', languages: '',
    // The written sections — Markdown, rendered by sheet-prose.js; plain strings here.
    backstory: '', appearance: '',
    knownSpells: [], // ids picked from the Spell Sheet's Available Spells panel — see spells.js
    // Slots SPENT per spell level (index 0 = 1st), never slots left — see spells.js's casting.
    spellSlotsUsed: { slots: [], pact: [] },
    statuses: [],    // ids from data/statuses.json the player has picked — see statuses.js
    // Picks made on feature cards, keyed by card key ('class:<id>' / 'species:<id>') — see feature-choices.js.
    featureChoices: {},
  };
}

// Six scores, always. `strengthFallback` is the top-level `strength` field, so a
// save without `abilities` keeps the Strength its inventory was sized for
// instead of silently becoming a 10.
function normalizeAbilities(raw, strengthFallback) {
  const out = {};
  ABILITIES.forEach(a => {
    const v = parseInt(raw?.[a.id], 10);
    out[a.id] = Number.isFinite(v) ? _clampAbilityScore(v)
              : (a.id === 'str' ? _clampAbilityScore(parseInt(strengthFallback, 10) || 10) : 10);
  });
  return out;
}

// 0 to 30. Zero is a real score (a creature drained to 0 Strength is
// incapacitated), so it is allowed rather than floored to 1.
function _clampAbilityScore(n) { return Math.max(0, Math.min(30, n)); }

function _getSkillsOfAbility(abilityId) {
  return SKILLS.filter(s => s.ability === abilityId);
}

// ─── DERIVATION ───

// The live character's score for one ability (10 when unset).
function getAbilityScore(id) { return state.character.abilities?.[id] ?? 10; }

// The live character's modifier for one ability.
function getAbilityModifier(id)   { return Math.floor((getAbilityScore(id) - 10) / 2); }

// From the total level: +2 at level 1, stepping every four levels.
function getProficiencyBonus() {
  const level = Math.max(1, Math.min(20, parseInt(state.character.level, 10) || 1));
  return 2 + Math.floor((level - 1) / 4);
}

// A skill's proficiency level: PROF_NONE, PROF_PROFICIENT or PROF_EXPERTISE.
function getSkillProficiency(skillId) { return state.character.skillProf?.[skillId] ?? PROF_NONE; }

// Whether the character is proficient in an ability's saving throw.
function hasSaveProficiency(abilityId) { return !!state.character.saveProf?.[abilityId]; }

// A skill's total modifier; takes the SKILLS entry, not its id.
function getSkillModifier(skill) {
  return getAbilityModifier(skill.ability) + getProficiencyBonus() * getSkillProficiency(skill.id);
}

// An ability's saving throw modifier.
function getSaveModifier(abilityId) {
  return getAbilityModifier(abilityId) + (hasSaveProficiency(abilityId) ? getProficiencyBonus() : 0);
}

function _getPassivePerception() {
  return 10 + getSkillModifier(SKILLS.find(s => s.id === 'perception'));
}

// The live character's initiative modifier.
function getInitiativeBonus() { return getAbilityModifier('dex'); }

function _formatModifier(n) { return (n >= 0 ? '+' : '-') + Math.abs(n); }

// ─── BUILDING THE REPEATED PARTS ───
// The unique boxes are static markup in index.html. The six ability groups come
// from the ABILITIES and SKILLS tables, built once at boot and only written into
// afterwards, so an input never loses focus mid-keystroke.

function _buildCharacterSheet() {
  if (isSheetBuilt) return;
  isSheetBuilt = true;

  const abilBox = document.getElementById('sheet-abilities');
  ABILITIES.forEach(a => abilBox.appendChild(_buildAbilityGroup(a)));

  // The section layout is put together once too (sheet-layout.js).
  ensureSheetLayout();
}

// A score, its save, and the skills that read off it.
function _buildAbilityGroup(a) {
  const group = document.createElement('section');
  group.className = 'ability-group';

  const name = document.createElement('h4');
  name.className = 'ability-name';
  name.textContent = a.label;

  // A button carrying `data-roll`, read by dice.js. The modifier is NOT stored
  // on the element — dice.js asks the sheet for it at the moment of the click.
  const mod = document.createElement('button');
  mod.type = 'button';
  mod.className = 'ability-mod';
  mod.id = `sheet-mod-${a.id}`;
  mod.dataset.roll = `ability:${a.id}`;
  mod.title = `Roll a ${a.label} check`;

  const score = document.createElement('input');
  score.type = 'number';
  score.className = 'ability-score';
  score.min = 0; score.max = 30;
  score.dataset.sheet = `abilities.${a.id}`;
  score.dataset.kind = 'int';
  score.setAttribute('aria-label', a.label + ' score');

  const scoreBox = document.createElement('label');
  scoreBox.className = 'ability-score-box';
  const scoreCap = document.createElement('span');
  scoreCap.textContent = 'Score';
  scoreBox.append(scoreCap, score);

  const head = document.createElement('div');
  head.className = 'ability-head';
  head.append(mod, scoreBox);

  const rows = document.createElement('div');
  rows.className = 'prof-list';

  // The save leads the group and is bolded — it belongs to the ability itself.
  const save = _buildProfRow({
    dot: { path: `saveProf.${a.id}`, kind: 'bool' },
    label: 'Saving Throw',
    valueId: `sheet-save-${a.id}`,
    roll: `save:${a.id}`,
  });
  save.classList.add('save-row');
  rows.appendChild(save);

  _getSkillsOfAbility(a.id).forEach(s => rows.appendChild(_buildProfRow({
    dot: { path: `skillProf.${s.id}`, kind: 'prof' },
    label: s.label,
    valueId: `sheet-skill-${s.id}`,
    roll: `skill:${s.id}`,
  })));

  group.append(name, head, rows);
  return group;
}

// One row: "proficiency dot · name · derived modifier". The dot is a button (the
// skill version cycles three states). The name+value is a SECOND button — one
// changes what the character is proficient in, the other rolls it; a single
// button doing both could only guess which was meant.
function _buildProfRow({ dot, label, valueId, roll }) {
  const row = document.createElement('div');
  row.className = 'prof-row';

  const btn = document.createElement('button');
  btn.className = 'prof-dot';
  btn.dataset.sheet = dot.path;
  btn.dataset.kind = dot.kind;
  btn.type = 'button';

  const name = document.createElement('span');
  name.className = 'prof-name';
  name.textContent = label;

  const value = document.createElement('span');
  value.className = 'prof-value';
  value.id = valueId;

  const rollBtn = document.createElement('button');
  rollBtn.type = 'button';
  rollBtn.className = 'prof-roll';
  rollBtn.dataset.roll = roll;
  rollBtn.title = 'Roll ' + label;
  rollBtn.append(name, value);

  row.append(btn, rollBtn);
  return row;
}

// ─── RENDERING ───

// Writes current values into the sheet. Called from `syncCharacterViewUI()`,
// which also fires on every roster update, hence the focus guard: a sync
// mid-word must not reset the box.
function renderCharacterSheet() {
  _buildCharacterSheet();

  const c = state.character;
  const readOnly = isReadOnly();
  document.getElementById('character-sheet').classList.toggle('sheet-readonly', readOnly);

  // Every plain input, by the path it edits. NOT `[data-roll]` — rolling writes
  // nothing, so a read-only sheet still rolls (see dice.js).
  document.querySelectorAll('#character-sheet [data-sheet]').forEach(el => {
    const kind = el.dataset.kind;
    if (kind === 'bool' || kind === 'prof') {
      _renderProfDot(el, kind);
      el.disabled = readOnly;
      return;
    }
    el.disabled = readOnly;
    if (kind === 'check') { el.checked = !!readSheetPath(el.dataset.sheet); return; }
    if (el === document.activeElement) return; // being typed into
    const v = readSheetPath(el.dataset.sheet);
    el.value = v === null || v === undefined ? '' : v;
  });

  // Derived: the numbers the rules work out for you.
  ABILITIES.forEach(a => {
    document.getElementById(`sheet-mod-${a.id}`).textContent  = _formatModifier(getAbilityModifier(a.id));
    document.getElementById(`sheet-save-${a.id}`).textContent = _formatModifier(getSaveModifier(a.id));
  });
  SKILLS.forEach(s => {
    document.getElementById(`sheet-skill-${s.id}`).textContent = _formatModifier(getSkillModifier(s));
  });

  document.getElementById('sheet-prof-bonus').textContent = _formatModifier(getProficiencyBonus());
  document.getElementById('sheet-initiative').textContent = _formatModifier(getInitiativeBonus());
  document.getElementById('sheet-passive').textContent    = _getPassivePerception();

  // The identity block under the name — the readout of what the gear edits.
  _renderSheetIdentity(c);

  // Nothing on someone else's sheet is editable, and a gear whose Save would
  // write to a character that is not yours is worse than no gear.
  document.getElementById('sheet-setup-btn').classList.toggle('hidden', readOnly);

  _renderDeathSaves(readOnly);
  renderStatuses(); // encumbrance among them, so it follows the inventory too

  // Species before classes: renderClassFeatures() applies unlocks from both
  // registries and wants the species section settled in the same pass.
  renderSpeciesTraits();
  renderClassFeatures();
  renderSheetProse();
}

// A row of facts (label above, value below) in the order the 2024 sheet prints
// them. Every fact is drawn whether set or not (em dash for a blank), so a
// missing one does not shuffle the rest along.
function _renderSheetIdentity(c) {
  const box = document.getElementById('sheet-identity');
  const entries = getClassEntries(c);

  // A class's own level is said only when multiclassed.
  const classes = entries.map(e => {
    const level = entries.length > 1 ? ` ${e.level}` : '';
    return e.subclass ? `${e.name}${level} (${e.subclass})` : `${e.name}${level}`;
  }).join(' / ');

  box.textContent = '';
  [
    [entries.length > 1 ? 'Classes' : 'Class', classes],
    ['Species',    c.race],
    ['Background', c.background],
    ['Alignment',  c.alignment],
    ['Level',      c.level],
  ].forEach(([label, value]) => box.appendChild(_buildIdentityFact(label, value)));
}

function _buildIdentityFact(label, value) {
  const fact = document.createElement('div');
  fact.className = 'identity-fact';

  const key = document.createElement('span');
  key.className = 'identity-key';
  key.textContent = label;

  const val = document.createElement('span');
  val.className = 'identity-val' + (value ? '' : ' empty');
  val.textContent = value || '—';

  fact.append(key, val);
  return fact;
}

function _renderProfDot(el, kind) {
  const level = kind === 'bool'
    ? (readSheetPath(el.dataset.sheet) ? PROF_PROFICIENT : PROF_NONE)
    : (readSheetPath(el.dataset.sheet) || PROF_NONE);
  el.dataset.level = level;
  el.title = kind === 'bool'
    ? (level ? 'Proficient' : 'Not proficient')
    : PROF_TITLES[level];
}

// Three pips a side, filled left to right.
function _renderDeathSaves(readOnly) {
  [['successes', 'sheet-death-succ'], ['failures', 'sheet-death-fail']].forEach(([key, boxId]) => {
    const box = document.getElementById(boxId);
    const filled = state.character.deathSaves?.[key] ?? 0;
    box.innerHTML = '';
    for (let i = 1; i <= 3; i++) {
      const pip = document.createElement('button');
      pip.type = 'button';
      pip.className = 'death-pip' + (i <= filled ? ' filled' : '');
      pip.title = `${i} ${key}`;
      pip.disabled = readOnly;
      // Clicking the pip you are on clears back to it minus one.
      pip.addEventListener('click', () => {
        _setSheetPath(`deathSaves.${key}`, i === filled ? i - 1 : i);
        commitSheetEdit(`deathSaves.${key}`);
      });
      box.appendChild(pip);
    }
  });
}

// ─── EDITING ───

// Reads a dotted path (`hp.current`) off the live character; undefined if absent.
function readSheetPath(path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), state.character);
}

function _setSheetPath(path, value) {
  const parts = path.split('.');
  let obj = state.character;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof obj[parts[i]] !== 'object' || obj[parts[i]] === null) obj[parts[i]] = {};
    obj = obj[parts[i]];
  }
  obj[parts[parts.length - 1]] = value;
}

// One listener for the whole sheet (~80 boxes, all doing the same thing).
function _onSheetInput(e) {
  const el = e.target.closest('[data-sheet]');
  if (!el || isReadOnly()) return;
  const kind = el.dataset.kind;
  if (kind === 'bool' || kind === 'prof') return; // buttons, handled on click

  let value;
  if (kind === 'check') {
    value = el.checked;
  } else if (kind === 'int') {
    const n = parseInt(el.value, 10);
    value = Number.isFinite(n) ? n : 0;
    if (el.dataset.sheet.startsWith('abilities.')) value = _clampAbilityScore(value);
  } else {
    value = el.value;
  }
  _setSheetPath(el.dataset.sheet, value);
  commitSheetEdit(el.dataset.sheet);
}

// Both events, because a checkbox or select does not reliably report through
// 'input' everywhere; writing the same value twice costs nothing.
const sheetEl = document.getElementById('character-sheet');
sheetEl.addEventListener('input', _onSheetInput);
sheetEl.addEventListener('change', _onSheetInput);

sheetEl.addEventListener('click', e => {
  const el = e.target.closest('.prof-dot');
  if (!el || isReadOnly()) return;
  const kind = el.dataset.kind;
  const current = readSheetPath(el.dataset.sheet);
  // Saves are proficient or not; skills cycle through expertise.
  const next = kind === 'bool' ? !current : ((parseInt(current, 10) || 0) + 1) % 3;
  _setSheetPath(el.dataset.sheet, next);
  commitSheetEdit(el.dataset.sheet);
});

// Runs everything that must follow a sheet edit to `path`. Strength is marked,
// not rebuilt: a score is typed a digit at a time, and rebuilding on each would
// empty the pack (grid.js's deferred resize). `updateWeightDisplay()` is
// unconditional because it also writes the header's name and Strength.
function commitSheetEdit(path) {
  if (path === 'abilities.str') {
    state.character.strength = state.character.abilities.str;
    markGridSizeDirty();
  }
  updateWeightDisplay();
  if (path === 'level' || path === 'name') syncCharacterViewUI();
  renderCharacterSheet(); // the derived numbers move with almost everything
  renderHomeScreen();     // a card may be showing the level or the name
  scheduleSaveAndSync();
}
