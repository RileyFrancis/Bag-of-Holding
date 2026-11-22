// =============================================================================
// CHAT — the table's conversation, in the sidebar beside the character sheet
// =============================================================================
'use strict';

// Messages live at `parties/<code>/chat/<pushId> { uid, name, text, at }`, a
// read-through cache refreshed by `subscribeToChat`; nothing is in the save file.
// `name` is stamped at send time. Render with `textContent`, never innerHTML:
// this is where another player's typing lands in your browser. A roll
// (`kind: 'roll'`) and a spell cast (`kind: 'cast'`) are messages too.

// Only the tail is subscribed, so an old campaign doesn't load its whole history.
const CHAT_HISTORY_LIMIT = 200; // messages
const CHAT_MAX_LEN = 2000;      // characters per message
const CHAT_INPUT_MAX_H = 120;   // px the composer grows to before it scrolls

let partyChatRef = null;

// The messages held, oldest first. Not in `state`: nothing outside this file reads them.
let chatMessages = [];

// Whether the reader is pinned to the bottom. A message arriving must not yank
// someone out of the history they scrolled up to read, and must not leave them
// stranded above the newest line when they were following along.
let chatPinnedToBottom = true;

const chatLogEl   = document.getElementById('chat-log');
const chatBodyEl  = document.getElementById('chat-body');
const chatEmptyEl = document.getElementById('chat-empty');
const chatFormEl  = document.getElementById('chat-form');
const chatInputEl = document.getElementById('chat-input');

// ─── THE SUBSCRIPTION ───

// Subscribes to a campaign's chat tail, replacing any earlier subscription.
function subscribeToChat(code) {
  unsubscribeFromChat();
  if (!firebaseDb) return;
  partyChatRef = firebaseDb.ref(`parties/${code}/chat`).limitToLast(CHAT_HISTORY_LIMIT);
  partyChatRef.on('value', snap => {
    const val = snap.val() ?? {};
    // Push ids sort lexicographically into chronological order; sorted
    // explicitly rather than trusting object key order.
    chatMessages = Object.keys(val).sort().map(id => ({ id, ...val[id] }));
    // A line arriving also pops a bubble over the speaker's tab (dice.js).
    noteBubbleFeed(chatMessages);
    renderChat();
  });
}

// Drops the chat subscription and clears the held messages.
function unsubscribeFromChat() {
  if (partyChatRef) { partyChatRef.off(); partyChatRef = null; }
  chatMessages = [];
  chatPinnedToBottom = true;
  // Or the next campaign's tail would arrive as a burst of live lines, popping
  // a bubble for every one of them.
  resetBubbleFeed();
  renderChat();
}

// ─── SENDING ───

// Whether this browser can post to a campaign's chat right now.
function canChat() {
  return !!(firebaseDb && state.party.active && state.party.code && isSignedIn());
}

// The name to speak under: the account's, because chat is between *players*.
// A GM has no character and would otherwise be nameless.
function getChatAuthorName() {
  return getAccountDisplayName() || state.party.playerName || 'Someone';
}

// Pins the log to the newest line. Saying something is an intent to follow,
// so dice.js and spells.js call this when they post too.
function pinChatToNewest() { chatPinnedToBottom = true; }

async function _sendChatMessage(text) {
  const body = text.trim().slice(0, CHAT_MAX_LEN);
  if (!body || !canChat()) return;

  pinChatToNewest();

  try {
    await firebaseDb.ref(`parties/${state.party.code}/chat`).push({
      uid: getOwnPlayerId(),
      name: getChatAuthorName(),
      text: body,
      at: firebase.database.ServerValue.TIMESTAMP,
    });
  } catch (e) {
    alert('Message not sent: ' + e.message);
  }
}

// ─── RENDERING ───

// Called whenever the tab is shown, so a reader arriving at Chat lands at the
// newest line rather than wherever the scroll was left.
function onChatTabShown() {
  chatPinnedToBottom = true;
  // A render, not just a scroll: the first time the tab is shown the pane has
  // never been drawn. renderChat() scrolls, since the log is pinned.
  renderChat();
}

function _scrollChatToBottom() {
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

// Redraws the chat pane: the signed-out/no-campaign notice, or the whole log.
function renderChat() {
  if (!chatLogEl) return;

  const isOpen = canChat();
  chatBodyEl.classList.toggle('hidden', !isOpen);
  chatEmptyEl.classList.toggle('hidden', isOpen);

  if (!isOpen) {
    chatEmptyEl.textContent = state.party.active
      ? 'Sign in to join the conversation.'
      : 'Chat belongs to a campaign. Open one from your home screen and the table can talk here.';
    return;
  }

  // Measured *before* the rebuild: afterwards the log is a different height and
  // the old scrollTop means nothing.
  const wasPinned = chatPinnedToBottom;

  chatLogEl.innerHTML = '';

  if (!chatMessages.length) {
    const empty = document.createElement('p');
    empty.className = 'chat-log-empty';
    empty.textContent = 'Nothing said yet.';
    chatLogEl.appendChild(empty);
    return;
  }

  const me = getOwnPlayerId();
  let lastUid = null;
  let lastAt = 0;

  chatMessages.forEach(m => {
    // Consecutive lines from one person within five minutes show the name once.
    const isSameSpeaker = m.uid === lastUid && Number(m.at) - lastAt < 300000;

    const isRoll = m.kind === 'roll' && !!m.roll;
    const isCast = m.kind === 'cast' && !!m.cast;

    const row = document.createElement('div');
    row.className = 'chat-msg' + (m.uid === me ? ' own' : '') +
                    (isSameSpeaker ? ' run-on' : '') + (isRoll ? ' roll' : '') + (isCast ? ' cast' : '');

    if (!isSameSpeaker) {
      const head = document.createElement('div');
      head.className = 'chat-msg-head';

      const who = document.createElement('span');
      who.className = 'chat-msg-name';
      who.textContent = m.name || 'Someone';

      const when = document.createElement('span');
      when.className = 'chat-msg-time';
      when.textContent = _formatChatTime(m.at);

      head.append(who, when);
      row.appendChild(head);
    }

    // A roll or cast gets a card built from its payload, never the sentence.
    // A plain line is textContent, never parsed.
    row.appendChild(isRoll ? _buildRollMessageBody(m) : isCast ? _buildCastMessageBody(m) : _buildPlainMessageBody(m));

    chatLogEl.appendChild(row);
    lastUid = m.uid;
    lastAt = Number(m.at) || 0;
  });

  if (wasPinned) _scrollChatToBottom();
}

function _buildPlainMessageBody(m) {
  const body = document.createElement('div');
  body.className = 'chat-msg-text';
  body.textContent = m.text ?? '';
  return body;
}

// The total, the label, and what was on the dice: the same pieces, in the same
// order, as the flying number and the corner chip.
function _buildRollMessageBody(m) {
  const r = buildRollFromMessage(m);

  const card = document.createElement('div');
  card.className = 'chat-roll';
  const crit = getRollCritClass(r);
  if (crit) card.classList.add(crit);

  const die = document.createElement('span');
  die.className = 'ico ico-d20 chat-roll-die';

  const total = document.createElement('span');
  total.className = 'chat-roll-total';
  total.textContent = r.total;

  const text = document.createElement('span');
  text.className = 'chat-roll-text';

  const label = document.createElement('span');
  label.className = 'chat-roll-label';
  label.textContent = r.label;
  const pill = buildRollModePill(r);
  if (pill) label.appendChild(pill);

  const detail = document.createElement('span');
  detail.className = 'chat-roll-detail';
  detail.textContent = formatRollDetailLine(r);

  text.append(label, detail);
  card.append(die, total, text);
  return card;
}

// A cast (spells.js's `_postCastToChat()`): the school's glyph where the roll
// card has its die, the spell's name, and who cast it at what level.
function _buildCastMessageBody(m) {
  const c = m.cast;
  const level = Number(c.level) || 0;

  const card = document.createElement('div');
  card.className = 'chat-roll chat-cast';

  const icon = createSchoolIcon(c.school);
  if (icon) {
    icon.classList.add('chat-cast-icon');
    card.appendChild(icon);
  }

  const text = document.createElement('span');
  text.className = 'chat-roll-text';

  const label = document.createElement('span');
  label.className = 'chat-roll-label';
  label.textContent = String(c.spell ?? 'a spell');

  const detail = document.createElement('span');
  detail.className = 'chat-roll-detail';
  detail.textContent = [
    String(c.character ?? '').trim(),
    getCastLevelText(level, Number(c.baseLevel) || level, !!c.pact),
  ].filter(Boolean).join(' · ');

  text.append(label, detail);
  card.appendChild(text);
  return card;
}

// Clock time for today, and the date once it is not today. A transcript read
// back the next session should say which evening a line came from.
function _formatChatTime(at) {
  const ms = Number(at);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  const isSameDay = d.getFullYear() === today.getFullYear() &&
                  d.getMonth() === today.getMonth() &&
                  d.getDate() === today.getDate();
  return isSameDay ? time : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + time;
}

// ─── WIRING ───

chatFormEl.addEventListener('submit', e => {
  e.preventDefault();
  const text = chatInputEl.value;
  chatInputEl.value = '';
  _autoGrowChatInput();
  _sendChatMessage(text);
});

// Enter sends; Shift+Enter is a newline (hence a textarea, not an input).
chatInputEl.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  e.preventDefault();
  chatFormEl.requestSubmit();
});

// Grows with the message to a few lines, then scrolls. Reset to `auto` first or
// the box can only ever get taller.
function _autoGrowChatInput() {
  chatInputEl.style.height = 'auto';
  chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, CHAT_INPUT_MAX_H) + 'px';
}
chatInputEl.addEventListener('input', _autoGrowChatInput);

// ─── THE CHAT MODAL ───

// Enter opens it; its ✕ or Escape closes it. There is no second log: the tab's
// empty state, log and composer are *moved* into the modal and back, so
// renderChat() and every listener above keep working.
const chatTabEl       = document.getElementById('tab-chat');
const chatModalEl     = document.getElementById('chat-modal');
const chatModalBodyEl = document.getElementById('chat-modal-body');

// Whether the chat modal is showing.
function isChatModalOpen() {
  return !chatModalEl.classList.contains('hidden');
}

// Moves the chat log into the modal and shows it.
function _openChatModal() {
  if (isChatModalOpen()) return;
  chatModalBodyEl.append(chatEmptyEl, chatBodyEl);
  showModal('chat-modal');
  // Moving an element resets its scroll, so land on the newest line.
  onChatTabShown();
  if (canChat()) chatInputEl.focus();
}

// Hides the modal and moves the chat log back into its tab.
function _closeChatModal() {
  if (!isChatModalOpen()) return;
  chatInputEl.blur();
  chatTabEl.append(chatEmptyEl, chatBodyEl);
  hideModal('chat-modal');
  onChatTabShown();
}

// Enter opens the chat from anywhere in the app, but not while typing, from
// the home screen, mid-drag, or over another modal. A button *focused from the
// keyboard* keeps Enter as its own (`:focus-visible`); one that merely kept
// focus after a mouse click does not, or Enter would re-click whatever was
// clicked last.
function _isChatShortcutAllowed(e) {
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.repeat) return false;
  const target = e.target;
  if (target && target.matches && target.matches('input, textarea, select')) return false;
  if (target && target.isContentEditable) return false;
  if (target && target !== document.body && target.matches && target.matches(':focus-visible')) return false;
  if (document.querySelector('.modal:not(.hidden)')) return false;
  if (state.screen !== 'app') return false;
  return state.mode === 'idle';
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && isChatModalOpen()) {
    e.preventDefault();
    _closeChatModal();
    return;
  }
  if (e.key === 'Enter' && _isChatShortcutAllowed(e)) {
    e.preventDefault(); // not a click on whatever button last kept focus
    _openChatModal();
  }
});

document.getElementById('chat-modal-close').addEventListener('click', _closeChatModal);
// The shared backdrop handler skips this modal (`data-backdrop-close="false"`),
// since hiding it alone would strand the log in here.
document.getElementById('modal-backdrop').addEventListener('click', _closeChatModal);

// Within a line or so of the bottom counts as pinned, so a fractional scroll
// position or rounding difference doesn't unstick the log.
chatLogEl.addEventListener('scroll', () => {
  const slack = chatLogEl.scrollHeight - chatLogEl.clientHeight - chatLogEl.scrollTop;
  chatPinnedToBottom = slack < 24;
});
