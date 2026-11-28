// =============================================================================
// SPELLS — spell slots and the spells a character's classes give access to
// =============================================================================
'use strict';

// Two registries, `data/spell-slots.json` (slots per spell level, indexed by a
// class's OWN level) and `data/spells.json` (each spell tagged with the classes
// that cast it), drawn onto the Spells view. Classes are matched by name, as in
// class-features.js; a class with no slot table grants no spells.
//
// Slot totals follow the Multiclass Spellcaster table (_getMulticlassCasterLevel()).
// Warlock's Pact Magic is its own pool, never blended into that total.
// The view can be turned off per character (`character.spellsEnabled`, default on).
//
// The Available Spells panel offers every class the spell data knows, not only the
// character's own, because a feat (Magic Initiate) can grant a spell from any class.

// Multiclass Spellcaster table membership. Warlock is never matched: Pact Magic is its own pool.
const FULL_CASTER_CLASSES = ['Bard', 'Cleric', 'Druid', 'Sorcerer', 'Wizard'];
const HALF_CASTER_CLASSES = ['Paladin', 'Ranger', 'Artificer'];
// The class alone grants nothing; only this exact subclass (trimmed, case-insensitive) does.
const THIRD_CASTER_SUBCLASSES = [
  { className: 'Fighter', subclassName: 'Eldritch Knight' },
  { className: 'Rogue', subclassName: 'Arcane Trickster' },
];

// Browser furniture, not a fact about any character: never saved or synced.
const SPELLBOOK_PREFS_KEY = 'dnd_inventory_spellbook';
const SPELLBOOK_SORT_MODES = ['class', 'school', 'all'];

const TIME_UNIT_MINUTES = { round: 0.1, minute: 1, hour: 60, day: 1440 }; // minutes per unit
const ACTION_TAGS = ['Action', 'Bonus Action', 'Reaction'];

// Each facet boils a spell's free text down to short tags, ranked the way a reader
// thinks of them (Action before 1 minute before 1 hour). `all: true` means a spell
// must carry EVERY checked tag (tick M to find spells that need one); the rest match ANY.
const SPELLBOOK_FACETS = [
  { key: 'schools', label: 'Schools', tags: s => [s.school || 'Other'], rank: () => 0 },
  { key: 'castingTimes', label: 'Casting Time', tags: _getSpellCastingTimeTags, rank: _getCastingTimeRank },
  { key: 'components', label: 'Components', tags: _getSpellComponentTags, rank: t => 'VSM'.indexOf(t), all: true,
    titles: { V: 'Verbal', S: 'Somatic', M: 'Material' } },
  { key: 'ranges', label: 'Range', tags: _getSpellRangeTags, rank: _getRangeRank },
  { key: 'durations', label: 'Duration', tags: _getSpellDurationTags, rank: _getDurationRank },
];

// Schools with a glyph (img/icon/spells/, .ico-school-* in icons.css), lower-cased.
// Anything else (homebrew, a typo) is printed as text instead.
const SPELL_SCHOOLS_WITH_ICONS = ['abjuration', 'conjuration', 'divination', 'enchantment',
  'evocation', 'illusion', 'necromancy', 'transmutation'];

const SPELL_SLOT_POOLS = ['slots', 'pact'];

// Hold time before the cast wheel opens, and movement (px) that opens it sooner;
// the advantage wheel's own feel (dice.js), so the two gestures read alike.
const CAST_WHEEL_HOLD_MS = 180;
const CAST_WHEEL_REACH = 9;
const CAST_WHEEL_DEADZONE = 24; // px; letting go inside it casts the default pick

// Short, not the item tooltip's 1.2 s: the list is read by running the pointer down it.
const SPELL_HOVER_DELAY_MS = 300;

// ─── LOADING THE REGISTRIES ───
let DEFAULT_SPELL_SLOTS = [];
let DEFAULT_MULTICLASS_SLOTS = {};
let DEFAULT_SPELLS = [];

function _loadDefaultSpellSlots() {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'data/spell-slots.json', false); // synchronous, like classes.json
    xhr.send();
    if (xhr.status !== 200) throw new Error(`HTTP ${xhr.status}`);
    const body = xhr.responseText.trim();
    if (body.startsWith('<')) throw new Error('not JSON'); // an unknown-path index page
    const parsed = JSON.parse(body);
    DEFAULT_SPELL_SLOTS = _sanitizeSpellSlotClasses(parsed.classes);
    DEFAULT_MULTICLASS_SLOTS = _sanitizeSlotsByLevel(parsed.multiclassSlotsByLevel);
  } catch (e) {
    // not fatal — the sheet is usable with no slot table known
    DEFAULT_SPELL_SLOTS = [];
    DEFAULT_MULTICLASS_SLOTS = {};
  }
}

function _loadDefaultSpells() {
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

// Shared by a class's `slotsByLevel` and `multiclassSlotsByLevel`: level → nine numbers.
function _sanitizeSlotsByLevel(raw) {
  const slotsByLevel = {};
  Object.entries(raw ?? {}).forEach(([level, slots]) => {
    const lvl = parseInt(level, 10);
    if (!Number.isFinite(lvl) || lvl < 1 || lvl > 20) return;
    if (!Array.isArray(slots)) return;
    slotsByLevel[lvl] = Array.from({ length: 9 }, (_, i) => Math.max(0, parseInt(slots[i], 10) || 0));
  });
  return slotsByLevel;
}

function _sanitizeSpellSlotClasses(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(c => {
    const name = String(c?.name ?? '').trim();
    if (!name) return null;
    const slotsByLevel = _sanitizeSlotsByLevel(c?.slotsByLevel);
    return Object.keys(slotsByLevel).length
      ? { name, slotsByLevel,
          cantripsByLevel: _sanitizeCountsByLevel(c?.cantripsByLevel),
          preparedByLevel: _sanitizeCountsByLevel(c?.preparedByLevel) }
      : null;
  }).filter(Boolean);
}

// Twenty counts indexed by class level − 1, or null when the table lacks the column.
function _sanitizeCountsByLevel(raw) {
  if (!Array.isArray(raw)) return null;
  return Array.from({ length: 20 }, (_, i) => Math.max(0, parseInt(raw[i], 10) || 0));
}

// Cleans a raw spell list into the app's spell shape, dropping entries with no
// id, name, level or class. Shared with homebrew-share.js.
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
      source: cleanSource(s?.source), // short book label (class-features.js)
      description: String(s?.description ?? ''),
    };
  }).filter(Boolean);
}

_loadDefaultSpellSlots();
_loadDefaultSpells();

// ─── THE REGISTRIES ───
// The app's spells, then usable homebrew ones (homebrew-share.js).
function _getAllSpells() {
  return getSpellsWithHomebrew(DEFAULT_SPELLS);
}

// Trimmed, case-insensitive match against the slot table's class names.
function _findSpellSlotClass(name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key) return null;
  return DEFAULT_SPELL_SLOTS.find(c => c.name.toLowerCase() === key) ?? null;
}

// The slots [level1..level9] for a class at a level, walking down to the nearest
// level present, since a hand-authored table need not be dense.
function _getSpellSlotsForClass(className, level) {
  const def = _findSpellSlotClass(className);
  if (!def) return null;
  const lvl = Math.max(1, Math.min(20, parseInt(level, 10) || 1));
  for (let l = lvl; l >= 1; l--) {
    if (def.slotsByLevel[l]) return def.slotsByLevel[l];
  }
  return [0, 0, 0, 0, 0, 0, 0, 0, 0];
}

// The character's classes that have a slot table, each with its own slots and the
// highest spell level they reach (0 = cantrips only).
function _getSpellcastingEntries(character) {
  return getClassEntries(character)
    .filter(e => _findSpellSlotClass(e.name))
    .map(e => {
      const slots = _getSpellSlotsForClass(e.name, e.level);
      let maxSpellLevel = 0;
      slots.forEach((n, i) => { if (n > 0) maxSpellLevel = i + 1; });
      return { name: e.name, level: e.level, slots, maxSpellLevel };
    });
}

function _isClassNameInList(className, names) {
  const key = className.trim().toLowerCase();
  return names.some(n => n.trim().toLowerCase() === key);
}

// The PHB multiclass caster level, read off RAW `classLevels` rather than
// `_getSpellcastingEntries()`, because Eldritch Knight/Arcane Trickster add levels
// with no slot table of their own. Each class is floored BEFORE summing, per RAW:
// Paladin 3/Ranger 3 is 1+1=2, not floor((3+3)/2)=3.
function _getMulticlassCasterLevel(rawEntries) {
  let level = 0;
  (rawEntries ?? []).forEach(e => {
    const name = String(e?.name ?? '').trim();
    const lvl = Math.max(0, parseInt(e?.level, 10) || 0);
    if (!name || !lvl) return;
    if (_isClassNameInList(name, FULL_CASTER_CLASSES)) {
      level += lvl;
    } else if (_isClassNameInList(name, HALF_CASTER_CLASSES)) {
      level += Math.floor(lvl / 2);
    } else {
      const third = THIRD_CASTER_SUBCLASSES.find(t => _isClassNameInList(name, [t.className]));
      if (third && _isClassNameInList(String(e?.subclass ?? ''), [third.subclassName])) {
        level += Math.floor(lvl / 3);
      }
    }
  });
  return level;
}

// The slots for a blended caster level, with the same nearest-level walk as
// `_getSpellSlotsForClass()`.
function _getMulticlassSpellSlots(casterLevel) {
  const lvl = Math.max(0, Math.min(20, casterLevel));
  for (let l = lvl; l >= 1; l--) {
    if (DEFAULT_MULTICLASS_SLOTS[l]) return DEFAULT_MULTICLASS_SLOTS[l];
  }
  return [0, 0, 0, 0, 0, 0, 0, 0, 0];
}

// Pact Magic, read off the Warlock entry alone at its own level; never blended
// into `_getMulticlassSpellSlots()`.
function _getPactMagicSlots(character) {
  const entry = getClassEntries(character).find(e => _isClassNameInList(String(e?.name ?? ''), ['Warlock']));
  if (!entry || !(parseInt(entry.level, 10) > 0)) return null;
  return _getSpellSlotsForClass('Warlock', entry.level);
}

// Whether this character's Spells view is offered (Character Setup). On unless
// set false, so a save without the field still gets it.
function isSpellSheetEnabled(character) {
  return character?.spellsEnabled !== false;
}

// Whether the character has picked this spell; availability is a separate
// question (`_getSpellbookAvailableSpells()`).
function _isSpellKnown(character, spellId) {
  return Array.isArray(character?.knownSpells) && character.knownSpells.includes(spellId);
}

// How many more cantrips and levelled spells the character may still pick: the
// class tables' Cantrips and Prepared Spells columns, summed across classes,
// less what `knownSpells` already holds. Never negative.
function getSpellChoiceShortfall(character) {
  let cantripLimit = 0;
  let spellLimit = 0;
  getClassEntries(character).forEach(e => {
    const def = _findSpellSlotClass(e.name);
    if (!def) return;
    const i = Math.max(1, Math.min(20, parseInt(e.level, 10) || 1)) - 1;
    cantripLimit += def.cantripsByLevel?.[i] ?? 0;
    spellLimit += def.preparedByLevel?.[i] ?? 0;
  });
  if (!cantripLimit && !spellLimit) return { cantrips: 0, spells: 0 };

  // Ids whose spell is gone (homebrew switched off) count for nothing.
  const levelById = new Map(_getAllSpells().map(s => [s.id, s.level]));
  let cantrips = 0;
  let spells = 0;
  (Array.isArray(character?.knownSpells) ? character.knownSpells : []).forEach(id => {
    if (!levelById.has(id)) return;
    if (levelById.get(id) === 0) cantrips++; else spells++;
  });
  return { cantrips: Math.max(0, cantripLimit - cantrips), spells: Math.max(0, spellLimit - spells) };
}

// "Choose 2 more cantrips and 1 more spell", or '' when nothing is owed.
function _getSpellShortfallText(shortfall) {
  const parts = [];
  if (shortfall.cantrips) parts.push(`${shortfall.cantrips} more cantrip${shortfall.cantrips === 1 ? '' : 's'}`);
  if (shortfall.spells) parts.push(`${shortfall.spells} more spell${shortfall.spells === 1 ? '' : 's'}`);
  return parts.length ? `Choose ${parts.join(' and ')}.` : '';
}

// The only write to `knownSpells`. Guarded by `isReadOnly()` itself, because a
// picker card is a button `renderCharacterSheet()` does not disable.
function _toggleKnownSpell(spellId) {
  if (isReadOnly()) return;
  const known = Array.isArray(state.character.knownSpells) ? state.character.knownSpells.slice() : [];
  const at = known.indexOf(spellId);
  if (at === -1) known.push(spellId); else known.splice(at, 1);
  state.character.knownSpells = known;
  _renderSpellSheetContent(); // bypasses the signature gate — classes/level didn't change
  scheduleSaveAndSync();
}

// ─── FILTER FACETS — every axis but class, read off a spell's own free text ───

// "10 minutes" → 10, "1 day" → 1440; null for anything that isn't a span of time.
function _getTimeSpanMinutes(text) {
  const m = /^(\d+)\s+(round|minute|hour|day)s?$/i.exec(text);
  return m ? parseInt(m[1], 10) * TIME_UNIT_MINUTES[m[2].toLowerCase()] : null;
}

// Sentence case, so "1 Minute" and "1 minute" are one tag. Action types skip it
// (the rules capitalise them).
function _toSentenceCase(text) {
  const t = String(text ?? '').trim();
  return t ? t[0].toUpperCase() + t.slice(1).toLowerCase() : '';
}

// What's left of a field once its parenthetical and any trailing ", which you
// take when…" clause are cut away.
function _getLeadingPhrase(text) {
  return String(text ?? '').split(/\s*[(,]/)[0].trim();
}

function _getSpellCastingTimeTags(spell) {
  const text = String(spell.castingTime ?? '');
  const lead = _getLeadingPhrase(text);
  const action = ACTION_TAGS.find(a => a.toLowerCase() === lead.toLowerCase());
  const tags = [action ?? _toSentenceCase(lead)].filter(Boolean);
  if (/\(ritual\)/i.test(text)) tags.push('Ritual');
  return tags;
}

function _getCastingTimeRank(tag) {
  const action = ACTION_TAGS.indexOf(tag);
  if (action !== -1) return action;
  if (tag === 'Ritual') return 1e9;
  const minutes = _getTimeSpanMinutes(tag);
  return minutes === null ? 1e8 : 10 + minutes;
}

function _getSpellComponentTags(spell) {
  const letters = _getLeadingPhrase(String(spell.components ?? '').replace(/,/g, ' '));
  return ['V', 'S', 'M'].filter(c => new RegExp('\\b' + c + '\\b').test(letters));
}

function _getSpellRangeTags(spell) {
  const tag = _toSentenceCase(_getLeadingPhrase(spell.range));
  return tag ? [tag] : [];
}

function _getRangeRank(tag) {
  if (tag === 'Self') return 0;
  if (tag === 'Touch') return 1;
  const m = /^(\d+)\s+(feet|foot|miles?)$/i.exec(tag);
  if (m) return 10 + parseInt(m[1], 10) * (/^mile/i.test(m[2]) ? 5280 : 1);
  if (tag === 'Sight') return 1e8;
  if (tag === 'Unlimited') return 1e8 + 1;
  return 1e9; // Special, and anything homebrew writes in
}

// Concentration is its own tag alongside the span it lasts, so "1 minute"
// finds a minute-long spell whether or not it needs concentration, and
// "Concentration" finds every one that does.
function _getSpellDurationTags(spell) {
  const text = String(spell.duration ?? '').trim();
  const needsConcentration = /^concentration/i.test(text);
  const span = text.replace(/^concentration,?\s*/i, '').replace(/^up to\s*/i, '');
  const tags = span ? [_toSentenceCase(span)] : [];
  if (needsConcentration) tags.push('Concentration');
  return tags;
}

function _getDurationRank(tag) {
  if (tag === 'Instantaneous') return 0;
  if (tag === 'Concentration') return 1e9;
  const minutes = _getTimeSpanMinutes(tag);
  if (minutes !== null) return 1 + minutes;
  if (/^until dispelled/i.test(tag)) return 1e7 + tag.length;
  return 1e8;
}

// Whether a spell survives one facet's checked tags.
function _doesSpellPassFacet(spell, facet, checked) {
  if (!checked.length) return true;
  const tags = facet.tags(spell);
  return facet.all ? checked.every(t => tags.includes(t)) : checked.some(t => tags.includes(t));
}

// The options a facet offers: every tag in the pool, plus any tag still
// checked that the pool no longer has (a class unchecked, a level lost) —
// otherwise it would keep filtering with no box left to untick.
function _getSpellbookFacetOptions(facet, available, checked) {
  const tags = new Set(checked);
  available.forEach(spell => facet.tags(spell).forEach(t => tags.add(t)));
  return [...tags].sort((a, b) => facet.rank(a) - facet.rank(b) || a.localeCompare(b));
}

function _areSpellbookFiltersDefault(prefs) {
  return !prefs.hiddenClasses.length && !prefs.shownExtraClasses.length &&
    SPELLBOOK_FACETS.every(f => !prefs[f.key].length);
}

// ─── THE AVAILABLE SPELLS PANEL — the pool, and its filter/sort preferences ───
// Session-only, like Browse's own search box — what's typed is a moment's
// question, not a preference worth keeping.
let spellbookQuery = '';

function _doesSpellNameMatch(spell, query) {
  return !query || spell.name.toLowerCase().includes(query);
}

// Every list empty. Facet lists are opt-IN (empty = no filter on that axis), and
// empty class lists already mean "only the character's own classes checked".
function _getDefaultSpellbookFilters() {
  const prefs = { hiddenClasses: [], shownExtraClasses: [] };
  SPELLBOOK_FACETS.forEach(f => { prefs[f.key] = []; });
  return prefs;
}

function _loadSpellbookPrefs() {
  const strings = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(SPELLBOOK_PREFS_KEY)); } catch (e) { /* private mode */ }
  const prefs = _getDefaultSpellbookFilters();
  Object.keys(prefs).forEach(key => { prefs[key] = strings(raw?.[key]); });
  prefs.sortMode = SPELLBOOK_SORT_MODES.includes(raw?.sortMode) ? raw.sortMode : 'class';
  return prefs;
}

let spellbookPrefs = _loadSpellbookPrefs();

function _saveSpellbookPrefs() {
  try { localStorage.setItem(SPELLBOOK_PREFS_KEY, JSON.stringify(spellbookPrefs)); } catch (e) { /* private mode */ }
}

// Every class the spell data knows, alphabetically. Deliberately not limited to the
// character's own: a feat can grant a spell from a class they have no levels in.
function _getSpellbookAllClassNames() {
  const names = new Set();
  _getAllSpells().forEach(s => s.classes.forEach(c => names.add(c)));
  return [...names].sort((a, b) => a.localeCompare(b));
}

// The panel's class rows: own spellcasting classes first (carrying `entry` for the
// level gate), then every other class. `own` picks the gate and the prefs list.
function _getSpellbookClassRows(entries) {
  const ownNames = new Set(entries.map(e => e.name));
  const extra = _getSpellbookAllClassNames().filter(n => !ownNames.has(n));
  return entries.map(e => ({ name: e.name, own: true, entry: e }))
    .concat(extra.map(name => ({ name, own: false, entry: null })));
}

// Owned classes are opt-OUT (`hiddenClasses`), others opt-IN (`shownExtraClasses`),
// so empty prefs already mean "only your own checked", with no first-run setup.
function _isSpellbookClassChecked(row) {
  return row.own
    ? !spellbookPrefs.hiddenClasses.includes(row.name)
    : spellbookPrefs.shownExtraClasses.includes(row.name);
}

function _setSpellbookClassChecked(row, isChecked) {
  const list = row.own ? spellbookPrefs.hiddenClasses : spellbookPrefs.shownExtraClasses;
  const shouldBeListed = row.own ? !isChecked : isChecked;
  const at = list.indexOf(row.name);
  if (shouldBeListed && at === -1) list.push(row.name);
  else if (!shouldBeListed && at !== -1) list.splice(at, 1);
  _saveSpellbookPrefs();
  _renderSpellSheetContent();
}

// The one reachability rule: an owned class is gated by its own slots, any other
// class grants on a name match. A tag alone is not enough for an owned class, or
// Misty Step (Wizard/Warlock) would read "granted by Wizard" to a low Wizard.
function _doesRowGrantSpell(spell, row) {
  if (!_isClassNameInList(row.name, spell.classes)) return false;
  if (!row.own) return true;
  return spell.level === 0 || row.entry.maxSpellLevel >= spell.level;
}

// The names of every row that grants this spell, own classes first. A spell
// shared by two (Guidance for a Cleric/Druid) is listed under both.
function _getSpellGrantingClasses(spell, classRows) {
  return classRows.filter(r => _doesRowGrantSpell(spell, r)).map(r => r.name);
}

// The panel's whole pool, independent of the checkboxes: they decide only what is
// displayed (`_getSpellbookSections()`). Any spell some row grants belongs here.
function _getSpellbookAvailableSpells(classRows) {
  return _getAllSpells()
    .filter(spell => _getSpellGrantingClasses(spell, classRows).length > 0)
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
}

// Every facet's checked tags. Class is not a facet: in Class mode it picks the
// group a spell is listed under.
function _doesSpellPassFacets(spell, prefs) {
  return SPELLBOOK_FACETS.every(f => _doesSpellPassFacet(spell, f, prefs[f.key]));
}

// The whole filter: granted by a checked class, and through every facet. What
// a search shows in full; anything else it matches is greyed below.
function _doesSpellPassFilters(spell, classRows, prefs) {
  const enabledNames = new Set(classRows.filter(_isSpellbookClassChecked).map(r => r.name));
  return _doesSpellPassFacets(spell, prefs) &&
    _getSpellGrantingClasses(spell, classRows).some(c => enabledNames.has(c));
}

// Groups `available` by class (checked, in `classRows` order), by school, or into
// one flat list (`all`), each by level then name. A spell is repeated per class
// group, never for school/all. Filtering hides a spell; `knownSpells` is untouched.
function _getSpellbookSections(available, classRows, prefs) {
  const byLevelThenName = (a, b) => a.level - b.level || a.name.localeCompare(b.name);
  const isVisible = spell => _doesSpellPassFilters(spell, classRows, prefs);

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
  classRows.forEach(row => { if (_isSpellbookClassChecked(row)) byClass.set(row.name, []); });
  available.forEach(spell => {
    if (!_doesSpellPassFacets(spell, prefs)) return;
    _getSpellGrantingClasses(spell, classRows).forEach(cls => {
      if (byClass.has(cls)) byClass.get(cls).push(spell);
    });
  });
  return [...byClass.entries()]
    .filter(([, spells]) => spells.length)
    .map(([heading, spells]) => ({ heading, spells: spells.sort(byLevelThenName) }));
}

// A picker card's meta line: whichever axis isn't the group heading. The school
// shows as its glyph (createSchoolIcon()), so only an unrecognised one is printed.
function _getSpellPickerMeta(spell, classRows, prefs) {
  const classes = _getSpellGrantingClasses(spell, classRows);
  const schoolText = _getSchoolIconName(spell.school) ? '' : (spell.school || '');
  if (prefs.sortMode === 'class') return schoolText;
  return [schoolText, classes.join(', ')].filter(Boolean).join(' · ');
}

function _renderSpellbookSettings(classRows, available) {
  const classBox = document.getElementById('spellbook-class-filters');
  const facetBox = document.getElementById('spellbook-facet-filters');
  if (!classBox || !facetBox) return;

  classBox.textContent = '';
  classRows.forEach(row => {
    classBox.appendChild(_createSpellbookFilterCheckbox(
      row.name, _isSpellbookClassChecked(row),
      isChecked => _setSpellbookClassChecked(row, isChecked)));
  });

  facetBox.textContent = '';
  SPELLBOOK_FACETS.forEach(facet => {
    const checked = spellbookPrefs[facet.key];
    const options = _getSpellbookFacetOptions(facet, available, checked);
    if (!options.length) return;
    const section = document.createElement('div');
    const label = document.createElement('span');
    label.className = 'spellbook-settings-label';
    label.textContent = facet.label;
    const group = document.createElement('div');
    group.className = 'spellbook-filter-group';
    options.forEach(tag => {
      const box = _createSpellbookFilterCheckbox(tag, checked.includes(tag),
        isChecked => _setSpellbookFilter(facet.key, tag, isChecked));
      if (facet.titles?.[tag]) box.title = facet.titles[tag];
      group.appendChild(box);
    });
    section.append(label, group);
    facetBox.appendChild(section);
  });

  document.querySelectorAll('#spellbook-sort input[name="spellbook-sort"]').forEach(radio => {
    radio.checked = radio.value === spellbookPrefs.sortMode;
  });
  // The panel folds away, so the button says when something in it is narrowing the list.
  const isFiltered = !_areSpellbookFiltersDefault(spellbookPrefs);
  document.getElementById('spellbook-settings-btn').classList.toggle('filtered', isFiltered);
  document.getElementById('spellbook-reset-filters').disabled = !isFiltered;
}

function _createSpellbookFilterCheckbox(label, checked, onChange) {
  const wrap = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked));
  wrap.append(box, document.createTextNode(label));
  return wrap;
}

function _setSpellbookFilter(prefKey, name, isChecked) {
  const list = spellbookPrefs[prefKey];
  const at = list.indexOf(name);
  if (isChecked && at === -1) list.push(name);
  else if (!isChecked && at !== -1) list.splice(at, 1);
  _saveSpellbookPrefs();
  _renderSpellSheetContent();
}

// Every facet unticked and the class boxes back to the character's own —
// the sort mode and the search box are not filters, and are left alone.
function _resetSpellbookFilters() {
  spellbookPrefs = { ..._getDefaultSpellbookFilters(), sortMode: spellbookPrefs.sortMode };
  _saveSpellbookPrefs();
  _renderSpellSheetContent();
}

document.getElementById('spellbook-reset-filters').addEventListener('click', _resetSpellbookFilters);

document.getElementById('spellbook-search').addEventListener('input', e => {
  spellbookQuery = e.target.value.trim().toLowerCase();
  _renderSpellSheetContent();
  document.getElementById('spellbook-list').scrollTop = 0;
});

document.getElementById('spellbook-settings-btn').addEventListener('click', () => {
  document.getElementById('spellbook-settings').classList.toggle('hidden');
});

document.querySelectorAll('#spellbook-sort input[name="spellbook-sort"]').forEach(radio => {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    spellbookPrefs.sortMode = SPELLBOOK_SORT_MODES.includes(radio.value) ? radio.value : 'class';
    _saveSpellbookPrefs();
    _renderSpellSheetContent();
  });
});

// ─── THE SECTION ───
// `syncCharacterViewUI()` re-runs on every roster sync, but this view only
// changes with classes and levels — same guard as `classFeaturesSig`.
let spellSheetSig = null;

function _getSpellSheetSignature() {
  const c = state.character || {};
  // Subclass is part of the signature — the Eldritch Knight/Arcane Trickster
  // check in `_getMulticlassCasterLevel()` reads it, same as `classFeaturesSig`.
  return getClassEntries(c).map(e => `${e.name}:${e.level}:${e.subclass}`).join('␟') +
    '‖' + getHomebrewUsableKey() + // a homebrew spell enabled or edited under the sheet
    '‖' + JSON.stringify(c.spellSlotsUsed ?? null); // a cast, synced in from whoever made it
}

// Redraws the Spells view when its signature changes (classes, usable homebrew, slots spent).
function renderSpellSheet() {
  const sig = _getSpellSheetSignature();
  if (sig === spellSheetSig) return;
  spellSheetSig = sig;
  _renderSpellSheetContent();
}

// The draw itself, outside the signature gate, so a known-spell toggle or prefs
// change (neither in the signature) can force a repaint.
function _renderSpellSheetContent() {
  // Emptying the lists collapses both scrollers to the top; put them back after the rebuild.
  const scrollers = ['spell-sheet', 'spellbook-list']
    .map(id => document.getElementById(id))
    .filter(Boolean)
    .map(el => ({ el, top: el.scrollTop }));
  _drawSpellSheetContent();
  scrollers.forEach(({ el, top }) => { el.scrollTop = top; });
}

function _drawSpellSheetContent() {
  const slotsBox = document.getElementById('spell-slots');
  const listBox = document.getElementById('spell-list');
  const pickerBox = document.getElementById('spellbook-list');
  if (!slotsBox || !listBox || !pickerBox) return;

  const character = state.character;
  const rawEntries = getClassEntries(character);
  const entries = _getSpellcastingEntries(character);

  slotsBox.textContent = '';
  listBox.textContent = '';
  pickerBox.textContent = '';
  _hideSpellHoverCard(); // its row is gone, and no pointerleave will say so

  // Slots come from the RAW class list, not `entries`: Eldritch Knight/Arcane
  // Trickster add slots despite having no spell-list data.
  const casterLevel = _getMulticlassCasterLevel(rawEntries);
  const totals = _getMulticlassSpellSlots(casterLevel);
  const pact = _getPactMagicSlots(character);
  const hasTotals = totals.some(n => n > 0);
  const hasPact = !!pact && pact.some(n => n > 0);
  const readOnly = isReadOnly();

  if (hasTotals) slotsBox.appendChild(_createSpellSlotGroup(totals, 'slots', readOnly));
  if (hasPact) {
    if (hasTotals) slotsBox.appendChild(_createSpellbookGroupHeading('Pact Magic'));
    slotsBox.appendChild(_createSpellSlotGroup(pact, 'pact', readOnly));
  }
  _balanceSpellSlotRows();
  if (!hasTotals && !hasPact && (entries.length || casterLevel > 0)) {
    slotsBox.appendChild(_createSpellNote('No spell slots yet — cantrips only.'));
  }

  if (!entries.length) {
    const names = rawEntries.map(e => e.name);
    const note = names.length
      ? `No known spellcasting class among ${names.map(n => `“${n}”`).join(', ')}.`
      : 'Add a class in Character Setup to see its spells.';
    listBox.appendChild(_createSpellNote(note));
    pickerBox.appendChild(_createSpellNote(note));
    _renderSpellbookSettings([], []);
    return;
  }

  const classRows = _getSpellbookClassRows(entries);
  const available = _getSpellbookAvailableSpells(classRows);
  _renderSpellbookSettings(classRows, available);

  // Says what the reminder glow on this panel is asking for (pending-choices.js).
  const shortfallText = _getSpellShortfallText(getSpellChoiceShortfall(character));
  if (shortfallText && !readOnly) {
    const note = _createSpellNote(shortfallText);
    note.classList.add('spell-pending-note');
    pickerBox.appendChild(note);
  }

  if (!available.length) {
    listBox.appendChild(_createSpellNote('No spells known at this level yet.'));
    pickerBox.appendChild(_createSpellNote('No spells available at this level yet.'));
    return;
  }

  const known = available.filter(s => _isSpellKnown(character, s.id));
  if (!known.length) {
    listBox.appendChild(_createSpellNote('Nothing picked yet — choose from Available Spells.'));
  } else {
    let lastLevel = null;
    known.forEach(spell => {
      if (spell.level !== lastLevel) {
        lastLevel = spell.level;
        listBox.appendChild(_createSpellLevelHeading(spell.level));
      }
      listBox.appendChild(_createCastableSpellCard(spell, readOnly));
    });
  }

  // A search shows matches inside the filters first, then the rest greyed (still pickable).
  const query = spellbookQuery;
  const named = available.filter(s => _doesSpellNameMatch(s, query));
  const sections = _getSpellbookSections(named, classRows, spellbookPrefs);
  const outside = query ? named.filter(s => !_doesSpellPassFilters(s, classRows, spellbookPrefs)) : [];
  if (!sections.length) {
    pickerBox.appendChild(_createSpellNote(
      !query ? 'Nothing matches the current filters.'
      : outside.length ? 'Nothing within the current filters.'
      : `No spell called “${document.getElementById('spellbook-search').value.trim()}”.`));
  }
  sections.forEach(({ heading, spells }) => {
    if (heading) pickerBox.appendChild(_createSpellbookGroupHeading(heading));
    let lastLevel = null;
    spells.forEach(spell => {
      if (spell.level !== lastLevel) {
        lastLevel = spell.level;
        pickerBox.appendChild(_createSpellLevelHeading(spell.level));
      }
      pickerBox.appendChild(_createSpellPickerCard(
        spell, _isSpellKnown(character, spell.id), readOnly,
        _getSpellPickerMeta(spell, classRows, spellbookPrefs)));
    });
  });
  if (outside.length) {
    pickerBox.appendChild(_createSpellbookGroupHeading('Outside your filters'));
    outside.forEach(spell => {
      const card = _createSpellPickerCard(spell, _isSpellKnown(character, spell.id), readOnly,
        [spell.level === 0 ? 'Cantrip' : _getSpellLevelLabel(spell.level).replace(' Level', ''),
          _getSpellGrantingClasses(spell, classRows).join(', ')].filter(Boolean).join(' · '));
      card.classList.add('outside');
      pickerBox.appendChild(card);
    });
  }
}

function _createSpellbookGroupHeading(text) {
  const h = document.createElement('h4');
  h.className = 'spellbook-group-heading';
  h.textContent = text;
  return h;
}

function _getSpellLevelLabel(level) {
  if (level === 0) return 'Cantrips';
  const suffix = level === 1 ? 'st' : level === 2 ? 'nd' : level === 3 ? 'rd' : 'th';
  return `${level}${suffix} Level`;
}

// One pool's tiles. Its rows are evened out by `_balanceSpellSlotRows()`.
function _createSpellSlotGroup(counts, pool, readOnly) {
  const group = document.createElement('div');
  group.className = 'spell-slot-group';
  counts.forEach((count, i) => { if (count > 0) group.appendChild(_createSpellSlotTile(i + 1, count, pool, readOnly)); });
  return group;
}

// Deals the tiles evenly over the fewest rows that fit (7 → 4 + 3, not 6 + 1),
// marking row ends with breaks the CSS honours. Re-run on redraw and on resize,
// since the box moves between a narrow column and full width (spells.css).
function _balanceSpellSlotRows() {
  const box = document.getElementById('spell-slots');
  const width = box.clientWidth;
  if (!width) return; // the view is hidden — the observer re-runs this on show
  const cs = getComputedStyle(box);
  const tileW = parseFloat(cs.getPropertyValue('--slot-tile-w'));
  const gap = parseFloat(cs.getPropertyValue('--slot-gap'));
  const fit = Math.max(1, Math.floor((width + gap) / (tileW + gap)));
  box.querySelectorAll('.spell-slot-group').forEach(group => {
    group.querySelectorAll('.spell-slot-break').forEach(b => b.remove());
    const tiles = [...group.children];
    const rows = Math.ceil(tiles.length / fit);
    // The first `tiles % rows` rows take one extra, so longer rows lead.
    let at = 0;
    for (let r = 0; r < rows - 1; r++) {
      at += Math.floor(tiles.length / rows) + (r < tiles.length % rows ? 1 : 0);
      const br = document.createElement('span');
      br.className = 'spell-slot-break';
      tiles[at - 1].after(br);
    }
  });
}

new ResizeObserver(_balanceSpellSlotRows).observe(document.getElementById('spell-slots'));

// Slots left over slots in all, and a pip per slot — filled while unspent.
// A pip is the manual fix for a cast made by mistake (or one made at the
// table without the app): clicking a filled pip spends down to it, an empty
// one refills up to it, the way a paper tracker is ticked.
function _createSpellSlotTile(level, count, pool, readOnly) {
  const left = _getSpellSlotsLeft(state.character, pool, level, count);

  const tile = document.createElement('div');
  tile.className = 'spell-slot-tile' + (left === 0 ? ' spent' : '');

  const lvl = document.createElement('span');
  lvl.className = 'spell-slot-level';
  lvl.textContent = _getSpellLevelLabel(level);

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
    pip.setAttribute('aria-label', `${_getSpellLevelLabel(level)} slot ${i + 1}: ${i < left ? 'unspent' : 'spent'}`);
    // Pip i filled → i left (spend it and everything above); empty → i + 1 left.
    pip.addEventListener('click', () => _setSpellSlotsLeft(pool, level, count, i < left ? i : i + 1));
    pips.appendChild(pip);
  }

  tile.append(lvl, n, pips);
  return tile;
}

function _createSpellLevelHeading(level) {
  const h = document.createElement('h4');
  h.className = 'spell-level-heading';
  h.textContent = _getSpellLevelLabel(level);
  return h;
}

// Parsed descriptions keyed by raw Markdown: spell text never changes at runtime,
// so each is parsed and sanitized once.
const spellDescCache = new Map();

function _renderSpellDesc(el, src) {
  const key = String(src ?? '');
  let tpl = spellDescCache.get(key);
  if (!tpl) {
    tpl = document.createElement('template');
    renderMarkdownInto(tpl.content, key);
    spellDescCache.set(key, tpl);
  }
  el.appendChild(tpl.content.cloneNode(true));
}

function _getSchoolIconName(school) {
  const key = String(school ?? '').trim().toLowerCase();
  return SPELL_SCHOOLS_WITH_ICONS.includes(key) ? key : null;
}

// The school's glyph element, or null for a school with none.
function createSchoolIcon(school) {
  const key = _getSchoolIconName(school);
  if (!key) return null;
  const el = createIconEl('school-' + key);
  el.classList.add('ico-school');
  el.title = String(school).trim();
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', el.title);
  return el;
}

function _createSpellCard(spell) {
  const card = document.createElement('article');
  card.className = 'spell-card';

  const head = document.createElement('div');
  head.className = 'spell-card-head';
  const name = document.createElement('h5');
  name.className = 'spell-name';
  name.textContent = spell.name;
  head.appendChild(name);
  const icon = createSchoolIcon(spell.school);
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

  // A `<div>`: the Markdown comes back block-level. Markup is built only through
  // `_renderSpellDesc` (markdown.js and its sanitizer), never directly.
  const desc = document.createElement('div');
  desc.className = 'spell-desc';
  _renderSpellDesc(desc, spell.description);

  card.append(head, meta, desc);
  // The school's glyph rides the card's top-right corner, large — see .spell-card .ico-school.
  if (icon) { card.classList.add('has-school-icon'); card.appendChild(icon); }
  return card;
}

// A row in the Available Spells panel; the whole card is the toggle. `metaText`
// comes from `_getSpellPickerMeta()`.
function _createSpellPickerCard(spell, isKnown, readOnly, metaText) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'spell-pick-card' + (isKnown ? ' known' : '');
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
  const icon = createSchoolIcon(spell.school);
  if (icon) card.appendChild(icon);
  card.addEventListener('click', () => _toggleKnownSpell(spell.id));
  card.addEventListener('pointerenter', () => _scheduleSpellHoverCard(spell, card));
  card.addEventListener('pointerleave', _hideSpellHoverCard);
  return card;
}

// ─── CASTING — spending slots, and the upcast wheel ───
// A click on a Spells Known card casts from the lowest slot that can; a held press
// opens a wheel of every slot level instead. `character.spellSlotsUsed = { slots,
// pact }` stores slots SPENT per level (index 0 = 1st), never slots left, so a
// level-up's new slot arrives fresh. Gated by `isReadOnly()`, unlike a roll: a cast writes.
const castWheelEl = document.getElementById('cast-wheel');

function _getSpellSlotsUsed(character, pool, level) {
  const n = parseInt(character?.spellSlotsUsed?.[pool]?.[level - 1], 10);
  return n > 0 ? n : 0;
}

function _getSpellSlotsLeft(character, pool, level, total) {
  return Math.max(0, total - _getSpellSlotsUsed(character, pool, level));
}

// Rewritten whole, as a dense nine-number array — RTDB reads a sparse one back
// as an object, which the reader above would survive but needn't.
function _setSpellSlotsUsed(pool, level, used) {
  const c = state.character;
  const arr = Array.from({ length: 9 }, (_, i) => _getSpellSlotsUsed(c, pool, i + 1));
  arr[level - 1] = Math.max(0, used);
  c.spellSlotsUsed = { ...(c.spellSlotsUsed ?? {}), [pool]: arr };
}

function _setSpellSlotsLeft(pool, level, total, left) {
  if (isReadOnly()) return;
  _setSpellSlotsUsed(pool, level, total - Math.max(0, Math.min(total, left)));
  renderSpellSheet(); // slot usage is in the signature
  scheduleSaveAndSync();
}

// Refills every spell slot, for a Long Rest (rest-effects.js).
function restoreSpellSlotsForLongRest()  { _restoreSpellSlots(SPELL_SLOT_POOLS); }

// Refills Pact Magic only, for a Short Rest (rest-effects.js).
function restoreSpellSlotsForShortRest() { _restoreSpellSlots(['pact']); }

function _restoreSpellSlots(pools) {
  if (isReadOnly()) return;
  const c = state.character;
  c.spellSlotsUsed = { ...(c.spellSlotsUsed ?? {}) };
  pools.forEach(pool => { c.spellSlotsUsed[pool] = Array(9).fill(0); });
  renderSpellSheet();
  scheduleSaveAndSync();
}

// Every { pool, level, total, left } this spell could be cast with — any slot
// at or above its own level, in either pool. Lowest level first, and the
// ordinary pool before Pact Magic at the same level. A cantrip has none.
function _getCastOptions(character, spell) {
  if (!(spell.level > 0)) return [];
  const pools = {
    slots: _getMulticlassSpellSlots(_getMulticlassCasterLevel(getClassEntries(character))),
    pact: _getPactMagicSlots(character) ?? [],
  };
  const opts = [];
  SPELL_SLOT_POOLS.forEach(pool => pools[pool].forEach((total, i) => {
    const level = i + 1;
    if (total > 0 && level >= spell.level) {
      opts.push({ pool, level, total, left: _getSpellSlotsLeft(character, pool, level, total) });
    }
  }));
  return opts.sort((a, b) => a.level - b.level || (a.pool === 'pact') - (b.pool === 'pact'));
}

// What a plain click spends: the cheapest slot that still has one left. For a
// Warlock that's the pact slot at its own level — Pact Magic always casts at it.
function _getDefaultCastOption(options) {
  return options.find(o => o.left > 0) ?? null;
}

function _findSpellById(id) {
  return _getAllSpells().find(s => s.id === id) ?? null;
}

// The one write path. `opt` null on a cantrip; on a levelled spell with no
// slot left, nothing is spent or said — the card shakes instead.
function _castSpell(spellId, opt) {
  if (isReadOnly()) return;
  const spell = _findSpellById(spellId);
  if (!spell) return;
  if (spell.level > 0) {
    if (!opt || opt.left <= 0) { _flashSpellCard(spellId, 'no-slot'); return; }
    _setSpellSlotsUsed(opt.pool, opt.level, _getSpellSlotsUsed(state.character, opt.pool, opt.level) + 1);
  }
  renderSpellSheet();
  _flashSpellCard(spellId, 'cast');
  _postCastToChat(spell, spell.level > 0 ? opt : null);
  scheduleSaveAndSync();
}

// Found again by id, because the cast above has just redrawn the list.
function _flashSpellCard(spellId, cls) {
  const card = document.querySelector(`#spell-list .spell-card[data-spell-id="${CSS.escape(spellId)}"]`);
  if (!card) return;
  card.classList.remove('cast', 'no-slot');
  void card.offsetWidth; // restart the animation on a second cast in a row
  card.classList.add(cls);
  card.addEventListener('animationend', () => card.classList.remove(cls), { once: true });
}

// "4th level", plus where the slot came from when that's not obvious.
function getCastLevelText(level, baseLevel, isPactSlot) {
  if (!(level > 0)) return 'Cantrip';
  const text = _getSpellLevelLabel(level).replace(' Level', ' level');
  const notes = [level > baseLevel ? 'upcast' : '', isPactSlot ? 'Pact Magic' : ''].filter(Boolean);
  return notes.length ? `${text} (${notes.join(', ')})` : text;
}

// Pushed from here so a cast's shape lives in one file (as dice.js's rolls do);
// silent with no campaign. `text` is the whole sentence, for clients that draw an
// unknown `kind` as a plain line, and for the tab bubble.
function _postCastToChat(spell, opt) {
  if (typeof canChat !== 'function' || !canChat()) return;
  pinChatToNewest();

  const character = String(state.character?.name ?? '').trim();
  const level = opt ? opt.level : 0;
  const pact = opt?.pool === 'pact';
  const sentence = `${character || getChatAuthorName()} casts ${spell.name}` +
    (level > 0 ? ` at ${getCastLevelText(level, spell.level, pact)}` : '') + '.';

  firebaseDb.ref('parties/' + state.party.code + '/chat').push({
    uid: getOwnPlayerId(),
    name: getChatAuthorName(),
    kind: 'cast',
    text: sentence,
    cast: {
      spell: spell.name, school: spell.school || '', character,
      level, baseLevel: spell.level, pact,
    },
    at: firebase.database.ServerValue.TIMESTAMP,
  }).catch(() => { /* the slot is spent either way */ });
}

// A Spells Known card, made castable. The hover card draws `_createSpellCard()`
// too, and must not be castable.
function _createCastableSpellCard(spell, readOnly) {
  const card = _createSpellCard(spell);
  card.dataset.spellId = spell.id;
  if (readOnly) return card;
  card.classList.add('castable');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  const opts = _getCastOptions(state.character, spell);
  const pick = _getDefaultCastOption(opts);
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

function _beginCastGesture(e, card) {
  if (e.button !== 0 || isReadOnly()) return;
  if (e.target.closest('a')) return; // a link in the description is still a link
  _endCastGesture(false);
  const spell = _findSpellById(card.dataset.spellId);
  if (!spell) return;
  e.preventDefault(); // no text selection dragging out of the card

  const options = _getCastOptions(state.character, spell);
  castGesture = {
    spellId: spell.id, card, options,
    pick: _getDefaultCastOption(options), hover: null, shown: false,
    x0: e.clientX, y0: e.clientY, pointerId: e.pointerId,
    // One option is nothing to choose between — the wheel never opens.
    timer: options.length > 1 ? setTimeout(_openCastWheel, CAST_WHEEL_HOLD_MS) : null,
  };
  try { card.setPointerCapture(e.pointerId); } catch (_) { /* still works uncaptured */ }
}

// A ring of options around the cursor, the first at twelve o'clock, going
// clockwise up the levels. Nudged only as far as it takes to stay on screen.
function _openCastWheel() {
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
    lvl.textContent = _getSpellLevelLabel(opt.level).replace(' Level', '');
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
  _paintCastWheel();
}

// The option under the pointer, or — in the middle — the one a plain click
// would spend. A spent one (or none at all) means letting go casts nothing.
function _paintCastWheel() {
  const g = castGesture;
  if (!g) return;
  const shown = g.hover ?? g.pick;
  g.options.forEach(o => o.el?.classList.toggle('active', o === shown));
  const baseLevel = _findSpellById(g.spellId)?.level ?? 1;
  castWheelEl.querySelector('.cast-wheel-caption').textContent =
    !shown ? 'No slots left'
    : shown.left <= 0 ? 'None left'
    : getCastLevelText(shown.level, baseLevel, shown.pool === 'pact');
  castWheelEl.classList.toggle('blocked', !shown || shown.left <= 0);
}

function _endCastGesture(cast) {
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
  const spell = _findSpellById(g.spellId);
  const chosen = g.hover ?? g.pick;
  const fresh = spell && chosen
    ? _getCastOptions(state.character, spell).find(o => o.pool === chosen.pool && o.level === chosen.level)
    : null;
  _castSpell(g.spellId, fresh ?? null);
}

window.addEventListener('pointermove', e => {
  const g = castGesture;
  if (!g) return;
  const dx = e.clientX - g.x0;
  const dy = e.clientY - g.y0;
  if (!g.shown && g.options.length > 1 && Math.hypot(dx, dy) > CAST_WHEEL_REACH) _openCastWheel();
  if (!g.shown) return;
  if (Math.hypot(dx, dy) < CAST_WHEEL_DEADZONE) {
    g.hover = null;
  } else {
    // The option whose direction is nearest the pointer's.
    const a = Math.atan2(dy, dx);
    const off = o => Math.abs(Math.atan2(Math.sin(a - o.angle), Math.cos(a - o.angle)));
    g.hover = g.options.reduce((best, o) => off(o) < off(best) ? o : best);
  }
  _paintCastWheel();
});

window.addEventListener('pointerup', () => _endCastGesture(true));
window.addEventListener('pointercancel', () => _endCastGesture(false));
registerEscapeLayer(ESCAPE_TIER.GESTURE, () => !!castGesture, () => _endCastGesture(false));

const spellListEl = document.getElementById('spell-list');

spellListEl.addEventListener('pointerdown', e => {
  const card = e.target.closest('.spell-card.castable');
  if (card) _beginCastGesture(e, card);
});

// The keyboard's way in: Enter or Space on a focused card casts the default,
// as a click does.
spellListEl.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target.closest('.spell-card.castable');
  if (!card || card !== e.target) return;
  e.preventDefault();
  e.stopPropagation(); // or Enter would open the chat modal too
  const spell = _findSpellById(card.dataset.spellId);
  if (spell) _castSpell(spell.id, _getDefaultCastOption(_getCastOptions(state.character, spell)));
});

// ─── THE HOVER CARD ───
// Hovering a row of Available Spells shows the full spell card plus its level and
// classes, beside the sidebar at the row's height so the list stays readable.
const spellHoverEl = document.getElementById('spell-hover-card');
let spellHoverTimer = null;

function _scheduleSpellHoverCard(spell, row) {
  _hideSpellHoverCard();
  spellHoverTimer = setTimeout(() => _showSpellHoverCard(spell, row), SPELL_HOVER_DELAY_MS);
}

function _hideSpellHoverCard() {
  clearTimeout(spellHoverTimer);
  spellHoverTimer = null;
  spellHoverEl.classList.add('hidden');
  spellHoverEl.textContent = '';
}

registerEscapeLayer(ESCAPE_TIER.POPUP, () => !spellHoverEl.classList.contains('hidden'), _hideSpellHoverCard);

function _showSpellHoverCard(spell, row) {
  if (!row.isConnected) return; // the list was redrawn under the timer
  const card = _createSpellCard(spell);
  const line = document.createElement('div');
  line.className = 'spell-hover-level';
  line.textContent = [
    spell.level === 0 ? 'Cantrip' : _getSpellLevelLabel(spell.level),
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
document.addEventListener('scroll', _hideSpellHoverCard, { capture: true });
document.addEventListener('keydown', _hideSpellHoverCard);
window.addEventListener('resize', _hideSpellHoverCard);

function _createSpellNote(text) {
  const p = document.createElement('p');
  p.className = 'spell-note';
  p.textContent = text;
  return p;
}
