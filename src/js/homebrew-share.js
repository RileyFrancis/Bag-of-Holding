// =============================================================================
// HOMEBREW SHARING — Who can use what: enabling, resolving, and the party seam
// =============================================================================
'use strict';

// A folder or a file in the homebrew tree can be enabled for characters and for
// campaigns (`state.homebrew.enabled[key] = { characters: [id], campaigns: [code] }`).
// A folder's targets reach everything inside it, however deep — a file is
// enabled for the union of its own targets and every ancestor's.
//
//   • Enabled for a CHARACTER: usable on that character's sheet and inventory
//     only. Published with the character when they are seated at a table, so
//     a GM or party member looking at that sheet still sees their homebrew
//     class's features — but it never lands in anyone else's lists.
//   • Enabled for a CAMPAIGN: usable by everyone at that table — you, every
//     other player, the GM. Published to `parties/<code>/homebrew/<uid>`.
//
// "Usable" means the registries hand it out: `allClasses()`, `allSpecies()`,
// `allSpells()` and the background hints read `usableHomebrewOf(kind)`, and
// usable items are merged into `state.db` flagged `_homebrew` (see
// `syncHomebrewItems()`). A disabled item someone already carries stays with
// them — `getCustomDb()` keeps a `_homebrew` template while an instance uses it.
//
// Each member's node is ONE JSON string, like cloud-save.js: RTDB drops the
// nulls and empty objects a class definition is full of. Like the shops, this
// is pacing, not security — a member reading the database sees every node.

// =============================================================================
// ENABLEMENT — the model
// =============================================================================
function homebrewAccessOf(key) {
  const a = state.homebrew.enabled[key];
  return { characters: a?.characters ?? [], campaigns: a?.campaigns ?? [] };
}

// `list` is 'characters' or 'campaigns'.
function setHomebrewAccess(key, list, target, on) {
  const cur = homebrewAccessOf(key);
  const next = { ...cur, [list]: on
    ? [...new Set(cur[list].concat(target))]
    : cur[list].filter(x => x !== target) };
  if (next.characters.length || next.campaigns.length) state.homebrew.enabled[key] = next;
  else delete state.homebrew.enabled[key];
  onHomebrewChanged();
}

// The folders a node sits in, nearest first.
function homebrewAncestorsOf(key) {
  const out = [];
  for (let p = homebrewParentOf(key); p; p = state.homebrew.folders[p]?.parentId ?? null) {
    if (out.includes(p)) break; // normalizeHomebrew() cuts loops; belt and braces
    out.push(p);
  }
  return out;
}

// Every target a node is enabled for, and — for each — which node gave it
// (itself, or the nearest folder that did), so the UI can say "via Weapons".
function homebrewEffectiveAccess(key) {
  const out = { characters: new Map(), campaigns: new Map() };
  [key, ...homebrewAncestorsOf(key)].forEach(node => {
    const a = homebrewAccessOf(node);
    a.characters.forEach(id => { if (!out.characters.has(id)) out.characters.set(id, node); });
    a.campaigns.forEach(code => { if (!out.campaigns.has(code)) out.campaigns.set(code, node); });
  });
  return out;
}

// This account's own homebrew as { key, entry } — entries as stored, and the
// roster's custom items as item entries (their template, `kind: 'item'`).
function ownHomebrewEntries() {
  return collectHomebrewFiles().map(f => ({
    key: f.key,
    entry: f.template ? { ...f.template, kind: 'item' } : state.homebrew.entries[f.entryId],
  })).filter(x => x.entry);
}

function ownEntriesEnabledFor({ characterId = null, campaignCodes = [] }) {
  return ownHomebrewEntries().filter(({ key }) => {
    const eff = homebrewEffectiveAccess(key);
    return (characterId && eff.characters.has(characterId)) ||
           campaignCodes.some(code => eff.campaigns.has(code));
  }).map(x => x.entry);
}

// =============================================================================
// WHAT IS USABLE RIGHT NOW
// =============================================================================
// Depends on whose sheet is on screen and which table (if any) we sit at:
//   own character, solo    → enabled for it, or for a campaign it plays in
//                            (that campaign's shared homebrew from the last
//                            session is cached on the bookmark)
//   seated at a campaign   → everything shared to the campaign, by anyone
//   + own character        → + enabled for it
//   + another's sheet      → + what that member enabled for their character
// Memoised on this key; `onHomebrewChanged()` bumps the revision.
let homebrewRev = 0;
let homebrewUsableMemo = { key: null, list: [] };

function homebrewUsableKey() {
  return [homebrewRev, state.activeCharacterId ?? '', state.party.active ? state.party.code : '',
    state.party.viewingPlayerId ?? '', state.party.role ?? '', liveStateIsOwnCharacter() ? 1 : 0].join('|');
}

function usableHomebrew() {
  const key = homebrewUsableKey();
  if (homebrewUsableMemo.key === key) return homebrewUsableMemo.list;

  const byId = new Map();
  const add = list => (list ?? []).forEach(e => { if (e?.id && !byId.has(e.id)) byId.set(e.id, e); });
  const ownChar = liveStateIsOwnCharacter() ? state.activeCharacterId : null;

  if (state.party.active) {
    const code = state.party.code;
    add(ownEntriesEnabledFor({ characterId: ownChar, campaignCodes: [code] }));
    const members = partyHomebrewMembers();
    Object.values(members).forEach(m => add(m.campaign));
    const viewing = state.party.viewingPlayerId;
    if (viewing && members[viewing]) add(members[viewing].character);
  } else if (ownChar) {
    const codes = Object.values(state.campaigns)
      .filter(c => c.characterId === ownChar).map(c => c.code);
    add(ownEntriesEnabledFor({ characterId: ownChar, campaignCodes: codes }));
    codes.forEach(code => add(state.campaigns[code]?.sharedHomebrew));
  }

  homebrewUsableMemo = { key, list: [...byId.values()] };
  return homebrewUsableMemo.list;
}

function invalidateUsableHomebrew() { homebrewRev++; }

function usableHomebrewOf(kind) {
  return usableHomebrew().filter(e => e.kind === kind);
}

// Anything that changes what is enabled or what exists: redraw every consumer.
// The sheet's sections are signature-gated, and `homebrewUsableKey()` is part
// of each signature, so `syncCharacterViewUI()` is enough to reach them.
function onHomebrewChanged() {
  homebrewRev++;
  debouncedSync();           // saves, and republishes to the party (party.js)
  refreshHomebrewConsumers();
  renderHomebrewSection();
}

function refreshHomebrewConsumers() {
  syncHomebrewItems();
  renderItemList();
  if (state.screen === 'app') syncCharacterViewUI();
}

// =============================================================================
// THE REGISTRIES' SIDE — homebrew in the shapes they already hold
// =============================================================================
// `findClassByName()` runs once per class entry per render, so each merged list
// is built once per `homebrewUsableKey()` and handed out until that changes.
// Callers only read what they are given — same promise DEFAULT_CLASSES has.
const homebrewRegistryMemo = {};
function memoHomebrewRegistry(name, build) {
  const key = homebrewUsableKey();
  const hit = homebrewRegistryMemo[name];
  if (hit && hit.key === key) return hit.list;
  const list = build();
  homebrewRegistryMemo[name] = { key, list };
  return list;
}

// A class and its homebrew subclasses; a built-in class gains homebrew
// subclasses too (matched by class name, the way a character's classes are).
// Copies, never the shared DEFAULT_CLASSES objects.
function withHomebrewClasses(defaults) {
  return memoHomebrewRegistry('classes', () => buildHomebrewClasses(defaults));
}

function buildHomebrewClasses(defaults) {
  const classes = defaults.map(c => ({ ...c, subclasses: c.subclasses.slice() }));
  usableHomebrewOf('class').forEach(e => {
    classes.push({
      id: e.id, name: e.name, source: cleanSource(e.source || 'HB'), homebrew: true,
      subclasses: [],
      features: (e.features ?? []).map(f => sanitizeFeature(f)).filter(Boolean),
    });
  });
  usableHomebrewOf('subclass').forEach(e => {
    const key = String(e.className ?? '').trim().toLowerCase();
    const parent = classes.find(c => c.name.toLowerCase() === key);
    if (!parent) return;
    parent.subclasses.push({
      id: e.id, name: e.name, source: cleanSource(e.source || 'HB'),
      features: (e.features ?? []).map(f => sanitizeFeature(f)).filter(Boolean),
    });
  });
  return classes;
}

function withHomebrewSpecies(defaults) {
  return memoHomebrewRegistry('species', () => defaults.concat(usableHomebrewOf('species').map(e => ({
    id: e.id, name: e.name, homebrew: true,
    traits: (e.traits ?? []).map(t => sanitizeTrait(t)).filter(Boolean),
  }))));
}

// A spell on no class's list would be dropped by the sanitizer, so it is listed
// under "Homebrew" — an extra class the spellbook offers as an opt-in checkbox.
function withHomebrewSpells(defaults) {
  return memoHomebrewRegistry('spells', () => {
    const raw = usableHomebrewOf('spell').map(e => ({
      ...e, classes: (e.classes ?? []).length ? e.classes : ['Homebrew'],
    }));
    return defaults.concat(sanitizeSpellList(raw));
  });
}

// Usable homebrew items in the Browse catalogue. Stale copies go, unless an
// instance still uses one. A character's own template of the same id (it is
// their custom item) always wins over the flagged copy.
function syncHomebrewItems() {
  const usable = usableHomebrewOf('item');
  const ids = new Set(usable.map(e => e.id));
  Object.values(state.db).forEach(t => {
    if (t?._homebrew && !ids.has(t.id) && !homebrewItemInUse(t.id)) delete state.db[t.id];
  });
  usable.forEach(e => {
    const cur = state.db[e.id];
    if (cur && !cur._homebrew) return;
    const { kind, ...template } = e;
    state.db[e.id] = { ...template, _homebrew: true };
  });
}

function homebrewItemInUse(templateId) {
  return Object.values(state.instances ?? {}).some(i => i.templateId === templateId);
}

// =============================================================================
// THE PARTY SEAM
// =============================================================================
// parties/<code>/homebrew/<uid> = { json: '{"campaign":[…],"character":[…]}' }
let partyHomebrewRef = null;
let lastPublishedHomebrew = null;

// Parsed nodes of current members only — a kicked player's node outlives their
// seat, and must stop counting the moment the roster says so.
function partyHomebrewMembers() {
  const out = {};
  Object.entries(state.party.homebrew ?? {}).forEach(([uid, node]) => {
    const member = uid === state.party.gmUid || !!state.party.players?.[uid];
    if (!member || uid === ownPlayerId()) return;
    try {
      const parsed = JSON.parse(node?.json ?? '{}');
      out[uid] = {
        campaign:  Array.isArray(parsed.campaign)  ? parsed.campaign  : [],
        character: Array.isArray(parsed.character) ? parsed.character : [],
      };
    } catch { /* a malformed node shares nothing */ }
  });
  return out;
}

function subscribeToHomebrew(code) {
  unsubscribeFromHomebrew();
  if (!firebaseDb) return;
  partyHomebrewRef = firebaseDb.ref(`parties/${code}/homebrew`);
  partyHomebrewRef.on('value', snap => {
    state.party.homebrew = snap.val() ?? {};
    cacheCampaignHomebrew(code);
    homebrewRev++;
    refreshHomebrewConsumers();
  });
  publishHomebrewToParty();
}

function unsubscribeFromHomebrew() {
  if (partyHomebrewRef) { partyHomebrewRef.off(); partyHomebrewRef = null; }
  lastPublishedHomebrew = null;
  if (state.party.homebrew && Object.keys(state.party.homebrew).length) {
    state.party.homebrew = {};
    homebrewRev++;
  }
}

// The others' campaign homebrew, kept on this account's bookmark so a
// character who plays here keeps the party's homebrew class between sessions.
// Not saved on its own — it rides the next save, like the bookmark's head count.
function cacheCampaignHomebrew(code) {
  const bookmark = state.campaigns[code];
  if (!bookmark) return;
  bookmark.sharedHomebrew = Object.values(partyHomebrewMembers()).flatMap(m => m.campaign);
}

// Our own node: what we share with the table, and what our seated character
// carries. Skipped when nothing changed — `debouncedSync()` calls this on every
// inventory edit.
function publishHomebrewToParty() {
  if (!state.party.active || !firebaseDb || !ownPlayerId()) return;
  const code = state.party.code;
  const seatedId = state.party.role === 'player'
    ? (state.campaigns[code]?.characterId ?? state.activeCharacterId) : null;
  const json = JSON.stringify({
    campaign: ownEntriesEnabledFor({ campaignCodes: [code] }),
    character: seatedId ? ownEntriesEnabledFor({ characterId: seatedId }) : [],
  });
  if (json === lastPublishedHomebrew) return;
  lastPublishedHomebrew = json;
  firebaseDb.ref(`parties/${code}/homebrew/${ownPlayerId()}`).set({ json })
    .catch(() => { lastPublishedHomebrew = null; }); // try again on the next sync
}

// =============================================================================
// THE "ENABLED FOR" PANEL
// =============================================================================
let homebrewAccessKey = null;

function homebrewNodeName(key) {
  if (state.homebrew.folders[key]) return state.homebrew.folders[key].name;
  return collectHomebrewFiles().find(f => f.key === key)?.name ?? 'this homebrew';
}

function openHomebrewAccess(key) {
  homebrewAccessKey = key;
  const isFolder = !!state.homebrew.folders[key];
  document.getElementById('homebrew-access-title').textContent = `Enable “${homebrewNodeName(key)}”`;
  document.getElementById('homebrew-access-note').textContent = isFolder
    ? 'Everything in this folder, and in the folders inside it, follows what you tick here.'
    : 'A campaign shares it with everyone at that table. A character keeps it to that character alone.';
  renderHomebrewAccess();
  showModal('homebrew-access-modal');
}

function renderHomebrewAccess() {
  const key = homebrewAccessKey;
  if (!key) return;
  const own = homebrewAccessOf(key);
  const eff = homebrewEffectiveAccess(key);

  const fill = (listEl, targets, list) => {
    listEl.innerHTML = '';
    if (!targets.length) {
      const p = document.createElement('p');
      p.className = 'modal-note';
      p.textContent = list === 'campaigns' ? 'No campaigns yet.' : 'No characters yet.';
      listEl.appendChild(p);
      return;
    }
    targets.forEach(({ id, name, detail }) => {
      const via = eff[list].get(id);
      const inherited = via && via !== key && !own[list].includes(id);
      const label = document.createElement('label');
      label.className = 'hb-access-row' + (inherited ? ' inherited' : '');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = own[list].includes(id) || inherited;
      box.disabled = inherited;
      box.addEventListener('change', () => {
        setHomebrewAccess(key, list, id, box.checked);
        renderHomebrewAccess();
      });
      const text = document.createElement('span');
      text.className = 'hb-access-name';
      text.textContent = name;
      label.append(box, text);
      const sub = inherited ? `via ${state.homebrew.folders[via]?.name ?? 'a folder'}` : detail;
      if (sub) {
        const d = document.createElement('span');
        d.className = 'hb-access-detail';
        d.textContent = sub;
        label.appendChild(d);
      }
      listEl.appendChild(label);
    });
  };

  fill(document.getElementById('homebrew-access-campaigns'), homebrewCampaignTargets(), 'campaigns');
  fill(document.getElementById('homebrew-access-characters'), homebrewCharacterTargets(), 'characters');
}

function homebrewCampaignTargets() {
  return campaignList().map(c => ({
    id: c.code, name: campaignDisplayName(c.code),
    detail: c.role === 'gm' ? 'Game Master' : (state.characters[c.characterId]?.character.name ?? ''),
  }));
}

function homebrewCharacterTargets() {
  return characterList().filter(slot => !isUntouchedSlot(slot)).map(slot => ({
    id: slot.character.id, name: slot.character.name, detail: '',
  }));
}

// The short line a tree row carries: who it is enabled for, own and inherited.
function homebrewAccessSummary(key) {
  const eff = homebrewEffectiveAccess(key);
  const names = [];
  eff.campaigns.forEach((via, code) => {
    if (state.campaigns[code]) names.push({ text: campaignDisplayName(code), campaign: true, inherited: via !== key });
  });
  eff.characters.forEach((via, id) => {
    if (state.characters[id]) names.push({ text: state.characters[id].character.name, campaign: false, inherited: via !== key });
  });
  return names;
}
