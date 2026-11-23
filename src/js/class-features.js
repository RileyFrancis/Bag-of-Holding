// =============================================================================
// CLASS FEATURES — what a character's class gives them, and the sheet's section
// =============================================================================
// The class registry over `data/classes.json`, the section that draws it, and the
// unlocks a feature can carry. Everything outside this file reads classes through
// `getAllClasses()` / `findClassByName()`, the seam homebrew classes come through.
// Classes are matched by name (free text) and each is read at its own level.
// Descriptions are Markdown, rendered only through markdown.js's sanitizer.
'use strict';

let DEFAULT_CLASSES = [];

// Session-only, not persisted: the useful default is what you actually have.
let showLockedFeatures = false;

// Which cards are folded shut; session-only, never saved or synced. Keyed with
// the section's scope, because class ids are bare words (`rage`) and species
// trait ids prefixed (`dwarf-darkvision`), so the two could collide.
const collapsedFeatures = new Set();

// Last signature the feature cards were drawn for (see _getClassFeaturesSignature).
let classFeaturesSig = null;

// Parsed descriptions keyed by raw Markdown; a feature's text never changes and
// the parse + sanitize is a real cost. Each card gets a fresh clone.
const featureDescCache = new Map();

// ─── LOADING THE CLASSES ───

// Synchronous, like `loadDefaultItems()`: content the app is expected to have.
function _loadDefaultClasses() {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'data/classes.json', false); // synchronous
    xhr.send();
    if (xhr.status !== 200) throw new Error(`HTTP ${xhr.status}`);
    // A host answering unknown paths with its index page would otherwise "find"
    // a class list made of HTML — the guard firebase-config.js uses.
    const body = xhr.responseText.trim();
    if (body.startsWith('<')) throw new Error('not JSON');
    DEFAULT_CLASSES = _sanitizeClassList(JSON.parse(body).classes);
  } catch (e) {
    // Not fatal — the sheet is usable with no classes known.
    DEFAULT_CLASSES = [];
  }
}

// Reduce the file to the shape the rest of this file promises. A class with no
// usable features is dropped.
function _sanitizeClassList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(c => {
    const id = String(c?.id ?? '').trim();
    const name = String(c?.name ?? '').trim();
    if (!id || !name) return null;
    const features = (Array.isArray(c.features) ? c.features : [])
      .map(f => sanitizeFeature(f))
      .filter(Boolean);
    return features.length
      ? { id, name, source: cleanSource(c.source),
          subclasses: _sanitizeSubclassList(c.subclasses), features }
      : null;
  }).filter(Boolean);
}

// A subclass is a class in miniature: id, name, own `source`, and features gated
// by level. It carries no `subclasses` of its own.
function _sanitizeSubclassList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(s => {
    const id = String(s?.id ?? '').trim();
    const name = String(s?.name ?? '').trim();
    if (!id || !name) return null;
    const features = (Array.isArray(s.features) ? s.features : [])
      .map(f => sanitizeFeature(f))
      .filter(Boolean);
    return features.length
      ? { id, name, source: cleanSource(s.source), features }
      : null;
  }).filter(Boolean);
}

// Short book label ("PHB"), free text and trimmed.
function cleanSource(raw) {
  return String(raw ?? '').trim().slice(0, 40);
}

// One class or subclass feature in its stored shape, or null when unusable.
function sanitizeFeature(f) {
  const id = String(f?.id ?? '').trim();
  const name = String(f?.name ?? '').trim();
  const level = parseInt(f?.level, 10);
  if (!id || !name || !Number.isFinite(level)) return null;
  return {
    id, name,
    level: Math.max(1, Math.min(20, level)),
    description: normalizeDescription(f?.description),
    unlocks: normalizeUnlocks(f?.unlocks),
    options: normalizeFeatureOptions(f?.options),
  };
}

// The explicit picks a feature or trait offers (`"options": [...]`), trimmed and
// de-duplicated; empty when the data names none.
function normalizeFeatureOptions(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(o => String(o ?? '').trim()).filter(Boolean))];
}

// One key or several, always read back as an array.
function normalizeUnlocks(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map(k => String(k).trim()).filter(Boolean);
}

// A description is Markdown, or an array of blocks (JSON has no multi-line
// string). Blocks join with a blank line, except two consecutive list items,
// which run on: a blank between bullets would split the list. A nested array is
// one block whose lines stay together (a `<table>`, a stanza). Shared with
// species-traits.js.
function normalizeDescription(raw) {
  if (!Array.isArray(raw)) return String(raw ?? '');

  const blocks = raw.map(b => Array.isArray(b)
    ? b.map(line => String(line ?? '')).join('\n')
    : String(b ?? ''));

  return blocks.reduce((acc, block, i) => {
    if (i === 0) return block;
    const prevLine = acc.slice(acc.lastIndexOf('\n') + 1);
    const thisLine = block.slice(0, block.indexOf('\n') + 1 || undefined);
    const isRunOn = MD_LIST_RE.test(prevLine) && MD_LIST_RE.test(thisLine);
    return acc + (isRunOn ? '\n' : '\n\n') + block;
  }, '');
}

_loadDefaultClasses();

// ─── THE REGISTRY ───

// Every usable class: the defaults, plus homebrew classes and subclasses
// (homebrew-share.js).
function getAllClasses() {
  return getClassesWithHomebrew(DEFAULT_CLASSES);
}

// Names are typed by hand — trimmed, case-insensitive; ids matched too, so a
// stored id survives a display-name edit.
function findClassByName(name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key) return null;
  return getAllClasses().find(c => c.name.toLowerCase() === key || c.id === key) ?? null;
}

// A character's free-text `subclass` field, matched against the subclasses of
// whichever class they hold.
function _findSubclassByName(classDef, name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key || !classDef) return null;
  return (classDef.subclasses ?? []).find(
    s => s.name.toLowerCase() === key || s.id === key) ?? null;
}

// Everything the character's classes offer, in section order: by level, then
// class, then as written. `owned` is the level gate; the list is always
// complete, and the section chooses what to draw.
function _getClassFeatureRows(character) {
  const entries = getClassEntries(character);
  const isMulticlass = entries.length > 1;
  const rows = [];

  entries.forEach(entry => {
    const def = findClassByName(entry.name);
    if (!def) return;
    const level = entry.level; // each class is read at its own level

    def.features.forEach((f, i) => rows.push({
      ...f,
      className: def.name,
      showClass: isMulticlass, // one class needs no label on every card
      sub: 0,                  // base features sort before the subclass's
      order: i,
      owned: f.level <= level,
    }));

    // The chosen subclass's features: interleaved by level, after base features
    // at a shared level, always tagged with the subclass name.
    const subclass = _findSubclassByName(def, entry.subclass);
    if (subclass) {
      subclass.features.forEach((f, i) => rows.push({
        ...f,
        className: def.name,
        subclassName: subclass.name,
        showClass: isMulticlass,
        sub: 1,
        order: i,
        owned: f.level <= level,
      }));
    }
  });

  rows.sort((a, b) =>
    a.level - b.level ||
    a.className.localeCompare(b.className) ||
    a.sub - b.sub ||
    a.order - b.order);
  return rows;
}

// The class and subclass features the character has reached, in section order.
function getOwnedClassFeatureRows(character) {
  return _getClassFeatureRows(character).filter(r => r.owned);
}

// Names typed that this app has never heard of. Not an error — the section says so.
function _getUnknownClassNames(character) {
  return getClassEntries(character).map(e => e.name).filter(n => !findClassByName(n));
}

// ─── UNLOCKS ───
// A feature may name sheet parts it brings (`"unlocks": ["subclass"]`); markup
// marks them `data-unlocked-by="subclass"` and they stay hidden until an owned
// feature names them. The key is a plain string shared by JSON and markup.

// Keys unlocked by any owned class feature, for sheet parts that belong to no
// class in particular.
function _getClassUnlockedSheetKeys(character) {
  const keys = new Set();
  _getClassFeatureRows(character).forEach(row => {
    if (row.owned) row.unlocks.forEach(k => keys.add(k));
  });
  return keys;
}

// A class the app does not know disables the whole mechanism — hiding a box for
// a class we cannot reason about would be an invention.
function _areClassUnlocksAuthoritative(character) {
  const entries = getClassEntries(character);
  return entries.length > 0 && entries.every(e => !!findClassByName(e.name));
}

// The unlock keys ONE class hands out at a given level and subclass, for the
// Character Setup modal. An unknown class returns `null` (not an empty set), and
// the caller must then show the field.
function getClassUnlockKeys(classDef, subclassName, level) {
  if (!classDef) return null;
  const keys = new Set();
  const collect = f => { if (f.level <= level) f.unlocks.forEach(k => keys.add(k)); };
  classDef.features.forEach(collect);
  _findSubclassByName(classDef, subclassName)?.features.forEach(collect);
  return keys;
}

// Whether one class entry has reached its subclass feature with no subclass typed.
// An unknown class is never pending: there is nothing to say it has one.
function isSubclassChoicePending(entry) {
  if (String(entry?.subclass ?? '').trim()) return false;
  const keys = getClassUnlockKeys(findClassByName(entry?.name), '', entry?.level ?? 1);
  return !!keys && keys.has('subclass');
}

// Class and species unlocks share one key space; species-traits.js supplies its
// half. Authoritative only when both halves are: if either cannot be reasoned
// about, a hidden box might be one the character should have.
function _applyFeatureUnlocks() {
  const isAuthoritative = _areClassUnlocksAuthoritative(state.character)
                       && areSpeciesUnlocksAuthoritative(state.character);

  let keys = null;
  if (isAuthoritative) {
    keys = _getClassUnlockedSheetKeys(state.character);
    getSpeciesUnlockKeys(state.character).forEach(k => keys.add(k));
  }

  // Scoped to the sheet — the setup modal's class rows are gated per class instead.
  document.querySelectorAll('#character-sheet [data-unlocked-by]').forEach(el => {
    const key = el.dataset.unlockedBy;
    el.classList.toggle('hidden', !!keys && !keys.has(key));
  });
}

// ─── THE SECTION ───

// The key a card is folded and its choice saved under: 'class:<id>' or 'species:<id>'.
function getFeatureCardKey(row, scope) {
  return `${scope}:${row.id}`;
}

// Flips a card's folded state; returns whether it is now expanded.
function _toggleFeatureCollapsed(key) {
  if (!collapsedFeatures.delete(key)) collapsedFeatures.add(key);
  return !collapsedFeatures.has(key);
}

// `renderCharacterSheet()` re-runs on every keystroke and roster sync, but this
// section changes only with classes, subclass, level, species, homebrew and the
// show-locked toggle; the signature lets the rebuild be skipped otherwise.
function _getClassFeaturesSignature() {
  const c = state.character || {};
  return [
    getClassEntries(c).map(e => `${e.name}:${e.level}:${e.subclass}`).join('␟'),
    c.level ?? '', c.race || '',
    showLockedFeatures ? '1' : '0',
    getHomebrewUsableKey(), // a homebrew class enabled or edited under the sheet
    getFeatureChoicesSignature(c), // a pick made here or synced in redraws its card
  ].join('‖');
}

// Draws the class features section and applies sheet unlocks.
function renderClassFeatures() {
  const box = document.getElementById('sheet-features');
  const btn = document.getElementById('feature-toggle-locked');
  if (!box) return;

  // Cheap and left unconditional, so a hidden field is never in the wrong state;
  // the costly card rebuild below is gated.
  _applyFeatureUnlocks();

  const sig = _getClassFeaturesSignature();
  if (sig === classFeaturesSig) return;
  classFeaturesSig = sig;

  const rows = _getClassFeatureRows(state.character);
  const lockedCount = rows.filter(r => !r.owned).length;

  // A toggle that cannot change what you see is noise.
  if (btn) {
    btn.classList.toggle('hidden', lockedCount === 0);
    setIconLabel(btn, showLockedFeatures ? 'hide' : 'show',
      showLockedFeatures ? 'Hide locked' : `Show all (${lockedCount})`);
    btn.title = showLockedFeatures
      ? 'Show only the features you have'
      : 'Also show features from levels you have not reached';
  }

  box.textContent = '';

  if (!rows.length) {
    box.appendChild(_buildFeatureEmptyState(state.character));
    return;
  }

  rows.forEach(row => {
    if (!row.owned && !showLockedFeatures) return;
    box.appendChild(buildFeatureCard(row));
  });

  if (!box.children.length) box.appendChild(buildFeatureNote('Nothing unlocked at this level yet.'));

  const sources = _getClassSourceSummary(state.character);
  if (sources) box.appendChild(_buildFeatureSourceNote(sources));

  const unknown = _getUnknownClassNames(state.character);
  if (unknown.length) {
    box.appendChild(buildFeatureNote(
      `No features known for ${unknown.map(n => `“${n}”`).join(', ')}.`));
  }
}

function _renderFeatureDescription(el, src) {
  const key = String(src ?? '');
  let tpl = featureDescCache.get(key);
  if (!tpl) {
    tpl = document.createElement('template');
    renderMarkdownInto(tpl.content, key);
    featureDescCache.set(key, tpl);
  }
  el.appendChild(tpl.content.cloneNode(true));
}

// Builds one feature card; shared with species-traits.js. `opts.badge: false`
// drops the level badge, `opts.scope` keys the fold state (default 'class').
function buildFeatureCard(row, opts = {}) {
  const hasBadge = opts.badge !== false;
  const key = getFeatureCardKey(row, opts.scope ?? 'class');
  const isExpanded = !collapsedFeatures.has(key);

  const card = document.createElement('article');
  card.className = 'feature-card' + (row.owned ? '' : ' locked')
                 + (hasBadge ? '' : ' no-badge')
                 + (isExpanded ? '' : ' collapsed');
  card.dataset.featureKey = key;

  const level = document.createElement('span');
  level.className = 'feature-level';
  level.textContent = row.level;
  level.title = `Unlocked at level ${row.level}`;

  // The name is a real `<button>` inside the heading (the standard disclosure
  // pattern), so Tab, Enter and Space work with no keydown handler. A click
  // anywhere on the card also toggles, via the delegated listener below.
  const name = document.createElement('h4');
  name.className = 'feature-name';

  const nameBtn = document.createElement('button');
  nameBtn.type = 'button';
  nameBtn.className = 'feature-name-btn';
  nameBtn.textContent = row.name;
  nameBtn.setAttribute('aria-expanded', String(isExpanded));
  name.appendChild(nameBtn);

  // The class name when multiclassed, and the subclass name whenever a feature
  // comes from one (single class or not).
  const tagText = row.subclassName
    ? (row.showClass ? `${row.className} · ${row.subclassName}` : row.subclassName)
    : (row.showClass ? row.className : '');
  if (tagText) {
    const tag = document.createElement('span');
    tag.className = 'feature-class';
    tag.textContent = tagText;
    name.appendChild(tag);
  }

  // A `<div>`, not a `<p>`: the Markdown comes back block-level. It must go
  // through the sanitizer, since homebrew classes sync and render in the GM's
  // browser.
  const desc = document.createElement('div');
  desc.className = 'feature-desc';
  desc.id = 'fd-' + key.replace(/[^\w-]/g, '-');
  nameBtn.setAttribute('aria-controls', desc.id);
  _renderFeatureDescription(desc, row.description);

  const text = document.createElement('div');
  text.className = 'feature-text';
  text.append(name, desc);

  // A feature that asks the player to pick something carries its picker.
  const choice = row.owned ? buildFeatureChoiceBlock(row, key) : null;
  if (choice) text.appendChild(choice);

  if (hasBadge) card.append(level, text);
  else card.append(text);
  return card;
}

function _buildFeatureEmptyState(character) {
  const names = getClassEntries(character).map(e => e.name);
  return buildFeatureNote(names.length
    ? `No features known for ${names.map(n => `“${n}”`).join(', ')}.`
    : 'Add a class in Character Setup to see its features.');
}

// Builds a quiet note paragraph for a feature section.
function buildFeatureNote(text) {
  const p = document.createElement('p');
  p.className = 'feature-note';
  p.textContent = text;
  return p;
}

// A caption naming where each known class and subclass comes from; '' when
// nothing carries a `source`.
function _getClassSourceSummary(character) {
  const parts = [];
  getClassEntries(character).forEach(entry => {
    const def = findClassByName(entry.name);
    if (!def) return;
    if (def.source) parts.push(`${def.name} — ${def.source}`);
    const subclass = _findSubclassByName(def, entry.subclass);
    if (subclass?.source) parts.push(`${subclass.name} — ${subclass.source}`);
  });
  return parts.join(' · ');
}

function _buildFeatureSourceNote(text) {
  const p = document.createElement('p');
  p.className = 'feature-sources';
  p.textContent = text;
  return p;
}

// Fills a `<datalist>` with names — the Character Setup modal's class and
// subclass hints. A hint, never a constraint.
function fillDatalist(dl, names) {
  if (!dl) return;
  dl.textContent = '';
  [...new Set(names)].forEach(n => {
    const opt = document.createElement('option');
    opt.value = n;
    dl.appendChild(opt);
  });
}

document.getElementById('feature-toggle-locked').addEventListener('click', () => {
  showLockedFeatures = !showLockedFeatures;
  renderClassFeatures();
});

// ─── FOLDING A CARD SHUT ───

// One delegated listener per section, since the cards are rebuilt on every
// render while the containers are static. Both are wired here because
// `buildFeatureCard()` is shared with species traits.
function _initFeatureFolding() {
  ['sheet-features', 'sheet-species-traits'].forEach(id => {
    const box = document.getElementById(id);
    if (box) box.addEventListener('click', _onFeatureCardClick);
  });
}

// Flips only the hit card's classes and aria state; a re-render would lose focus
// and cost a Markdown parse per feature.
function _onFeatureCardClick(e) {
  const card = e.target.closest('.feature-card');
  if (!card) return;

  // A description may hold a link, and the section's controls sit in the title.
  if (e.target.closest('a, input, textarea, select, label, .feature-choice')) return;
  if (e.target.closest('button') && !e.target.closest('.feature-name-btn')) return;

  // A click that ends a drag-select is a reader highlighting a passage to copy.
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && card.contains(sel.anchorNode)) return;

  const isExpanded = _toggleFeatureCollapsed(card.dataset.featureKey);
  card.classList.toggle('collapsed', !isExpanded);
  const btn = card.querySelector('.feature-name-btn');
  if (btn) btn.setAttribute('aria-expanded', String(isExpanded));
}

_initFeatureFolding();
