// =============================================================================
// REST — the short and long rest buttons, the short rest tray and Hit Dice, and
// the party's long rest: the vote, the GM's decision, and the camp supplies
// =============================================================================
'use strict';

// The party's rest state lives at `parties/<code>/rest`:
//   { shortRestsLeft, campSuppliesPerCharacter?, longRest }
//   longRest: { id, byUid, byName, at, status, responses, required, supplies }
// `status` runs 'voting' → 'supplies' → 'accepted', or ends 'declined' from
// either. `responses` maps a player's uid to { name, rest }; those who chose
// to rest are its members. `supplies` maps a member's uid to their pledge
// { name, total, items: [{ templateId, name, count }], done }. The food is
// taken from inventories only once the rest is accepted.
// Signed out or with no campaign, both rests are this browser's alone.

const SHORT_RESTS_PER_LONG_REST = 2;  // short rests the party gets between long rests
const REST_NOTICE_MS = 4000;          // how long an outcome notice stays up

let partyRestRef = null;
let partyRest = {};                   // read-through cache of `parties/<code>/rest`

// Solo play has no party node, so its count lives here for the session.
let soloShortRestsLeft = SHORT_RESTS_PER_LONG_REST;

// The long rest request as last seen, so an outcome is acted on only when this
// client watched it change — a reload into an old accepted request must not
// rest (or eat) again.
let lastSeenLongRest = null;
let hasRestSnapshot = false;

let isSoloLongRestOpen = false;       // the solo long rest card, with its food picker
let hitDiceSession = null;            // { count, healed } while the Hit Dice card is up
let supplyDraft = { key: '', counts: {} }; // food picked but not yet pledged, by template id
let gmPeekLongRestId = null;          // a GM opened the decision card before everyone answered
let restNotice = null;                // { title, text } shown briefly after an outcome
let restNoticeTimer = null;
let lastRestPromptSignature = '';

const restDockEl        = document.getElementById('rest-dock');
const shortRestBtn      = document.getElementById('short-rest-btn');
const longRestBtn       = document.getElementById('long-rest-btn');
const shortRestTrayEl   = document.getElementById('short-rest-tray');
const shortRestPipsEl   = document.getElementById('short-rest-pips');
const shortRestCountEl  = document.getElementById('short-rest-count');
const restPromptEl      = document.getElementById('rest-prompt');
const restPromptTitleEl = document.getElementById('rest-prompt-title');
const restPromptTextEl  = document.getElementById('rest-prompt-text');
const restPromptBodyEl  = document.getElementById('rest-prompt-body');
const restPromptActsEl  = document.getElementById('rest-prompt-actions');

// ─── THE SUBSCRIPTION ───

// Subscribes to a campaign's rest state, replacing any earlier subscription.
function subscribeToRest(code) {
  unsubscribeFromRest();
  if (!firebaseDb) return;
  partyRestRef = firebaseDb.ref(`parties/${code}/rest`);
  partyRestRef.on('value', snap => {
    partyRest = snap.val() ?? {};
    _noteLongRestChange(partyRest.longRest ?? null);
    renderRestUI();
  });
}

// Drops the rest subscription and any prompt it was showing.
function unsubscribeFromRest() {
  if (partyRestRef) { partyRestRef.off(); partyRestRef = null; }
  partyRest = {};
  lastSeenLongRest = null;
  hasRestSnapshot = false;
  gmPeekLongRestId = null;
  renderRestUI();
}

function _isPartyRest() {
  return !!(firebaseDb && partyRestRef && state.party.active && state.party.code);
}

function _getLongRestRef() {
  return firebaseDb.ref(`parties/${state.party.code}/rest/longRest`);
}

function _isOwnLongRestMember(longRest) {
  return state.party.role === 'player' && !!longRest?.responses?.[state.party.playerId]?.rest;
}

// Rest effects land on the player's own character, never a sheet they are
// only looking at.
function _returnToOwnCharacter() {
  if (isReadOnly()) switchViewToOwn();
}

// Acts on a request moving on, if this client saw the step happen.
function _noteLongRestChange(longRest) {
  const prev = lastSeenLongRest;
  lastSeenLongRest = longRest ? { id: longRest.id, status: longRest.status } : null;
  if (!hasRestSnapshot) { hasRestSnapshot = true; return; }
  if (!longRest || !prev || prev.id !== longRest.id || prev.status === longRest.status) return;

  const isMember = _isOwnLongRestMember(longRest);
  if (longRest.status === 'supplies') {
    if (isMember) _returnToOwnCharacter(); // the food picker reads your own pack
    return;
  }
  if (longRest.status === 'accepted') {
    if (isMember) {
      _returnToOwnCharacter();
      const pledge = longRest.supplies?.[state.party.playerId];
      if (pledge?.done) consumeFood(_getPledgeItems(pledge));
      applyLongRestRecovery();
    }
    _showRestNotice('The party takes a long rest',
      isMember ? 'You wake rested.' : 'You kept watch while they slept.');
  } else if (longRest.status === 'declined') {
    _showRestNotice('No long rest', prev.status === 'supplies'
      ? 'The Game Master called off the long rest. Nobody’s food was used.'
      : 'The Game Master declined the long rest.');
  }
}

// ─── SHORT REST ───

function _getShortRestsLeft() {
  if (!_isPartyRest()) return soloShortRestsLeft;
  const n = Number(partyRest.shortRestsLeft);
  return Number.isFinite(n) ? n : SHORT_RESTS_PER_LONG_REST;
}

// A GM has no character to rest.
function _canTakeShortRest() {
  if (state.party.active && state.party.role === 'gm') return false;
  return _getShortRestsLeft() > 0;
}

// Whether the short rest's tray of remaining rests is showing.
function isShortRestTrayOpen() {
  return restDockEl.classList.contains('short-open');
}

function _setShortRestTrayOpen(isOpen) {
  restDockEl.classList.toggle('short-open', isOpen);
  shortRestTrayEl.setAttribute('aria-hidden', String(!isOpen));
  shortRestBtn.setAttribute('aria-expanded', String(isOpen));
}

// Folds the short rest tray away without resting.
function closeShortRestTray() {
  _setShortRestTrayOpen(false);
}

// Spends one of the party's short rests. The count is claimed by a transaction
// so two players resting at once can't both take the last one.
function _takeShortRest() {
  if (!_canTakeShortRest()) return;
  if (!_isPartyRest()) {
    soloShortRestsLeft--;
    _finishShortRest();
    return;
  }
  firebaseDb.ref(`parties/${state.party.code}/rest/shortRestsLeft`).transaction(cur => {
    const left = cur ?? SHORT_RESTS_PER_LONG_REST;
    return left > 0 ? left - 1 : undefined;
  }).then(({ committed }) => {
    if (committed) _finishShortRest();
  }).catch(e => alert('Could not take a short rest: ' + e.message));
}

// What a short rest restores, then the offer to spend Hit Dice if any are left.
function _finishShortRest() {
  _returnToOwnCharacter();
  applyShortRestRecovery();
  if (getHitDiceStatus().left > 0) hitDiceSession = { count: 1, healed: [] };
  else _showRestNotice('Short rest', 'You catch your breath. No Hit Dice are left to spend.');
  renderRestUI();
}

function _renderShortRestTray() {
  const left = _getShortRestsLeft();
  shortRestPipsEl.replaceChildren(...Array.from({ length: SHORT_RESTS_PER_LONG_REST }, (_, i) => {
    const pip = document.createElement('span');
    pip.className = 'short-rest-pip' + (i < left ? ' left' : '');
    return pip;
  }));
  shortRestCountEl.textContent = left <= 0 ? 'No short rests left'
    : left === 1 ? '1 short rest left' : left + ' short rests left';
  shortRestTrayEl.classList.toggle('empty', left <= 0);
  shortRestBtn.title = _canTakeShortRest() && isShortRestTrayOpen()
    ? 'Click again to take a short rest' : 'Short rest';
}

// ─── HIT DICE ───

function _stepHitDiceCount(delta) {
  if (!hitDiceSession) return;
  const left = getHitDiceStatus().left;
  hitDiceSession.count = Math.max(1, Math.min(Math.max(1, left), hitDiceSession.count + delta));
  renderRestUI();
}

function _rollHitDice() {
  if (!hitDiceSession) return;
  const healed = spendHitDice(hitDiceSession.count);
  if (healed === null) return;
  hitDiceSession.healed.push(healed);
  hitDiceSession.count = Math.max(1, Math.min(hitDiceSession.count, getHitDiceStatus().left));
  renderRestUI();
}

function _closeHitDice() {
  hitDiceSession = null;
  renderRestUI();
}

// " + 4" / " − 2" / "", trailing a dice formula.
function _formatRestModifier(mod) {
  return mod ? (mod > 0 ? ' + ' : ' − ') + Math.abs(mod) : '';
}

function _getHitDiceModel() {
  const status = getHitDiceStatus();
  const hp = state.character.hp ?? {};
  const con = getAbilityModifier('con');
  const n = Math.min(hitDiceSession.count, Math.max(0, status.left));
  const canRoll = status.left > 0 && !isAtFullHp() && !isReadOnly();
  const healedText = hitDiceSession.healed.length
    ? 'Healed ' + hitDiceSession.healed.map(h => '+' + h).join(', ') : '';
  return {
    title: 'Short rest',
    text: 'Spend Hit Dice to heal? Each die heals its roll plus your Constitution modifier. Roll as many times as you like.',
    sig: [hp.current, hp.max, status.left, n, healedText].join('|'),
    body: () => _buildHitDiceBody(status, hp, n, healedText),
    actions: [
      { label: 'Done', onClick: _closeHitDice },
      { label: n ? `Roll ${n}d${status.faces}${_formatRestModifier(con * n)}` : 'Roll',
        primary: true, disabled: !canRoll, onClick: _rollHitDice },
    ],
  };
}

function _buildHitDiceBody(status, hp, n, healedText) {
  const stats = document.createElement('div');
  stats.className = 'rest-prompt-stats';
  stats.append(
    _buildRestStat('HP', `${hp.current ?? 0} / ${hp.max ?? 0}`),
    _buildRestStat('Hit Dice', `${status.left} / ${status.max} d${status.faces}`),
  );

  const stepper = _buildRestStepper(n, {
    label: 'Dice to roll',
    canDown: n > 1,
    canUp: n < status.left,
    onStep: _stepHitDiceCount,
  });

  const out = [stats, stepper];
  if (healedText) {
    const healed = document.createElement('div');
    healed.className = 'rest-prompt-healed';
    healed.textContent = healedText;
    out.push(healed);
  }
  return out;
}

// ─── LONG REST: THE REQUEST ───

function _getActiveLongRest() {
  const longRest = partyRest.longRest;
  return _isPartyRest() && (longRest?.status === 'voting' || longRest?.status === 'supplies') ? longRest : null;
}

// A member's name as the table knows them: their character's, else their seat's.
function _getMemberName(uid, fallback) {
  const p = state.party.players?.[uid];
  return p?.character?.name || p?.name || fallback || 'Someone';
}

// Who has answered, split by their answer, and who still owes one. An offline
// player isn't waited on unless they already voted.
function _getLongRestTally(longRest) {
  const responses = longRest.responses ?? {};
  const resting = [], notResting = [], waiting = [];
  Object.entries(responses).forEach(([uid, r]) => {
    (r?.rest ? resting : notResting).push(_getMemberName(uid, r?.name));
  });
  Object.entries(state.party.players ?? {}).forEach(([uid, p]) => {
    if (!responses[uid] && isPlayerOnline(p)) waiting.push(_getMemberName(uid, p?.name));
  });
  return { resting, notResting, waiting };
}

// Starts a long rest: the solo card, or a vote put to the whole party.
function _requestLongRest() {
  if (!_isPartyRest()) {
    if (state.party.active && state.party.role === 'gm') return;
    isSoloLongRestOpen = true;
    renderRestUI();
    return;
  }
  const active = _getActiveLongRest();
  if (active) {
    // A GM asking again opens the decision early, for a vote someone is sitting on.
    if (state.party.role === 'gm' && active.status === 'voting') { gmPeekLongRestId = active.id; renderRestUI(); }
    return;
  }

  const isGM = state.party.role === 'gm';
  const longRest = {
    id: firebaseDb.ref().push().key,
    byUid: isGM ? (getOwnPlayerId() ?? 'gm') : state.party.playerId,
    byName: getChatAuthorName(),
    at: firebase.database.ServerValue.TIMESTAMP,
    status: 'voting',
  };
  // Asking is a vote to rest; a GM asks without resting themselves.
  if (!isGM) longRest.responses = { [state.party.playerId]: { name: getChatAuthorName(), rest: true } };
  _getLongRestRef().set(longRest).catch(e => alert('Could not ask for a long rest: ' + e.message));
}

// One player's answer. A transaction, so an answer to a request that has just
// been replaced or decided is dropped rather than landing on the wrong one.
function _answerLongRest(requestId, wantsRest) {
  const uid = state.party.playerId;
  const name = getChatAuthorName();
  _getLongRestRef().transaction(longRest => {
    if (!longRest || longRest.id !== requestId || longRest.status !== 'voting') return;
    longRest.responses = { ...(longRest.responses ?? {}), [uid]: { name, rest: wantsRest } };
    return longRest;
  }).catch(e => alert('Could not send your answer: ' + e.message));
}

function _getCampSuppliesPerCharacter() {
  const n = Number(partyRest.campSuppliesPerCharacter);
  return Number.isFinite(n) && n >= 0 ? n : CAMP_SUPPLIES_PER_CHARACTER;
}

// The GM's answer to the vote. Accepting moves on to gathering camp supplies:
// the camp needs a share for every character resting.
function _decideLongRest(requestId, isAccepted) {
  const longRest = _getActiveLongRest();
  if (!longRest || longRest.id !== requestId || longRest.status !== 'voting' || state.party.role !== 'gm') return;
  gmPeekLongRestId = null;
  if (!isAccepted) { _finishLongRest(requestId, false); return; }

  const memberCount = Object.values(longRest.responses ?? {}).filter(r => r?.rest).length;
  const required = _getCampSuppliesPerCharacter() * memberCount;
  if (!required) { _finishLongRest(requestId, true); return; }
  partyRestRef.update({ 'longRest/status': 'supplies', 'longRest/required': required })
    .catch(e => alert('Could not record your decision: ' + e.message));
}

// Ends a request either way. Accepting also refills the party's short rests.
function _finishLongRest(requestId, isAccepted) {
  partyRestRef.transaction(rest => {
    const longRest = rest?.longRest;
    if (!longRest || longRest.id !== requestId) return;
    if (longRest.status !== 'voting' && longRest.status !== 'supplies') return;
    _closeLongRest(rest, isAccepted);
    return rest;
  }).catch(e => alert('Could not record your decision: ' + e.message));
}

function _closeLongRest(rest, isAccepted) {
  rest.longRest.status = isAccepted ? 'accepted' : 'declined';
  rest.longRest.decidedAt = Date.now();
  if (isAccepted) rest.shortRestsLeft = SHORT_RESTS_PER_LONG_REST;
}

function _showRestNotice(title, text) {
  restNotice = { title, text };
  clearTimeout(restNoticeTimer);
  restNoticeTimer = setTimeout(() => { restNotice = null; renderRestUI(); }, REST_NOTICE_MS);
}

// ─── LONG REST: CAMP SUPPLIES ───

function _getPledgeItems(pledge) {
  const raw = pledge?.items;
  return (Array.isArray(raw) ? raw : Object.values(raw ?? {})).filter(i => i && i.count > 0);
}

// uids of everyone resting, and of those who have finished pledging.
function _getSupplyMembers(longRest) {
  const members = Object.entries(longRest.responses ?? {}).filter(([, r]) => r?.rest).map(([uid]) => uid);
  const done = members.filter(uid => longRest.supplies?.[uid]?.done);
  return { members, done };
}

function _getPledgedTotal(longRest) {
  return Object.values(longRest.supplies ?? {}).reduce((sum, p) => sum + (p?.done ? Number(p.total) || 0 : 0), 0);
}

// The working pick for one request, started fresh when the request changes.
function _getSupplyDraft(key) {
  if (supplyDraft.key !== key) supplyDraft = { key, counts: {} };
  return supplyDraft;
}

// The draft as pledge items, clamped to what is actually carried.
function _getDraftItems(draft) {
  return getOwnFoodStock()
    .map(row => ({ templateId: row.templateId, name: row.name, value: row.value,
                   count: Math.min(row.units, draft.counts[row.templateId] ?? 0) }))
    .filter(i => i.count > 0);
}

function _getItemsTotal(items) {
  return items.reduce((sum, i) => sum + i.count * (i.value ?? 0), 0);
}

function _stepSupplyDraft(key, templateId, delta) {
  const draft = _getSupplyDraft(key);
  const row = getOwnFoodStock().find(r => r.templateId === templateId);
  if (!row) return;
  draft.counts[templateId] = Math.max(0, Math.min(row.units, (draft.counts[templateId] ?? 0) + delta));
  renderRestUI();
}

// Pledges the picked food and marks this member done. When that makes everyone
// done with enough pledged, the same transaction accepts the rest.
function _pledgeSupplies(requestId) {
  const items = _getDraftItems(_getSupplyDraft(requestId));
  const pledge = {
    name: getChatAuthorName(),
    total: _getItemsTotal(items),
    items: items.map(({ templateId, name, count }) => ({ templateId, name, count })),
    done: true,
  };
  const uid = state.party.playerId;
  partyRestRef.transaction(rest => {
    const longRest = rest?.longRest;
    if (!longRest || longRest.id !== requestId || longRest.status !== 'supplies') return;
    longRest.supplies = { ...(longRest.supplies ?? {}), [uid]: pledge };
    const { members, done } = _getSupplyMembers(longRest);
    if (done.length === members.length && _getPledgedTotal(longRest) >= (Number(longRest.required) || 0)) {
      _closeLongRest(rest, true);
    }
    return rest;
  }).catch(e => alert('Could not pledge your supplies: ' + e.message));
}

// The solo long rest: no vote and no GM, so the food picked is simply eaten.
function _takeSoloLongRest(isConfirmed) {
  isSoloLongRestOpen = false;
  if (isConfirmed) {
    consumeFood(_getDraftItems(_getSupplyDraft('solo')));
    soloShortRestsLeft = SHORT_RESTS_PER_LONG_REST;
    applyLongRestRecovery();
    _showRestNotice('Long rest', 'You wake rested.');
  }
  supplyDraft = { key: '', counts: {} };
  renderRestUI();
}

// The food picker: one row per food item carried, with a stepper.
function _buildSupplyPicker(key) {
  const draft = _getSupplyDraft(key);
  const stock = getOwnFoodStock();
  const list = document.createElement('div');
  list.className = 'rest-supply-list';
  if (!stock.length) {
    list.textContent = 'You aren’t carrying any food.';
    list.classList.add('empty');
    return list;
  }
  stock.forEach(row => {
    const n = Math.min(row.units, draft.counts[row.templateId] ?? 0);
    const line = document.createElement('div');
    line.className = 'rest-supply-row' + (n ? ' picked' : '');
    const name = document.createElement('span');
    name.className = 'rest-supply-name';
    name.textContent = row.name;
    const meta = document.createElement('span');
    meta.className = 'rest-supply-meta';
    meta.textContent = `${row.value} each · ${row.units} carried`;
    line.append(name, meta, _buildRestStepper(n, {
      label: 'How many ' + row.name,
      canDown: n > 0,
      canUp: n < row.units,
      onStep: delta => _stepSupplyDraft(key, row.templateId, delta),
    }));
    list.appendChild(line);
  });
  return list;
}

function _getSupplyPickerSig(key) {
  const draft = _getSupplyDraft(key);
  return getOwnFoodStock().map(r => `${r.templateId}:${r.units}:${draft.counts[r.templateId] ?? 0}`).join(',');
}

// ─── LONG REST: THE PROMPT MODELS ───

// What the prompt card should show right now, or null for nothing. One card at
// a time, the thing waiting on this player first.
function _getRestPromptModel() {
  if (hitDiceSession) return _getHitDiceModel();
  if (isSoloLongRestOpen) return _getSoloLongRestModel();

  const longRest = _getActiveLongRest();
  const isGM = state.party.role === 'gm';
  if (longRest?.status === 'voting') {
    if (!isGM && !longRest.responses?.[state.party.playerId]) return _getVoteModel(longRest);
    if (isGM) {
      const tally = _getLongRestTally(longRest);
      if (!tally.waiting.length || gmPeekLongRestId === longRest.id) return _getGmDecisionModel(longRest, tally);
    }
  }
  if (longRest?.status === 'supplies') {
    if (isGM) return _getGmSuppliesModel(longRest);
    if (_isOwnLongRestMember(longRest)) return _getMemberSuppliesModel(longRest);
  }

  if (restNotice) return { title: restNotice.title, text: restNotice.text, actions: [] };
  return null;
}

function _getVoteModel(longRest) {
  return {
    key: longRest.id,
    title: 'Long rest?',
    text: `${_getMemberName(longRest.byUid, longRest.byName)} wants the party to take a long rest.`,
    actions: [
      { label: 'Keep going', onClick: () => _answerLongRest(longRest.id, false) },
      { label: 'Rest', primary: true, onClick: () => _answerLongRest(longRest.id, true) },
    ],
  };
}

function _getGmDecisionModel(longRest, tally) {
  const groups = [
    { label: 'Resting', names: tally.resting, cls: 'resting' },
    { label: 'Not resting', names: tally.notResting, cls: 'not-resting' },
    { label: 'Still deciding', names: tally.waiting, cls: 'waiting' },
  ].filter(g => g.names.length);
  const hasResters = tally.resting.length > 0;
  return {
    key: longRest.id,
    title: 'Long rest request',
    text: hasResters
      ? 'The party wants to take a long rest, including the following players.'
      : 'Nobody chose to rest.',
    groups,
    actions: [
      { label: 'Decline', onClick: () => _decideLongRest(longRest.id, false) },
      { label: 'Accept', primary: true, disabled: !hasResters, onClick: () => _decideLongRest(longRest.id, true) },
    ],
  };
}

function _getSuppliesProgressText(longRest, extra = 0) {
  return `${_getPledgedTotal(longRest) + extra} / ${Number(longRest.required) || 0} camp supplies`;
}

function _getMemberSuppliesModel(longRest) {
  const uid = state.party.playerId;
  const { members, done } = _getSupplyMembers(longRest);
  const waiting = members.filter(m => !done.includes(m)).map(m => _getMemberName(m));
  const perChar = _getCampSuppliesPerCharacter();

  if (longRest.supplies?.[uid]?.done) {
    return {
      key: longRest.id,
      title: 'Camp supplies',
      text: `${_getSuppliesProgressText(longRest)} pledged. Waiting for the rest of the party.`,
      groups: [{ label: 'Still choosing', names: waiting, cls: 'waiting' }].filter(g => g.names.length),
      actions: [],
    };
  }
  if (isReadOnly()) {
    return {
      key: longRest.id,
      title: 'Camp supplies',
      text: 'The long rest was accepted. Go back to your own inventory to choose food for the camp.',
      actions: [{ label: 'Return to my inventory', primary: true, onClick: switchViewToOwn }],
    };
  }

  const items = _getDraftItems(_getSupplyDraft(longRest.id));
  const mine = _getItemsTotal(items);
  return {
    key: longRest.id,
    title: 'Camp supplies',
    text: `The Game Master accepted the long rest. The camp needs ${perChar} supplies for each of the ` +
          `${members.length} resting, so ${_getSuppliesProgressText(longRest, mine)} with your pick. ` +
          'Food you give is used up.',
    sig: _getSupplyPickerSig(longRest.id),
    body: () => [_buildSupplyPicker(longRest.id)],
    actions: [{ label: mine ? `Give ${mine} supplies` : 'Give nothing', primary: true,
                onClick: () => _pledgeSupplies(longRest.id) }],
  };
}

function _getGmSuppliesModel(longRest) {
  const { members, done } = _getSupplyMembers(longRest);
  const isShort = _getPledgedTotal(longRest) < (Number(longRest.required) || 0);
  return {
    key: longRest.id,
    title: 'Camp supplies',
    text: `${_getSuppliesProgressText(longRest)} pledged.` +
          (done.length === members.length && isShort ? ' Everyone has chosen, and the camp is short.' : ''),
    groups: [
      { label: 'Done', names: done.map(m => _getMemberName(m)), cls: 'resting' },
      { label: 'Still choosing', names: members.filter(m => !done.includes(m)).map(m => _getMemberName(m)), cls: 'waiting' },
    ].filter(g => g.names.length),
    actions: [
      { label: 'Call it off', onClick: () => _finishLongRest(longRest.id, false) },
      { label: 'Rest anyway', primary: true, onClick: () => _finishLongRest(longRest.id, true) },
    ],
  };
}

function _getSoloLongRestModel() {
  const items = _getDraftItems(_getSupplyDraft('solo'));
  const mine = _getItemsTotal(items);
  return {
    key: 'solo',
    title: 'Take a long rest?',
    text: `A night's camp takes ${CAMP_SUPPLIES_PER_CHARACTER} supplies, ${mine} picked. Food you pick is used up.`,
    sig: _getSupplyPickerSig('solo'),
    body: () => [_buildSupplyPicker('solo')],
    actions: [
      { label: 'Not now', onClick: () => _takeSoloLongRest(false) },
      { label: 'Rest', primary: true, onClick: () => _takeSoloLongRest(true) },
    ],
  };
}

// ─── THE PROMPT CARD ───

function _buildRestStat(label, value) {
  const el = document.createElement('div');
  el.className = 'rest-prompt-stat';
  const l = document.createElement('span');
  l.textContent = label;
  const v = document.createElement('strong');
  v.textContent = value;
  el.append(l, v);
  return el;
}

function _buildRestStepper(value, { label, canDown, canUp, onStep }) {
  const wrap = document.createElement('div');
  wrap.className = 'rest-stepper';
  wrap.setAttribute('aria-label', label);
  const down = document.createElement('button');
  down.type = 'button';
  down.className = 'btn-sm';
  down.textContent = '−';
  down.disabled = !canDown;
  down.addEventListener('click', () => onStep(-1));
  const num = document.createElement('span');
  num.className = 'rest-stepper-value';
  num.textContent = value;
  const up = document.createElement('button');
  up.type = 'button';
  up.className = 'btn-sm';
  up.textContent = '+';
  up.disabled = !canUp;
  up.addEventListener('click', () => onStep(1));
  wrap.append(down, num, up);
  return wrap;
}

function _buildRestPromptGroup(group) {
  const wrap = document.createElement('div');
  wrap.className = 'rest-prompt-group ' + group.cls;
  const label = document.createElement('div');
  label.className = 'rest-prompt-group-label';
  label.textContent = group.label;
  const names = document.createElement('div');
  names.className = 'rest-prompt-names';
  group.names.forEach(n => {
    const chip = document.createElement('span');
    chip.className = 'rest-prompt-name';
    chip.textContent = n;
    names.appendChild(chip);
  });
  wrap.append(label, names);
  return wrap;
}

// Draws the prompt card. Names are other players' typing, so everything goes
// in through textContent. Skips the rebuild when nothing changed, because the
// roster redraws often and must not swap buttons out from under the cursor.
function _renderRestPrompt() {
  const model = _getRestPromptModel();
  const signature = model ? JSON.stringify(model, (k, v) => typeof v === 'function' ? undefined : v) : '';
  if (signature === lastRestPromptSignature) return;
  lastRestPromptSignature = signature;

  restPromptEl.classList.toggle('hidden', !model);
  if (!model) return;
  restPromptTitleEl.textContent = model.title;
  restPromptTextEl.textContent = model.text ?? '';
  restPromptBodyEl.replaceChildren(
    ...(model.body ? model.body() : []),
    ...(model.groups ?? []).map(_buildRestPromptGroup),
  );
  restPromptActsEl.replaceChildren(...model.actions.map(a => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = a.primary ? 'btn-primary' : 'btn-sm';
    btn.textContent = a.label;
    btn.disabled = !!a.disabled;
    btn.addEventListener('click', a.onClick);
    return btn;
  }));
}

// ─── RENDERING ───

// Redraws the rest buttons, the short rest tray and the prompt card. Called on
// every rest snapshot and roster change (party.js).
function renderRestUI() {
  _renderShortRestTray();

  const longRest = _getActiveLongRest();
  longRestBtn.classList.toggle('pending', !!longRest);
  if (!longRest) longRestBtn.title = 'Long rest';
  else if (longRest.status === 'supplies') longRestBtn.title = 'Long rest accepted · gathering camp supplies';
  else longRestBtn.title = 'Long rest requested · waiting on '
    + (_getLongRestTally(longRest).waiting.join(', ') || 'the Game Master');

  _renderRestPrompt();
}

// ─── WIRING ───

shortRestBtn.addEventListener('click', () => {
  if (!isShortRestTrayOpen()) {
    setDiceDockOpen(false); // the two trays share the corner
    _setShortRestTrayOpen(true);
  } else {
    _setShortRestTrayOpen(false);
    _takeShortRest();
  }
  _renderShortRestTray();
});

longRestBtn.addEventListener('click', () => {
  closeShortRestTray();
  _requestLongRest();
});

// A click anywhere else folds the tray away without resting.
document.addEventListener('pointerdown', e => {
  if (isShortRestTrayOpen() && !restDockEl.contains(e.target)) closeShortRestTray();
});
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && isShortRestTrayOpen()) closeShortRestTray();
});

renderRestUI();
