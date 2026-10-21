// =============================================================================
// SPELLS — spell slots and the spells a character's classes give access to
// =============================================================================
'use strict';

// Same shape as class-features.js / species-traits.js: two small registries —
// `data/spell-slots.json` (how many slots of each spell level a class grants,
// indexed by that class's OWN level) and `data/spells.json` (every spell this
// app knows, each tagged with the classes that can cast it) — and a section
// that draws them onto a third view of a character, alongside the inventory
// and the sheet. A character's classes are matched by name, exactly as
// class-features.js matches them; a class this app has no slot table for grants
// no spells at all, the same way an unknown class shows no features.
//
// Spell Slots totals follow the rules' own Multiclass Spellcaster table: full
// caster levels (Bard/Cleric/Druid/Sorcerer/Wizard) count in full, half-caster
// levels (Paladin/Ranger/Artificer) count floored by 2, and Eldritch
// Knight/Arcane Trickster levels count floored by 3 — each class's
// contribution floored BEFORE summing, per RAW — and the blended total is
// looked up once in `multiclassSlotsByLevel` (see multiclassCasterLevel()).
// Warlock's Pact Magic is never blended into that total; it is its own pool,
// read off the Warlock entry alone and shown as a separate line.
//
// The whole sheet can be turned off per character (`character.spellsEnabled`,
// default on), from Character Setup — see character-setup.js — for a
// character with no need of it.
//
// The Available Spells panel (in the sidebar's Spells tab) is not limited to
// the character's own classes the way Spell Slots and Spells Known are — a
// feat (Magic Initiate and the like) can grant a spell from a class with no
// levels in it at all, so its class checkboxes always list every class this
// app's spell data knows of, just unchecked by default for any the character
// doesn't actually have. See `spellbookClassRows()` / `spellbookAvailableSpells()`.

// =============================================================================
// LOADING THE REGISTRIES
// =============================================================================
let DEFAULT_SPELL_SLOTS = [];
let DEFAULT_MULTICLASS_SLOTS = {};
let DEFAULT_SPELLS = [];

function loadDefaultSpellSlots() {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'data/spell-slots.json', false); // synchronous, like classes.json
    xhr.send();
    if (xhr.status !== 200) throw new Error(`HTTP ${xhr.status}`);
    const body = xhr.responseText.trim();
    if (body.startsWith('<')) throw new Error('not JSON'); // an unknown-path index page
    const parsed = JSON.parse(body);
    DEFAULT_SPELL_SLOTS = sanitizeSpellSlotClasses(parsed.classes);
    DEFAULT_MULTICLASS_SLOTS = sanitizeSlotsByLevel(parsed.multiclassSlotsByLevel);
  } catch (e) {
    // not fatal — the sheet is usable with no slot table known
    DEFAULT_SPELL_SLOTS = [];
    DEFAULT_MULTICLASS_SLOTS = {};
  }
}

function loadDefaultSpells() {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'data/spells.json', false);
    xhr.send();
    if (xhr.status !== 200) throw new Error(`HTTP ${xhr.status}`);
    const body = xhr.responseText.trim();
    if (body.startsWith('<')) throw new Error('not JSON');
    DEFAULT_SPELLS = sanitizeSpellList(JSON.parse(body).spells);
  } catch (e) {
    DEFAULT_SPELLS = [];
  }
}

// Shared by a class's own `slotsByLevel` and the top-level
// `multiclassSlotsByLevel` table — both are level → nine-number-array maps.
function sanitizeSlotsByLevel(raw) {
  const slotsByLevel = {};
  Object.entries(raw ?? {}).forEach(([level, slots]) => {
    const lvl = parseInt(level, 10);
    if (!Number.isFinite(lvl) || lvl < 1 || lvl > 20) return;
    if (!Array.isArray(slots)) return;
    slotsByLevel[lvl] = Array.from({ length: 9 }, (_, i) => Math.max(0, parseInt(slots[i], 10) || 0));
  });
  return slotsByLevel;
}

function sanitizeSpellSlotClasses(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(c => {
    const name = String(c?.name ?? '').trim();
    if (!name) return null;
    const slotsByLevel = sanitizeSlotsByLevel(c?.slotsByLevel);
    return Object.keys(slotsByLevel).length ? { name, slotsByLevel } : null;
  }).filter(Boolean);
}

function sanitizeSpellList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(s => {
    const id = String(s?.id ?? '').trim();
    const name = String(s?.name ?? '').trim();
    const level = parseInt(s?.level, 10);
    if (!id || !name || !Number.isFinite(level)) return null;
    const classes = (Array.isArray(s?.classes) ? s.classes : [])
      .map(c => String(c).trim()).filter(Boolean);
    if (!classes.length) return null;
    return {
      id, name,
      level: Math.max(0, Math.min(9, level)),
      school: String(s?.school ?? '').trim(),
      castingTime: String(s?.castingTime ?? '').trim(),
      range: String(s?.range ?? '').trim(),
      components: String(s?.components ?? '').trim(),
      duration: String(s?.duration ?? '').trim(),
      classes,
      source: cleanSource(s?.source), // short book label, same helper class-features.js uses
      description: String(s?.description ?? ''),
    };
  }).filter(Boolean);
}

loadDefaultSpellSlots();
loadDefaultSpells();

// =============================================================================
// THE REGISTRIES
// =============================================================================
// The app's spells, then usable homebrew ones (homebrew-share.js).
function allSpells() {
  return withHomebrewSpells(DEFAULT_SPELLS);
}

// Trimmed, case-insensitive — the same free-text match class-features.js uses
// for `findClassByName()`, just against the slot table's own class list.
function findSpellSlotClass(name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key) return null;
  return DEFAULT_SPELL_SLOTS.find(c => c.name.toLowerCase() === key) ?? null;
}

// The slots array [level1..level9] a class of the given level has, walking
// down to the nearest level actually present — the table above happens to be
// dense, but a hand-authored one need not be.
function spellSlotsForClass(className, level) {
  const def = findSpellSlotClass(className);
  if (!def) return null;
  const lvl = Math.max(1, Math.min(20, parseInt(level, 10) || 1));
  for (let l = lvl; l >= 1; l--) {
    if (def.slotsByLevel[l]) return def.slotsByLevel[l];
  }
  return [0, 0, 0, 0, 0, 0, 0, 0, 0];
}

// A character's classes that this app has a slot table for, each with its own
// slots and the highest spell level those slots reach (0 = cantrips only).
// Whether the app knows the character's OTHER classes is irrelevant here —
// same as `characterClassLevel()` reading one class at a time.
function spellcastingEntriesOf(character) {
  return classEntriesOf(character)
    .filter(e => findSpellSlotClass(e.name))
    .map(e => {
      const slots = spellSlotsForClass(e.name, e.level);
      let maxSpellLevel = 0;
      slots.forEach((n, i) => { if (n > 0) maxSpellLevel = i + 1; });
      return { name: e.name, level: e.level, slots, maxSpellLevel };
    });
}

function classMatchesAny(className, names) {
  const key = className.trim().toLowerCase();
  return names.some(n => n.trim().toLowerCase() === key);
}

// The rules' own multiclass caster-level math (PHB "Spell Slots" under
// Multiclassing) — read off RAW `classLevels` (name + level + subclass), not
// `spellcastingEntriesOf()`'s filtered list, because Eldritch Knight/Arcane
// Trickster contribute here despite this app having no spell-slot table (or
// spell list) of their own under "Fighter"/"Rogue". Warlock is deliberately
// never matched here — Pact Magic is its own pool, see `pactMagicSlots()`.
const FULL_CASTER_CLASSES = ['Bard', 'Cleric', 'Druid', 'Sorcerer', 'Wizard'];
const HALF_CASTER_CLASSES = ['Paladin', 'Ranger', 'Artificer'];
// { class, subclass }: the class ALONE grants nothing — only this exact
// free-text subclass does, matched the same trimmed/case-insensitive way
// `findSubclassByName()` in class-features.js matches a character's subclass.
const THIRD_CASTER_SUBCLASSES = [
  { className: 'Fighter', subclassName: 'Eldritch Knight' },
  { className: 'Rogue', subclassName: 'Arcane Trickster' },
];

// Each class's contribution is floored BEFORE summing — a Paladin 3/Ranger 3
// multiclass counts as caster level 1+1=2, not floor((3+3)/2)=3. That
// per-class flooring is RAW, not a simplification.
function multiclassCasterLevel(rawEntries) {
  let level = 0;
  (rawEntries ?? []).forEach(e => {
    const name = String(e?.name ?? '').trim();
    const lvl = Math.max(0, parseInt(e?.level, 10) || 0);
    if (!name || !lvl) return;
    if (classMatchesAny(name, FULL_CASTER_CLASSES)) {
      level += lvl;
    } else if (classMatchesAny(name, HALF_CASTER_CLASSES)) {
      level += Math.floor(lvl / 2);
    } else {
      const third = THIRD_CASTER_SUBCLASSES.find(t => classMatchesAny(name, [t.className]));
      if (third && classMatchesAny(String(e?.subclass ?? ''), [third.subclassName])) {
        level += Math.floor(lvl / 3);
      }
    }
  });
  return level;
}

// The blended multiclass caster level's slots, off `multiclassSlotsByLevel` —
// same nearest-level-at-or-below walk as `spellSlotsForClass()`.
function multiclassSpellSlots(casterLevel) {
  const lvl = Math.max(0, Math.min(20, casterLevel));
  for (let l = lvl; l >= 1; l--) {
    if (DEFAULT_MULTICLASS_SLOTS[l]) return DEFAULT_MULTICLASS_SLOTS[l];
  }
  return [0, 0, 0, 0, 0, 0, 0, 0, 0];
}

// Pact Magic is its own pool, always read off the Warlock entry alone at the
// Warlock's own level — never blended into `multiclassSpellSlots()`.
function pactMagicSlots(character) {
  const entry = classEntriesOf(character).find(e => classMatchesAny(String(e?.name ?? ''), ['Warlock']));
  if (!entry || !(parseInt(entry.level, 10) > 0)) return null;
  return spellSlotsForClass('Warlock', entry.level);
}

// Whether the sheet's own view is offered at all for this character — a
// per-character preference set in Character Setup, on by default so an older
// save (no field yet) still gets it.
function spellSheetEnabled(character) {
  return character?.spellsEnabled !== false;
}

// Whether a spell is on the character's own list, kept separately from
// availability: `spellbookAvailableSpells()` answers "could this character
// ever cast it", this answers "have they actually picked it" for the
// Available Spells panel's toggle and #spell-list's own filter.
function isSpellKnown(character, spellId) {
  return Array.isArray(character?.knownSpells) && character.knownSpells.includes(spellId);
}

// The panel's whole write path — a card's click, nothing else touches
// `knownSpells`. Guarded the way every other character edit is
// (`isReadOnly()`), since a picker card is a button, not an `<input>`
// `renderCharacterSheet()` can just disable.
function toggleKnownSpell(spellId) {
  if (isReadOnly()) return;
  const known = Array.isArray(state.character.knownSpells) ? state.character.knownSpells.slice() : [];
  const at = known.indexOf(spellId);
  if (at === -1) known.push(spellId); else known.splice(at, 1);
  state.character.knownSpells = known;
  renderSpellSheetContent(); // bypasses the signature gate — classes/level didn't change
  debouncedSync();
}

// =============================================================================
// THE AVAILABLE SPELLS PANEL — the pool, and its filter/sort preferences
// =============================================================================
// This browser's furniture, like item-sort.js's own key — a way of reading the
// spell list, not a fact about any character. Never saved or synced.
const SPELLBOOK_PREFS_KEY = 'dnd_inventory_spellbook';
const SPELLBOOK_SORT_MODES = ['class', 'school', 'all'];

function loadSpellbookPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(SPELLBOOK_PREFS_KEY));
    return {
      sortMode: SPELLBOOK_SORT_MODES.includes(raw?.sortMode) ? raw.sortMode : 'class',
      hiddenClasses: Array.isArray(raw?.hiddenClasses) ? raw.hiddenClasses.filter(x => typeof x === 'string') : [],
      shownExtraClasses: Array.isArray(raw?.shownExtraClasses) ? raw.shownExtraClasses.filter(x => typeof x === 'string') : [],
      hiddenSchools: Array.isArray(raw?.hiddenSchools) ? raw.hiddenSchools.filter(x => typeof x === 'string') : [],
    };
  } catch (e) {
    return { sortMode: 'class', hiddenClasses: [], shownExtraClasses: [], hiddenSchools: [] };
  }
}

let spellbookPrefs = loadSpellbookPrefs();

function saveSpellbookPrefs() {
  try { localStorage.setItem(SPELLBOOK_PREFS_KEY, JSON.stringify(spellbookPrefs)); } catch (e) { /* private mode */ }
}

// Every class this app's spell data knows of, alphabetically — deliberately
// not limited to the character's own classes. A feat (Magic Initiate and the
// like) can grant a spell from a class the character has no levels in at all,
// so the panel must be able to show any class's list on request.
function spellbookAllClassNames() {
  const names = new Set();
  allSpells().forEach(s => s.classes.forEach(c => names.add(c)));
  return [...names].sort((a, b) => a.localeCompare(b));
}

// The rows the panel offers: the character's own spellcasting classes first
// (their own class order, carrying their own `entry` for the level gate
// below), then every other class, alphabetically. `own` decides both that
// gate and which preference list a checkbox toggles.
function spellbookClassRows(entries) {
  const ownNames = new Set(entries.map(e => e.name));
  const extra = spellbookAllClassNames().filter(n => !ownNames.has(n));
  return entries.map(e => ({ name: e.name, own: true, entry: e }))
    .concat(extra.map(name => ({ name, own: false, entry: null })));
}

// An owned class defaults to shown — `hiddenClasses` is an opt-OUT list, same
// as `hiddenSchools`. Any other class defaults to hidden — `shownExtraClasses`
// is an opt-IN list — so "every class is an option, but only your own are
// checked to start" needs no first-run bookkeeping: an empty prefs object
// already means exactly that.
function spellbookClassChecked(row) {
  return row.own
    ? !spellbookPrefs.hiddenClasses.includes(row.name)
    : spellbookPrefs.shownExtraClasses.includes(row.name);
}

function setSpellbookClassChecked(row, checked) {
  const list = row.own ? spellbookPrefs.hiddenClasses : spellbookPrefs.shownExtraClasses;
  const member = row.own ? !checked : checked;
  const at = list.indexOf(row.name);
  if (member && at === -1) list.push(row.name);
  else if (!member && at !== -1) list.splice(at, 1);
  saveSpellbookPrefs();
  renderSpellSheetContent();
}

// Whether `row`'s class actually grants `spell` — the one reachability rule
// everything else in this section is built from. An owned class is gated by
// its own slots, same as ever; any other class has no level to gate it by, so
// a name match is reachable outright. Tag membership alone is *not* enough
// for an owned class past its own cap — a spell tagged with both an owned and
// an unrelated class (e.g. Misty Step, Wizard/Warlock) must not read as
// "granted by Wizard" for a Wizard too low-level to actually reach it, even
// though it's still reachable overall via the other tag.
function spellGrantsRow(spell, row) {
  if (!classMatchesAny(row.name, spell.classes)) return false;
  if (!row.own) return true;
  return spell.level === 0 || row.entry.maxSpellLevel >= spell.level;
}

// Every row among `classRows` that actually grants this spell — own classes
// first, in class order, extra classes after. A spell shared by two of them
// (e.g. Guidance for a Cleric/Druid) is listed under both, the same way a
// real spellbook would repeat it.
function spellGrantingClasses(spell, classRows) {
  return classRows.filter(r => spellGrantsRow(spell, r)).map(r => r.name);
}

// The panel's whole pool, independent of which checkboxes are currently on —
// those only decide what's *displayed* (`spellbookSections()`), not what's
// known. A spell reachable via any row at all (owned-and-in-range, or simply
// tagged with a class the character has no levels in) belongs in the pool;
// the checkbox, defaulting off for a class the character doesn't have, is
// what actually keeps it out of sight until asked for.
function spellbookAvailableSpells(classRows) {
  return allSpells()
    .filter(spell => spellGrantingClasses(spell, classRows).length > 0)
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
}

function spellbookAvailableSchools(available) {
  const schools = new Set(available.map(s => s.school || 'Other'));
  return [...schools].sort((a, b) => a.localeCompare(b));
}

// Groups `available` for the panel per `prefs`: by class (checked classes, in
// `classRows` order), by school (alphabetical), or `all` (one flat list) —
// sorted by level then name within every group either way. An unchecked class
// or school drops its spells from view entirely (never from `knownSpells`
// itself — see `renderSpellSheetContent()`). A spell surviving via more than
// one checked class is listed once per class group, but only once for
// school/all (a spell has one school, and `all` has no groups to repeat it
// into).
function spellbookSections(available, classRows, prefs) {
  const byLevelThenName = (a, b) => a.level - b.level || a.name.localeCompare(b.name);
  const enabledNames = new Set(classRows.filter(spellbookClassChecked).map(r => r.name));
  const isVisible = spell => {
    if (prefs.hiddenSchools.includes(spell.school || 'Other')) return false;
    return spellGrantingClasses(spell, classRows).some(c => enabledNames.has(c));
  };

  if (prefs.sortMode === 'all') {
    const spells = available.filter(isVisible).sort(byLevelThenName);
    return spells.length ? [{ heading: null, spells }] : [];
  }

  if (prefs.sortMode === 'school') {
    const bySchool = new Map();
    available.forEach(spell => {
      if (!isVisible(spell)) return;
      const school = spell.school || 'Other';
      if (!bySchool.has(school)) bySchool.set(school, []);
      bySchool.get(school).push(spell);
    });
    return [...bySchool.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([heading, spells]) => ({ heading, spells: spells.sort(byLevelThenName) }));
  }

  const byClass = new Map();
  classRows.forEach(row => { if (spellbookClassChecked(row)) byClass.set(row.name, []); });
  available.forEach(spell => {
    if (prefs.hiddenSchools.includes(spell.school || 'Other')) return;
    spellGrantingClasses(spell, classRows).forEach(cls => {
      if (byClass.has(cls)) byClass.get(cls).push(spell);
    });
  });
  return [...byClass.entries()]
    .filter(([, spells]) => spells.length)
    .map(([heading, spells]) => ({ heading, spells: spells.sort(byLevelThenName) }));
}

// The meta line on a picker card — whichever axis isn't already the group
// heading is the useful thing to print beside the spell's name. The school is
// never printed: every card carries its glyph (schoolIcon()) instead, so in
// Class mode the line is empty, and only an unrecognised school falls back to
// its name.
function spellPickerMeta(spell, classRows, prefs) {
  const classes = spellGrantingClasses(spell, classRows);
  const schoolText = schoolIconName(spell.school) ? '' : (spell.school || '');
  if (prefs.sortMode === 'class') return schoolText;
  return [schoolText, classes.join(', ')].filter(Boolean).join(' · ');
}

function renderSpellbookSettings(classRows, available) {
  const classBox = document.getElementById('spellbook-class-filters');
  const schoolBox = document.getElementById('spellbook-school-filters');
  if (!classBox || !schoolBox) return;

  classBox.textContent = '';
  classRows.forEach(row => {
    classBox.appendChild(spellbookFilterCheckbox(
      row.name, spellbookClassChecked(row),
      checked => setSpellbookClassChecked(row, checked)));
  });

  schoolBox.textContent = '';
  spellbookAvailableSchools(available).forEach(school => {
    schoolBox.appendChild(spellbookFilterCheckbox(
      school, !spellbookPrefs.hiddenSchools.includes(school),
      checked => setSpellbookFilter('hiddenSchools', school, !checked)));
  });

  document.querySelectorAll('#spellbook-sort input[name="spellbook-sort"]').forEach(radio => {
    radio.checked = radio.value === spellbookPrefs.sortMode;
  });
}

function spellbookFilterCheckbox(label, checked, onChange) {
  const wrap = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked));
  wrap.append(box, document.createTextNode(label));
  return wrap;
}

function setSpellbookFilter(prefKey, name, hidden) {
  const list = spellbookPrefs[prefKey];
  const at = list.indexOf(name);
  if (hidden && at === -1) list.push(name);
  else if (!hidden && at !== -1) list.splice(at, 1);
  saveSpellbookPrefs();
  renderSpellSheetContent();
}

document.getElementById('spellbook-settings-btn').addEventListener('click', () => {
  document.getElementById('spellbook-settings').classList.toggle('hidden');
});

document.querySelectorAll('#spellbook-sort input[name="spellbook-sort"]').forEach(radio => {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    spellbookPrefs.sortMode = SPELLBOOK_SORT_MODES.includes(radio.value) ? radio.value : 'class';
    saveSpellbookPrefs();
    renderSpellSheetContent();
  });
});

// =============================================================================
// THE SECTION
// =============================================================================
// `syncCharacterViewUI()` re-runs on every roster sync, but this view only
// changes with classes and levels — same guard as `classFeaturesSig`.
let spellSheetSig = null;

function spellSheetSignature() {
  const c = state.character || {};
  // Subclass is part of the signature — the Eldritch Knight/Arcane Trickster
  // check in `multiclassCasterLevel()` reads it, same as `classFeaturesSig`.
  return classEntriesOf(c).map(e => `${e.name}:${e.level}:${e.subclass}`).join('␟') +
    '‖' + homebrewUsableKey() + // a homebrew spell enabled or edited under the sheet
    '‖' + JSON.stringify(c.spellSlotsUsed ?? null); // a cast, synced in from whoever made it
}

function renderSpellSheet() {
  const sig = spellSheetSignature();
  if (sig === spellSheetSig) return;
  spellSheetSig = sig;
  renderSpellSheetContent();
}

// The actual draw, split out from the signature gate above so
// `toggleKnownSpell()` can force a repaint on every click — picking a spell
// changes nothing the signature watches (classes/level).
function renderSpellSheetContent() {
  const slotsBox = document.getElementById('spell-slots');
  const listBox = document.getElementById('spell-list');
  const pickerBox = document.getElementById('spellbook-list');
  if (!slotsBox || !listBox || !pickerBox) return;

  const character = state.character;
  const rawEntries = classEntriesOf(character);
  const entries = spellcastingEntriesOf(character);

  slotsBox.textContent = '';
  listBox.textContent = '';
  pickerBox.textContent = '';
  hideSpellHoverCard(); // its row is gone, and no pointerleave will say so

  // Slots are drawn from the RAW class list, not `entries` — an Eldritch
  // Knight/Arcane Trickster contributes a real slot count via
  // `multiclassCasterLevel()` even though this app has no spell-list data
  // under "Fighter"/"Rogue" for the Known/Available sections below.
  const casterLevel = multiclassCasterLevel(rawEntries);
  const totals = multiclassSpellSlots(casterLevel);
  const pact = pactMagicSlots(character);
  const hasTotals = totals.some(n => n > 0);
  const hasPact = !!pact && pact.some(n => n > 0);
  const readOnly = isReadOnly();

  if (hasTotals) {
    totals.forEach((count, i) => { if (count > 0) slotsBox.appendChild(spellSlotTile(i + 1, count, 'slots', readOnly)); });
  }
  if (hasPact) {
    if (hasTotals) slotsBox.appendChild(spellbookGroupHeading('Pact Magic'));
    pact.forEach((count, i) => { if (count > 0) slotsBox.appendChild(spellSlotTile(i + 1, count, 'pact', readOnly)); });
  }
  const longRestBtn = document.getElementById('spell-long-rest');
  const shortRestBtn = document.getElementById('spell-short-rest');
  longRestBtn.classList.toggle('hidden', !hasTotals && !hasPact);
  shortRestBtn.classList.toggle('hidden', !hasPact);
  longRestBtn.disabled = shortRestBtn.disabled = readOnly;
  if (!hasTotals && !hasPact && (entries.length || casterLevel > 0)) {
    slotsBox.appendChild(spellNote('No spell slots yet — cantrips only.'));
  }

  if (!entries.length) {
    const names = rawEntries.map(e => e.name);
    const note = names.length
      ? `No known spellcasting class among ${names.map(n => `“${n}”`).join(', ')}.`
      : 'Add a class in Character Setup to see its spells.';
    listBox.appendChild(spellNote(note));
    pickerBox.appendChild(spellNote(note));
    renderSpellbookSettings([], []);
    return;
  }

  const classRows = spellbookClassRows(entries);
  const available = spellbookAvailableSpells(classRows);
  renderSpellbookSettings(classRows, available);

  if (!available.length) {
    listBox.appendChild(spellNote('No spells known at this level yet.'));
    pickerBox.appendChild(spellNote('No spells available at this level yet.'));
    return;
  }

  const known = available.filter(s => isSpellKnown(character, s.id));
  if (!known.length) {
    listBox.appendChild(spellNote('Nothing picked yet — choose from Available Spells.'));
  } else {
    let lastLevel = null;
    known.forEach(spell => {
      if (spell.level !== lastLevel) {
        lastLevel = spell.level;
        listBox.appendChild(spellLevelHeading(spell.level));
      }
      listBox.appendChild(castableSpellCard(spell, readOnly));
    });
  }

  const sections = spellbookSections(available, classRows, spellbookPrefs);
  if (!sections.length) {
    pickerBox.appendChild(spellNote('Nothing matches the current filters.'));
    return;
  }
  sections.forEach(({ heading, spells }) => {
    if (heading) pickerBox.appendChild(spellbookGroupHeading(heading));
    let lastLevel = null;
    spells.forEach(spell => {
      if (spell.level !== lastLevel) {
        lastLevel = spell.level;
        pickerBox.appendChild(spellLevelHeading(spell.level));
      }
      pickerBox.appendChild(spellPickerCard(
        spell, isSpellKnown(character, spell.id), readOnly,
        spellPickerMeta(spell, classRows, spellbookPrefs)));
    });
  });
}

function spellbookGroupHeading(text) {
  const h = document.createElement('h4');
  h.className = 'spellbook-group-heading';
  h.textContent = text;
  return h;
}

function spellLevelLabel(level) {
  if (level === 0) return 'Cantrips';
  const suffix = level === 1 ? 'st' : level === 2 ? 'nd' : level === 3 ? 'rd' : 'th';
  return `${level}${suffix} Level`;
}

// Slots left over slots in all, and a pip per slot — filled while unspent.
// A pip is the manual fix for a cast made by mistake (or one made at the
// table without the app): clicking a filled pip spends down to it, an empty
// one refills up to it, the way a paper tracker is ticked.
function spellSlotTile(level, count, pool, readOnly) {
  const left = spellSlotsLeft(state.character, pool, level, count);

  const tile = document.createElement('div');
  tile.className = 'spell-slot-tile' + (left === 0 ? ' spent' : '');

  const lvl = document.createElement('span');
  lvl.className = 'spell-slot-level';
  lvl.textContent = spellLevelLabel(level);

  const n = document.createElement('span');
  n.className = 'spell-slot-count';
  n.textContent = left;
  const of = document.createElement('span');
  of.className = 'spell-slot-of';
  of.textContent = ' / ' + count;
  n.appendChild(of);

  const pips = document.createElement('span');
  pips.className = 'spell-slot-pips';
  for (let i = 0; i < count; i++) {
    const pip = document.createElement('button');
    pip.type = 'button';
    pip.className = 'spell-slot-pip' + (i < left ? ' full' : '');
    pip.disabled = readOnly;
    pip.setAttribute('aria-label', `${spellLevelLabel(level)} slot ${i + 1}: ${i < left ? 'unspent' : 'spent'}`);
    // Pip i filled → i left (spend it and everything above); empty → i + 1 left.
    pip.addEventListener('click', () => setSpellSlotsLeft(pool, level, count, i < left ? i : i + 1));
    pips.appendChild(pip);
  }

  tile.append(lvl, n, pips);
  return tile;
}

function spellLevelHeading(level) {
  const h = document.createElement('h4');
  h.className = 'spell-level-heading';
  h.textContent = spellLevelLabel(level);
  return h;
}

// Parsed descriptions are cached by their raw Markdown string, same reasoning
// as class-features.js's featureDescCache — data/spells.json never changes at
// runtime, so the parse + sanitize only needs to happen once per spell.
const spellDescCache = new Map();

function renderSpellDesc(el, src) {
  const key = String(src ?? '');
  let tpl = spellDescCache.get(key);
  if (!tpl) {
    tpl = document.createElement('template');
    renderMarkdownInto(tpl.content, key);
    spellDescCache.set(key, tpl);
  }
  el.appendChild(tpl.content.cloneNode(true));
}

// The eight schools that have a glyph (img/icon/spells/, .ico-school-* in
// icons.css), keyed by the lower-cased name data/spells.json uses. Anything
// else — homebrew, a typo — gets null and is printed as text instead.
const SPELL_SCHOOLS_WITH_ICONS = ['abjuration', 'conjuration', 'divination', 'enchantment',
  'evocation', 'illusion', 'necromancy', 'transmutation'];
function schoolIconName(school) {
  const key = String(school ?? '').trim().toLowerCase();
  return SPELL_SCHOOLS_WITH_ICONS.includes(key) ? key : null;
}
function schoolIcon(school) {
  const key = schoolIconName(school);
  if (!key) return null;
  const el = iconEl('school-' + key);
  el.classList.add('ico-school');
  el.title = String(school).trim();
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', el.title);
  return el;
}

function spellCard(spell) {
  const card = document.createElement('article');
  card.className = 'spell-card';

  const head = document.createElement('div');
  head.className = 'spell-card-head';
  const name = document.createElement('h5');
  name.className = 'spell-name';
  name.textContent = spell.name;
  head.appendChild(name);
  const icon = schoolIcon(spell.school);
  const schoolText = [icon ? null : spell.school, spell.source].filter(Boolean).join(' · ');
  if (schoolText) {
    const school = document.createElement('span');
    school.className = 'spell-school';
    school.textContent = schoolText;
    head.appendChild(school);
  }

  const meta = document.createElement('div');
  meta.className = 'spell-meta';
  [spell.castingTime, spell.range, spell.components, spell.duration].filter(Boolean).forEach(text => {
    const span = document.createElement('span');
    span.className = 'spell-meta-item';
    span.textContent = text;
    meta.appendChild(span);
  });

  // A `<div>`, not a `<p>`: the description is Markdown and comes back
  // block-level, same as class-features.js's feature-desc. `renderSpellDesc`
  // is the only way markup may be built from this string — markdown.js is the
  // one sanctioned path app-wide, sanitizer included, no exceptions per file.
  const desc = document.createElement('div');
  desc.className = 'spell-desc';
  renderSpellDesc(desc, spell.description);

  card.append(head, meta, desc);
  // The school's glyph rides the card's top-right corner, large — see .spell-card .ico-school.
  if (icon) { card.classList.add('has-school-icon'); card.appendChild(icon); }
  return card;
}

// A row in the Available Spells panel — the whole card is the toggle, same as
// a Browse card starting a placement is its whole click. `metaText` is
// whichever axis isn't already the group heading (see `spellPickerMeta()`).
function spellPickerCard(spell, known, readOnly, metaText) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'spell-pick-card' + (known ? ' known' : '');
  card.disabled = readOnly;

  const dot = document.createElement('span');
  dot.className = 'spell-pick-dot';

  const name = document.createElement('span');
  name.className = 'spell-pick-name';
  name.textContent = spell.name;

  const meta = document.createElement('span');
  meta.className = 'spell-pick-meta';
  meta.textContent = metaText || '';

  card.append(dot, name, meta);
  const icon = schoolIcon(spell.school);
  if (icon) card.appendChild(icon);
  card.addEventListener('click', () => toggleKnownSpell(spell.id));
  card.addEventListener('pointerenter', () => scheduleSpellHoverCard(spell, card));
  card.addEventListener('pointerleave', hideSpellHoverCard);
  return card;
}

// =============================================================================
// CASTING — spending slots, and the upcast wheel
// =============================================================================
// A click on a Spells Known card casts it from the lowest slot that can; a held
// press opens a wheel of every slot level it could be cast with instead. What
// is stored is `character.spellSlotsUsed = { slots: [...], pact: [...] }` —
// slots SPENT per level (index 0 = 1st), never slots left, so the maximum is
// always whatever the class table says now: a level-up's new slot arrives
// fresh, and a level lost never leaves a stale count behind. Saved and synced
// like any sheet field. Gated by `isReadOnly()`, unlike a roll — a cast writes.
const SPELL_SLOT_POOLS = ['slots', 'pact'];

// Hold time before the wheel opens, and movement that opens it sooner — the
// advantage wheel's own feel (dice.js), so the two gestures read alike.
const CAST_WHEEL_HOLD_MS = 180;
const CAST_WHEEL_REACH = 9;
// Inside this radius, letting go casts the default pick.
const CAST_WHEEL_DEADZONE = 24;

const castWheelEl = document.getElementById('cast-wheel');

function spellSlotsUsedOf(character, pool, level) {
  const n = parseInt(character?.spellSlotsUsed?.[pool]?.[level - 1], 10);
  return n > 0 ? n : 0;
}

function spellSlotsLeft(character, pool, level, total) {
  return Math.max(0, total - spellSlotsUsedOf(character, pool, level));
}

// Rewritten whole, as a dense nine-number array — RTDB reads a sparse one back
// as an object, which the reader above would survive but needn't.
function setSpellSlotsUsed(pool, level, used) {
  const c = state.character;
  const arr = Array.from({ length: 9 }, (_, i) => spellSlotsUsedOf(c, pool, i + 1));
  arr[level - 1] = Math.max(0, used);
  c.spellSlotsUsed = { ...(c.spellSlotsUsed ?? {}), [pool]: arr };
}

function setSpellSlotsLeft(pool, level, total, left) {
  if (isReadOnly()) return;
  setSpellSlotsUsed(pool, level, total - Math.max(0, Math.min(total, left)));
  renderSpellSheet(); // slot usage is in the signature
  debouncedSync();
}

// A Long Rest refills everything; a Short Rest refills Pact Magic only.
function restoreSpellSlots(pools) {
  if (isReadOnly()) return;
  const c = state.character;
  c.spellSlotsUsed = { ...(c.spellSlotsUsed ?? {}) };
  pools.forEach(pool => { c.spellSlotsUsed[pool] = Array(9).fill(0); });
  renderSpellSheet();
  debouncedSync();
}

document.getElementById('spell-long-rest').addEventListener('click', () => restoreSpellSlots(SPELL_SLOT_POOLS));
document.getElementById('spell-short-rest').addEventListener('click', () => restoreSpellSlots(['pact']));

// Every { pool, level, total, left } this spell could be cast with — any slot
// at or above its own level, in either pool. Lowest level first, and the
// ordinary pool before Pact Magic at the same level. A cantrip has none.
function castOptions(character, spell) {
  if (!(spell.level > 0)) return [];
  const pools = {
    slots: multiclassSpellSlots(multiclassCasterLevel(classEntriesOf(character))),
    pact: pactMagicSlots(character) ?? [],
  };
  const opts = [];
  SPELL_SLOT_POOLS.forEach(pool => pools[pool].forEach((total, i) => {
    const level = i + 1;
    if (total > 0 && level >= spell.level) {
      opts.push({ pool, level, total, left: spellSlotsLeft(character, pool, level, total) });
    }
  }));
  return opts.sort((a, b) => a.level - b.level || (a.pool === 'pact') - (b.pool === 'pact'));
}

// What a plain click spends: the cheapest slot that still has one left. For a
// Warlock that's the pact slot at its own level — Pact Magic always casts at it.
function defaultCastOption(options) {
  return options.find(o => o.left > 0) ?? null;
}

function findSpellById(id) {
  return allSpells().find(s => s.id === id) ?? null;
}

// The one write path. `opt` null on a cantrip; on a levelled spell with no
// slot left, nothing is spent or said — the card shakes instead.
function castSpell(spellId, opt) {
  if (isReadOnly()) return;
  const spell = findSpellById(spellId);
  if (!spell) return;
  if (spell.level > 0) {
    if (!opt || opt.left <= 0) { flashSpellCard(spellId, 'no-slot'); return; }
    setSpellSlotsUsed(opt.pool, opt.level, spellSlotsUsedOf(state.character, opt.pool, opt.level) + 1);
  }
  renderSpellSheet();
  flashSpellCard(spellId, 'cast');
  postCastToChat(spell, spell.level > 0 ? opt : null);
  debouncedSync();
}

// Found again by id, because the cast above has just redrawn the list.
function flashSpellCard(spellId, cls) {
  const card = document.querySelector(`#spell-list .spell-card[data-spell-id="${CSS.escape(spellId)}"]`);
  if (!card) return;
  card.classList.remove('cast', 'no-slot');
  void card.offsetWidth; // restart the animation on a second cast in a row
  card.classList.add(cls);
  card.addEventListener('animationend', () => card.classList.remove(cls), { once: true });
}

// "4th level", plus where the slot came from when that's not obvious.
function castLevelText(level, baseLevel, pact) {
  if (!(level > 0)) return 'Cantrip';
  const text = spellLevelLabel(level).replace(' Level', ' level');
  const notes = [level > baseLevel ? 'upcast' : '', pact ? 'Pact Magic' : ''].filter(Boolean);
  return notes.length ? `${text} (${notes.join(', ')})` : text;
}

// Pushed from here rather than chat.js so a cast's shape stays in one file —
// the same split as dice.js's `postRollToChat()`, and the same silent fall
// through `canChat()` with no campaign. `text` is the whole sentence, for an
// older client that draws any unknown `kind` as a plain line (and for the tab
// bubble, which shows it as speech).
function postCastToChat(spell, opt) {
  if (typeof canChat !== 'function' || !canChat()) return;
  chatFollowNewest();

  const character = String(state.character?.name ?? '').trim();
  const level = opt ? opt.level : 0;
  const pact = opt?.pool === 'pact';
  const sentence = `${character || chatAuthorName()} casts ${spell.name}` +
    (level > 0 ? ` at ${castLevelText(level, spell.level, pact)}` : '') + '.';

  firebaseDb.ref('parties/' + state.party.code + '/chat').push({
    uid: ownPlayerId(),
    name: chatAuthorName(),
    kind: 'cast',
    text: sentence,
    cast: {
      spell: spell.name, school: spell.school || '', character,
      level, baseLevel: spell.level, pact,
    },
    at: firebase.database.ServerValue.TIMESTAMP,
  }).catch(() => { /* the slot is spent either way */ });
}

// A Spells Known card, made castable. The hover card draws `spellCard()` too,
// and must not be.
function castableSpellCard(spell, readOnly) {
  const card = spellCard(spell);
  card.dataset.spellId = spell.id;
  if (readOnly) return card;
  card.classList.add('castable');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  const opts = castOptions(state.character, spell);
  const pick = defaultCastOption(opts);
  if (spell.level > 0 && !pick) {
    card.classList.add('no-slots');
    card.title = 'No slots left';
  } else {
    card.title = opts.length > 1 ? 'Click to cast · hold to upcast' : 'Click to cast';
  }
  return card;
}

// The live press, or null.
let castGesture = null;

function beginCastGesture(e, card) {
  if (e.button !== 0 || isReadOnly()) return;
  if (e.target.closest('a')) return; // a link in the description is still a link
  endCastGesture(false);
  const spell = findSpellById(card.dataset.spellId);
  if (!spell) return;
  e.preventDefault(); // no text selection dragging out of the card

  const options = castOptions(state.character, spell);
  castGesture = {
    spellId: spell.id, card, options,
    pick: defaultCastOption(options), hover: null, shown: false,
    x0: e.clientX, y0: e.clientY, pointerId: e.pointerId,
    // One option is nothing to choose between — the wheel never opens.
    timer: options.length > 1 ? setTimeout(openCastWheel, CAST_WHEEL_HOLD_MS) : null,
  };
  try { card.setPointerCapture(e.pointerId); } catch (_) { /* still works uncaptured */ }
}

// A ring of options around the cursor, the first at twelve o'clock, going
// clockwise up the levels. Nudged only as far as it takes to stay on screen.
function openCastWheel() {
  const g = castGesture;
  if (!g || g.shown) return;
  g.shown = true;

  const anchor = castWheelEl.querySelector('.cast-wheel-anchor');
  anchor.querySelectorAll('.cast-wheel-opt').forEach(o => o.remove());

  // Geometry read from the CSS that draws the wheel — one source of truth.
  const cs = getComputedStyle(castWheelEl);
  const radius = parseFloat(cs.getPropertyValue('--cast-r'));
  const reach = radius + parseFloat(cs.getPropertyValue('--cast-opt')) / 2;
  const pad = 6;

  g.options.forEach((opt, i) => {
    opt.angle = -Math.PI / 2 + (i / g.options.length) * Math.PI * 2;
    const el = document.createElement('div');
    el.className = 'cast-wheel-opt' + (opt.left > 0 ? '' : ' spent') + (opt.pool === 'pact' ? ' pact' : '');
    el.style.setProperty('--ox', (Math.cos(opt.angle) * radius) + 'px');
    el.style.setProperty('--oy', (Math.sin(opt.angle) * radius) + 'px');
    el.style.animationDelay = (i * 18) + 'ms';
    const lvl = document.createElement('span');
    lvl.className = 'cast-wheel-level';
    lvl.textContent = spellLevelLabel(opt.level).replace(' Level', '');
    const sub = document.createElement('span');
    sub.className = 'cast-wheel-sub';
    sub.textContent = opt.pool === 'pact' ? `Pact · ${opt.left}` : `${opt.left} left`;
    el.append(lvl, sub);
    opt.el = el;
    anchor.appendChild(el);
  });

  castWheelEl.style.setProperty('--wx', Math.max(reach + pad, Math.min(g.x0, window.innerWidth - reach - pad)) + 'px');
  castWheelEl.style.setProperty('--wy', Math.max(reach + pad, Math.min(g.y0, window.innerHeight - reach - pad)) + 'px');
  castWheelEl.classList.remove('hidden');
  paintCastWheel();
}

// The option under the pointer, or — in the middle — the one a plain click
// would spend. A spent one (or none at all) means letting go casts nothing.
function paintCastWheel() {
  const g = castGesture;
  if (!g) return;
  const shown = g.hover ?? g.pick;
  g.options.forEach(o => o.el?.classList.toggle('active', o === shown));
  const baseLevel = findSpellById(g.spellId)?.level ?? 1;
  castWheelEl.querySelector('.cast-wheel-caption').textContent =
    !shown ? 'No slots left'
    : shown.left <= 0 ? 'None left'
    : castLevelText(shown.level, baseLevel, shown.pool === 'pact');
  castWheelEl.classList.toggle('blocked', !shown || shown.left <= 0);
}

function endCastGesture(cast) {
  const g = castGesture;
  if (!g) return;
  castGesture = null;
  clearTimeout(g.timer);
  castWheelEl.classList.add('hidden');
  castWheelEl.classList.remove('blocked');
  try { g.card.releasePointerCapture(g.pointerId); } catch (_) { /* never captured */ }
  if (!cast) return;
  if (g.hover && g.hover.left <= 0) return; // let go on a spent option: backed out
  // Re-read off the character rather than trusted from the press — a sync may
  // have spent that slot while the wheel was open.
  const spell = findSpellById(g.spellId);
  const chosen = g.hover ?? g.pick;
  const fresh = spell && chosen
    ? castOptions(state.character, spell).find(o => o.pool === chosen.pool && o.level === chosen.level)
    : null;
  castSpell(g.spellId, fresh ?? null);
}

window.addEventListener('pointermove', e => {
  const g = castGesture;
  if (!g) return;
  const dx = e.clientX - g.x0;
  const dy = e.clientY - g.y0;
  if (!g.shown && g.options.length > 1 && Math.hypot(dx, dy) > CAST_WHEEL_REACH) openCastWheel();
  if (!g.shown) return;
  if (Math.hypot(dx, dy) < CAST_WHEEL_DEADZONE) {
    g.hover = null;
  } else {
    // The option whose direction is nearest the pointer's.
    const a = Math.atan2(dy, dx);
    const off = o => Math.abs(Math.atan2(Math.sin(a - o.angle), Math.cos(a - o.angle)));
    g.hover = g.options.reduce((best, o) => off(o) < off(best) ? o : best);
  }
  paintCastWheel();
});

window.addEventListener('pointerup', () => endCastGesture(true));
window.addEventListener('pointercancel', () => endCastGesture(false));
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && castGesture) endCastGesture(false);
});

const spellListEl = document.getElementById('spell-list');

spellListEl.addEventListener('pointerdown', e => {
  const card = e.target.closest('.spell-card.castable');
  if (card) beginCastGesture(e, card);
});

// The keyboard's way in: Enter or Space on a focused card casts the default,
// as a click does.
spellListEl.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target.closest('.spell-card.castable');
  if (!card || card !== e.target) return;
  e.preventDefault();
  e.stopPropagation(); // or Enter would open the chat modal too
  const spell = findSpellById(card.dataset.spellId);
  if (spell) castSpell(spell.id, defaultCastOption(castOptions(state.character, spell)));
});

// =============================================================================
// THE HOVER CARD
// =============================================================================
// Hovering a row of Available Spells shows the spell in full — the same card
// Spells Known draws, plus its level and classes, which a known spell gets from
// its heading instead. Out beside the sidebar, at the row's height, so the list
// stays readable under it. A short delay, not the item tooltip's 1.2 s: this is
// a list read by running the pointer down it.
const SPELL_HOVER_DELAY_MS = 300;
const spellHoverEl = document.getElementById('spell-hover-card');
let spellHoverTimer = null;

function scheduleSpellHoverCard(spell, row) {
  hideSpellHoverCard();
  spellHoverTimer = setTimeout(() => showSpellHoverCard(spell, row), SPELL_HOVER_DELAY_MS);
}

function hideSpellHoverCard() {
  clearTimeout(spellHoverTimer);
  spellHoverTimer = null;
  spellHoverEl.classList.add('hidden');
  spellHoverEl.textContent = '';
}

function showSpellHoverCard(spell, row) {
  if (!row.isConnected) return; // the list was redrawn under the timer
  const card = spellCard(spell);
  const line = document.createElement('div');
  line.className = 'spell-hover-level';
  line.textContent = [
    spell.level === 0 ? 'Cantrip' : spellLevelLabel(spell.level),
    spell.school,
    spell.classes.join(', '),
  ].filter(Boolean).join(' · ');
  card.querySelector('.spell-card-head').after(line);
  spellHoverEl.textContent = '';
  spellHoverEl.appendChild(card);
  spellHoverEl.classList.remove('hidden');

  // Left of the sidebar, tops aligned with the row, kept inside the window.
  const pad = 8;
  const r = row.getBoundingClientRect();
  const panel = row.closest('#sidebar')?.getBoundingClientRect() ?? r;
  const w = spellHoverEl.offsetWidth;
  const h = spellHoverEl.offsetHeight;
  spellHoverEl.style.left = Math.max(pad, panel.left - w - pad) + 'px';
  spellHoverEl.style.top = Math.max(pad, Math.min(r.top, window.innerHeight - h - pad)) + 'px';
}

// The card isn't anchored to anything that moves, so a scroll would leave it
// beside the wrong row; and C/I/S can switch the view out from under it.
document.addEventListener('scroll', hideSpellHoverCard, { capture: true });
document.addEventListener('keydown', hideSpellHoverCard);
window.addEventListener('resize', hideSpellHoverCard);

function spellNote(text) {
  const p = document.createElement('p');
  p.className = 'spell-note';
  p.textContent = text;
  return p;
}
