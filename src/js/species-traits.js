// =============================================================================
// SPECIES TRAITS — what a character's species gives them, and the sheet section
// =============================================================================
'use strict';

// Same shape as class-features.js (read that header first): a registry over
// `data/species.json` and a section that draws it, both sharing that file's
// `featureCard()` and CSS. Species is matched by name (`race`, free text); it is
// one field, not a list, so there is no per-card tag. `level` on a trait is
// optional (defaults to 1) and the level badge is drawn only when levels differ.
// See CLAUDE.md § Species traits.

// =============================================================================
// LOADING THE SPECIES
// =============================================================================
let DEFAULT_SPECIES = [];

function loadDefaultSpecies() {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'data/species.json', false); // synchronous
    xhr.send();
    if (xhr.status !== 200) throw new Error(`HTTP ${xhr.status}`);
    // A host answering unknown paths with its index page would "find" a list
    // made of HTML — the guard firebase-config.js and class-features.js use.
    const body = xhr.responseText.trim();
    if (body.startsWith('<')) throw new Error('not JSON');
    DEFAULT_SPECIES = sanitizeSpeciesList(JSON.parse(body).species);
  } catch (e) {
    DEFAULT_SPECIES = []; // not fatal — the sheet is usable with no species known
  }
}

// A species with no usable traits is dropped.
function sanitizeSpeciesList(raw) {
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

// `level` is optional here (defaults to 1), where a class feature's is required
// — almost every species trait is level 1.
function sanitizeTrait(t) {
  const id = String(t?.id ?? '').trim();
  const name = String(t?.name ?? '').trim();
  if (!id || !name) return null;
  const level = parseInt(t?.level, 10);
  return {
    id, name,
    level: Number.isFinite(level) ? Math.max(1, Math.min(20, level)) : 1,
    description: normalizeDescription(t?.description), // shared, as below
    unlocks: normalizeUnlocks(t?.unlocks),              // shared with class-features.js
  };
}

loadDefaultSpecies();

// =============================================================================
// THE REGISTRY
// =============================================================================
// The single seam custom species come through — usable homebrew species
// (homebrew-share.js) after the app's own.
function allSpecies() {
  return withHomebrewSpecies(DEFAULT_SPECIES);
}

// Trimmed, case-insensitive; ids matched too, so a stored id survives a rename.
function findSpeciesByName(name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key) return null;
  return allSpecies().find(s => s.name.toLowerCase() === key || s.id === key) ?? null;
}

// One place, so a species that ever counts levels differently has somewhere to land.
function characterSpeciesLevel(character, _speciesDef) {
  return Math.max(1, Math.min(20, parseInt(character?.level, 10) || 1));
}

// Everything the species offers, by level then written order. `owned` is the
// level gate; the section chooses what to draw.
function speciesTraitsFor(character) {
  const def = findSpeciesByName(character?.race);
  if (!def) return [];
  const level = characterSpeciesLevel(character, def);
  return def.traits
    .map((t, i) => ({ ...t, speciesName: def.name, order: i, owned: t.level <= level }))
    .sort((a, b) => a.level - b.level || a.order - b.order);
}

// The name typed that this app has never heard of, or '' when blank or known.
function unknownSpeciesName(character) {
  const typed = String(character?.race ?? '').trim();
  return typed && !findSpeciesByName(typed) ? typed : '';
}

// =============================================================================
// UNLOCKS
// =============================================================================
// A trait may name parts of the sheet it brings with it, exactly as a class
// feature may — same key space, same `data-unlocked-by` markup. The two are
// unioned by `applyFeatureUnlocks()` in class-features.js, which owns the
// mechanism; these two functions are this file's half of the answer.
function speciesUnlockKeys(character) {
  const keys = new Set();
  speciesTraitsFor(character).forEach(row => {
    if (row.owned) row.unlocks.forEach(k => keys.add(k));
  });
  return keys;
}

// A species the app does not know disables the mechanism. A BLANK species is
// authoritative — it grants and hides nothing.
function speciesUnlocksAreAuthoritative(character) {
  return !unknownSpeciesName(character);
}

// =============================================================================
// THE SECTION
// =============================================================================
// Session-only, not persisted.
let showLockedTraits = false;

// Only changes with the character's species, level, and the toggle — skip the
// rebuild otherwise (`renderCharacterSheet()` calls this on every keystroke).
let speciesTraitsSig = null;

function speciesTraitsSignature() {
  const c = state.character || {};
  return [c.race || '', c.level ?? '', showLockedTraits ? '1' : '0', homebrewUsableKey()].join('‖');
}

function renderSpeciesTraits() {
  const box = document.getElementById('sheet-species-traits');
  const btn = document.getElementById('trait-toggle-locked');
  if (!box) return;

  const sig = speciesTraitsSignature();
  if (sig === speciesTraitsSig) return;
  speciesTraitsSig = sig;

  const rows = speciesTraitsFor(state.character);
  const locked = rows.filter(r => !r.owned).length;

  // A toggle that cannot change what you see is noise.
  if (btn) {
    btn.classList.toggle('hidden', locked === 0);
    setIconLabel(btn, showLockedTraits ? 'hide' : 'show',
      showLockedTraits ? 'Hide locked' : `Show all (${locked})`);
    btn.title = showLockedTraits
      ? 'Show only the traits you have'
      : 'Also show traits from levels you have not reached';
  }

  box.textContent = '';

  if (!rows.length) {
    box.appendChild(speciesEmptyState(state.character));
    return;
  }

  // The level badge is drawn only when the levels of the rows actually DRAWN
  // differ — for a species almost everything is level 1, and a column of
  // identical "1"s is noise.
  const drawn = rows.filter(r => r.owned || showLockedTraits);
  const graded = drawn.some(r => r.level > 1);

  drawn.forEach(row => {
    box.appendChild(featureCard({ ...row, showClass: false },
      { badge: graded, scope: 'species' }));
  });

  // Every trait is locked and the reader has chosen not to see them.
  if (!box.children.length) box.appendChild(featureNote('Nothing unlocked at this level yet.'));
}

function speciesEmptyState(character) {
  const unknown = unknownSpeciesName(character);
  return featureNote(unknown
    ? `No traits known for “${unknown}”.`
    : 'Set a species in Character Setup to see its traits.');
}

document.getElementById('trait-toggle-locked').addEventListener('click', () => {
  showLockedTraits = !showLockedTraits;
  renderSpeciesTraits();
});
