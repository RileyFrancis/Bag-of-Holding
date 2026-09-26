// =============================================================================
// CHARACTERS — The account's roster of characters, and the home screen
// =============================================================================
'use strict';

// The save file holds a roster — `state.characters`, keyed by id — and exactly
// one slot is live in `state.character` / `state.instances` / `state.equipped` /
// `state.db` at a time. The roster is the store; the live fields are the working
// copy. Two functions bridge them and nothing else may:
//   commitActiveCharacter()        working copy → slot (runs from buildSavePayload)
//   loadActiveCharacterIntoLive()  slot → working copy
// commitActiveCharacter() refuses when the working copy is not your own character
// (another member's sheet, or a GM with none) — see `liveStateIsOwnCharacter()`.
// This file also holds the classLevels model and the home screen. See CLAUDE.md
// § Characters and the home screen, and § Multiclassing.

// =============================================================================
// MODEL
// =============================================================================
function newCharacterId() {
  return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

// `id` is carried on the character itself so a slot and its meta can never be
// orphaned.
function blankCharacterMeta(name = 'Unnamed Hero') {
  return normalizeCharacterMeta({ id: newCharacterId(), name, strength: 10, level: 1, race: '', classLevels: [] });
}

// =============================================================================
// CLASS LEVELS — the authoritative multiclass model
// =============================================================================
// A character's classes are `classLevels`: an ordered list of
// `{ name, level, subclass }`, one entry per class, each with its own level and
// subclass. `classes` (names), `level` (the sum) and `subclass` (the first) are
// MIRRORS, written only by `normalizeCharacterMeta()` — the same arrangement
// `strength` / `abilities.str` have. Writing a bare `level` on a character that
// has classes is ignored. See CLAUDE.md § Multiclassing.
const MAX_LEVEL = 20;

function blankClassEntry(name = '') {
  return { name: String(name).trim(), level: 1, subclass: '' };
}

// Reads `classLevels` when present, folds the old three into it when not (an
// older save, or a party member on an older client). The split is a guess, and
// only for a multiclass — the first class gets what is left after one level each
// for the rest, so the total comes through exactly right.
function normalizeClassLevels(m) {
  if (Array.isArray(m.classLevels)) return sanitizeClassLevels(m.classLevels);

  const names = Array.isArray(m.classes)
    ? m.classes.map(c => String(c).trim()).filter(Boolean)
    : String(m.classes ?? '').split(/[,/]/).map(c => c.trim()).filter(Boolean);
  if (!names.length) return [];

  const total = clampLevel(parseInt(m.level, 10) || 1);
  const first = Math.max(1, total - (names.length - 1));
  return sanitizeClassLevels(names.map((name, i) => ({
    name,
    level: i === 0 ? first : 1,
    subclass: i === 0 ? (m.subclass ?? '') : '',
  })));
}

function sanitizeClassLevels(raw) {
  return raw
    .map(e => (typeof e === 'string' ? { name: e } : (e ?? {})))
    .map(e => ({
      name: String(e.name ?? '').trim(),
      level: clampLevel(parseInt(e.level, 10) || 1),
      subclass: String(e.subclass ?? '').trim(),
    }))
    .filter(e => e.name);
}

function clampLevel(n) { return Math.max(1, Math.min(MAX_LEVEL, n)); }

// The one way to read a character's classes. A normalized character hands its
// list back; anything older (a party roster entry with only names and one level)
// is folded on the way out.
function classEntriesOf(c) {
  if (Array.isArray(c?.classLevels) && c.classLevels.length) return c.classLevels;
  return normalizeClassLevels(c ?? {});
}

// The sum of what they have taken in each class, capped at 20. A classless
// character still has a level, and there it is the typed one.
function totalLevelOf(entries, fallbackLevel) {
  if (!entries.length) return clampLevel(parseInt(fallbackLevel, 10) || 1);
  return clampLevel(entries.reduce((sum, e) => sum + e.level, 0));
}

// Old saves (and older party data) carry only name + strength — every sheet
// field is filled in from `defaultSheetFields()` here. `strength` is a mirror of
// `abilities.str`, written only here.
function normalizeCharacterMeta(meta, id) {
  const m = meta ?? {};
  const abilities = normalizeAbilities(m.abilities, m.strength);
  const sheet = defaultSheetFields();

  Object.keys(sheet).forEach(key => {
    if (m[key] === undefined || m[key] === null) return;
    // Nested groups merge field by field, so a save from before one gained a key
    // keeps the default for that key.
    sheet[key] = (typeof sheet[key] === 'object' && !Array.isArray(sheet[key]))
      ? { ...sheet[key], ...m[key] }
      : m[key];
  });

  const classLevels = normalizeClassLevels(m);

  return {
    id: id ?? m.id ?? newCharacterId(),
    name: String(m.name ?? 'Unnamed Hero'),
    race: String(m.race ?? ''),
    abilities,
    ...sheet,
    // The authoritative model and its three mirrors, last so nothing merged in
    // above can overwrite one.
    classLevels,
    classes: classLevels.map(e => e.name),
    level: totalLevelOf(classLevels, m.level),
    subclass: classLevels.find(e => e.subclass)?.subclass ?? '',
    strength: abilities.str, // mirror
  };
}

function characterSlot(meta, rest = {}) {
  return {
    character:   normalizeCharacterMeta(meta),
    instances:   rest.instances   ?? {},
    equipped:    rest.equipped    ?? {},
    equipLayout: rest.equipLayout ?? [],
    db:          rest.db          ?? {},
  };
}

// Insertion order — the order they were created in.
function characterList() {
  return Object.values(state.characters);
}

// The roster is never empty: deleting the last character hands back a fresh one.
function ensureCharacter() {
  if (state.activeCharacterId && state.characters[state.activeCharacterId]) return;
  const first = characterList()[0];
  if (first) { state.activeCharacterId = first.character.id; loadActiveCharacterIntoLive(); return; }
  const slot = characterSlot(blankCharacterMeta());
  state.characters[slot.character.id] = slot;
  state.activeCharacterId = slot.character.id;
  loadActiveCharacterIntoLive();
}

// The slot ensureCharacter() mints is a placeholder, not a character anyone
// made — so "no characters" means a roster of nothing but untouched blanks.
// Judged by content rather than a flag on the slot: commitActiveCharacter()
// rebuilds the slot wholesale, so a flag would not survive the first save.
// The active slot is read from the working copy, which is newer than the slot.
function isUntouchedSlot(slot) {
  const id = slot.character.id;
  const live = id === state.activeCharacterId && liveStateIsOwnCharacter();
  const character = live ? state.character : slot.character;
  const instances = live ? state.instances : slot.instances;
  const equipped  = live ? state.equipped  : slot.equipped;
  const db        = live ? getCustomDb()   : slot.db;
  if (Object.keys(instances ?? {}).length) return false;
  if (Object.values(equipped ?? {}).some(Boolean)) return false;
  if (Object.keys(db ?? {}).length) return false;
  // Both through the normalizer with one id, so key order and unknown keys agree.
  const blank = normalizeCharacterMeta({ ...blankCharacterMeta(), id }, id);
  return JSON.stringify(normalizeCharacterMeta(character, id)) === JSON.stringify(blank);
}

// A first visit, in effect: nobody made yet and no table to go back to. The
// home screen greets them rather than showing the placeholder's card.
function isWelcomeVisit() {
  if (state.party.active) return false;
  if (Object.keys(state.campaigns ?? {}).length) return false;
  return characterList().every(isUntouchedSlot);
}

// A new character replaces any placeholder rather than joining it —
// a roster of "Unnamed Hero" plus the one they meant to make is not what they
// asked for.
function dropUntouchedSlotsExcept(keepId) {
  characterList().forEach(slot => {
    const id = slot.character.id;
    // Never the active slot — a GM's working copy may still be sitting on it.
    if (id !== keepId && id !== state.activeCharacterId && isUntouchedSlot(slot)) delete state.characters[id];
  });
}

// =============================================================================
// THE BRIDGE: LIVE STATE ⇄ SLOT
// =============================================================================
// True only when what is on screen is genuinely this account's active character
// (not a GM, not another member's sheet) — otherwise the slot must be left alone.
function liveStateIsOwnCharacter() {
  if (!state.activeCharacterId || !state.characters[state.activeCharacterId]) return false;
  if (state.party.active && state.party.viewingPlayerId !== null) return false;
  if (state.party.active && state.party.role === 'gm') return false;
  return true;
}

function commitActiveCharacter() {
  if (!liveStateIsOwnCharacter()) return;
  state.characters[state.activeCharacterId] = {
    character:   { ...state.character, id: state.activeCharacterId },
    instances:   state.instances,
    equipped:    state.equipped,
    equipLayout: state.equipLayout,
    db:          getCustomDb(),
  };
}

// The custom item catalogue is per character, so it is rebuilt from the defaults
// each time rather than merged.
function loadActiveCharacterIntoLive() {
  const slot = state.characters[state.activeCharacterId];
  if (!slot) return;
  state.character   = { ...slot.character };
  state.instances   = slot.instances   ? { ...slot.instances } : {};
  state.equipped    = slot.equipped    ? { ...slot.equipped }  : {};
  state.equipLayout = slot.equipLayout ? [...slot.equipLayout] : [];
  state.db = {};
  DEFAULT_ITEMS.forEach(t => { state.db[t.id] = t; });
  Object.assign(state.db, slot.db ?? {});
  // A character with no layout of its own goes through loadSlotConfig(), so this
  // browser's pre-layout `dnd_slot_config` is still migrated. It returns early
  // once a layout is set.
  if (!state.equipLayout.length) loadSlotConfig();
  syncNextId();
}

// Everything redrawn when the working copy is replaced wholesale.
function renderLiveCharacter() {
  rebuildGrid();
  renderItemList();
  renderEquipPanel();
  renderStash();
  updateWeightDisplay();
  syncCharacterViewUI();
}

function activateCharacter(id) {
  if (!state.characters[id]) return;
  if (state.activeCharacterId === id) return;
  cancelPlacing();
  commitActiveCharacter();   // whatever is on screen goes back to its own slot first
  state.activeCharacterId = id;
  loadActiveCharacterIntoLive();
  renderLiveCharacter();
  // Swapping characters at a table changes who sits in that seat.
  noteActiveCharacterForCampaign();
  debouncedSync();           // saves, and republishes to the party roster
  syncRoute();               // the character's page is its own URL
}

function createCharacter(meta) {
  const slot = characterSlot(meta);
  state.characters[slot.character.id] = slot;
  return slot.character.id;
}

function deleteCharacter(id) {
  if (!state.characters[id]) return;
  const wasActive = state.activeCharacterId === id;
  delete state.characters[id];
  if (wasActive) {
    state.activeCharacterId = null;
    ensureCharacter();       // falls back to another, or mints a fresh one
    renderLiveCharacter();
  }
  debouncedSync();
  renderHomeScreen();
}

// Writes a character's details back — to the slot, and to the working copy when
// that character is on screen.
function updateCharacterMeta(id, meta) {
  const slot = state.characters[id];
  if (!slot) return;
  slot.character = normalizeCharacterMeta({ ...slot.character, ...meta }, id);
  if (state.activeCharacterId === id && liveStateIsOwnCharacter()) {
    const strengthChanged = state.character.strength !== slot.character.strength;
    state.character = { ...slot.character };
    if (strengthChanged) rebuildGrid();
    updateWeightDisplay();
    syncCharacterViewUI();
  }
  debouncedSync();
  renderHomeScreen();
}

// The gear edits the character on screen, not always one of yours: a GM editing
// a player's Strength edits the working copy, and `debouncedSync()` publishes it
// to the player's roster entry.
function applyMetaToLiveCharacter(meta) {
  const next = normalizeCharacterMeta({ ...state.character, ...meta }, state.character.id ?? null);
  const strengthChanged = state.character.strength !== next.strength;
  state.character = next;
  if (strengthChanged) rebuildGrid();
  updateWeightDisplay();
  syncCharacterViewUI(); // the tab and the sheet both carry the name
  debouncedSync();
  renderHomeScreen();
}

// =============================================================================
// SAVE PAYLOAD SHAPE
// =============================================================================
// Version 1 was a single character at the top level — still what an older
// browser or cloud save holds, folded into a one-character roster here.
function normalizeSavePayload(data) {
  const characters = {};
  let activeId = null;

  if (data && data.characters && typeof data.characters === 'object') {
    Object.entries(data.characters).forEach(([id, raw]) => {
      const slot = characterSlot(normalizeCharacterMeta(raw?.character, id), raw ?? {});
      characters[slot.character.id] = slot;
    });
    activeId = data.activeCharacterId ?? null;
  } else if (data && (data.character || data.instances)) {
    const slot = characterSlot(normalizeCharacterMeta(data.character), data);
    characters[slot.character.id] = slot;
    activeId = slot.character.id;
  }

  if (!activeId || !characters[activeId]) activeId = Object.keys(characters)[0] ?? null;
  return { characters, activeCharacterId: activeId };
}

// What the cloud-conflict modal reads: one line about a whole save, in whichever
// version it is written.
function describeSavePayload(data) {
  const { characters, activeCharacterId } = normalizeSavePayload(data);
  const list = Object.values(characters);
  if (!list.length) return 'Empty save';
  const active = characters[activeCharacterId] ?? list[0];
  const count = Object.keys(active.instances ?? {}).length;
  const others = list.length - 1;
  return `${active.character.name} — ${count} item${count === 1 ? '' : 's'}` +
         (others > 0 ? `\n+ ${others} other character${others === 1 ? '' : 's'}` : '');
}

// =============================================================================
// THE HOME SCREEN
// =============================================================================
// A page of its own, not a panel — picking a character is what you do before
// there is an inventory, and where a signed-in player starts.

const homeScreenEl = document.getElementById('home-screen');
const homeGridEl   = document.getElementById('home-card-grid');
const homeMenuEl   = document.getElementById('char-card-menu');

// Which card's ⋯ menu is open, or null.
let openCardMenuId = null;

// A GM's cards are not selectable — they are running the table, not playing a
// character. Their roster is still theirs to edit.
function canSelectCharacter() {
  return !(state.party.active && state.party.role === 'gm');
}

function openHomeScreen() {
  // Somebody else's sheet must not still be the working copy when a card is clicked.
  if (state.party.viewingPlayerId !== null) switchViewToOwn();
  hideMissingScreen();
  state.screen = 'home';
  homeScreenEl.classList.remove('hidden');
  renderHomeScreen();
  syncRoute();
}

function closeHomeScreen() {
  hideMissingScreen();
  state.screen = 'app';
  closeCardMenu();
  homeScreenEl.classList.add('hidden');
  syncRoute();
}

// "Fighter" for one class, "Warlock 5 / Bard 2" for a multiclass — the per-class
// level is worth saying only when the classes disagree about it.
function describeCharacterClasses(c) {
  const entries = classEntriesOf(c);
  if (!entries.length) return '';
  if (entries.length === 1) return entries[0].name;
  return entries.map(e => `${e.name} ${e.level}`).join(' / ');
}

function renderHomeScreen() {
  if (state.screen !== 'home') return;

  // The campaigns above the roster — same page, two questions.
  renderCampaignSection();
  // And the homebrew below the roster, welcome or not — it is the account's,
  // not any one character's.
  renderHomebrewSection();

  // Nobody made yet: a greeting and one button in place of the roster, whose
  // only card would be the placeholder.
  const welcome = isWelcomeVisit();
  document.getElementById('home-welcome').classList.toggle('hidden', !welcome);
  document.getElementById('home-roster').classList.toggle('hidden', welcome);
  if (welcome) return;

  const note = document.getElementById('home-note');
  if (canSelectCharacter()) {
    note.classList.add('hidden');
  } else {
    // A GM's cards are not selectable, so the gesture that closes this page for
    // everyone else is not theirs — the note points at their campaign card.
    note.textContent = 'You are running ' + campaignDisplayName(state.party.code) +
                       ' as Game Master, so no character of your own is in play. Your ' +
                       'roster is still yours to edit — pick a player from the character ' +
                       'tabs to look at theirs. Click the campaign above to go back to it.';
    note.classList.remove('hidden');
  }

  homeGridEl.innerHTML = '';
  // The placeholder is never a card: deleting the last character mints one, and
  // showing it would look like the delete had not happened.
  const list = characterList().filter(slot => !isUntouchedSlot(slot));

  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'home-empty';
    empty.textContent = 'No characters yet. Create one to get started.';
    homeGridEl.appendChild(empty);
    return;
  }

  list.forEach(slot => {
    const c = slot.character;
    const isActive = c.id === state.activeCharacterId;

    const card = document.createElement('div');
    card.className = 'char-card' + (isActive ? ' active' : '') +
                     (canSelectCharacter() ? ' selectable' : '');
    card.dataset.charId = c.id;

    const menuBtn = document.createElement('button');
    menuBtn.className = 'char-card-menu-btn';
    menuBtn.title = 'Edit or delete this character';
    menuBtn.setAttribute('aria-label', 'Character options');
    menuBtn.appendChild(iconEl('dots'));
    menuBtn.addEventListener('click', e => {
      e.stopPropagation();
      toggleCardMenu(c.id, menuBtn);
    });
    card.appendChild(menuBtn);

    const nameEl = document.createElement('div');
    nameEl.className = 'char-card-name';
    nameEl.textContent = c.name;
    card.appendChild(nameEl);

    const levelEl = document.createElement('div');
    levelEl.className = 'char-card-level';
    levelEl.textContent = 'Level ' + c.level;
    card.appendChild(levelEl);

    [['Class', describeCharacterClasses(c) || '—'],
     ['Species', c.race || '—']].forEach(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'char-card-row';
      const k = document.createElement('span');
      k.className = 'char-card-key';
      k.textContent = label;
      const v = document.createElement('span');
      v.className = 'char-card-val';
      v.textContent = value;
      row.append(k, v);
      card.appendChild(row);
    });

    const foot = document.createElement('div');
    foot.className = 'char-card-foot';
    const count = Object.keys(slot.instances ?? {}).length;
    foot.textContent = `STR ${c.strength} · ${count} item${count === 1 ? '' : 's'}`;
    card.appendChild(foot);

    if (isActive) {
      const badge = document.createElement('span');
      badge.className = 'char-card-badge';
      badge.textContent = 'Active';
      card.appendChild(badge);
    }

    if (canSelectCharacter()) {
      card.addEventListener('click', () => {
        activateCharacter(c.id);
        closeHomeScreen();
      });
    }

    homeGridEl.appendChild(card);
  });
}

// =============================================================================
// THE ⋯ MENU
// =============================================================================
function toggleCardMenu(id, btn) {
  if (openCardMenuId === id) { closeCardMenu(); return; }
  openCardMenuId = id;
  const r = btn.getBoundingClientRect();
  homeMenuEl.classList.remove('hidden'); // measurable only once shown
  const width = homeMenuEl.offsetWidth;
  homeMenuEl.style.top  = (r.bottom + 4) + 'px';
  homeMenuEl.style.left = Math.max(4, Math.min(r.right - width, window.innerWidth - width - 4)) + 'px';
}

function closeCardMenu() {
  openCardMenuId = null;
  homeMenuEl.classList.add('hidden');
}

document.getElementById('char-card-edit').addEventListener('click', e => {
  e.stopPropagation();
  const id = openCardMenuId;
  closeCardMenu();
  if (id) openCharModal(id);
});

document.getElementById('char-card-delete').addEventListener('click', e => {
  e.stopPropagation();
  const id = openCardMenuId;
  closeCardMenu();
  if (!id) return;
  const slot = state.characters[id];
  if (!slot) return;
  const count = Object.keys(slot.instances ?? {}).length;
  if (!confirm(`Delete ${slot.character.name}?\n\n` +
               `Their ${count} item${count === 1 ? '' : 's'} and equipment go with them. ` +
               'This cannot be undone.')) return;
  deleteCharacter(id);
});

document.addEventListener('click', e => {
  if (openCardMenuId === null) return;
  if (homeMenuEl.contains(e.target)) return;
  closeCardMenu();
});

// =============================================================================
// WIRING
// =============================================================================
document.getElementById('home-btn').addEventListener('click', () => {
  if (state.screen === 'home') closeHomeScreen();
  else openHomeScreen();
});

document.getElementById('home-new-char-btn').addEventListener('click', () => {
  openCharModal(null, { isNew: true });
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || state.screen !== 'home') return;
  if (document.querySelector('.modal:not(.hidden)')) return; // the modal closes first
  if (openCardMenuId !== null) { closeCardMenu(); return; }
  closeHomeScreen();
});

// =============================================================================
// LANDING HERE AT BOOT
// =============================================================================
// A visit starts on the home screen, signed in or not — which character and
// which table come before the inventory — unless the URL names one of this
// roster's characters (router.js, applyBootRoute()). A first visit gets the
// welcome in place of the roster (isWelcomeVisit()).
//
// Older builds remembered the last sign-in under this key, purely to guess at
// boot whether to open this page. Nothing reads it now; cleared, not left behind.
try { localStorage.removeItem('dnd_inventory_last_signin'); } catch { /* private mode */ }

document.getElementById('home-welcome-create-btn').addEventListener('click', () => {
  openCharModal(null, { isNew: true });
});
