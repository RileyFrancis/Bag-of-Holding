// =============================================================================
// HOMEBREW SHARING — Who can use what: enabling, resolving, and the party seam
// =============================================================================
'use strict';

// `state.homebrew.enabled[key] = { characters: [id], campaigns: [code] }`. A file
// is enabled for the union of its own targets and every ancestor folder's.
//   • CHARACTER: usable on that character only. Published with them when seated,
//     so viewers of that sheet see its features, but never in anyone's lists.
//   • CAMPAIGN: usable by everyone at that table (`parties/<code>/homebrew/<uid>`).
// Usable homebrew is handed out by the registries (`getUsableHomebrewOfKind()`), and
// items are merged into `state.db` flagged `_homebrew` (`syncHomebrewItems()`).
// Each member's node is ONE JSON string, since RTDB drops the nulls and empty
// objects a class definition is full of. This is pacing, not security.

// ─── ENABLEMENT MODEL ──────────────────────────────────────────────────────
function _getHomebrewAccess(key) {
  const a = state.homebrew.enabled[key];
  return { characters: a?.characters ?? [], campaigns: a?.campaigns ?? [] };
}

// `list` is 'characters' or 'campaigns'.
function _setHomebrewAccess(key, list, target, isEnabled) {
  const cur = _getHomebrewAccess(key);
  const next = { ...cur, [list]: isEnabled
    ? [...new Set(cur[list].concat(target))]
    : cur[list].filter(x => x !== target) };
  if (next.characters.length || next.campaigns.length) state.homebrew.enabled[key] = next;
  else delete state.homebrew.enabled[key];
  onHomebrewChanged();
}

// The folders a node sits in, nearest first.
function _getHomebrewAncestors(key) {
  const out = [];
  for (let p = getHomebrewParentId(key); p; p = state.homebrew.folders[p]?.parentId ?? null) {
    if (out.includes(p)) break; // normalizeHomebrew() cuts loops; belt and braces
    out.push(p);
  }
  return out;
}

// Every target a node is enabled for, mapped to the node that gave it (itself or
// the nearest folder), so the UI can say "via Weapons".
function _getHomebrewEffectiveAccess(key) {
  const out = { characters: new Map(), campaigns: new Map() };
  [key, ..._getHomebrewAncestors(key)].forEach(node => {
    const a = _getHomebrewAccess(node);
    a.characters.forEach(id => { if (!out.characters.has(id)) out.characters.set(id, node); });
    a.campaigns.forEach(code => { if (!out.campaigns.has(code)) out.campaigns.set(code, node); });
  });
  return out;
}

// This account's own homebrew as { key, entry }: entries as stored, and the
// roster's custom items as their template with `kind: 'item'`.
function _getOwnHomebrewEntries() {
  return collectHomebrewFiles().map(f => ({
    key: f.key,
    entry: f.template ? { ...f.template, kind: 'item' } : state.homebrew.entries[f.entryId],
  })).filter(x => x.entry);
}

function _getOwnHomebrewEnabledFor({ characterId = null, campaignCodes = [] }) {
  return _getOwnHomebrewEntries().filter(({ key }) => {
    const eff = _getHomebrewEffectiveAccess(key);
    return (characterId && eff.characters.has(characterId)) ||
           campaignCodes.some(code => eff.campaigns.has(code));
  }).map(x => x.entry);
}

// ─── WHAT IS USABLE RIGHT NOW ──────────────────────────────────────────────
// Depends on whose sheet is on screen and which table (if any) we sit at:
//   own character, solo    → enabled for it, or for a campaign it plays in
//                            (plus that campaign's shared homebrew, cached on
//                            the bookmark)
//   seated at a campaign   → everything shared to the campaign, by anyone
//   + own character        → + enabled for it
//   + another's sheet      → + what that member enabled for their character
// Memoised on this key; `onHomebrewChanged()` bumps the revision.
let homebrewRev = 0;
let homebrewUsableMemo = { key: null, list: [] };

// Signature of everything usable homebrew depends on; include it in any
// render gate that reads homebrew.
function getHomebrewUsableKey() {
  return [homebrewRev, state.activeCharacterId ?? '', state.party.active ? state.party.code : '',
    state.party.viewingPlayerId ?? '', state.party.role ?? '', isLiveStateOwnCharacter() ? 1 : 0].join('|');
}

function _getUsableHomebrew() {
  const key = getHomebrewUsableKey();
  if (homebrewUsableMemo.key === key) return homebrewUsableMemo.list;

  const byId = new Map();
  const add = list => (list ?? []).forEach(e => { if (e?.id && !byId.has(e.id)) byId.set(e.id, e); });
  const ownChar = isLiveStateOwnCharacter() ? state.activeCharacterId : null;

  if (state.party.active) {
    const code = state.party.code;
    add(_getOwnHomebrewEnabledFor({ characterId: ownChar, campaignCodes: [code] }));
    const members = _getPartyHomebrewMembers();
    Object.values(members).forEach(m => add(m.campaign));
    const viewing = state.party.viewingPlayerId;
    if (viewing && members[viewing]) add(members[viewing].character);
  } else if (ownChar) {
    const codes = Object.values(state.campaigns)
      .filter(c => c.characterId === ownChar).map(c => c.code);
    add(_getOwnHomebrewEnabledFor({ characterId: ownChar, campaignCodes: codes }));
    codes.forEach(code => add(state.campaigns[code]?.sharedHomebrew));
  }

  homebrewUsableMemo = { key, list: [...byId.values()] };
  return homebrewUsableMemo.list;
}

// Forces the usable list and registry memos to rebuild on next read.
function invalidateUsableHomebrew() { homebrewRev++; }

// Usable homebrew entries of one kind, for whoever's sheet is on screen.
function getUsableHomebrewOfKind(kind) {
  return _getUsableHomebrew().filter(e => e.kind === kind);
}

// Call after anything that changes what is enabled or exists: saves and redraws
// every consumer. `getHomebrewUsableKey()` is in each sheet signature, so
// `syncCharacterViewUI()` reaches the gated sections.
function onHomebrewChanged() {
  homebrewRev++;
  scheduleSaveAndSync();           // saves, and republishes to the party (party.js)
  refreshHomebrewConsumers();
  renderHomebrewSection();
}

// Redraws everything that reads usable homebrew, without saving.
function refreshHomebrewConsumers() {
  syncHomebrewItems();
  renderItemList();
  if (state.screen === 'app') syncCharacterViewUI();
}

// ─── REGISTRY MERGES ───────────────────────────────────────────────────────
// `findClassByName()` runs once per class entry per render, so each merged list
// is built once per `getHomebrewUsableKey()` and handed out until that changes.
// Callers only read what they are given, the same promise DEFAULT_CLASSES has.
const homebrewRegistryMemo = {};
function _getMemoizedHomebrewRegistry(name, build) {
  const key = getHomebrewUsableKey();
  const hit = homebrewRegistryMemo[name];
  if (hit && hit.key === key) return hit.list;
  const list = build();
  homebrewRegistryMemo[name] = { key, list };
  return list;
}

// The class registry plus usable homebrew classes and subclasses (a built-in
// class gains homebrew subclasses too, matched by name). Copies, never the
// shared DEFAULT_CLASSES objects.
function getClassesWithHomebrew(defaults) {
  return _getMemoizedHomebrewRegistry('classes', () => _buildHomebrewClasses(defaults));
}

function _buildHomebrewClasses(defaults) {
  const classes = defaults.map(c => ({ ...c, subclasses: c.subclasses.slice() }));
  getUsableHomebrewOfKind('class').forEach(e => {
    classes.push({
      id: e.id, name: e.name, source: cleanSource(e.source || 'HB'), homebrew: true,
      subclasses: [],
      features: (e.features ?? []).map(f => sanitizeFeature(f)).filter(Boolean),
    });
  });
  getUsableHomebrewOfKind('subclass').forEach(e => {
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

// The species registry plus usable homebrew species.
function getSpeciesWithHomebrew(defaults) {
  return _getMemoizedHomebrewRegistry('species', () => defaults.concat(getUsableHomebrewOfKind('species').map(e => ({
    id: e.id, name: e.name, homebrew: true,
    traits: (e.traits ?? []).map(t => sanitizeTrait(t)).filter(Boolean),
  }))));
}

// The spell list plus usable homebrew spells. A spell on no class's list would be
// dropped by the sanitizer, so it is listed under the opt-in "Homebrew" class.
function getSpellsWithHomebrew(defaults) {
  return _getMemoizedHomebrewRegistry('spells', () => {
    const raw = getUsableHomebrewOfKind('spell').map(e => ({
      ...e, classes: (e.classes ?? []).length ? e.classes : ['Homebrew'],
    }));
    return defaults.concat(sanitizeSpellList(raw));
  });
}

// Merges usable homebrew items into `state.db`. Stale copies go unless an
// instance still uses one; a character's own template of the same id (their
// custom item) always wins over the flagged copy.
function syncHomebrewItems() {
  const usable = getUsableHomebrewOfKind('item');
  const ids = new Set(usable.map(e => e.id));
  Object.values(state.db).forEach(t => {
    if (t?._homebrew && !ids.has(t.id) && !isHomebrewItemInUse(t.id)) delete state.db[t.id];
  });
  usable.forEach(e => {
    const cur = state.db[e.id];
    if (cur && !cur._homebrew) return;
    const { kind, ...template } = e;
    state.db[e.id] = { ...template, _homebrew: true };
  });
}

// True when any placed or carried instance uses this template.
function isHomebrewItemInUse(templateId) {
  return Object.values(state.instances ?? {}).some(i => i.templateId === templateId);
}

// ─── THE PARTY SEAM ────────────────────────────────────────────────────────
// parties/<code>/homebrew/<uid> = { json: '{"campaign":[…],"character":[…]}' }
let partyHomebrewRef = null;
let lastPublishedHomebrew = null;

// Parsed nodes of current members only: a kicked player's node outlives their
// seat and must stop counting the moment the roster says so.
function _getPartyHomebrewMembers() {
  const out = {};
  Object.entries(state.party.homebrew ?? {}).forEach(([uid, node]) => {
    const isMember = uid === state.party.gmUid || !!state.party.players?.[uid];
    if (!isMember || uid === getOwnPlayerId()) return;
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

// Listens to the party's homebrew nodes and publishes our own.
function subscribeToHomebrew(code) {
  unsubscribeFromHomebrew();
  if (!firebaseDb) return;
  partyHomebrewRef = firebaseDb.ref(`parties/${code}/homebrew`);
  partyHomebrewRef.on('value', snap => {
    state.party.homebrew = snap.val() ?? {};
    _cacheCampaignHomebrew(code);
    homebrewRev++;
    refreshHomebrewConsumers();
  });
  publishHomebrewToParty();
}

// Stops listening and forgets the party's homebrew.
function unsubscribeFromHomebrew() {
  if (partyHomebrewRef) { partyHomebrewRef.off(); partyHomebrewRef = null; }
  lastPublishedHomebrew = null;
  if (state.party.homebrew && Object.keys(state.party.homebrew).length) {
    state.party.homebrew = {};
    homebrewRev++;
  }
}

// Keeps the others' campaign homebrew on this account's bookmark, so it stays
// usable between sessions. Not saved on its own; it rides the next save.
function _cacheCampaignHomebrew(code) {
  const bookmark = state.campaigns[code];
  if (!bookmark) return;
  bookmark.sharedHomebrew = Object.values(_getPartyHomebrewMembers()).flatMap(m => m.campaign);
}

// Writes our own node: what we share with the table and what our seated
// character carries. Skipped when unchanged, since `scheduleSaveAndSync()` calls this
// on every inventory edit.
function publishHomebrewToParty() {
  if (!state.party.active || !firebaseDb || !getOwnPlayerId()) return;
  const code = state.party.code;
  const seatedId = state.party.role === 'player'
    ? (state.campaigns[code]?.characterId ?? state.activeCharacterId) : null;
  const json = JSON.stringify({
    campaign: _getOwnHomebrewEnabledFor({ campaignCodes: [code] }),
    character: seatedId ? _getOwnHomebrewEnabledFor({ characterId: seatedId }) : [],
  });
  if (json === lastPublishedHomebrew) return;
  lastPublishedHomebrew = json;
  firebaseDb.ref(`parties/${code}/homebrew/${getOwnPlayerId()}`).set({ json })
    .catch(() => { lastPublishedHomebrew = null; }); // try again on the next sync
}

// ─── THE "ENABLED FOR" PANEL ───────────────────────────────────────────────
let homebrewAccessKey = null;

function _getHomebrewNodeName(key) {
  if (state.homebrew.folders[key]) return state.homebrew.folders[key].name;
  return collectHomebrewFiles().find(f => f.key === key)?.name ?? 'this homebrew';
}

// Opens the "Enable for" modal for a homebrew folder or file.
function openHomebrewAccess(key) {
  homebrewAccessKey = key;
  const isFolder = !!state.homebrew.folders[key];
  document.getElementById('homebrew-access-title').textContent = `Enable “${_getHomebrewNodeName(key)}”`;
  document.getElementById('homebrew-access-note').textContent = isFolder
    ? 'Everything in this folder, and in the folders inside it, follows what you tick here.'
    : 'A campaign shares it with everyone at that table. A character keeps it to that character alone.';
  _renderHomebrewAccess();
  showModal('homebrew-access-modal');
}

function _renderHomebrewAccess() {
  const key = homebrewAccessKey;
  if (!key) return;
  const own = _getHomebrewAccess(key);
  const eff = _getHomebrewEffectiveAccess(key);

  const fillTargetList = (listEl, targets, list) => {
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
      const isInherited = via && via !== key && !own[list].includes(id);
      const label = document.createElement('label');
      label.className = 'hb-access-row' + (isInherited ? ' inherited' : '');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = own[list].includes(id) || isInherited;
      box.disabled = isInherited;
      box.addEventListener('change', () => {
        _setHomebrewAccess(key, list, id, box.checked);
        _renderHomebrewAccess();
      });
      const text = document.createElement('span');
      text.className = 'hb-access-name';
      text.textContent = name;
      label.append(box, text);
      const sub = isInherited ? `via ${state.homebrew.folders[via]?.name ?? 'a folder'}` : detail;
      if (sub) {
        const d = document.createElement('span');
        d.className = 'hb-access-detail';
        d.textContent = sub;
        label.appendChild(d);
      }
      listEl.appendChild(label);
    });
  };

  fillTargetList(document.getElementById('homebrew-access-campaigns'), _getHomebrewCampaignTargets(), 'campaigns');
  fillTargetList(document.getElementById('homebrew-access-characters'), _getHomebrewCharacterTargets(), 'characters');
}

function _getHomebrewCampaignTargets() {
  return getCampaignList().map(c => ({
    id: c.code, name: getCampaignDisplayName(c.code),
    detail: c.role === 'gm' ? 'Game Master' : (state.characters[c.characterId]?.character.name ?? ''),
  }));
}

function _getHomebrewCharacterTargets() {
  return getCharacterSlots().filter(slot => !isUntouchedSlot(slot)).map(slot => ({
    id: slot.character.id, name: slot.character.name, detail: '',
  }));
}

// Who a tree row is enabled for, own and inherited, as [{ text, campaign, inherited }].
function getHomebrewAccessSummary(key) {
  const eff = _getHomebrewEffectiveAccess(key);
  const names = [];
  eff.campaigns.forEach((via, code) => {
    if (state.campaigns[code]) names.push({ text: getCampaignDisplayName(code), campaign: true, inherited: via !== key });
  });
  eff.characters.forEach((via, id) => {
    if (state.characters[id]) names.push({ text: state.characters[id].character.name, campaign: false, inherited: via !== key });
  });
  return names;
}
