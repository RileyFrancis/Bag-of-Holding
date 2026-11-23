// =============================================================================
// SPECIES TRAITS — what a character's species gives them, and the sheet section
// =============================================================================
// Same shape as class-features.js: a registry over `data/species.json` and a
// section that draws it with that file's `buildFeatureCard()` and CSS. Species is
// matched by name (`race`, free text); it is one field, so cards carry no tag.
// A trait's `level` is optional (defaults to 1).
'use strict';

let DEFAULT_SPECIES = [];

// Session-only, not persisted.
let showLockedTraits = false;

// Last signature the trait cards were drawn for (see _getSpeciesTraitsSignature).
let speciesTraitsSig = null;

// ─── LOADING THE SPECIES ───

function _loadDefaultSpecies() {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'data/species.json', false); // synchronous
    xhr.send();
    if (xhr.status !== 200) throw new Error(`HTTP ${xhr.status}`);
    // A host answering unknown paths with its index page would "find" a list
    // made of HTML — the guard firebase-config.js and class-features.js use.
    const body = xhr.responseText.trim();
    if (body.startsWith('<')) throw new Error('not JSON');
    DEFAULT_SPECIES = _sanitizeSpeciesList(JSON.parse(body).species);
  } catch (e) {
    DEFAULT_SPECIES = []; // not fatal — the sheet is usable with no species known
  }
}

// A species with no usable traits is dropped.
function _sanitizeSpeciesList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(s => {
    const id = String(s?.id ?? '').trim();
    const name = String(s?.name ?? '').trim();
    if (!id || !name) return null;
    const traits = (Array.isArray(s.traits) ? s.traits : [])
      .map(t => sanitizeTrait(t))
      .filter(Boolean);
    return traits.length ? { id, name, traits } : null;
  }).filter(Boolean);
}

// One species trait in its stored shape, or null when unusable. `level` is
// optional here (defaults to 1), where a class feature's is required.
function sanitizeTrait(t) {
  const id = String(t?.id ?? '').trim();
  const name = String(t?.name ?? '').trim();
  if (!id || !name) return null;
  const level = parseInt(t?.level, 10);
  return {
    id, name,
    level: Number.isFinite(level) ? Math.max(1, Math.min(20, level)) : 1,
    description: normalizeDescription(t?.description), // shared with class-features.js
    unlocks: normalizeUnlocks(t?.unlocks),              // shared with class-features.js
    options: normalizeFeatureOptions(t?.options),       // shared with class-features.js
  };
}

_loadDefaultSpecies();

// ─── THE REGISTRY ───

// Every usable species: the defaults, then usable homebrew (homebrew-share.js).
function getAllSpecies() {
  return getSpeciesWithHomebrew(DEFAULT_SPECIES);
}

// Trimmed, case-insensitive; ids matched too, so a stored id survives a rename.
function _findSpeciesByName(name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key) return null;
  return getAllSpecies().find(s => s.name.toLowerCase() === key || s.id === key) ?? null;
}

// One place, so a species that ever counts levels differently has somewhere to land.
function _getCharacterSpeciesLevel(character, _speciesDef) {
  return Math.max(1, Math.min(20, parseInt(character?.level, 10) || 1));
}

// Everything the species offers, by level then written order. `owned` is the
// level gate; the section chooses what to draw.
function _getSpeciesTraitRows(character) {
  const def = _findSpeciesByName(character?.race);
  if (!def) return [];
  const level = _getCharacterSpeciesLevel(character, def);
  return def.traits
    .map((t, i) => ({ ...t, speciesName: def.name, order: i, owned: t.level <= level }))
    .sort((a, b) => a.level - b.level || a.order - b.order);
}

// The species traits the character has reached.
function getOwnedSpeciesTraitRows(character) {
  return _getSpeciesTraitRows(character).filter(r => r.owned);
}

// The name typed that this app has never heard of, or '' when blank or known.
function _getUnknownSpeciesName(character) {
  const typed = String(character?.race ?? '').trim();
  return typed && !_findSpeciesByName(typed) ? typed : '';
}

// ─── UNLOCKS ───
// A trait may name sheet parts it brings, exactly as a class feature may (same
// key space, same `data-unlocked-by` markup). class-features.js owns the
// mechanism and unions both halves in `renderClassFeatures()`.

// Keys unlocked by the character's owned species traits.
function getSpeciesUnlockKeys(character) {
  const keys = new Set();
  _getSpeciesTraitRows(character).forEach(row => {
    if (row.owned) row.unlocks.forEach(k => keys.add(k));
  });
  return keys;
}

// Whether species unlocks can be trusted: an unknown species disables the
// mechanism, while a BLANK species is authoritative (it grants and hides nothing).
function areSpeciesUnlocksAuthoritative(character) {
  return !_getUnknownSpeciesName(character);
}

// ─── THE SECTION ───

// The section changes only with species, level, homebrew and the toggle, and
// `renderCharacterSheet()` calls it on every keystroke; this gates the rebuild.
function _getSpeciesTraitsSignature() {
  const c = state.character || {};
  return [c.race || '', c.level ?? '', showLockedTraits ? '1' : '0', getHomebrewUsableKey(),
    getFeatureChoicesSignature(c)].join('‖');
}

// Draws the species traits section of the sheet.
function renderSpeciesTraits() {
  const box = document.getElementById('sheet-species-traits');
  const btn = document.getElementById('trait-toggle-locked');
  if (!box) return;

  const sig = _getSpeciesTraitsSignature();
  if (sig === speciesTraitsSig) return;
  speciesTraitsSig = sig;

  const rows = _getSpeciesTraitRows(state.character);
  const lockedCount = rows.filter(r => !r.owned).length;

  // A toggle that cannot change what you see is noise.
  if (btn) {
    btn.classList.toggle('hidden', lockedCount === 0);
    setIconLabel(btn, showLockedTraits ? 'hide' : 'show',
      showLockedTraits ? 'Hide locked' : `Show all (${lockedCount})`);
    btn.title = showLockedTraits
      ? 'Show only the traits you have'
      : 'Also show traits from levels you have not reached';
  }

  box.textContent = '';

  if (!rows.length) {
    box.appendChild(_buildSpeciesEmptyState(state.character));
    return;
  }

  // The level badge is drawn only when the levels of the rows actually DRAWN
  // differ — for a species almost everything is level 1, and a column of
  // identical "1"s is noise.
  const drawn = rows.filter(r => r.owned || showLockedTraits);
  const isGraded = drawn.some(r => r.level > 1);

  drawn.forEach(row => {
    box.appendChild(buildFeatureCard({ ...row, showClass: false },
      { badge: isGraded, scope: 'species' }));
  });

  // Every trait is locked and the reader has chosen not to see them.
  if (!box.children.length) box.appendChild(buildFeatureNote('Nothing unlocked at this level yet.'));
}

function _buildSpeciesEmptyState(character) {
  const unknown = _getUnknownSpeciesName(character);
  return buildFeatureNote(unknown
    ? `No traits known for “${unknown}”.`
    : 'Set a species in Character Setup to see its traits.');
}

document.getElementById('trait-toggle-locked').addEventListener('click', () => {
  showLockedTraits = !showLockedTraits;
  renderSpeciesTraits();
});
