// =============================================================================
// REST — the short and long rest buttons, the short rest tray, and the party's
// long rest vote
// =============================================================================
'use strict';

// The party's rest state lives at `parties/<code>/rest`:
//   { shortRestsLeft, longRest: { id, byUid, byName, at, status, responses } }
// `status` is 'voting' | 'accepted' | 'declined'; `responses` maps a player's
// uid to { name, rest }. Players vote on a long rest; once every online player
// has answered, the GM accepts or declines it for everyone who chose to rest.
// Signed out or with no campaign, both rests are this browser's alone.

const SHORT_RESTS_PER_LONG_REST = 2;  // short rests the party gets between long rests
const REST_NOTICE_MS = 4000;          // how long an accepted/declined notice stays up

let partyRestRef = null;
let partyRest = {};                   // read-through cache of `parties/<code>/rest`

// Solo play has no party node, so its count lives here for the session.
let soloShortRestsLeft = SHORT_RESTS_PER_LONG_REST;

// The long rest request as last seen, so an outcome is acted on only when this
// client watched it change — a reload into an old accepted request must not
// rest again.
let lastSeenLongRest = null;
let hasRestSnapshot = false;

let isSoloLongRestConfirming = false;
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
const restPromptListsEl = document.getElementById('rest-prompt-lists');
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

// Acts on a request reaching its outcome, if this client saw it while voting.
function _noteLongRestChange(longRest) {
  const prev = lastSeenLongRest;
  lastSeenLongRest = longRest ? { id: longRest.id, status: longRest.status } : null;
  if (!hasRestSnapshot) { hasRestSnapshot = true; return; }
  if (!longRest || !prev || prev.id !== longRest.id) return;
  if (prev.status !== 'voting' || longRest.status === 'voting') return;

  const isMember = state.party.role === 'player'
    && !!longRest.responses?.[state.party.playerId]?.rest;
  if (longRest.status === 'accepted') {
    if (isMember) _applyLongRestToCharacter();
    _showRestNotice('The party takes a long rest',
      isMember ? 'You wake rested.' : 'You kept watch while they slept.');
  } else {
    _showRestNotice('No long rest', 'The Game Master declined the long rest.');
  }
}

// ─── REST EFFECTS ───
// What each rest does to the character is not decided yet; these are the hooks.

function _applyShortRestToCharacter() {}

function _applyLongRestToCharacter() {}

// ─── SHORT REST ───

function _getShortRestsLeft() {
  if (!_isPartyRest()) return soloShortRestsLeft;
  const n = Number(partyRest.shortRestsLeft);
  return Number.isFinite(n) ? n : SHORT_RESTS_PER_LONG_REST;
}

// A GM has no character to rest, and a player viewing someone else's sheet
// would rest the wrong one.
function _canTakeShortRest() {
  if (state.party.active && state.party.role === 'gm') return false;
  if (isReadOnly()) return false;
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
    _applyShortRestToCharacter();
    renderRestUI();
    return;
  }
  firebaseDb.ref(`parties/${state.party.code}/rest/shortRestsLeft`).transaction(cur => {
    const left = cur ?? SHORT_RESTS_PER_LONG_REST;
    return left > 0 ? left - 1 : undefined;
  }).then(({ committed }) => {
    if (committed) _applyShortRestToCharacter();
  }).catch(e => alert('Could not take a short rest: ' + e.message));
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
  shortRestBtn.title = _canTakeShortRest()
    ? (isShortRestTrayOpen() ? 'Click again to take a short rest' : 'Short rest')
    : 'Short rest';
}

// ─── LONG REST: THE REQUEST ───

function _getVotingLongRest() {
  const longRest = partyRest.longRest;
  return _isPartyRest() && longRest?.status === 'voting' ? longRest : null;
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

// Starts a long rest: a confirmation alone, or a vote put to the whole party.
function _requestLongRest() {
  if (!_isPartyRest()) {
    isSoloLongRestConfirming = true;
    renderRestUI();
    return;
  }
  const voting = _getVotingLongRest();
  if (voting) {
    // A GM asking again opens the decision early, for a vote someone is sitting on.
    if (state.party.role === 'gm') { gmPeekLongRestId = voting.id; renderRestUI(); }
    return;
  }

  const isGM = state.party.role === 'gm';
  const uid = getOwnPlayerId();
  const longRest = {
    id: firebaseDb.ref().push().key,
    byUid: isGM ? (uid ?? 'gm') : state.party.playerId,
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

// The GM's decision. Accepting also refills the party's short rests.
function _decideLongRest(requestId, isAccepted) {
  const longRest = _getVotingLongRest();
  if (!longRest || longRest.id !== requestId || state.party.role !== 'gm') return;
  gmPeekLongRestId = null;
  const update = {
    'longRest/status': isAccepted ? 'accepted' : 'declined',
    'longRest/decidedAt': firebase.database.ServerValue.TIMESTAMP,
  };
  if (isAccepted) update.shortRestsLeft = SHORT_RESTS_PER_LONG_REST;
  partyRestRef.update(update).catch(e => alert('Could not record your decision: ' + e.message));
}

function _confirmSoloLongRest(isConfirmed) {
  isSoloLongRestConfirming = false;
  if (isConfirmed) {
    soloShortRestsLeft = SHORT_RESTS_PER_LONG_REST;
    _applyLongRestToCharacter();
  }
  renderRestUI();
}

function _showRestNotice(title, text) {
  restNotice = { title, text };
  clearTimeout(restNoticeTimer);
  restNoticeTimer = setTimeout(() => { restNotice = null; renderRestUI(); }, REST_NOTICE_MS);
}

// ─── LONG REST: THE PROMPT ───

// What the prompt card should show right now, or null for nothing.
function _getRestPromptModel() {
  if (isSoloLongRestConfirming) {
    return {
      title: 'Take a long rest?',
      text: 'Your character settles in for eight hours of rest.',
      actions: [
        { label: 'Sleep is for the weak!', onClick: () => _confirmSoloLongRest(false) },
        { label: 'Rest', primary: true, onClick: () => _confirmSoloLongRest(true) },
      ],
    };
  }

  const longRest = _getVotingLongRest();
  if (longRest && state.party.role === 'player' && !longRest.responses?.[state.party.playerId]) {
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
  if (longRest && state.party.role === 'gm') {
    const tally = _getLongRestTally(longRest);
    if (!tally.waiting.length || gmPeekLongRestId === longRest.id) return _getGmDecisionModel(longRest, tally);
  }

  if (restNotice) return { title: restNotice.title, text: restNotice.text, actions: [] };
  return null;
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
  restPromptListsEl.replaceChildren(...(model.groups ?? []).map(_buildRestPromptGroup));
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

  const longRest = _getVotingLongRest();
  const isWaiting = !!longRest;
  longRestBtn.classList.toggle('pending', isWaiting);
  longRestBtn.title = !isWaiting ? 'Long rest'
    : 'Long rest requested · waiting on ' + (_getLongRestTally(longRest).waiting.join(', ') || 'the Game Master');

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
