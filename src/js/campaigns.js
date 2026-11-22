// =============================================================================
// CAMPAIGNS — the table a character sits at, and the section that lists them
// =============================================================================
'use strict';

const CAMPAIGN_NAME_MAX = 40; // characters

const campaignGridEl = document.getElementById('campaign-card-grid');
const campaignNoteEl = document.getElementById('campaign-note');
const campaignMenuEl = document.getElementById('campaign-card-menu');

let openCampaignMenuCode = null;
let campaignModalMode = 'create'; // 'create' | 'join'

// A campaign is a persistent party: a roster keyed by account uid (not by a
// per-join session id), so it outlives every session in it. party.js is the live
// session under it. Two halves, neither a copy of the other:
//
//   parties/<code>/          in Firebase — the campaign. Shared, authoritative.
//     meta      { name, gmUid, gmName, createdAt }
//     gm        { name, uid, connected }
//     players   { [uid]: { name, uid, characterId, connected, character, … } }
//     shops     …
//
//   state.campaigns[code]    in the save file — this account's *bookmark*.
//     { code, name, role, characterId, gmName, memberCount, lastPlayed }
//
// The bookmark is only what the home screen needs before Firebase answers; it is
// refreshed from the party once connected, and nothing reads it to decide
// anything that matters (`_enterCampaign()` asks the party who its GM is). It
// rides the save payload, so it follows the account across browsers.

// ─── THE MODEL ───

function _normalizeCampaign(raw, code) {
  const c = raw ?? {};
  return {
    code: String(c.code ?? code ?? '').toUpperCase(),
    name: String(c.name ?? '').slice(0, CAMPAIGN_NAME_MAX),
    role: c.role === 'gm' ? 'gm' : 'player',
    // Which of your characters plays here. Null for a GM, and null for a bookmark
    // without the field until `_enterCampaign()` fills it in.
    characterId: c.characterId ?? null,
    gmName: String(c.gmName ?? ''),
    memberCount: Number.isFinite(c.memberCount) ? c.memberCount : 0,
    lastPlayed: Number.isFinite(c.lastPlayed) ? c.lastPlayed : 0,
    // The other members' campaign homebrew as last seen at the table — a cache
    // (homebrew-share.js), so a character keeps the party's homebrew class
    // between sessions. Their node is the truth whenever we are seated.
    sharedHomebrew: Array.isArray(c.sharedHomebrew) ? c.sharedHomebrew : [],
  };
}

// Cleans the saved `campaigns` map into bookmarks keyed by upper-case code.
function normalizeCampaigns(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  Object.entries(raw).forEach(([code, c]) => {
    const norm = _normalizeCampaign(c, code);
    if (norm.code) out[norm.code] = norm;
  });
  return out;
}

// Most recently played first — a table you left behind sinks on its own.
function getCampaignList() {
  return Object.values(state.campaigns).sort((a, b) => b.lastPlayed - a.lastPlayed);
}

// What to call a campaign in a sentence; the code stands in for a missing name.
function getCampaignDisplayName(code) {
  const c = state.campaigns[code];
  if (c && c.name) return c.name;
  if (state.party.code === code && state.party.campaignName) return state.party.campaignName;
  return 'campaign ' + code;
}

function _rememberCampaign(patch) {
  const code = String(patch.code ?? '').toUpperCase();
  if (!code) return;
  state.campaigns[code] = _normalizeCampaign({ ...state.campaigns[code], ...patch, code }, code);
  scheduleSaveAndSync();
  renderHomeScreen();
}

// Drops a campaign bookmark and saves.
function forgetCampaign(code) {
  if (!code || !state.campaigns[code]) return;
  delete state.campaigns[code];
  scheduleSaveAndSync();
  renderHomeScreen();
}

// Refreshes a bookmark's name and GM from the party's meta snapshot. Like
// noteCampaignRoster(), a no-op without a bookmark, and deliberately skips
// `scheduleSaveAndSync()`: a save per snapshot is too much writing for a cached label.
function noteCampaignMeta(code, meta) {
  const entry = state.campaigns[code];
  if (!entry || !meta) return;
  entry.name = String(meta.name ?? entry.name).slice(0, CAMPAIGN_NAME_MAX);
  entry.gmName = String(meta.gmName ?? entry.gmName);
  renderHomeScreen();
}

// Refreshes a bookmark's head count from a roster snapshot.
function noteCampaignRoster(code, players) {
  const entry = state.campaigns[code];
  if (!entry) return;
  entry.memberCount = Object.keys(players ?? {}).length;
  renderHomeScreen();
}

// A player switching characters while seated at a table changes which character
// sits in that seat. Called from `activateCharacter()`; the republish is handled
// by the `scheduleSaveAndSync()` there.
function noteActiveCharacterForCampaign() {
  const { active, code, role } = state.party;
  if (!active || role !== 'player' || !state.campaigns[code]) return;
  state.campaigns[code].characterId = state.activeCharacterId;
}

// ─── ENTERING AND LEAVING ───
// The one path in, from a card on the home screen. It asks the PARTY what role
// we hold (`meta.gmUid`) rather than trusting the bookmark — a GM signed in on a
// new browser must still land in the right chair.
async function _enterCampaign(code) {
  if (!isSignedIn()) {
    requireAuth('Campaigns need an account, so your table knows who is who.', () => _enterCampaign(code));
    return;
  }
  if (state.party.active) {
    if (state.party.code === code) { closeHomeScreen(); switchTab('party'); return; }
    if (!confirm('Leave ' + getCampaignDisplayName(state.party.code) + ' and go to ' +
                 getCampaignDisplayName(code) + '?')) return;
    leaveParty();
  }

  const meta = await fetchCampaignMeta(code);
  if (!meta) {
    if (confirm('Campaign ' + code + ' no longer exists.\n\nRemove it from your list?')) forgetCampaign(code);
    return;
  }

  const uid = getOwnPlayerId();
  const isGM = !!meta.gmUid && meta.gmUid === uid;

  // A player brings the character this campaign remembers — switching to them
  // BEFORE the join is what makes the roster entry right the first time.
  if (!isGM) {
    const wanted = state.campaigns[code]?.characterId;
    if (wanted && state.characters[wanted] && wanted !== state.activeCharacterId) activateCharacter(wanted);
  }

  const hasEntered = isGM
    ? await enterCampaignAsGM(code, meta)
    : await enterCampaignAsPlayer(code, getAccountDisplayName() || state.character.name || 'Player', meta);
  if (!hasEntered) return;

  _rememberCampaign({
    code,
    name: meta.name ?? '',
    role: isGM ? 'gm' : 'player',
    characterId: isGM ? null : state.activeCharacterId,
    gmName: meta.gmName ?? '',
    lastPlayed: Date.now(),
  });

  closeHomeScreen();
}

// Resigning the seat (as against ending the session). The roster entry goes.
// A GM's campaign is not theirs to resign from — with nobody running it the
// record is dead, so their version deletes it outright.
async function _leaveCampaign(code) {
  const entry = state.campaigns[code];
  if (!entry) return;
  const isGM = entry.role === 'gm';

  const warning = isGM
    ? 'Delete ' + getCampaignDisplayName(code) + '?\n\n' +
      'It is deleted for everyone: the roster, the shops and the code all go, and ' +
      'the players in it are dropped. Their own characters and inventories are ' +
      'untouched. This cannot be undone.'
    : 'Leave ' + getCampaignDisplayName(code) + '?\n\n' +
      'You give up your seat at this table. Your character and everything in your ' +
      'inventory stay yours — rejoining just needs the code again.';
  if (!confirm(warning)) return;

  if (state.party.active && state.party.code === code) leaveParty();

  if (firebaseDb) {
    const path = isGM ? 'parties/' + code : 'parties/' + code + '/players/' + getOwnPlayerId();
    try {
      await firebaseDb.ref(path).remove();
    } catch (e) {
      alert('Could not reach the campaign to leave it cleanly: ' + e.message +
            '\n\nIt has been taken off your list here.');
    }
  }

  forgetCampaign(code);
}

async function _renameCampaign(code, name) {
  const entry = state.campaigns[code];
  if (!entry || entry.role !== 'gm' || !firebaseDb) return;
  try {
    await firebaseDb.ref('parties/' + code + '/meta').update({ name });
  } catch (e) {
    alert('Could not rename the campaign: ' + e.message);
    return;
  }
  _rememberCampaign({ code, name });
}

// ─── THE HOME SCREEN SECTION ───

// Draws the campaign cards above the character roster on the home screen.
function renderCampaignSection() {
  if (state.screen !== 'home') return;

  // Signed out there is nothing to list. The buttons stay live — `requireAuth()`
  // is how every other gated entry point behaves, and a disabled button would
  // point the note at a door that cannot be opened.
  const isUserSignedIn = isSignedIn();
  campaignNoteEl.classList.toggle('hidden', isUserSignedIn);
  if (!isUserSignedIn) {
    campaignNoteEl.textContent = state.auth.ready
      ? 'Sign in to play in a campaign. Your characters are yours either way — an ' +
        'account is only what lets a table tell one player from another.'
      : 'Checking your account…';
  }

  campaignGridEl.innerHTML = '';
  const list = isUserSignedIn ? getCampaignList() : [];

  if (!list.length) {
    if (isUserSignedIn) {
      const empty = document.createElement('p');
      empty.className = 'home-empty';
      empty.textContent = 'No campaigns yet. Create one to run a table, or join one with its code.';
      campaignGridEl.appendChild(empty);
    }
    return;
  }

  list.forEach(c => campaignGridEl.appendChild(_createCampaignCard(c)));
}

function _createCampaignCard(c) {
  const isCurrent = state.party.active && state.party.code === c.code;
  const isGM = c.role === 'gm';

  const card = document.createElement('div');
  card.className = 'char-card campaign-card selectable' + (isCurrent ? ' active' : '');
  card.dataset.campaignCode = c.code;

  const menuBtn = document.createElement('button');
  menuBtn.className = 'char-card-menu-btn';
  menuBtn.title = 'Campaign options';
  menuBtn.setAttribute('aria-label', 'Campaign options');
  menuBtn.appendChild(createIconEl('dots'));
  menuBtn.addEventListener('click', e => {
    e.stopPropagation();
    _toggleCampaignMenu(c.code, menuBtn);
  });
  card.appendChild(menuBtn);

  const nameEl = document.createElement('div');
  nameEl.className = 'char-card-name';
  nameEl.textContent = c.name || c.code;
  card.appendChild(nameEl);

  const roleEl = document.createElement('div');
  roleEl.className = 'campaign-card-role ' + c.role;
  roleEl.textContent = isGM ? 'Game Master' : 'Player';
  card.appendChild(roleEl);

  // Every row is drawn whether filled or not — a row that vanished would shuffle
  // the others along (same as the sheet's identity block).
  const playing = isGM
    ? '—'
    : (state.characters[c.characterId]?.character.name ?? 'Not chosen yet');
  [['Code', c.code, 'campaign-code-row'],
   ['GM', isGM ? 'You' : (c.gmName || '—'), ''],
   ['Playing', playing, '']].forEach(([label, value, cls]) => {
    const row = document.createElement('div');
    row.className = 'char-card-row' + (cls ? ' ' + cls : '');
    const keyEl = document.createElement('span');
    keyEl.className = 'char-card-key';
    keyEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.className = 'char-card-val';
    valueEl.textContent = value;
    row.append(keyEl, valueEl);
    card.appendChild(row);
  });

  const foot = document.createElement('div');
  foot.className = 'char-card-foot';
  const memberCount = c.memberCount;
  foot.textContent = memberCount + ' player' + (memberCount === 1 ? '' : 's') +
                     (c.lastPlayed ? ' · ' + _describeLastPlayed(c.lastPlayed) : '');
  card.appendChild(foot);

  if (isCurrent) {
    const badge = document.createElement('span');
    badge.className = 'char-card-badge';
    badge.textContent = 'In session';
    card.appendChild(badge);
  }

  card.addEventListener('click', () => _enterCampaign(c.code));
  return card;
}

// Coarse on purpose — the list is already ordered by the real number.
function _describeLastPlayed(ms) {
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return days + ' days ago';
  if (days < 365) return Math.round(days / 30) + ' months ago';
  return 'over a year ago';
}

// ─── THE ⋯ MENU ───
function _toggleCampaignMenu(code, btn) {
  if (openCampaignMenuCode === code) { _closeCampaignMenu(); return; }
  closeCardMenu(); // the character cards' menu, so only one is ever open
  openCampaignMenuCode = code;

  const isGM = state.campaigns[code]?.role === 'gm';
  document.getElementById('campaign-card-rename').classList.toggle('hidden', !isGM);
  document.getElementById('campaign-card-leave').textContent =
    isGM ? 'Delete Campaign' : 'Leave Campaign';

  const btnRect = btn.getBoundingClientRect();
  campaignMenuEl.classList.remove('hidden'); // measurable only once shown
  const width = campaignMenuEl.offsetWidth;
  campaignMenuEl.style.top  = (btnRect.bottom + 4) + 'px';
  campaignMenuEl.style.left = Math.max(4, Math.min(btnRect.right - width, window.innerWidth - width - 4)) + 'px';
}

function _closeCampaignMenu() {
  openCampaignMenuCode = null;
  campaignMenuEl.classList.add('hidden');
}

// ─── THE CAMPAIGN MODAL ───
// One dialog, two jobs — creating a table and joining one are the same question
// asked from either side.

// Opens the campaign dialog on its 'create' or 'join' tab, cleared.
function openCampaignModal(mode = 'create') {
  _setCampaignModalMode(mode);
  document.getElementById('campaign-name-input').value = '';
  document.getElementById('campaign-code-input').value = '';
  fillCampaignCharacterSelect();
  showModal('campaign-modal');
  setTimeout(() => {
    document.getElementById(campaignModalMode === 'join' ? 'campaign-code-input' : 'campaign-name-input').focus();
  }, 0);
}

function _setCampaignModalMode(mode) {
  campaignModalMode = mode === 'join' ? 'join' : 'create';
  const isJoin = campaignModalMode === 'join';
  document.querySelectorAll('.campaign-mode-btn').forEach(b =>
    b.classList.toggle('active', (b.dataset.mode === 'join') === isJoin));
  document.getElementById('campaign-create-fields').classList.toggle('hidden', isJoin);
  document.getElementById('campaign-join-fields').classList.toggle('hidden', !isJoin);
  document.getElementById('campaign-confirm-btn').textContent = isJoin ? 'Join Campaign' : 'Create Campaign';
}

// Fills the join form's picker of which character will sit in the seat.
function fillCampaignCharacterSelect() {
  const sel = document.getElementById('campaign-character-select');
  sel.innerHTML = '';
  getCharacterSlots().forEach(slot => {
    const opt = document.createElement('option');
    opt.value = slot.character.id;
    opt.textContent = slot.character.name + ' · Level ' + slot.character.level;
    sel.appendChild(opt);
  });
  sel.value = state.activeCharacterId ?? '';
}

async function _submitCampaignModal() {
  const btn = document.getElementById('campaign-confirm-btn');
  btn.disabled = true;
  try {
    if (campaignModalMode === 'create') await _submitCampaignCreate();
    else await _submitCampaignJoin();
  } finally {
    btn.disabled = false;
  }
}

async function _submitCampaignCreate() {
  const name = document.getElementById('campaign-name-input').value.trim().slice(0, CAMPAIGN_NAME_MAX);
  if (!name) { alert('Give the campaign a name — it is what your players will see.'); return; }

  if (state.party.active) leaveParty();
  const code = await createCampaign(name);
  if (!code) return;

  _rememberCampaign({
    code, name, role: 'gm', characterId: null,
    gmName: getAccountDisplayName() || 'Game Master',
    memberCount: 0, lastPlayed: Date.now(),
  });
  closeHomeScreen();
  alert(name + ' is ready.\n\nIts code is ' + code + ' — share that with your players.');
}

async function _submitCampaignJoin() {
  const code = document.getElementById('campaign-code-input').value.trim().toUpperCase();
  if (code.length !== 6) { alert('A campaign code is 6 characters.'); return; }

  const charId = document.getElementById('campaign-character-select').value;
  if (!charId || !state.characters[charId]) { alert('Pick the character who plays in this campaign.'); return; }

  const meta = await fetchCampaignMeta(code);
  if (!meta) { alert('No campaign with that code. Check it and try again.'); return; }

  // Bookmark the seat BEFORE entering, so `_enterCampaign()` finds the chosen
  // character where it looks for it.
  _rememberCampaign({
    code,
    name: meta.name ?? '',
    role: meta.gmUid === getOwnPlayerId() ? 'gm' : 'player',
    characterId: charId,
    gmName: meta.gmName ?? '',
    lastPlayed: Date.now(),
  });

  hideModal('campaign-modal');
  await _enterCampaign(code);
}

// ─── WIRING ───
function _startNewCampaign() {
  requireAuth('Creating a campaign needs an account, so your table knows who is running it.',
              () => openCampaignModal('create'));
}
document.getElementById('campaign-new-btn').addEventListener('click', _startNewCampaign);
// The welcome's GM door — the same way in as the Campaigns heading's button.
document.getElementById('home-welcome-campaign-btn').addEventListener('click', _startNewCampaign);

document.getElementById('campaign-join-btn').addEventListener('click', () => {
  requireAuth('Joining a campaign needs an account, so your group can tell who is who.',
              () => openCampaignModal('join'));
});

document.querySelectorAll('.campaign-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => _setCampaignModalMode(btn.dataset.mode));
});

document.getElementById('campaign-confirm-btn').addEventListener('click', _submitCampaignModal);

document.querySelectorAll('#campaign-modal input').forEach(input => {
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); _submitCampaignModal(); }
  });
});

document.getElementById('campaign-card-rename').addEventListener('click', e => {
  e.stopPropagation();
  const code = openCampaignMenuCode;
  _closeCampaignMenu();
  if (!code) return;
  const current = state.campaigns[code]?.name ?? '';
  const name = prompt('Campaign name', current);
  if (name === null) return;
  const trimmed = name.trim().slice(0, CAMPAIGN_NAME_MAX);
  if (trimmed && trimmed !== current) _renameCampaign(code, trimmed);
});

document.getElementById('campaign-card-copy').addEventListener('click', e => {
  e.stopPropagation();
  const code = openCampaignMenuCode;
  _closeCampaignMenu();
  if (code) navigator.clipboard.writeText(code).catch(() => {});
});

document.getElementById('campaign-card-leave').addEventListener('click', e => {
  e.stopPropagation();
  const code = openCampaignMenuCode;
  _closeCampaignMenu();
  if (code) _leaveCampaign(code);
});

document.addEventListener('click', e => {
  if (openCampaignMenuCode === null) return;
  if (campaignMenuEl.contains(e.target)) return;
  _closeCampaignMenu();
});
