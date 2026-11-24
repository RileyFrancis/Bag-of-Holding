// =============================================================================
// PARTY — Firebase party sync, presence, and party UI
// =============================================================================
'use strict';

const PRESENCE_HEARTBEAT_MS = 40000;  // how often a live client re-states itself
const PRESENCE_STALE_MS     = 105000; // ~2.5 missed beats before a claim lapses
const PRESENCE_SWEEP_MS     = 15000;  // how often the panel re-checks the clock

// Party play is other people's data, so it is the one part that asks for an account.
const PARTY_AUTH_REASON = 'Campaigns need an account, so your group can tell who is who.';

let firebaseDb = null;
let partyPlayersRef = null;
let partyMetaRef = null;
let firebaseInitError = null; // kept so the party buttons can say what went wrong

// Our own node in the party. Owned by the presence block — the only thing
// that may write to it. It carries an onDisconnect handler that must be re-armed
// on every reconnect and *cancelled* when we leave on purpose; uncancelled it
// would write `connected: false` back into a roster we are no longer in.
let partySelfRef = null;

// Whether we have ever seen ourselves in the roster. A player's entry vanishing
// afterwards means the GM removed it (the roster is the only signal, and one a
// slow first snapshot cannot spoof).
let hasSeenSelfInRoster = false;

let presenceConnRef    = null; // .info/connected
let presenceOffsetRef  = null; // .info/serverTimeOffset
let presenceTimer      = null;
let presenceSweepTimer = null;

// `lastSeen` is server-stamped, so it must be read against the server's clock —
// a client an hour out would call everyone offline, or nobody.
let serverTimeOffset = 0;

// The roster's online/offline answer at the last redraw, so the sweep redraws only on a change.
let lastPresenceSignature = '';

let syncTimer = null;

// Sets up the Firebase app and database handle; a no-op without config or SDK.
function initFirebase() {
  if (!FIREBASE_CONFIG) return; // firebase-config.js already explained why
  if (typeof firebase === 'undefined') {
    firebaseInitError = 'sdk';
    console.warn('The Firebase SDK did not load — party features unavailable. ' +
                 'The <script> tags in index.html pull it from gstatic.com, which needs a network connection.');
    return;
  }
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    firebaseDb = firebase.database();
  } catch (e) {
    firebaseInitError = e.message;
    console.warn('Firebase init failed — party features unavailable:', e);
  }
}

// Why party sync is off, phrased as the thing that fixes it. The three causes
// look identical from the button; by far the most common is opening index.html
// off disk, where the browser refuses to read .env.
function getPartyUnavailableMessage() {
  if (!FIREBASE_CONFIG) {
    if (location.protocol === 'file:') {
      return 'Party play needs the app served over HTTP.\n\n' +
             'Opened straight from disk (file://), the browser will not let it read .env, ' +
             'so the Firebase settings never arrive.\n\n' +
             'From the project folder run:\n' +
             '    python3 -m http.server 8787\n' +
             'then open http://localhost:8787';
    }
    const isLocalHost = ['localhost', '127.0.0.1', ''].includes(location.hostname);
    if (!isLocalHost) {
      return 'Party play is off because this deploy has no Firebase settings.\n\n' +
             '.env is gitignored, so it never reaches the host — and Cloudflare Pages ' +
             'will not serve a file whose name starts with a dot in any case.\n\n' +
             'Set the FIREBASE_* variables under Pages → Settings → Variables and Secrets, ' +
             'then redeploy: functions/firebase-env.js serves them to this page at ' +
             '/firebase-env, which is currently answering with nothing.';
    }
    return 'Party play is off because .env could not be read.\n\n' +
           'It must sit in the project root and be served alongside index.html — ' +
           'check that opening /.env on this server returns the file, and that it sets ' +
           'FIREBASE_DATABASE_URL.\n\nSee .env.example for the full list of keys.';
  }
  if (firebaseInitError === 'sdk') {
    return 'Party play is off because the Firebase SDK did not load.\n\n' +
           'index.html pulls it from gstatic.com, so it needs a working network connection ' +
           '(and no extension blocking it).';
  }
  return 'Party play is off because Firebase failed to start:\n\n' + firebaseInitError +
         '\n\nCheck the values in .env against Firebase Console → Project settings → Your apps.';
}

function _generatePartyCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─── IDENTITY ───
// A player's node under `parties/<code>/players` is keyed by their account uid,
// so rejoining lands on the node you already had and the roster can be read as
// membership. The GM's node is the single `parties/<code>/gm`.

// This account's uid, which is also its roster key; null when signed out.
function getOwnPlayerId() {
  return state.auth.user?.uid ?? null;
}

// The synced character behind one party member's account (the roster's
// `p.character`), or null.
function getCharacterForUid(uid) {
  return uid ? (state.party.players?.[uid]?.character ?? null) : null;
}

// Legacy roster entries are `p_`-prefixed and identified only by the typed name.
// The sweep is best-effort; a leftover it misses is one Kick away.
function _isLegacyPlayerKey(id) {
  return typeof id === 'string' && id.startsWith('p_');
}

async function _sweepLegacySelfEntries(code, name) {
  try {
    const snap = await firebaseDb.ref(`parties/${code}/players`).get();
    const players = snap.val() ?? {};
    const stale = Object.entries(players).filter(([id, p]) => _isLegacyPlayerKey(id) && p && p.name === name);
    await Promise.all(stale.map(([id]) =>
      firebaseDb.ref(`parties/${code}/players/${id}`).remove().catch(() => {})));
  } catch { /* a courtesy; a failure must not block the join */ }
}

// The non-default item templates to save. Someone's homebrew item (`_homebrew`,
// homebrew-share.js) is kept only while an instance still uses it.
function getCustomDb() {
  return Object.fromEntries(
    Object.entries(state.db).filter(([id, t]) =>
      !DEFAULT_ITEM_IDS.has(id) && (!t?._homebrew || isHomebrewItemInUse(id)))
  );
}

function _getSerializableInstances() {
  return Object.fromEntries(
    Object.entries(state.instances).map(([id, inst]) => [id, {
      id: inst.id,
      templateId: inst.templateId,
      rotation: inst.rotation,
      row: inst.row,
      col: inst.col,
      stackCount: inst.stackCount,
      containerId: inst.containerId ?? null,
    }])
  );
}

// ─── ENTERING A CAMPAIGN ───
// Three ways in; only the write differs, and `_beginPartySession()` does the rest.
// Each returns the campaign code on success, or null after alerting why.

function _beginPartySession({ code, role, playerId, playerName, campaignName }) {
  state.party.active = true;
  state.party.code = code;
  state.party.role = role;
  state.party.playerId = playerId;
  state.party.playerName = playerName;
  state.party.campaignName = campaignName ?? null;
  state.party.viewingPlayerId = null;
  state.party.players = {};

  _subscribeToParty(code);
  _startPresenceSweep(); // a lapsed claim has no snapshot to announce it
  hideModal('campaign-modal');
  _updatePartyUI();
  switchTab('party');
}

// The campaign's own name, who runs it, and when it was made — written once,
// read by anyone holding the code.
function _buildCampaignMeta(name, uid, gmName) {
  return { name, gmUid: uid ?? null, gmName: gmName || 'Game Master', createdAt: Date.now() };
}

// Writes a new campaign with us as GM and starts the session.
async function createCampaign(name) {
  if (!firebaseDb) { alert(getPartyUnavailableMessage()); return null; }
  const uid = getOwnPlayerId();
  if (!uid) { alert('Creating a campaign needs an account, so your table knows who is running it.'); return null; }

  const code = _generatePartyCode();
  const gmName = getAccountDisplayName() || 'Game Master';
  try {
    await firebaseDb.ref(`parties/${code}`).update({
      meta: _buildCampaignMeta(name, uid, gmName),
      gm: { name: gmName, uid, connected: true, lastSeen: _getPresenceStamp() },
    });
    _startPresence(firebaseDb.ref(`parties/${code}/gm`));
  } catch (e) {
    alert('Failed to create the campaign: ' + e.message);
    return null;
  }

  _beginPartySession({ code, role: 'gm', playerId: 'gm', playerName: gmName, campaignName: name });
  return code;
}

// The GM returning to a campaign they run. An `update`, not a `set`, so anything
// else stored on the GM node survives.
async function enterCampaignAsGM(code, meta) {
  if (!firebaseDb) { alert(getPartyUnavailableMessage()); return null; }
  const uid = getOwnPlayerId();
  const gmName = getAccountDisplayName() || 'Game Master';
  try {
    const gmRef = firebaseDb.ref(`parties/${code}/gm`);
    await gmRef.update({ name: gmName, uid, connected: true, lastSeen: _getPresenceStamp() });
    _startPresence(gmRef);
  } catch (e) {
    alert('Could not rejoin as Game Master: ' + e.message);
    return null;
  }

  _beginPartySession({ code, role: 'gm', playerId: 'gm', playerName: gmName, campaignName: meta?.name ?? null });
  return code;
}

// A player taking their seat. `update` for the same reason: a rejoin lands on the
// node they already had rather than making a second beside it.
async function enterCampaignAsPlayer(code, playerName, meta) {
  if (!firebaseDb) { alert(getPartyUnavailableMessage()); return null; }
  const uid = getOwnPlayerId();
  if (!uid) { alert('Joining a campaign needs an account, so your group can tell who is who.'); return null; }

  try {
    const playerRef = firebaseDb.ref(`parties/${code}/players/${uid}`);
    await playerRef.update({
      uid,
      name: playerName,
      connected: true,
      lastSeen: _getPresenceStamp(),
      characterId: state.character.id ?? null,
      character: state.character,
      instances: _getSerializableInstances(),
      customDb: getCustomDb(),
      equipped: state.equipped,
      _writtenBy: uid,
    });
    _startPresence(playerRef);
    hasSeenSelfInRoster = true; // we just wrote it — a later absence is a removal
  } catch (e) {
    alert('Failed to join the campaign: ' + e.message);
    return null;
  }

  _sweepLegacySelfEntries(code, playerName); // fire and forget

  _beginPartySession({ code, role: 'player', playerId: uid, playerName, campaignName: meta?.name ?? null });
  return code;
}

// ─── PRESENCE — the green dot ───
// Green iff that person has the app open on this campaign right now — a claim
// about the present, so it cannot be written once and left. Two facts:
// `connected` is what the client last claimed, `lastSeen` is when, so a claim
// with no heartbeat behind it lapses on its own. `onDisconnect` is armed from
// `.info/connected` (re-armed on every reconnect); `_endPresence()` writes the
// `false` itself before cancelling.

function _getServerNow() { return Date.now() + serverTimeOffset; }

function _getPresenceStamp() {
  return firebase.database.ServerValue.TIMESTAMP;
}

// Take up our own node and start claiming it.
function _startPresence(ref) {
  _endPresence(); // anything still held here is a previous seat
  partySelfRef = ref;

  if (!presenceOffsetRef) {
    presenceOffsetRef = firebaseDb.ref('.info/serverTimeOffset');
    presenceOffsetRef.on('value', snap => { serverTimeOffset = snap.val() ?? 0; });
  }

  presenceConnRef = firebaseDb.ref('.info/connected');
  presenceConnRef.on('value', snap => {
    if (!snap.val()) return;   // the drop itself is the server's to record
    const self = partySelfRef; // may have been dropped while this was in flight
    if (!self) return;
    // `connected: true` is written INSIDE the .then(), after the handler is
    // registered — a drop between the two would leave a live seat unwatched.
    self.onDisconnect().update({ connected: false, lastSeen: _getPresenceStamp() })
      .then(() => { if (partySelfRef === self) _sendPresenceHeartbeat(); })
      .catch(() => { /* offline again already — the next connect re-arms */ });
  });

  clearInterval(presenceTimer);
  presenceTimer = setInterval(_sendPresenceHeartbeat, PRESENCE_HEARTBEAT_MS);
}

// The claim itself. NOT folded into `_syncPartyState()` — that writes to whichever
// node is being edited, which for a GM is one of the players.
function _sendPresenceHeartbeat() {
  if (!partySelfRef) return;
  partySelfRef.update({ connected: true, lastSeen: _getPresenceStamp() })
    .catch(() => { /* a removed seat; the roster listener has it */ });
}

// Stand down. The `false` is written before the handler is cancelled. It can
// land on a node the GM just deleted (where `update()` recreates it) — which is
// why `_handleRemovedFromParty()` and Leave Campaign (campaigns.js) both sweep the node after.
function _endPresence({ markOffline = true } = {}) {
  clearInterval(presenceTimer);
  presenceTimer = null;

  if (presenceConnRef) { presenceConnRef.off(); presenceConnRef = null; }

  if (partySelfRef) {
    const self = partySelfRef;
    partySelfRef = null;
    if (markOffline) self.update({ connected: false, lastSeen: _getPresenceStamp() }).catch(() => {});
    try { self.onDisconnect().cancel(); } catch { /* already gone */ }
  }
}

// Whether a roster entry is live. Both halves are required; an entry with no
// `lastSeen` at all reads as offline.
function isPlayerOnline(p) {
  if (!p || !p.connected) return false;
  const seen = Number(p.lastSeen);
  if (!Number.isFinite(seen)) return false;
  return _getServerNow() - seen < PRESENCE_STALE_MS;
}

// A claim lapses by the passage of time, which Firebase will not wake us for. So
// the panel re-checks itself — and redraws only when the answer changed, because
// this runs every 15s and must not rebuild the roster under the cursor.
function _getPresenceSignature() {
  return Object.entries(state.party.players ?? {})
    .map(([id, p]) => id + ':' + (isPlayerOnline(p) ? '1' : '0'))
    .sort()
    .join(',');
}

function _startPresenceSweep() {
  clearInterval(presenceSweepTimer);
  lastPresenceSignature = _getPresenceSignature();
  presenceSweepTimer = setInterval(() => {
    const sig = _getPresenceSignature();
    if (sig === lastPresenceSignature) return;
    lastPresenceSignature = sig;
    _updatePartyPanel();
    renderRestUI();
  }, PRESENCE_SWEEP_MS);
}

function _stopPresenceSweep() {
  clearInterval(presenceSweepTimer);
  presenceSweepTimer = null;
  lastPresenceSignature = '';
}

// ─── SESSION AND SYNC ───

// What a code points at, or null. The campaign's own record tells a joiner
// whether they walk in as GM or player — a question a local bookmark must never
// answer.
async function fetchCampaignMeta(code) {
  if (!firebaseDb) return null;
  try {
    const snap = await firebaseDb.ref(`parties/${code}`).get();
    if (!snap.exists()) return null;
    const val = snap.val() ?? {};
    // A party with no `meta` node is described from what it does have.
    return val.meta ?? { name: '', gmUid: val.gm?.uid ?? null, gmName: val.gm?.name ?? 'Game Master', createdAt: 0 };
  } catch (e) {
    alert('Failed to connect: ' + e.message);
    return null;
  }
}

// Subscribes to everything the campaign shares: shops, chat, map, homebrew, meta and roster.
function _subscribeToParty(code) {
  subscribeToShops(code);     // the party's shops ride along with its roster
  subscribeToChat(code);      // and so does its conversation
  subscribeToBattlemap(code); // and the board they are standing on
  subscribeToHomebrew(code);  // and whatever homebrew the table has been handed
  subscribeToRest(code);      // and how rested they are

  // The campaign's own record — a GM renaming it, or a first join that had only
  // the code, both arrive here, and the home-screen bookmark is refreshed from it.
  if (partyMetaRef) partyMetaRef.off();
  partyMetaRef = firebaseDb.ref(`parties/${code}/meta`);
  partyMetaRef.on('value', snap => {
    const meta = snap.val();
    if (!meta) return;
    state.party.campaignName = meta.name ?? null;
    state.party.gmUid = meta.gmUid ?? null;
    noteCampaignMeta(code, meta);
    _updatePartyUI();
  });

  if (partyPlayersRef) partyPlayersRef.off();
  partyPlayersRef = firebaseDb.ref(`parties/${code}/players`);

  partyPlayersRef.on('value', snap => {
    const players = snap.val() ?? {};
    state.party.players = players;

    // Being removed from the roster IS the message — no separate "you were
    // kicked" flag to write, read and clean up.
    if (state.party.role === 'player') {
      if (players[state.party.playerId]) hasSeenSelfInRoster = true;
      else if (hasSeenSelfInRoster) { _handleRemovedFromParty(); return; }
    }

    const viewId = state.party.viewingPlayerId;
    if (viewId && players[viewId]) {
      const viewedData = players[viewId];
      // Reload only for the player's own change, not an echo of our GM write.
      if (viewedData._writtenBy !== state.party.playerId) {
        _loadPlayerStateIntoView(viewedData);
      }
    }

    // A player looking at their own inventory takes in a GM's edit.
    if (state.party.role === 'player' && state.party.viewingPlayerId === null) {
      const ownData = players[state.party.playerId];
      if (ownData && ownData._writtenBy && ownData._writtenBy !== state.party.playerId) {
        _applyRemoteEditToOwnState(ownData);
      }
    }

    noteCampaignRoster(state.party.code, players);
    lastPresenceSignature = _getPresenceSignature(); // the sweep only chases changes
    _updatePartyPanel();
    renderRestUI(); // who a long rest vote is waiting on follows the roster
  });
}

// Ends the session (not the membership): unsubscribes, marks us offline and
// restores the solo view. Giving up the seat for good is Leave Campaign in campaigns.js.
function leaveParty() {
  if (!state.party.active) return;
  if (partyPlayersRef) { partyPlayersRef.off(); partyPlayersRef = null; }
  if (partyMetaRef) { partyMetaRef.off(); partyMetaRef = null; }
  unsubscribeFromShops();
  unsubscribeFromChat();
  unsubscribeFromBattlemap();
  unsubscribeFromHomebrew();
  unsubscribeFromRest();

  // Marks us offline, then cancels the onDisconnect; cancelling alone would leave a lit dot.
  _endPresence();
  _stopPresenceSweep();
  hasSeenSelfInRoster = false;

  const wasGM = state.party.role === 'gm';
  if (state.party.viewingPlayerId !== null) _restoreOwnState();

  state.party = {
    active: false, code: null, role: null, playerId: null, playerName: null,
    campaignName: null, viewingPlayerId: null, ownState: null, players: {},
    gmUid: null, homebrew: {},
  };
  refreshHomebrewConsumers(); // the table's homebrew leaves with the table

  // A GM's working copy is the placeholder — their own character was left
  // untouched in its slot, so it comes back now.
  if (wasGM) {
    ensureCharacter();
    loadActiveCharacterIntoLive();
    renderLiveCharacter();
  }

  _updatePartyUI();
  renderRestUI(); // back to solo rests
  switchTab('browse');
  renderHomeScreen(); // the campaign card is a Resume again
  syncRoute();        // off the table: campaign#<code> becomes character#<id>
}

// Kicked by the GM — nothing local is lost (the roster entry was a copy), so
// this is a leave with an explanation. It drops the campaign bookmark too: a
// card left behind would be an invitation back into a campaign you were removed
// from, and clicking it would write the seat back.
function _handleRemovedFromParty() {
  const code = state.party.code;
  const selfId = state.party.playerId;
  const ref = firebaseDb && code && selfId
    ? firebaseDb.ref(`parties/${code}/players/${selfId}`) : null;
  const name = getCampaignDisplayName(code);

  leaveParty();
  forgetCampaign(code);

  // A sync in flight when the GM removed us lands afterwards and recreates the
  // entry — sweep our own node once we have stopped syncing.
  if (ref) ref.remove().catch(() => { /* already gone, or no longer permitted */ });

  alert(`You have been removed from ${name} by the Game Master.\n\n` +
        'Your character and everything in your inventory are untouched. ' +
        'Rejoining needs the campaign code again.');
}

// GM only. Removing the entry is the whole operation — their client sees itself
// gone from the roster and leaves.
async function _kickPlayer(playerId, displayName) {
  if (!firebaseDb || !state.party.active || state.party.role !== 'gm') return;
  if (!confirm(`Remove ${displayName} from the campaign?\n\n` +
               'They lose their seat, not their character: their own inventory is ' +
               'untouched, but the campaign stops remembering them and rejoining ' +
               'needs the code again.')) return;

  if (state.party.viewingPlayerId === playerId) switchViewToOwn();

  try {
    await firebaseDb.ref(`parties/${state.party.code}/players/${playerId}`).remove();
    // Their shared homebrew stops counting with their seat (partyHomebrewMembers
    // filters on the roster); the node is swept so it doesn't linger either.
    firebaseDb.ref(`parties/${state.party.code}/homebrew/${playerId}`).remove().catch(() => {});
  } catch (e) {
    alert('Could not remove that player: ' + e.message);
  }
}

// Call after any change to the live character: saves locally and to the cloud,
// then pushes the change to the party after a 400 ms debounce.
function scheduleSaveAndSync() {
  // A GM editing a player's inventory must not overwrite their own save with it.
  const isGmEditing = state.party.active && state.party.role === 'gm' && state.party.viewingPlayerId !== null;
  if (!isGmEditing) { autoSave(); scheduleCloudSave(); }
  if (!state.party.active) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(_syncPartyState, 400);
}

function _syncPartyState() {
  if (!state.party.active || !firebaseDb) return;
  publishHomebrewToParty(); // a no-op unless what we share changed

  let targetId;
  if (state.party.role === 'gm') {
    targetId = state.party.viewingPlayerId;
    if (!targetId) return;
  } else {
    if (state.party.viewingPlayerId !== null) return; // don't sync when viewing someone else
    targetId = state.party.playerId;
  }

  firebaseDb.ref(`parties/${state.party.code}/players/${targetId}`).update({
    character: state.character,
    instances: _getSerializableInstances(),
    customDb: getCustomDb(),
    equipped: state.equipped,
    _writtenBy: state.party.playerId,
  });
}

function _loadPlayerStateIntoView(playerData) {
  if (!playerData) return;
  cancelPlacing();

  if (playerData.character) state.character = { ...playerData.character };

  state.db = {};
  DEFAULT_ITEMS.forEach(t => { state.db[t.id] = t; });
  if (playerData.customDb) Object.assign(state.db, playerData.customDb);

  // Another member's client may not have migrated to slug ids yet (items.js).
  state.instances = playerData.instances ? migrateInstanceTemplateIds(playerData.instances) : {};
  state.equipped  = playerData.equipped  ? { ...playerData.equipped  } : {};
  syncHomebrewItems();
  syncNextId();
  rebuildGrid();
  renderItemList();
  updateWeightDisplay();
}

function _applyRemoteEditToOwnState(playerData) {
  if (playerData.instances !== undefined) state.instances = migrateInstanceTemplateIds(playerData.instances) ?? {};
  if (playerData.equipped  !== undefined) state.equipped  = { ...playerData.equipped  };
  if (playerData.customDb) Object.assign(state.db, playerData.customDb);
  syncNextId();
  rebuildGrid();
  renderItemList();
  updateWeightDisplay();
}

function _saveOwnState() {
  state.party.ownState = {
    character: { ...state.character },
    instances: JSON.parse(JSON.stringify(state.instances)),
    equipped:  { ...state.equipped },
    customDb:  JSON.parse(JSON.stringify(getCustomDb())),
  };
}

function _restoreOwnState() {
  const own = state.party.ownState;
  if (!own) return;
  state.character = { ...own.character };
  state.instances = { ...own.instances };
  state.equipped  = { ...(own.equipped ?? {}) };
  state.db = {};
  DEFAULT_ITEMS.forEach(t => { state.db[t.id] = t; });
  Object.assign(state.db, own.customDb);
  state.party.ownState = null;
  syncHomebrewItems();
  syncNextId();
  rebuildGrid();
  renderItemList();
  updateWeightDisplay();
}

// Shows another member's character in place of our own (read-only for a player).
function switchViewToPlayer(playerId) {
  if (state.party.viewingPlayerId === playerId) return;
  cancelPlacing();

  if (state.party.role === 'player' && state.party.viewingPlayerId === null) _saveOwnState();

  state.party.viewingPlayerId = playerId;
  const playerData = state.party.players[playerId];
  if (playerData) _loadPlayerStateIntoView(playerData);

  _updatePartyPanel();
  updateViewingBanner();
  document.body.classList.toggle('party-readonly', isReadOnly());
}

// Returns from viewing a member: a player gets their own state back, a GM gets no selection.
function switchViewToOwn() {
  if (state.party.viewingPlayerId === null) return;
  cancelPlacing();
  state.party.viewingPlayerId = null;

  if (state.party.role === 'player') {
    _restoreOwnState();
  } else {
    // GM — back to no-selection. Deliberately not one of their own characters:
    // commitActiveCharacter() refuses to write this working copy anywhere.
    state.character = { id: null, name: 'Game Master', strength: 10, level: 1, race: '', classLevels: [] };
    state.instances = {};
    state.db = {};
    DEFAULT_ITEMS.forEach(t => { state.db[t.id] = t; });
    syncHomebrewItems(); // the table's homebrew, for the GM's shop editor
    initGrid();
    buildGrid();
    renderAllItems();
    updateWeightDisplay();
  }

  _updatePartyPanel();
  updateViewingBanner();
  document.body.classList.toggle('party-readonly', isReadOnly());
}

// Whether the live view must not be edited: a player looking at someone else's character.
function isReadOnly() {
  if (!state.party.active) return false;
  if (state.party.role === 'gm') return false;
  return state.party.viewingPlayerId !== null;
}

function _getCarriedWeightFor(instances, customDb) {
  const db = {};
  DEFAULT_ITEMS.forEach(t => { db[t.id] = t; });
  Object.assign(db, customDb ?? {});
  return Object.values(instances ?? {}).reduce((sum, inst) => {
    const t = db[getCurrentTemplateId(inst.templateId)];
    if (!t) return sum;
    return sum + (isStackable(t) ? getItemUnitWeight(t) * inst.stackCount : getShapeWeight(getRotatedShape(t.shape, inst.rotation)));
  }, 0);
}

// ─── PARTY UI ───
function _updatePartyUI() {
  const isInParty = state.party.active;

  document.getElementById('party-code-badge').classList.toggle('hidden', !isInParty);
  if (isInParty) document.getElementById('party-code-badge').textContent = state.party.code;

  document.getElementById('party-no-session').classList.toggle('hidden', isInParty);
  document.getElementById('party-session').classList.toggle('hidden', !isInParty);

  if (isInParty) {
    document.getElementById('party-code-text').textContent = state.party.code;
    // The campaign's name; a party with only a code leaves the row off rather than empty.
    const nameEl = document.getElementById('party-campaign-name');
    nameEl.textContent = state.party.campaignName ?? '';
    nameEl.classList.toggle('hidden', !state.party.campaignName);
    const roleEl = document.getElementById('party-role-badge');
    roleEl.textContent = state.party.role === 'gm' ? 'Game Master' : 'Player';
    roleEl.className = 'party-role-badge ' + state.party.role;

    const gmHint = document.getElementById('party-gm-hint');
    gmHint.classList.toggle('hidden', !(state.party.role === 'gm' && state.party.viewingPlayerId === null));

    const gmPlaceholder = document.getElementById('gm-placeholder');
    gmPlaceholder.classList.toggle('hidden', !(state.party.role === 'gm' && state.party.viewingPlayerId === null));

    document.getElementById('char-summary').style.visibility =
      (state.party.role === 'gm' && state.party.viewingPlayerId === null) ? 'hidden' : '';
  } else {
    document.getElementById('char-summary').style.visibility = '';
    document.getElementById('gm-placeholder').classList.add('hidden');
  }

  document.body.classList.toggle('party-readonly', isReadOnly());
  _updatePartyPanel();
  updateViewingBanner();
}

function _updatePartyPanel() {
  // The character tabs are this same roster and selection in another shape.
  syncCharacterViewUI();

  const listEl = document.getElementById('party-player-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const players = state.party.players ?? {};

  if (Object.keys(players).length === 0 && state.party.role === 'gm') {
    const hint = document.createElement('p');
    hint.className = 'party-empty-hint';
    hint.textContent = 'Waiting for players to join…';
    listEl.appendChild(hint);
    return;
  }

  Object.entries(players).forEach(([id, p]) => {
    const isViewing = state.party.viewingPlayerId === id;
    const isOwn = state.party.role === 'player' && id === state.party.playerId;
    const canClick = !isOwn;

    const entry = document.createElement('div');
    entry.className = 'party-player-entry' +
      (isViewing ? ' viewing' : '') +
      (isOwn ? ' own' : '') +
      (canClick ? ' clickable' : '');

    const top = document.createElement('div');
    top.className = 'party-entry-top';

    const dot = document.createElement('span');
    dot.className = 'party-dot ' + (isPlayerOnline(p) ? 'online' : 'offline');

    const nameEl = document.createElement('span');
    nameEl.className = 'party-player-name-text';
    nameEl.textContent = p.name + (isOwn ? ' (You)' : '');

    top.appendChild(dot);
    top.appendChild(nameEl);

    // Only the GM may remove someone, and never themselves.
    if (state.party.role === 'gm') {
      const kickBtn = document.createElement('button');
      kickBtn.className = 'btn-sm danger party-kick-btn';
      kickBtn.textContent = 'Kick';
      kickBtn.title = `Remove ${p.name} from the party`;
      kickBtn.addEventListener('click', e => {
        e.stopPropagation(); // the entry itself selects the player
        _kickPlayer(id, p.name);
      });
      top.appendChild(kickBtn);
    }

    entry.appendChild(top);

    if (p.character) {
      const carried = _getCarriedWeightFor(p.instances, p.customDb);
      const encThreshold = p.character.strength * 15;
      const statusText = carried > encThreshold * 2 ? ' · Heavily Enc.' : carried > encThreshold ? ' · Enc.' : '';
      const infoEl = document.createElement('span');
      infoEl.className = 'party-player-info';
      infoEl.textContent = `${p.character.name} · ${Math.round(carried * 10) / 10} lb${statusText}`;
      entry.appendChild(infoEl);

      // Level / race / class. An older client sends name + strength only, and
      // this line is left off rather than showing a row of blanks.
      const characterSummary = _describePartyCharacter(p.character);
      if (characterSummary) {
        const subEl = document.createElement('span');
        subEl.className = 'party-player-info';
        subEl.textContent = characterSummary;
        entry.appendChild(subEl);
      }
    }

    if (canClick) {
      entry.addEventListener('click', () => {
        if (isViewing) switchViewToOwn();
        else switchViewToPlayer(id);
      });
    }

    listEl.appendChild(entry);
  });
}

// "Level 7 · Tiefling · Warlock 5 / Bard 2", skipping whatever is missing. The
// level is the character's total; each class says its own only when multiclassed.
function _describePartyCharacter(c) {
  if (!c) return '';
  const classes = describeCharacterClasses(c);
  const parts = [];
  if (c.level) parts.push('Level ' + c.level);
  if (c.race) parts.push(c.race);
  if (classes) parts.push(classes);
  return parts.join(' · ');
}

// Shows or hides the "Editing/Viewing <name>'s ..." banner for the current selection.
function updateViewingBanner() {
  const banner = document.getElementById('viewing-banner');
  const viewId = state.party.viewingPlayerId;

  if (!state.party.active || viewId === null) {
    banner.classList.add('hidden');
    return;
  }

  banner.classList.remove('hidden');
  // The character's name, to match the tab you picked them from.
  const player = state.party.players[viewId];
  const name = player?.character?.name ?? player?.name ?? 'Player';
  const textEl = document.getElementById('viewing-banner-text');
  const returnBtn = document.getElementById('return-to-own-btn');

  // The map is the party's, not this player's — the banner names the view the
  // reader is handed back rather than claiming they are editing a board.
  const viewLabel = { sheet: 'character sheet', spells: 'spell sheet', map: 'inventory' }[state.view] || 'inventory';
  if (state.party.role === 'gm') {
    textEl.textContent = `Editing ${name}'s ${viewLabel}`;
    returnBtn.textContent = 'Deselect Player';
  } else {
    textEl.textContent = `Viewing ${name}'s ${viewLabel} (read-only)`;
    returnBtn.textContent = 'Return to Your Inventory';
  }

  document.getElementById('gm-placeholder').classList.add('hidden');
}

// ─── WIRING ───
// Both party buttons open the campaign modal (campaigns.js) behind a sign-in.
document.getElementById('party-btn').addEventListener('click', () => {
  if (state.party.active) switchTab('party');
  else requireAuth(PARTY_AUTH_REASON, () => openCampaignModal('join'));
});

document.getElementById('open-party-modal-btn').addEventListener('click', () => {
  requireAuth(PARTY_AUTH_REASON, () => openCampaignModal('join'));
});

document.getElementById('copy-code-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(state.party.code ?? '').then(() => {
    flashButton(document.getElementById('copy-code-btn'), 'Copied!');
  });
});

// Ends the session, not the membership. Giving up the seat is Leave Campaign, on
// the home screen.
document.getElementById('leave-party-btn').addEventListener('click', () => {
  if (confirm('Leave this session?\n\n' +
              'You keep your seat in the campaign — it is on your home screen, and ' +
              'opening it puts you straight back in.')) leaveParty();
});

document.getElementById('return-to-own-btn').addEventListener('click', switchViewToOwn);
