// =============================================================================
// DICE — rolling, and the places a roll is seen
// =============================================================================
'use strict';

// A roll has three audiences: the roller (the big tumbling number, then a corner
// chip whose hover shows the whole working), the table (a line in the chat log),
// and everyone else (a bubble over the roller's tab, as a chat line pops one).
// There is no rolls collection: a roll IS a chat message with `kind: 'roll'`, so
// it inherits the log's server ordering, single subscription and capped tail.
// Nothing here talks to Firebase except `_postRollToChat()`; rolling works with
// no campaign at all.

// ─── THE MODEL ───

const DICE_FACES = [4, 6, 8, 10, 12, 20, 100];

// How many of your own rolls the corner keeps.
const ROLL_HISTORY_LIMIT = 3;

// A roll runs a random 1–3 seconds; the last stretch is the settle (the true
// number held still). A fixed duration reads as a delay rather than suspense.
const ROLL_SPIN_MIN_MS = 1000;
const ROLL_SPIN_MAX_MS = 3000;
const ROLL_SETTLE_MS   = 450;

// An advantage roll's two extra beats (numbers stand side by side, then the
// grey-out and slide) come OUT of the tumble, not after it.
const ROLL_PAIR_HOLD_MS = 450;
const ROLL_RESOLVE_MS   = 520;

// The tumble gets at least this much even at the bottom of the range.
const ROLL_SPIN_MIN_FLOOR_MS = 320;

// Gap between one tumbled number and the next, start and end.
const ROLL_TICK_FAST_MS = 40;
const ROLL_TICK_SLOW_MS = 205;

const ROLL_FLIGHT_MS = 620; // flier's trip to the corner chip

// How long a bubble hangs over a tab: long enough to read, scaled by what it
// says and clamped to a range. The last stretch is the fade.
const TAB_BUBBLE_MIN_MS = 3000;
const TAB_BUBBLE_MAX_MS = 8000;
const TAB_BUBBLE_MS_PER_CHAR = 60;
const TAB_BUBBLE_FADE_MS = 400;

// A chat line longer than this is cut short in its bubble; the log has the
// whole thing, and a paragraph hanging off a tab would cover the page.
const TAB_BUBBLE_MAX_CHARS = 120;

// Press-and-hold wheel: hold time before it opens on its own, and pointer
// travel (px) that opens it sooner so a decisive flick is not ignored.
const WHEEL_HOLD_MS = 180;
const WHEEL_REACH   = 9;

// px from the origin that counts as having chosen a side.
const WHEEL_DEADZONE = 26;

const DOCK_MOD_LIMIT = 30; // largest modifier, either sign, the dice dock takes

// Keyed by the value stored on a roll, so the map is also the set of legal modes.
const ROLL_MODES = {
  adv: { label: 'Advantage',    short: 'Adv', glyph: '▲' },
  dis: { label: 'Disadvantage', short: 'Dis', glyph: '▼' },
};

// Your own rolls, oldest first. Session-only, never saved, never synced.
let rollHistory = [];

// Matches a flier to its chip, and a chip to the roll its hover detail draws from.
let rollSeq = 0;

const diceStageEl   = document.getElementById('dice-stage');
const diceHistoryEl = document.getElementById('dice-history');
const diceBubbleEl  = document.getElementById('dice-tab-bubbles');
const rollWheelEl   = document.getElementById('roll-wheel');
const rollDetailEl  = document.getElementById('roll-detail');

// ─── ROLLING ───

function _rollOneDie(faces) {
  return 1 + Math.floor(Math.random() * faces);
}

function _rollDicePool(faces, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(_rollOneDie(faces));
  return out;
}

function _getPoolTotal(pool) {
  return pool.reduce((a, b) => a + b, 0);
}

// A roll's dice as groups of one size, `[{ faces, count }]`, largest die
// first. A sheet roll is one group; the dice dock can mix sizes (1d20 + 2d6).
// `dice` and `dropped` are flat, in this same group order, so the Nth value is
// read against the Nth slot of `_getGroupFacesList()`. Anything without a `pool`
// (a sheet roll, an older client's chat line) is its own `faces`/`count`.
function _getRollGroups(r) {
  const raw = r && r.pool ? (Array.isArray(r.pool) ? r.pool : Object.values(r.pool)) : [];
  const groups = raw
    .map(g => ({ faces: Number(g && g.faces) || 0, count: Number(g && g.count) || 0 }))
    .filter(g => g.faces > 0 && g.count > 0);
  if (groups.length) return groups;
  return [{ faces: Number(r && r.faces) || 20, count: Number(r && r.count) || 1 }];
}

// Merges repeats, drops unknown sizes and clamps each group, so
// `[d6, d20, d6]` comes out as 1d20 + 2d6.
function _normalizeDicePool(pool) {
  const byFaces = new Map();
  pool.forEach(g => {
    const faces = parseInt(g.faces, 10);
    if (!DICE_FACES.includes(faces)) return;
    byFaces.set(faces, (byFaces.get(faces) || 0) + (parseInt(g.count, 10) || 0));
  });
  return [...byFaces]
    .filter(([, count]) => count > 0)
    .map(([faces, count]) => ({ faces, count: Math.min(20, count) }))
    .sort((a, b) => b.faces - a.faces);
}

function _getRollGroupsDice(groups) {
  return groups.flatMap(g => _rollDicePool(g.faces, g.count));
}

// The die size behind each slot of a flat `dice` list.
function _getGroupFacesList(groups) {
  return groups.flatMap(g => Array(g.count).fill(g.faces));
}

// The one way a roll happens. Advantage rolls the whole pool twice and keeps the
// better total, not special-cased to a single d20. `pool` (the dice dock's
// mixed handful) takes the place of `faces`/`count` when given.
function performRoll({ label, faces = 20, count = 1, pool = null, mod = 0, mode = 'normal', parts = [], kind = '' }) {
  count = Math.max(1, Math.min(20, parseInt(count, 10) || 1));
  mod   = Math.max(-99, Math.min(99, parseInt(mod, 10) || 0));
  if (!ROLL_MODES[mode]) mode = 'normal';

  const groups = pool ? _normalizeDicePool(pool) : [{ faces, count }];
  if (!groups.length) return null;
  // The first group stands in for `faces`/`count`, which an older client reads
  // off the chat payload.
  faces = groups[0].faces;
  count = groups[0].count;

  let dice, dropped = [], keptIndex = 0;
  if (mode === 'normal') {
    dice = _getRollGroupsDice(groups);
  } else {
    const a = _getRollGroupsDice(groups);
    const b = _getRollGroupsDice(groups);
    const isAKept = mode === 'adv' ? _getPoolTotal(a) >= _getPoolTotal(b) : _getPoolTotal(a) <= _getPoolTotal(b);
    dice      = isAKept ? a : b;
    dropped   = isAKept ? b : a;
    // Which side won, in roll order. The flier draws the two in this order so it
    // does not give the answer away by always putting the winner on the left.
    // Local only, not in the chat payload.
    keptIndex = isAKept ? 0 : 1;
  }

  const roll = {
    id: ++rollSeq,
    label: label || _formatRollFormula({ pool: groups, mod: 0 }),
    faces, count, pool: groups, mod, mode, dice, dropped, keptIndex, parts,
    // What the roll was for, where something is waiting on the answer
    // (initiative). Not in the chat payload.
    kind,
    total: _getPoolTotal(dice) + mod,
  };

  _showOwnRoll(roll);          // the middle of the screen, then the corner
  _postRollToChat(roll);       // and the table, when there is one
  noteRollForInitiative(roll); // a no-op away from a battle map
  return roll;
}

// A natural 20 or a natural 1, and only on a single d20. Read off the kept die.
function getRollCritClass(r) {
  const groups = _getRollGroups(r);
  if (groups.length !== 1 || groups[0].faces !== 20 || groups[0].count !== 1) return '';
  if (r.dice[0] === 20) return 'crit';
  if (r.dice[0] === 1)  return 'fumble';
  return '';
}

// ─── HOW A ROLL READS  ("14 Arcana" — number first, label second) ───


function _getRollModeLabel(r)  { return ROLL_MODES[r.mode]?.label ?? ''; }
function _getRollModeShortLabel(r) { return ROLL_MODES[r.mode]?.short ?? ''; }

function _formatSigned(n) { return (n >= 0 ? '+' : '−') + Math.abs(n); }

// " + 3" / " − 2" / "": the trailing half of a formula.
function _formatModSuffix(mod) {
  return mod ? ' ' + (mod > 0 ? '+' : '−') + ' ' + Math.abs(mod) : '';
}

// "1d20 + 2d6 + 3": what was asked for, with nothing of the answer in it.
function _formatRollFormula(r) {
  return _getRollGroups(r).map(g => g.count + 'd' + g.faces).join(' + ') + _formatModSuffix(r.mod);
}

// "1d20 (9) + 2d6 (3, 5) + 3": what was on the dice, plus whatever advantage
// discarded.
function _formatRollBreakdown(r) {
  const dropped = _getRollDiceList(r, 'dropped');
  const dice = _getRollDiceList(r);
  let at = 0;
  let text = _getRollGroups(r).map(g => {
    const vals = dice.slice(at, at + g.count);
    at += g.count;
    return g.count + 'd' + g.faces + ' (' + vals.join(', ') + ')';
  }).join(' + ') + _formatModSuffix(r.mod);
  if (dropped.length) {
    text += ' · dropped ' + (dropped.length > 1
      ? dropped.join(', ') + ' = ' + _getPoolTotal(dropped)
      : dropped[0]);
  }
  return text;
}

// The line under the number. Shared by the flier and the chat card.
function formatRollDetailLine(r) {
  const bits = [];
  const crit = getRollCritClass(r);
  if (crit === 'crit')   bits.push('Natural 20');
  if (crit === 'fumble') bits.push('Natural 1');
  const mode = _getRollModeLabel(r);
  if (mode) bits.push(mode);
  bits.push(_formatRollBreakdown(r));
  return bits.join(' · ');
}

// The two whole totals an advantage roll produced, in roll order, as the flier
// shows them side by side.
function _getRollPairTotals(r) {
  const other = _getPoolTotal(_getRollDiceList(r, 'dropped')) + r.mod;
  return r.keptIndex === 1 ? [other, r.total] : [r.total, other];
}

// Whether this roll is drawn as two numbers (a mode with something discarded).
function _isRollPaired(r) {
  return !!ROLL_MODES[r.mode] && _getRollDiceList(r, 'dropped').length > 0;
}

// The plain-text form, stamped on the chat message as its `text` for any client
// that does not know what a roll is. The renderer never reads it.
function _formatRollSentence(r) {
  return '🎲 ' + r.total + ' ' + r.label + ' · ' + formatRollDetailLine(r);
}

// The Adv / Dis tag, one builder for every surface that draws a roll. `isLong`
// spells it out for the flier, which has the room. Returns null for a straight roll.
function buildRollModePill(r, isLong) {
  if (!ROLL_MODES[r.mode]) return null;
  const el = document.createElement('span');
  el.className = 'roll-mode-pill ' + r.mode;
  el.textContent = isLong ? _getRollModeLabel(r) : _getRollModeShortLabel(r);
  return el;
}

// ─── 1 · THE MIDDLE OF THE SCREEN, THEN THE CORNER ───

// The chip is put into the corner first and held invisible; the flier is then
// aimed at where it actually landed. Measuring the real destination is the only
// way the flight ends exactly on it.
function _showOwnRoll(roll) {
  rollHistory.push(roll);
  if (rollHistory.length > ROLL_HISTORY_LIMIT) rollHistory.shift();
  _renderRollHistory(roll.id); // draws the newest chip, but holds it invisible
  _flyRoll(roll);
}

function _renderRollHistory(landingId) {
  if (!diceHistoryEl) return;
  _hideRollDetail(); // the chip it was describing is about to be thrown away
  diceHistoryEl.textContent = '';
  diceHistoryEl.classList.toggle('hidden', rollHistory.length === 0);

  const newest = rollHistory.length - 1;
  rollHistory.forEach((r, i) => {
    const chip = document.createElement('div');
    // Age, not index: how far each chip fades back is the CSS's business.
    chip.className = 'roll-chip age-' + (newest - i);
    const crit = getRollCritClass(r);
    if (crit) chip.classList.add(crit);
    if (r.id === landingId) chip.classList.add('landing');
    chip.dataset.rollId = r.id;

    const total = document.createElement('span');
    total.className = 'roll-chip-total';
    total.textContent = r.total;

    const label = document.createElement('span');
    label.className = 'roll-chip-label';
    label.textContent = r.label;

    chip.append(total, label);
    // No `title`: hovering opens the full working (_showRollDetail()).
    const pill = buildRollModePill(r);
    if (pill) chip.appendChild(pill);
    diceHistoryEl.appendChild(chip);
  });
}

// Built at rest (`translate(-50%, -50%)` only), so the entrance tumble lives on
// the inner element and the flier's own transform stays free for the flight and
// its bounding box truthful when the flight is measured. The wash behind the
// number is the flier's `::before`, not the inner one's: it travels to the
// corner with the number but must not tumble with it.
function _flyRoll(roll) {
  if (!diceStageEl) return;

  // A second roll supersedes one still in the air; the older one has a chip
  // waiting for it either way.
  [...diceStageEl.children].forEach(_finishFlierNow);

  const isPaired = _isRollPaired(roll);

  const flier = document.createElement('div');
  flier.className = 'roll-flier spinning' + (isPaired ? ' paired' : '');
  // The crit class does nothing until `.settled`: a number that turns green as
  // it appears has given the answer away in the first frame.
  const crit = getRollCritClass(roll);
  if (crit) flier.classList.add(crit);

  const inner = document.createElement('div');
  inner.className = 'roll-flier-inner';

  const totals = document.createElement('div');
  totals.className = 'roll-flier-totals';
  // Each number gets the widest box this roll could ever need, up front; a box
  // that grew with the digit count would shove its neighbour on every tick.
  const width = _getTotalBoxWidth(roll);
  const nums = (isPaired ? [0, 1] : [0]).map(() => {
    const n = document.createElement('div');
    n.className = 'roll-flier-total';
    n.style.width = width + 'ch';
    n.textContent = _rollFakeTotal(roll);
    totals.appendChild(n);
    return n;
  });

  const label = document.createElement('div');
  label.className = 'roll-flier-label';
  label.textContent = roll.label;
  const pill = buildRollModePill(roll, true);
  if (pill) label.appendChild(pill);

  const detail = document.createElement('div');
  detail.className = 'roll-flier-detail';
  detail.textContent = formatRollDetailLine(roll);

  inner.append(totals, label, detail);
  flier.appendChild(inner);
  flier.__rollId = roll.id;
  diceStageEl.appendChild(flier);
  diceStageEl.classList.remove('hidden');

  _spinFlier(flier, totals, nums, roll, isPaired);
}

// Box width in `ch` (one digit, with tabular figures), from the extremes the
// pool can reach rather than the number in hand. Fixed, not a minimum, so a
// non-tabular font overruns evenly either side of centred text. The sign gets a
// fraction of a digit.
function _getTotalBoxWidth(r) {
  const groups = _getRollGroups(r);
  const hi = groups.reduce((n, g) => n + g.count * g.faces, 0) + r.mod;
  const lo = groups.reduce((n, g) => n + g.count, 0) + r.mod;
  const digits = n => String(Math.abs(n)).length;
  return Math.max(digits(hi), digits(lo)) + (lo < 0 || hi < 0 ? 0.6 : 0);
}

// A plausible number to tumble past: the same pool, rolled again, so a
// 3d6 + 2 never flashes a value it could not produce.
function _rollFakeTotal(roll) {
  return _getPoolTotal(_getRollGroupsDice(_getRollGroups(roll))) + roll.mod;
}

// The tumble. Numbers arrive fast then further apart (eased on t²). A setTimeout
// chain, not rAF: a background tab stops rAF entirely, and a roll thrown in one
// must still land; throttled timers only make the tumble slower and coarser.
function _spinFlier(flier, totalsEl, nums, roll, isPaired) {
  const whole = ROLL_SPIN_MIN_MS + Math.random() * (ROLL_SPIN_MAX_MS - ROLL_SPIN_MIN_MS);
  const beats = isPaired ? ROLL_PAIR_HOLD_MS + ROLL_RESOLVE_MS : ROLL_SETTLE_MS;
  const spinMs = Math.max(ROLL_SPIN_MIN_FLOOR_MS, whole - beats);
  const start = performance.now();
  let timer = null;

  const tick = () => {
    const t = Math.min(1, (performance.now() - start) / spinMs);
    if (t >= 1) { lock(); return; }
    // Both sides tumble independently: they are two separate dice.
    nums.forEach(n => { n.textContent = _rollFakeTotal(roll); });
    timer = setTimeout(tick, ROLL_TICK_FAST_MS + (ROLL_TICK_SLOW_MS - ROLL_TICK_FAST_MS) * t * t);
  };

  // Both dice have stopped. For a straight roll that is the answer; for advantage
  // the two numbers now stand side by side, undecided, for ROLL_PAIR_HOLD_MS.
  const lock = () => {
    const finals = isPaired ? _getRollPairTotals(roll) : [roll.total];
    nums.forEach((n, i) => { n.textContent = finals[i]; });
    flier.classList.remove('spinning');
    flier.classList.add('locked');
    timer = isPaired
      ? setTimeout(resolve, ROLL_PAIR_HOLD_MS)
      : setTimeout(settle, 0);
  };

  // The loser greys and shrinks where it stands; the winner slides to the middle.
  const resolve = () => {
    const loser = nums[roll.keptIndex === 0 ? 1 : 0];
    const winner = nums[roll.keptIndex];
    loser.classList.add('dropped');
    _centreWinner(totalsEl, winner);
    // A roll thrown in the first moment of a page view measures in the fallback
    // font; digit widths differ enough to leave the winner off centre. Re-run
    // once the display face lands.
    if (document.fonts && document.fonts.status !== 'loaded') {
      document.fonts.ready.then(() => _centreWinner(totalsEl, winner));
    }
    settle();
  };

  // The answer is final. Only now does the detail line appear and a crit get its
  // colour: both name the answer, so showing them earlier gives it away.
  const settle = () => {
    flier.classList.add('settled');
    timer = setTimeout(() => _landRoll(flier, roll), isPaired ? ROLL_RESOLVE_MS : ROLL_SETTLE_MS);
  };

  // "Stop what you are doing", held on the element so the next roll can reach it.
  flier.__finishNow = () => clearTimeout(timer);

  tick();
}

// Slides the surviving number to the middle of the row, by transform alone so
// the row never reflows. `offsetLeft`/`offsetWidth`, NOT `getBoundingClientRect()`:
// the rect is the transformed one and these elements sit under the entrance
// tumble which scales the block. Offsets are layout values, relative to
// `.roll-flier` (the nearest positioned ancestor). Transform is cleared first so
// this is safe to run twice.
function _centreWinner(totalsEl, winner) {
  winner.style.transform = '';
  const rowCentre = totalsEl.offsetLeft + totalsEl.offsetWidth / 2;
  const winCentre = winner.offsetLeft + winner.offsetWidth / 2;
  winner.style.transform = 'translateX(' + (rowCentre - winCentre) + 'px)';
}

// A new roll supersedes one still in the air: no flight, no fade.
function _finishFlierNow(flier) {
  flier.__finishNow?.();
  const id = flier.__rollId;
  flier.remove();
  if (id !== undefined) _revealRollChip(id);
  if (!diceStageEl.childElementCount) diceStageEl.classList.add('hidden');
}

function _revealRollChip(rollId) {
  diceHistoryEl
    ?.querySelector('.roll-chip[data-roll-id="' + rollId + '"]')
    ?.classList.remove('landing');
}

// Both rectangles read in the same frame, before anything is written.
function _landRoll(flier, roll) {
  const chip = diceHistoryEl
    ? diceHistoryEl.querySelector('.roll-chip[data-roll-id="' + roll.id + '"]')
    : null;
  const from = flier.getBoundingClientRect();
  const to   = chip ? chip.getBoundingClientRect() : null;

  const finish = () => {
    flier.remove();
    // The chip is revealed by the same call that removes the flier.
    if (chip) chip.classList.remove('landing');
    if (!diceStageEl.childElementCount) diceStageEl.classList.add('hidden');
  };

  // No destination (corner behind the home page, history reset mid-flight):
  // fade out where it stands.
  if (!to || !to.width || !from.height) {
    flier.classList.add('gone');
    setTimeout(finish, 280);
    return;
  }

  const dx = (to.left + to.width  / 2) - (from.left + from.width  / 2);
  const dy = (to.top  + to.height / 2) - (from.top  + from.height / 2);
  // Scaled by height: the chip is far wider than tall relative to the flier.
  const scale = Math.max(0.08, to.height / from.height);

  flier.classList.add('flying');
  flier.style.transitionDuration = ROLL_FLIGHT_MS + 'ms';
  flier.style.transform = 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px)) scale(' + scale + ')';
  flier.style.opacity = '0.2';

  // `transitionend` fires per property and not at all in a background tab, so
  // the timeout is the one that counts.
  let isDone = false;
  const once = () => { if (isDone) return; isDone = true; finish(); };
  flier.addEventListener('transitionend', once, { once: true });
  setTimeout(once, ROLL_FLIGHT_MS + 120);
}

// ─── 2 · THE CHAT LOG ───

// Pushed from here rather than chat.js so a roll's shape stays in one file.
// `canChat()` is the same gate an ordinary line goes through, so a solo /
// signed-out / campaign-less roll falls through it silently.
function _postRollToChat(r) {
  if (typeof canChat !== 'function' || !canChat()) return;

  pinChatToNewest(); // saying something is an intent to watch it land

  firebaseDb.ref('parties/' + state.party.code + '/chat').push({
    uid: getOwnPlayerId(),
    name: getChatAuthorName(),
    kind: 'roll',
    text: _formatRollSentence(r),
    // Flat and complete: the renderer at the other end works only from this.
    // `parts` is deliberately not sent; it is for the roller's hover card only.
    // `pool` only for a mixed handful, so an older client reads `faces`/`count`
    // (the first group) and still has `text` to fall back on.
    roll: {
      label: r.label, total: r.total, mode: r.mode,
      faces: r.faces, count: r.count, mod: r.mod,
      ...(r.pool && r.pool.length > 1 ? { pool: r.pool } : {}),
      dice: r.dice, dropped: r.dropped,
    },
    at: firebase.database.ServerValue.TIMESTAMP,
  }).catch(() => { /* a roll that could not be said is still a roll */ });
}

// RTDB returns an array when keys are 0…n, an object otherwise, and nothing at
// all when empty (which `dropped` is on every ordinary roll).
function _getRollDiceList(roll, key) {
  const values = roll ? roll[key ?? 'dice'] : null;
  return Array.isArray(values) ? values : Object.values(values ?? {});
}

// Rebuilds a roll from a chat message, so remote and local rolls share every
// formatter above.
function buildRollFromMessage(m) {
  const r = m.roll ?? {};
  return {
    label: r.label || 'Roll',
    total: Number(r.total) || 0,
    faces: Number(r.faces) || 20,
    count: Number(r.count) || 1,
    mod:   Number(r.mod)   || 0,
    pool:  r.pool ? _getRollGroups(r) : null,
    mode:  ROLL_MODES[r.mode] ? r.mode : 'normal',
    dice:    _getRollDiceList(r),
    dropped: _getRollDiceList(r, 'dropped'),
    parts: [],
  };
}

// ─── 3 · SPEECH BUBBLES OVER THE TABS ───

// A fixed layer, not children of the tabs: `#character-tabs` scrolls sideways
// and clips overflow, so a bubble hanging below a tab would be sliced off.
// One bubble per tab: whatever that player said or rolled last replaces the one
// before it.
const tabBubbles = new Map(); // tab key → { text } | { roll fields }, + { at, ms, timer }

// null until the first chat snapshot. Joining delivers the whole tail at once
// and every line in it is history; a bubble per line would be a wall of them.
let seenBubbleIds = null;

// Every new chat line pops a bubble over its speaker's tab, a roll included.
function noteBubbleFeed(messages) {
  const isFirstSnapshot = seenBubbleIds === null;
  if (isFirstSnapshot) seenBubbleIds = new Set();
  const me = getOwnPlayerId();

  messages.forEach(m => {
    if (seenBubbleIds.has(m.id)) return;
    seenBubbleIds.add(m.id);
    if (isFirstSnapshot) return; // the backlog is not news
    const isRoll = m.kind === 'roll' && !!m.roll;
    // Our own roll lands in the corner, and it is posted as the tumble starts,
    // so a bubble would give the number away before it lands.
    if (isRoll && m.uid === me) return;
    // Our own tab is keyed OWN_TAB, not by account id.
    const key = m.uid === me ? OWN_TAB : m.uid;
    if (isRoll) _popTabBubble(key, _getRollBubbleFields(buildRollFromMessage(m)));
    else {
      const text = _getTabBubbleText(m.text);
      if (text) _popTabBubble(key, { text });
    }
  });
}

// Called when the log is torn down, or the next campaign's tail reads as live.
function resetBubbleFeed() {
  seenBubbleIds = null;
  tabBubbles.forEach(b => clearTimeout(b.timer));
  tabBubbles.clear();
  renderTabBubbles();
}

function _getRollBubbleFields(roll) {
  return { total: roll.total, label: roll.label, crit: getRollCritClass(roll), mode: roll.mode };
}

// One line of the message, cut at a word near the cap. Newlines fold to spaces:
// a bubble is a glance, not a transcript.
function _getTabBubbleText(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= TAB_BUBBLE_MAX_CHARS) return text;
  const cut = text.slice(0, TAB_BUBBLE_MAX_CHARS);
  const space = cut.lastIndexOf(' ');
  // Back to a word break unless that would throw away most of the line.
  return (space > TAB_BUBBLE_MAX_CHARS * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '') + '…';
}

// Scaled by what the bubble actually shows; a cut-short line has already said
// all it is going to.
function _getTabBubbleDuration(b) {
  const chars = b.text !== undefined ? b.text.length : String(b.total).length + String(b.label).length;
  return Math.max(TAB_BUBBLE_MIN_MS,
    Math.min(TAB_BUBBLE_MAX_MS, TAB_BUBBLE_MIN_MS + chars * TAB_BUBBLE_MS_PER_CHAR));
}

function _popTabBubble(key, fields) {
  // Keyed by tab. A line from someone not on the strip (a GM, a departed
  // player) has nothing to point at and renderTabBubbles() drops it.
  const existing = tabBubbles.get(key);
  if (existing) clearTimeout(existing.timer);

  const ms = _getTabBubbleDuration(fields);
  tabBubbles.set(key, {
    ...fields,
    ms,
    at: Date.now(), // so a redraw resumes the bubble at its real age
    timer: setTimeout(() => { tabBubbles.delete(key); renderTabBubbles(); }, ms),
  });
  renderTabBubbles();
}

// Draws a bubble under each tab that has one. Rebuilt from the tabs each time:
// `renderCharacterTabs()` throws its buttons away and calls this at its end.
function renderTabBubbles() {
  if (!diceBubbleEl) return;
  diceBubbleEl.textContent = '';
  if (!tabBubbles.size || !charTabsEl) return;

  tabBubbles.forEach((b, key) => {
    const tab = charTabsEl.querySelector('.char-tab[data-tab-key="' + CSS.escape(key) + '"]');
    if (!tab) return;
    const tabRect = tab.getBoundingClientRect();
    if (!tabRect.width) return; // the strip is hidden: nothing to point at

    const bubble = document.createElement('div');

    if (b.text !== undefined) {
      // textContent, never innerHTML: another player's typing, same as the log.
      bubble.className = 'tab-bubble speech';
      bubble.textContent = b.text;
    } else {
      bubble.className = 'tab-bubble' + (b.crit ? ' ' + b.crit : '');

      const total = document.createElement('span');
      total.className = 'tab-bubble-total';
      total.textContent = b.total;

      const label = document.createElement('span');
      label.className = 'tab-bubble-label';
      label.textContent = b.label;

      bubble.append(total, label);
      const pill = buildRollModePill(b);
      if (pill) bubble.appendChild(pill);
    }
    diceBubbleEl.appendChild(bubble);

    // Measured after the text is in, and clamped so the rightmost tab's bubble
    // cannot hang off the window.
    const w = bubble.offsetWidth;
    const clamped = Math.max(6, Math.min(tabRect.left + tabRect.width / 2 - w / 2, window.innerWidth - w - 6));
    bubble.style.left = clamped + 'px';
    bubble.style.top  = (tabRect.bottom + 8) + 'px';
    // The tail points at the middle of the tab even when the clamp shifted the
    // bubble sideways.
    bubble.style.setProperty('--tail-x',
      Math.max(10, Math.min(tabRect.left + tabRect.width / 2 - clamped, w - 10)) + 'px');

    // Rebuilt on every roster update, so start each animation at the age the
    // bubble has actually reached: a negative delay runs the entrance forward,
    // the fade is delayed by what is left. Otherwise a heartbeat mid-life
    // replays the pop and resets the countdown to leave.
    const age = Date.now() - b.at;
    bubble.style.animationDelay =
      (-age) + 'ms, ' + Math.max(0, b.ms - TAB_BUBBLE_FADE_MS - age) + 'ms';
  });
}

// The strip scrolls and the window resizes; either moves a tab out from under
// its bubble.
window.addEventListener('resize', () => { if (tabBubbles.size) renderTabBubbles(); });
charTabsEl.addEventListener('scroll', () => { if (tabBubbles.size) renderTabBubbles(); });

// ─── 4 · THE WORKING, ON HOVER ───

// Hovering a corner chip opens the whole roll: every die face, the discarded
// pool, and each score and proficiency behind the modifier as its own raw
// number. `parts` is collected at roll time because the sheet moves.
function _showRollDetail(chip) {
  const roll = rollHistory.find(r => String(r.id) === chip.dataset.rollId);
  if (!roll || !rollDetailEl) return;

  rollDetailEl.textContent = '';

  const head = document.createElement('div');
  head.className = 'roll-detail-head';
  const name = document.createElement('span');
  name.className = 'roll-detail-name';
  name.textContent = roll.label;
  head.appendChild(name);
  const pill = buildRollModePill(roll);
  if (pill) head.appendChild(pill);
  rollDetailEl.appendChild(head);

  // Each die on its own line, kept ones first; a dropped pool struck through.
  const dice = document.createElement('div');
  dice.className = 'roll-detail-group';
  const facesOf = _getGroupFacesList(_getRollGroups(roll));
  _getRollDiceList(roll).forEach((v, i) => dice.appendChild(
    _buildRollDetailRow('d' + facesOf[i], '', String(v), _getRollDieRowClass(facesOf[i], v))));
  _getRollDiceList(roll, 'dropped').forEach((v, i) => dice.appendChild(
    _buildRollDetailRow('d' + facesOf[i], roll.mode === 'adv' ? 'lower' : 'higher',
                  String(v), 'dropped')));
  rollDetailEl.appendChild(dice);

  // Where the modifier came from. An empty `parts` has no group at all.
  const parts = (roll.parts ?? []).filter(p => p);
  if (parts.length) {
    const box = document.createElement('div');
    box.className = 'roll-detail-group';
    parts.forEach(p => box.appendChild(
      _buildRollDetailRow(p.label, p.note ?? '', _formatSigned(p.value))));
    rollDetailEl.appendChild(box);
  }

  const foot = document.createElement('div');
  foot.className = 'roll-detail-group total';
  foot.appendChild(_buildRollDetailRow('Total', _formatRollFormula(roll), String(roll.total)));
  rollDetailEl.appendChild(foot);

  rollDetailEl.classList.remove('hidden');
  _positionRollDetail(chip);
}

// Marks a natural 20 / 1 on the die itself; with several dice, the only way to
// see which one it was.
function _getRollDieRowClass(faces, value) {
  if (faces !== 20) return '';
  if (value === 20) return 'crit';
  if (value === 1)  return 'fumble';
  return '';
}

function _buildRollDetailRow(label, note, value, cls) {
  const row = document.createElement('div');
  row.className = 'roll-detail-row' + (cls ? ' ' + cls : '');

  const labelEl = document.createElement('span');
  labelEl.className = 'roll-detail-label';
  labelEl.textContent = label;

  const noteEl = document.createElement('span');
  noteEl.className = 'roll-detail-note';
  noteEl.textContent = note;

  const valueEl = document.createElement('span');
  valueEl.className = 'roll-detail-value';
  valueEl.textContent = value;

  row.append(labelEl, noteEl, valueEl);
  return row;
}

// To the left of the chip and bottom-aligned with it: the stack is in the
// bottom-right corner, so there is room on one side only. Clamped to the window.
function _positionRollDetail(chip) {
  const chipRect = chip.getBoundingClientRect();
  const cardRect = rollDetailEl.getBoundingClientRect(); // measurable now it is shown
  const left = Math.max(8, Math.min(chipRect.left - cardRect.width - 10, window.innerWidth - cardRect.width - 8));
  const top  = Math.max(8, Math.min(chipRect.bottom - cardRect.height, window.innerHeight - cardRect.height - 8));
  rollDetailEl.style.left = left + 'px';
  rollDetailEl.style.top  = top + 'px';
}

function _hideRollDetail() {
  if (!rollDetailEl) return;
  rollDetailEl.classList.add('hidden');
  rollDetailEl.textContent = '';
}

registerEscapeLayer(ESCAPE_TIER.POPUP,
  () => !!rollDetailEl && !rollDetailEl.classList.contains('hidden'), _hideRollDetail);

// Delegated (the chips are rebuilt on every roll). `pointerover`, not
// `mouseenter`, so moving between two chips swaps the card.
diceHistoryEl.addEventListener('pointerover', e => {
  const chip = e.target.closest('.roll-chip');
  if (chip) _showRollDetail(chip);
});
diceHistoryEl.addEventListener('pointerleave', _hideRollDetail);

// ─── ADVANTAGE AND DISADVANTAGE — the press-and-hold wheel ───

// Press and hold a modifier or a die, slide onto one of the two options and let
// go. Letting go in the middle rolls straight, so the gesture costs an ordinary
// click nothing. Disadvantage left, advantage right.

// The live gesture, or null. One at a time: a second pointerdown cancels the first.
let rollGesture = null;

// When a roll was last made by the pointer flow, so the `click` that follows can
// be ignored. Keyboard clicks (Enter/Space) have no pointer sequence and are the
// only ones let through, which keeps every roll target keyboard-reachable.
let lastPointerRollAt = 0;

// Starts a press-and-hold on a roll target. `spec` is called again at release,
// so the roll uses the modifier shown at that moment.
function beginRollGesture(e, el, spec) {
  if (e.button !== 0) return;
  _finishRollGesture(false);
  if (!spec()) return; // nothing to roll: an unknown key, or a stale target

  rollGesture = {
    spec, el, mode: 'normal', shown: false,
    x0: e.clientX, y0: e.clientY, pointerId: e.pointerId,
    timer: setTimeout(_openRollWheel, WHEEL_HOLD_MS),
  };
  // Captured so the pointer can leave the button without the gesture ending.
  try { el.setPointerCapture(e.pointerId); } catch (_) { /* no capture, still works */ }
}

// Opens on the cursor, nudged only as far as needed to stay on screen; every
// pixel of nudge is a lie about where the hub is, which is why the options are
// small and the caption under the hub spells the abbreviations out.
function _openRollWheel() {
  if (!rollGesture || rollGesture.shown) return;
  rollGesture.shown = true;

  // Reach read from the CSS that draws the wheel, the one source of truth.
  const cs = getComputedStyle(rollWheelEl);
  const reachX = parseFloat(cs.getPropertyValue('--wheel-gap')) +
                 parseFloat(cs.getPropertyValue('--wheel-w'));
  const reachY = parseFloat(cs.getPropertyValue('--wheel-h')) / 2;
  const pad = 6;

  rollWheelEl.style.setProperty('--wx',
    Math.max(reachX + pad, Math.min(rollGesture.x0, window.innerWidth - reachX - pad)) + 'px');
  rollWheelEl.style.setProperty('--wy',
    Math.max(reachY + pad, Math.min(rollGesture.y0, window.innerHeight - reachY - pad)) + 'px');

  rollWheelEl.classList.remove('hidden');
  _paintRollWheel();
}

function _paintRollWheel() {
  const mode = rollGesture?.mode ?? 'normal';
  rollWheelEl.querySelectorAll('.roll-wheel-opt').forEach(o => {
    o.classList.toggle('active', o.dataset.mode === mode);
  });
  rollWheelEl.classList.toggle('picked', mode !== 'normal');
  // Letting go in the middle is a real choice, named as plainly as the others.
  rollWheelEl.querySelector('.roll-wheel-caption').textContent =
    ROLL_MODES[mode]?.label ?? 'Straight roll';
}

// `roll` is false for the ways a gesture ends without one (Escape, cancel, a
// fresh press on top). `lastPointerRollAt` is stamped either way, since the
// browser still delivers a `click` after a backed-out press.
function _finishRollGesture(shouldRoll) {
  const g = rollGesture;
  if (!g) return;
  rollGesture = null;

  clearTimeout(g.timer);
  rollWheelEl.classList.add('hidden');
  rollWheelEl.classList.remove('picked');
  try { g.el.releasePointerCapture(g.pointerId); } catch (_) { /* never captured */ }

  lastPointerRollAt = Date.now();
  // The spec is read now, so a roll uses the modifier the sheet is showing at
  // the moment it is let go.
  if (shouldRoll) _rollSpecNow(g.spec(), g.mode);
}

// `onRoll` is the spec's own follow-up (the dice dock emptying its handful).
function _rollSpecNow(spec, mode) {
  if (!spec) return;
  if (performRoll({ ...spec, mode }) && spec.onRoll) spec.onRoll();
}

window.addEventListener('pointermove', e => {
  if (!rollGesture) return;
  const dx = e.clientX - rollGesture.x0;
  const dy = e.clientY - rollGesture.y0;
  if (!rollGesture.shown && Math.hypot(dx, dy) > WHEEL_REACH) _openRollWheel();
  if (!rollGesture.shown) return;
  rollGesture.mode = Math.abs(dx) < WHEEL_DEADZONE ? 'normal' : (dx < 0 ? 'dis' : 'adv');
  _paintRollWheel();
});

window.addEventListener('pointerup',     () => _finishRollGesture(true));
window.addEventListener('pointercancel', () => _finishRollGesture(false));
registerEscapeLayer(ESCAPE_TIER.GESTURE, () => !!rollGesture, () => _finishRollGesture(false));

// Rolls straight on a click: the keyboard's way in, and the fallback for a
// pointer sequence that produced no roll of its own.
function rollFromClick(spec) {
  if (Date.now() - lastPointerRollAt < 400) return;
  _rollSpecNow(spec(), 'normal');
}

// ─── ROLLING FROM THE CHARACTER SHEET ───

// Returns the roll spec for a sheet target's `data-roll` key; this is the only
// reader. The modifier is asked of the sheet at the moment of the gesture, never
// stored on the element. `parts` is the same answer taken apart, for the hover detail.
function getSheetRollSpec(key) {
  const [kind, id] = key.split(':');
  const pb = getProficiencyBonus();
  const ability = a => ({
    label: ABILITIES.find(x => x.id === a).label,
    value: getAbilityModifier(a),
    note: 'score ' + getAbilityScore(a),
  });

  if (kind === 'skill') {
    const s = SKILLS.find(x => x.id === id);
    if (!s) return null;
    const level = getSkillProficiency(s.id);
    return {
      label: s.label, faces: 20, count: 1, mod: getSkillModifier(s),
      parts: [
        ability(s.ability),
        level ? { label: level === PROF_EXPERTISE ? 'Expertise' : 'Proficiency', value: pb * level } : null,
      ].filter(Boolean),
    };
  }
  if (kind === 'save') {
    const a = ABILITIES.find(x => x.id === id);
    if (!a) return null;
    return {
      label: a.label + ' Save', faces: 20, count: 1, mod: getSaveModifier(id),
      parts: [
        ability(id),
        hasSaveProficiency(id) ? { label: 'Proficiency', value: pb } : null,
      ].filter(Boolean),
    };
  }
  if (kind === 'ability') {
    const a = ABILITIES.find(x => x.id === id);
    if (!a) return null;
    return { label: a.label + ' Check', faces: 20, count: 1, mod: getAbilityModifier(id), parts: [ability(id)] };
  }
  if (kind === 'initiative') {
    // On a battle map this is also what puts the character into the turn order.
    return { label: 'Initiative', faces: 20, count: 1, mod: getInitiativeBonus(), parts: [ability('dex')], kind: 'initiative' };
  }
  return null;
}

// One delegated pair for the whole sheet. Deliberately NOT gated by
// `isReadOnly()`: rolling writes nothing, and the roll is attributed to the
// account that clicked, so a GM rolling a player's Perception is honest.
const sheetRollEl = document.getElementById('character-sheet');

sheetRollEl.addEventListener('pointerdown', e => {
  const el = e.target.closest('[data-roll]');
  if (el) beginRollGesture(e, el, () => getSheetRollSpec(el.dataset.roll));
});

sheetRollEl.addEventListener('click', e => {
  const el = e.target.closest('[data-roll]');
  if (el) rollFromClick(() => getSheetRollSpec(el.dataset.roll));
});

// ─── THE DICE DOCK ───

// The button in the top right of the middle of the app, and the column of faces
// it opens. Each click on a face adds one of that die to the handful (a
// right-click takes one back); Roll throws the lot plus the modifier, and is
// the one held-press target here, so a whole handful can be rolled with
// advantage. The handful is session-only and emptied by the roll that uses it.

const diceDockEl      = document.getElementById('dice-dock');
const diceDockBtn     = document.getElementById('dice-dock-btn');
const diceDockPanel   = document.getElementById('dice-dock-panel');
const diceDockFaces   = document.getElementById('dice-dock-faces');
const diceDockRollBtn = document.getElementById('dice-dock-roll');
const diceDockModEl   = document.getElementById('dice-dock-mod-input');

// faces → how many of that die are in the handful.
const dockPool = new Map();

function _getDockMod() {
  return Math.max(-DOCK_MOD_LIMIT, Math.min(DOCK_MOD_LIMIT, parseInt(diceDockModEl.value, 10) || 0));
}

function _getDockPoolGroups() {
  return [...dockPool].map(([faces, count]) => ({ faces, count }));
}

// Read at the moment the Roll button is let go, like every other roll spec.
function _getDockRollSpec() {
  const pool = _normalizeDicePool(_getDockPoolGroups());
  if (!pool.length) return null;
  const mod = _getDockMod();
  return {
    // No label but the formula: a bare handful of dice is not about anything.
    label: _formatRollFormula({ pool, mod }),
    pool, mod,
    parts: mod ? [{ label: 'Modifier', value: mod }] : [],
    onRoll: _clearDock,
  };
}

function _buildDiceDock() {
  if (!diceDockFaces || diceDockFaces.childElementCount) return;

  DICE_FACES.forEach(faces => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'die-btn';
    btn.dataset.faces = faces;
    btn.title = 'Add a d' + faces + ' · right-click to take one back';

    const face = document.createElement('span');
    face.className = 'die-face';
    face.textContent = 'd' + faces;

    const count = document.createElement('span');
    count.className = 'die-count';

    btn.append(face, count);
    diceDockFaces.appendChild(btn);
  });
  _renderDiceDock();
}

// Counts on the faces, and the Roll button only once there is something to roll.
function _renderDiceDock() {
  diceDockFaces.querySelectorAll('.die-btn').forEach(btn => {
    const n = dockPool.get(Number(btn.dataset.faces)) || 0;
    btn.classList.toggle('picked', n > 0);
    btn.querySelector('.die-count').textContent = n > 1 ? n : '';
  });
  diceDockRollBtn.classList.toggle('hidden', !dockPool.size);
}

function _addDockDie(faces, delta) {
  const n = Math.max(0, Math.min(20, (dockPool.get(faces) || 0) + delta));
  if (n) dockPool.set(faces, n);
  else dockPool.delete(faces);
  _renderDiceDock();
}

function _stepDockMod(delta) {
  const n = Math.max(-DOCK_MOD_LIMIT, Math.min(DOCK_MOD_LIMIT, _getDockMod() + delta));
  diceDockModEl.value = n ? n : '';
}

function _clearDock() {
  dockPool.clear();
  diceDockModEl.value = '';
  _renderDiceDock();
}

// The column stays in the layout while closed so it can animate; `inert` keeps
// its faces out of the tab order and away from the pointer meanwhile.
function setDiceDockOpen(isOpen) {
  diceDockEl.classList.toggle('open', isOpen);
  diceDockPanel.inert = !isOpen;
  diceDockPanel.setAttribute('aria-hidden', String(!isOpen));
  diceDockBtn.setAttribute('aria-expanded', String(isOpen));
}

// Whether the dice dock's column of faces is showing.
function isDiceDockOpen() {
  return diceDockEl.classList.contains('open');
}

diceDockBtn.addEventListener('click', () => {
  const willOpen = !isDiceDockOpen();
  if (willOpen) closeShortRestTray(); // the two trays share the corner
  setDiceDockOpen(willOpen);
});

diceDockFaces.addEventListener('click', e => {
  const btn = e.target.closest('.die-btn');
  if (btn) _addDockDie(Number(btn.dataset.faces), 1);
});

diceDockFaces.addEventListener('contextmenu', e => {
  const btn = e.target.closest('.die-btn');
  if (!btn) return;
  e.preventDefault();
  _addDockDie(Number(btn.dataset.faces), -1);
});

diceDockRollBtn.addEventListener('pointerdown', e => beginRollGesture(e, diceDockRollBtn, _getDockRollSpec));
diceDockRollBtn.addEventListener('click', () => rollFromClick(_getDockRollSpec));

// A typed-in number past the limit is pulled back to it once the box is left.
diceDockModEl.addEventListener('change', () => _stepDockMod(0));
diceDockPanel.querySelectorAll('[data-mod-step]').forEach(b => {
  b.addEventListener('click', () => _stepDockMod(Number(b.dataset.modStep)));
});

// A click anywhere else folds the column away; the handful stays for next time.
// The rest buttons share #dice-dock, so it is the button and column that count.
document.addEventListener('pointerdown', e => {
  if (!isDiceDockOpen()) return;
  if (diceDockBtn.contains(e.target) || diceDockPanel.contains(e.target)) return;
  setDiceDockOpen(false);
});
// Below the roll gesture's tier, so an Escape backing out of a held Roll does
// not also fold the column.
registerEscapeLayer(ESCAPE_TIER.TRAY, isDiceDockOpen, () => setDiceDockOpen(false));

_buildDiceDock();
setDiceDockOpen(false);
