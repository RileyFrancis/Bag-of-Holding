// =============================================================================
// CLASS FEATURES — what a character's class gives them, and the sheet's section
// =============================================================================
'use strict';

// The registry (where a class definition comes from), the section that draws it,
// and the unlocks a feature can carry. Class data is `data/classes.json` —
// content, not code. Nothing outside this file touches `DEFAULT_CLASSES`;
// everything goes through `allClasses()` / `findClassByName()`, the seam custom
// classes will come through. Classes are matched by name (a free-text field), and
// each class entry is read at its own level (`characterClassLevel()`); the
// character's total level still drives the proficiency bonus and species traits.
// Descriptions are Markdown, so this file is a second consumer of markdown.js's
// sanitizer. See CLAUDE.md § Class features.

// =============================================================================
// LOADING THE CLASSES
// =============================================================================
// Synchronous, like `loadDefaultItems()` — content the app is expected to have,
// and the reason it needs an HTTP server rather than `file://`.
let DEFAULT_CLASSES = [];

function loadDefaultClasses() {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'data/classes.json', false); // synchronous
    xhr.send();
    if (xhr.status !== 200) throw new Error(`HTTP ${xhr.status}`);
    // A host answering unknown paths with its index page would otherwise "find"
    // a class list made of HTML — the guard firebase-config.js uses.
    const body = xhr.responseText.trim();
    if (body.startsWith('<')) throw new Error('not JSON');
    DEFAULT_CLASSES = sanitizeClassList(JSON.parse(body).classes);
  } catch (e) {
    // Not fatal — the sheet is usable with no classes known.
    DEFAULT_CLASSES = [];
  }
}

// Reduce the file to the shape the rest of this file promises. A class with no
// usable features is dropped.
function sanitizeClassList(raw) {
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
          subclasses: sanitizeSubclassList(c.subclasses), features }
      : null;
  }).filter(Boolean);
}

// A subclass is a class in miniature — an id, name, own `source`, and features
// gated by the character's total level. It carries no `subclasses` of its own.
function sanitizeSubclassList(raw) {
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
  };
}

// One key or several, always read back as an array.
function normalizeUnlocks(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map(k => String(k).trim()).filter(Boolean);
}

// A description is Markdown. JSON has no multi-line string, so an ARRAY is also
// accepted (the convention `data/classes.json`'s own `_comment` block uses).
// Blocks are separated by a blank line — except two consecutive list items,
// which run on (`collectListItems()` stops at a blank line, so a blank between
// two bullets would split them). `MD_LIST_RE` is markdown.js's own test,
// borrowed not copied. A nested array is one block whose lines are kept together
// (a hand-written `<table>`, or a stanza wanting hard breaks). Shared with
// species-traits.js. See CLAUDE.md § Class features.
function normalizeDescription(raw) {
  if (!Array.isArray(raw)) return String(raw ?? '');

  const blocks = raw.map(b => Array.isArray(b)
    ? b.map(line => String(line ?? '')).join('\n')
    : String(b ?? ''));

  return blocks.reduce((acc, block, i) => {
    if (i === 0) return block;
    const prevLine = acc.slice(acc.lastIndexOf('\n') + 1);
    const thisLine = block.slice(0, block.indexOf('\n') + 1 || undefined);
    const runOn = MD_LIST_RE.test(prevLine) && MD_LIST_RE.test(thisLine);
    return acc + (runOn ? '\n' : '\n\n') + block;
  }, '');
}

loadDefaultClasses();

// =============================================================================
// THE REGISTRY
// =============================================================================
// The single seam custom classes come through — homebrew classes, and homebrew
// subclasses under their class, whenever they are usable (homebrew-share.js).
function allClasses() {
  return withHomebrewClasses(DEFAULT_CLASSES);
}

// Names are typed by hand — trimmed, case-insensitive; ids matched too, so a
// stored id survives a display-name edit.
function findClassByName(name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key) return null;
  return allClasses().find(c => c.name.toLowerCase() === key || c.id === key) ?? null;
}

// A character's free-text `subclass` field, matched against the subclasses of
// whichever class they hold.
function findSubclassByName(classDef, name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key || !classDef) return null;
  return (classDef.subclasses ?? []).find(
    s => s.name.toLowerCase() === key || s.id === key) ?? null;
}

// The level a character counts as for ONE particular class — the entry's own
// level, not the total. Falls back to the total level for a class we were handed
// but have no entry for.
function characterClassLevel(character, classDef) {
  const entry = classEntriesOf(character).find(e => matchesClass(classDef, e.name));
  if (entry) return entry.level;
  return Math.max(1, Math.min(20, parseInt(character?.level, 10) || 1));
}

function matchesClass(classDef, name) {
  if (!classDef) return false;
  const key = String(name ?? '').trim().toLowerCase();
  return key === classDef.name.toLowerCase() || key === classDef.id;
}

// Everything the character's classes offer, in section order: by level, then
// class, then as written. `owned` is what the level gate decides — the list is
// always complete, and the section chooses what to draw.
function classFeaturesFor(character) {
  const entries = classEntriesOf(character);
  const multi = entries.length > 1;
  const rows = [];

  entries.forEach(entry => {
    const def = findClassByName(entry.name);
    if (!def) return;
    const level = entry.level; // the entry's own level

    def.features.forEach((f, i) => rows.push({
      ...f,
      className: def.name,
      showClass: multi,     // one class needs no label on every card
      sub: 0,               // base features sort before the subclass's
      order: i,
      owned: f.level <= level,
    }));

    // The chosen subclass's features — interleaved by level, sorted after base
    // features at a shared level, always tagged with the subclass name.
    const subclass = findSubclassByName(def, entry.subclass);
    if (subclass) {
      subclass.features.forEach((f, i) => rows.push({
        ...f,
        className: def.name,
        subclassName: subclass.name,
        showClass: multi,
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

// Names typed that this app has never heard of. Not an error — the section says so.
function unknownClassNames(character) {
  return classEntriesOf(character).map(e => e.name).filter(n => !findClassByName(n));
}

// =============================================================================
// UNLOCKS — sheet parts that arrive with a feature
// =============================================================================
// A feature may name parts of the sheet it brings with it (`"unlocks":
// ["subclass"]`); markup marks them `data-unlocked-by="subclass"` and they stay
// hidden until an owned feature names them. The key is a plain string shared
// between JSON and markup — the data never has to know how the sheet is built.
// See CLAUDE.md § Class features (Unlocks).

// The character-wide question — right for a sheet part that belongs to no class
// in particular. Has no targets today (a species Lineage field will arrive here).
function unlockedSheetKeys(character) {
  const keys = new Set();
  classFeaturesFor(character).forEach(row => {
    if (row.owned) row.unlocks.forEach(k => keys.add(k));
  });
  return keys;
}

// A class the app does not know disables the whole mechanism — hiding a box for
// a class we cannot reason about would be an invention.
function featureUnlocksAreAuthoritative(character) {
  const entries = classEntriesOf(character);
  return entries.length > 0 && entries.every(e => !!findClassByName(e.name));
}

// The unlock keys ONE class alone hands out at a given level and subclass — what
// the Character Setup modal needs, since a Warlock 5 has a subclass to name and
// a Bard 2 does not. A class this app has never heard of returns `null` (not an
// empty set), and the caller must then show the field.
function classUnlockKeys(classDef, subclassName, level) {
  if (!classDef) return null;
  const keys = new Set();
  const collect = f => { if (f.level <= level) f.unlocks.forEach(k => keys.add(k)); };
  classDef.features.forEach(collect);
  findSubclassByName(classDef, subclassName)?.features.forEach(collect);
  return keys;
}

// Both registries feed one key space. This owns the mechanism; species-traits.js
// supplies its half. The authoritative test is an AND: if either half of what
// the character is cannot be reasoned about, a hidden box might be one they
// should have.
function applyFeatureUnlocks() {
  const authoritative = featureUnlocksAreAuthoritative(state.character)
                     && speciesUnlocksAreAuthoritative(state.character);

  let keys = null;
  if (authoritative) {
    keys = unlockedSheetKeys(state.character);
    speciesUnlockKeys(state.character).forEach(k => keys.add(k));
  }

  // Scoped to the sheet — the setup modal's class rows are gated per class instead.
  document.querySelectorAll('#character-sheet [data-unlocked-by]').forEach(el => {
    const key = el.dataset.unlockedBy;
    el.classList.toggle('hidden', !!keys && !keys.has(key));
  });
}

// =============================================================================
// THE SECTION
// =============================================================================
// Session-only, not persisted — the useful default is what you actually have.
let showLockedFeatures = false;

// Which cards are folded shut. Session-only Set, never saved or synced; every
// card opens expanded. Keyed with the section's SCOPE, not the bare id — class
// feature ids are bare words (`rage`), species trait ids prefixed
// (`dwarf-darkvision`), so the two files could collide on one.
const collapsedFeatures = new Set();

function featureKey(row, scope) {
  return `${scope}:${row.id}`;
}

function toggleFeatureCollapsed(key) {
  if (!collapsedFeatures.delete(key)) collapsedFeatures.add(key);
  return !collapsedFeatures.has(key);   // the new expanded state
}

// `renderCharacterSheet()` re-runs on every keystroke and every roster sync, but
// this section only changes with classes, subclass, level, species and the
// show-locked toggle. Skip the rebuild otherwise — it used to re-parse every
// card's Markdown on every stroke.
let classFeaturesSig = null;

function classFeaturesSignature() {
  const c = state.character || {};
  return [
    classEntriesOf(c).map(e => `${e.name}:${e.level}:${e.subclass}`).join('␟'),
    c.level ?? '', c.race || '',
    showLockedFeatures ? '1' : '0',
    homebrewUsableKey(), // a homebrew class enabled or edited under the sheet
  ].join('‖');
}

function renderClassFeatures() {
  const box = document.getElementById('sheet-features');
  const btn = document.getElementById('feature-toggle-locked');
  if (!box) return;

  // Cheap and left unconditional, so a hidden field is never in the wrong state;
  // the costly card rebuild below is gated.
  applyFeatureUnlocks();

  const sig = classFeaturesSignature();
  if (sig === classFeaturesSig) return;
  classFeaturesSig = sig;

  const rows = classFeaturesFor(state.character);
  const locked = rows.filter(r => !r.owned).length;

  // A toggle that cannot change what you see is noise.
  if (btn) {
    btn.classList.toggle('hidden', locked === 0);
    setIconLabel(btn, showLockedFeatures ? 'hide' : 'show',
      showLockedFeatures ? 'Hide locked' : `Show all (${locked})`);
    btn.title = showLockedFeatures
      ? 'Show only the features you have'
      : 'Also show features from levels you have not reached';
  }

  box.textContent = '';

  if (!rows.length) {
    box.appendChild(featureEmptyState(state.character));
    return;
  }

  rows.forEach(row => {
    if (!row.owned && !showLockedFeatures) return;
    box.appendChild(featureCard(row));
  });

  if (!box.children.length) box.appendChild(featureNote('Nothing unlocked at this level yet.'));

  const sources = classSourceSummary(state.character);
  if (sources) box.appendChild(featureSourceNote(sources));

  const unknown = unknownClassNames(state.character);
  if (unknown.length) {
    box.appendChild(featureNote(
      `No features known for ${unknown.map(n => `“${n}”`).join(', ')}.`));
  }
}

// Parsed descriptions are cached by their raw Markdown string — a feature's text
// never changes, and the parse + sanitize is a real cost now that descriptions
// run to several paragraphs. Each card gets a fresh clone.
const featureDescCache = new Map();

function renderFeatureDesc(el, src) {
  const key = String(src ?? '');
  let tpl = featureDescCache.get(key);
  if (!tpl) {
    tpl = document.createElement('template');
    renderMarkdownInto(tpl.content, key);
    featureDescCache.set(key, tpl);
  }
  el.appendChild(tpl.content.cloneNode(true));
}

// Shared with the species traits section (species-traits.js). `opts.badge` is
// what it varies — a species grants almost everything at level 1, and a column
// of identical badges is noise.
function featureCard(row, opts = {}) {
  const withBadge = opts.badge !== false;
  const key = featureKey(row, opts.scope ?? 'class');
  const expanded = !collapsedFeatures.has(key);

  const card = document.createElement('article');
  card.className = 'feature-card' + (row.owned ? '' : ' locked')
                 + (withBadge ? '' : ' no-badge')
                 + (expanded ? '' : ' collapsed');
  card.dataset.featureKey = key;

  const level = document.createElement('span');
  level.className = 'feature-level';
  level.textContent = row.level;
  level.title = `Unlocked at level ${row.level}`;

  // The name is a real `<button>` inside the heading (the standard disclosure
  // pattern): Tab reaches it, Enter/Space work on it, no keydown handler of our
  // own. Styled back to bare text in the CSS. Clicking anywhere on the card also
  // toggles it — the delegated listener below, reached here by bubbling.
  const name = document.createElement('h4');
  name.className = 'feature-name';

  const nameBtn = document.createElement('button');
  nameBtn.type = 'button';
  nameBtn.className = 'feature-name-btn';
  nameBtn.textContent = row.name;
  nameBtn.setAttribute('aria-expanded', String(expanded));
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

  // A `<div>`, not a `<p>`: the description is Markdown and comes back
  // block-level. `renderMarkdownInto` is the only way markup may be built from a
  // string here — it sanitizes on the way in, which matters because a
  // user-authored class will sync to Firebase and render in the GM's browser.
  const desc = document.createElement('div');
  desc.className = 'feature-desc';
  desc.id = 'fd-' + key.replace(/[^\w-]/g, '-');
  nameBtn.setAttribute('aria-controls', desc.id);
  renderFeatureDesc(desc, row.description);

  const text = document.createElement('div');
  text.className = 'feature-text';
  text.append(name, desc);

  if (withBadge) card.append(level, text);
  else card.append(text);
  return card;
}

function featureEmptyState(character) {
  const names = classEntriesOf(character).map(e => e.name);
  return featureNote(names.length
    ? `No features known for ${names.map(n => `“${n}”`).join(', ')}.`
    : 'Add a class in Character Setup to see its features.');
}

function featureNote(text) {
  const p = document.createElement('p');
  p.className = 'feature-note';
  p.textContent = text;
  return p;
}

// A quiet caption above the cards naming where each known class and subclass
// comes from. Skipped when nothing carries a `source`.
function classSourceSummary(character) {
  const parts = [];
  classEntriesOf(character).forEach(entry => {
    const def = findClassByName(entry.name);
    if (!def) return;
    if (def.source) parts.push(`${def.name} — ${def.source}`);
    const subclass = findSubclassByName(def, entry.subclass);
    if (subclass?.source) parts.push(`${subclass.name} — ${subclass.source}`);
  });
  return parts.join(' · ');
}

function featureSourceNote(text) {
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

// =============================================================================
// FOLDING A CARD SHUT
// =============================================================================
// One listener per section, not one per card — the sections are rebuilt on every
// render while the containers are static markup. Both wired from here because
// `featureCard()` is (species traits fold too). The toggle only flips classes
// and the aria state on the card that was hit — deliberately NOT a re-render,
// which would throw away focus and cost a Markdown parse per feature.
function initFeatureFolding() {
  ['sheet-features', 'sheet-species-traits'].forEach(id => {
    const box = document.getElementById(id);
    if (box) box.addEventListener('click', onFeatureCardClick);
  });
}

function onFeatureCardClick(e) {
  const card = e.target.closest('.feature-card');
  if (!card) return;

  // A description may hold a link, and the section's controls sit in the title.
  if (e.target.closest('a, input, textarea, select, label')) return;
  if (e.target.closest('button') && !e.target.closest('.feature-name-btn')) return;

  // A click that ends a drag-select is a reader highlighting a passage to copy.
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && card.contains(sel.anchorNode)) return;

  const expanded = toggleFeatureCollapsed(card.dataset.featureKey);
  card.classList.toggle('collapsed', !expanded);
  const btn = card.querySelector('.feature-name-btn');
  if (btn) btn.setAttribute('aria-expanded', String(expanded));
}

initFeatureFolding();
