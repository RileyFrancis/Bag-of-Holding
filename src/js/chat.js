// =============================================================================
// CHAT — the table's conversation, in the sidebar beside the character sheet
// =============================================================================
'use strict';

// Talk belongs to the table: `parties/<code>/chat/<pushId> { uid, name, text, at }`.
// A read-through cache like state.shops, refreshed by `subscribeToChat` (from
// `subscribeToParty`); nothing about it is in the save file. `name` is stamped
// at send time, not looked up when drawn. `textContent`, never innerHTML — this
// is the one pane where another player's typing lands in your browser. A roll is
// a message too (`kind: 'roll'`, drawn as a card by `rollMessageBody()`).
// See CLAUDE.md § Chat.

// Only the tail is subscribed — a year-old campaign should not cost a year of
// messages to open a tab.
const CHAT_HISTORY = 200;
const CHAT_MAX_LEN = 2000;

let partyChatRef = null;

// The messages we hold, oldest first. Not in `state`, because unlike the shops
// nothing outside this file reads them.
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

// =============================================================================
// THE SUBSCRIPTION
// =============================================================================
function subscribeToChat(code) {
  unsubscribeFromChat();
  if (!firebaseDb) return;
  partyChatRef = firebaseDb.ref(`parties/${code}/chat`).limitToLast(CHAT_HISTORY);
  partyChatRef.on('value', snap => {
    const val = snap.val() ?? {};
    // Push ids sort lexicographically into chronological order — sorted
    // explicitly rather than trusting object key order.
    chatMessages = Object.keys(val).sort().map(id => ({ id, ...val[id] }));
    // A line arriving is news for the tab strip too — a bubble over the
    // speaker's tab (dice.js, whose roll bubbles came first).
    noteBubbleFeed(chatMessages);
    renderChat();
  });
}

function unsubscribeFromChat() {
  if (partyChatRef) { partyChatRef.off(); partyChatRef = null; }
  chatMessages = [];
  chatPinnedToBottom = true;
  // Or the next campaign's tail would arrive as a burst of live lines, popping
  // a bubble for every one of them.
  resetBubbleFeed();
  renderChat();
}

// =============================================================================
// SENDING
// =============================================================================
function canChat() {
  return !!(firebaseDb && state.party.active && state.party.code && isSignedIn());
}

// The name to speak under: the account's, because chat is between *players*.
// A GM has no character and would otherwise be nameless.
function chatAuthorName() {
  return accountDisplayName() || state.party.playerName || 'Someone';
}

// Saying something is always an intent to follow. A named function so dice.js
// can declare the same intent when it posts a roll.
function chatFollowNewest() { chatPinnedToBottom = true; }

async function sendChatMessage(text) {
  const body = text.trim().slice(0, CHAT_MAX_LEN);
  if (!body || !canChat()) return;

  chatFollowNewest();

  try {
    await firebaseDb.ref(`parties/${state.party.code}/chat`).push({
      uid: ownPlayerId(),
      name: chatAuthorName(),
      text: body,
      at: firebase.database.ServerValue.TIMESTAMP,
    });
  } catch (e) {
    alert('Message not sent: ' + e.message);
  }
}

// =============================================================================
// RENDERING
// =============================================================================
// Called whenever the tab is shown, so a reader arriving at Chat lands at the
// newest line rather than wherever the scroll happened to be left.
function onChatTabShown() {
  chatPinnedToBottom = true;
  // A render, not just a scroll — the first time this tab is shown the pane has
  // never been drawn. renderChat() scrolls for us, now that we are pinned.
  renderChat();
}

function scrollChatToBottom() {
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function renderChat() {
  if (!chatLogEl) return;

  const open = canChat();
  chatBodyEl.classList.toggle('hidden', !open);
  chatEmptyEl.classList.toggle('hidden', open);

  if (!open) {
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

  const me = ownPlayerId();
  let lastUid = null;
  let lastAt = 0;

  chatMessages.forEach(m => {
    // Consecutive lines from one person inside a few minutes are one turn in the
    // conversation, so the name is said once. A gap means the conversation
    // resumed, and it is worth saying again.
    const sameSpeaker = m.uid === lastUid && Number(m.at) - lastAt < 300000;

    const isRoll = m.kind === 'roll' && !!m.roll;

    const row = document.createElement('div');
    row.className = 'chat-msg' + (m.uid === me ? ' own' : '') +
                    (sameSpeaker ? ' run-on' : '') + (isRoll ? ' roll' : '');

    if (!sameSpeaker) {
      const head = document.createElement('div');
      head.className = 'chat-msg-head';

      const who = document.createElement('span');
      who.className = 'chat-msg-name';
      who.textContent = m.name || 'Someone';

      const when = document.createElement('span');
      when.className = 'chat-msg-time';
      when.textContent = formatChatTime(m.at);

      head.append(who, when);
      row.appendChild(head);
    }

    // A roll gets a card of its own, built from the payload never the sentence.
    // Everything else: textContent, never innerHTML — a chat line did not ask to
    // be formatted, so it is not parsed at all.
    row.appendChild(isRoll ? rollMessageBody(m) : plainMessageBody(m));

    chatLogEl.appendChild(row);
    lastUid = m.uid;
    lastAt = Number(m.at) || 0;
  });

  if (wasPinned) scrollChatToBottom();
}

function plainMessageBody(m) {
  const body = document.createElement('div');
  body.className = 'chat-msg-text';
  body.textContent = m.text ?? '';
  return body;
}

// The total, the label, and what was on the dice — the same three pieces, same
// order, as the flying number and the corner chip.
function rollMessageBody(m) {
  const r = rollFromMessage(m);

  const card = document.createElement('div');
  card.className = 'chat-roll';
  const crit = rollCrit(r);
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
  const pill = rollModePill(r); // dice.js's, shared across all four surfaces
  if (pill) label.appendChild(pill);

  const detail = document.createElement('span');
  detail.className = 'chat-roll-detail';
  detail.textContent = rollDetailLine(r); // the same line the flying number carries

  text.append(label, detail);
  card.append(die, total, text);
  return card;
}

// Clock time for today, and the date once it is not today. A transcript read
// back the next session should say which evening a line came from.
function formatChatTime(at) {
  const ms = Number(at);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  const sameDay = d.getFullYear() === today.getFullYear() &&
                  d.getMonth() === today.getMonth() &&
                  d.getDate() === today.getDate();
  return sameDay ? time : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + time;
}

// =============================================================================
// WIRING
// =============================================================================
chatFormEl.addEventListener('submit', e => {
  e.preventDefault();
  const text = chatInputEl.value;
  chatInputEl.value = '';
  autoGrowChatInput();
  sendChatMessage(text);
});

// Enter sends; Shift+Enter is a newline (hence a textarea, not an input).
chatInputEl.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  e.preventDefault();
  chatFormEl.requestSubmit();
});

// Grows with the message to a few lines, then scrolls. Reset to `auto` first or
// the box can only ever get taller.
const CHAT_INPUT_MAX_H = 120;
function autoGrowChatInput() {
  chatInputEl.style.height = 'auto';
  chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, CHAT_INPUT_MAX_H) + 'px';
}
chatInputEl.addEventListener('input', autoGrowChatInput);

// =============================================================================
// THE CHAT MODAL — the same log, bigger, in the middle of the screen
// =============================================================================
// Enter opens it; its ✕ or Escape closes it. There is no second log: the tab's
// empty state, log and composer are *moved* into the modal and back, so
// renderChat() and every listener above keep working untouched.
const chatTabEl       = document.getElementById('tab-chat');
const chatModalEl     = document.getElementById('chat-modal');
const chatModalBodyEl = document.getElementById('chat-modal-body');

function chatModalIsOpen() {
  return !chatModalEl.classList.contains('hidden');
}

function openChatModal() {
  if (chatModalIsOpen()) return;
  chatModalBodyEl.append(chatEmptyEl, chatBodyEl);
  showModal('chat-modal');
  // Moving an element resets its scroll, so land on the newest line.
  onChatTabShown();
  if (canChat()) chatInputEl.focus();
}

function closeChatModal() {
  if (!chatModalIsOpen()) return;
  chatInputEl.blur();
  chatTabEl.append(chatEmptyEl, chatBodyEl);
  hideModal('chat-modal');
  onChatTabShown();
}

// Enter opens the chat from anywhere in the app — but not while typing, from
// the home screen, mid-drag, or over another modal. A button *focused from the
// keyboard* keeps Enter as its own (`:focus-visible`); one that merely kept
// focus after a mouse click does not, or Enter would re-click whatever was
// clicked last.
function chatShortcutAllowed(e) {
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.repeat) return false;
  const t = e.target;
  if (t && t.matches && t.matches('input, textarea, select')) return false;
  if (t && t.isContentEditable) return false;
  if (t && t !== document.body && t.matches && t.matches(':focus-visible')) return false;
  if (document.querySelector('.modal:not(.hidden)')) return false;
  if (state.screen !== 'app') return false;
  return state.mode === 'idle';
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && chatModalIsOpen()) {
    e.preventDefault();
    closeChatModal();
    return;
  }
  if (e.key === 'Enter' && chatShortcutAllowed(e)) {
    e.preventDefault(); // not a click on whatever button last kept focus
    openChatModal();
  }
});

document.getElementById('chat-modal-close').addEventListener('click', closeChatModal);
// The shared backdrop handler skips this modal (`data-backdrop-close="false"`),
// since hiding it alone would strand the log in here.
document.getElementById('modal-backdrop').addEventListener('click', closeChatModal);

// What "pinned" means, measured rather than assumed: within a line or so of the
// bottom counts as following along, so a fractional scroll position or a
// rounding difference does not unstick the log.
chatLogEl.addEventListener('scroll', () => {
  const slack = chatLogEl.scrollHeight - chatLogEl.clientHeight - chatLogEl.scrollTop;
  chatPinnedToBottom = slack < 24;
});
