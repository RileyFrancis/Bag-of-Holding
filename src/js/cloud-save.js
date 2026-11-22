// =============================================================================
// CLOUD-SAVE — Mirrors the inventory to the signed-in account
// =============================================================================
'use strict';

// The save is one JSON string at `users/{uid}/save`, not a tree: RTDB drops nulls
// and empty objects, so a tree write would silently fail to replicate a deletion.
// Last writer wins, except a first sign-in with real data on both sides
// (`_openCloudConflictModal`).

const CLOUD_SAVE_DEBOUNCE_MS = 1200; // ms of quiet before a change is pushed

// Identifies this tab, so our own writes don't bounce back as remote changes.
const CLOUD_CLIENT_ID = Math.random().toString(36).slice(2, 10);

// Who the ref belongs to. Held here rather than read back off state.auth so the
// two cannot disagree halfway through a sign-in.
let cloudUser = null;
let cloudSaveRef = null;
let cloudWriteTimer = null;
let cloudStatus = 'off'; // 'off' | 'syncing' | 'synced' | 'error'
let cloudStatusDetail = '';
let pendingRemoteSave = null; // waits for the drag in progress to finish
let remoteRetryTimer = null;

// ─── LIFECYCLE ───────────────────────────────────────────────────────────────
// Restarts cloud sync for the new user, or stops it on sign-out; auth.js calls it.
function onAuthUserChanged(user) {
  _stopCloudSync();
  cloudUser = user || null;
  if (!cloudUser || !firebaseDb) { _setCloudStatus('off'); return; }

  cloudSaveRef = firebaseDb.ref(`users/${cloudUser.uid}/save`);
  _reconcileWithCloud();
}

function _stopCloudSync() {
  cloudUser = null;
  clearTimeout(cloudWriteTimer);
  clearTimeout(remoteRetryTimer);
  cloudWriteTimer = null;
  remoteRetryTimer = null;
  pendingRemoteSave = null;
  if (cloudSaveRef) { cloudSaveRef.off(); cloudSaveRef = null; }
}

function _isCloudSyncActive() {
  return !!(cloudSaveRef && cloudUser);
}

// What the account holds versus what this browser holds, on first sign-in.
async function _reconcileWithCloud() {
  _setCloudStatus('syncing');

  let remote;
  try {
    remote = (await cloudSaveRef.get()).val();
  } catch (err) {
    _setCloudStatus('error', _getCloudErrorDetail(err));
    return;
  }

  const localJson = JSON.stringify(buildSavePayload());

  // Nothing up there yet — this browser's inventory becomes the account's.
  if (!remote || !remote.json) { _pushCloudSave(); _listenForRemoteSaves(); return; }

  // Same thing on both sides, or nothing of our own worth keeping.
  if (remote.json === localJson || !hasLocalSave()) {
    _applyCloudSave(remote, { force: true });
    _listenForRemoteSaves();
    return;
  }

  _openCloudConflictModal(remote, localJson);
}

function _listenForRemoteSaves() {
  if (!cloudSaveRef) return;
  cloudSaveRef.on('value', snap => {
    const remote = snap.val();
    if (!remote || !remote.json) return;
    if (remote.updatedBy === CLOUD_CLIENT_ID) { _setCloudStatus('synced'); return; } // our own echo
    _applyCloudSave(remote);
  }, err => _setCloudStatus('error', _getCloudErrorDetail(err)));
}

// ─── WRITING ─────────────────────────────────────────────────────────────────
// Queues a debounced push of the save; scheduleSaveAndSync() calls this on every change.
function scheduleCloudSave() {
  if (!_isCloudSyncActive()) return;
  // While someone else's inventory is on screen, `state` is theirs — pushing it
  // to our account would overwrite our own save with their sheet.
  if (state.party.viewingPlayerId !== null) return;

  clearTimeout(cloudWriteTimer);
  _setCloudStatus('syncing');
  cloudWriteTimer = setTimeout(_pushCloudSave, CLOUD_SAVE_DEBOUNCE_MS);
}

function _pushCloudSave() {
  if (!_isCloudSyncActive()) return;
  if (state.party.viewingPlayerId !== null) return;

  cloudSaveRef.set({
    json: JSON.stringify(buildSavePayload()),
    updatedAt: Date.now(),
    updatedBy: CLOUD_CLIENT_ID,
  }).then(
    () => _setCloudStatus('synced'),
    err => _setCloudStatus('error', _getCloudErrorDetail(err)),
  );
}

// ─── READING ─────────────────────────────────────────────────────────────────
// Mid-drag the dragged item is out of the grid and the ghost is following the
// cursor; replacing the whole save underneath that would strand it. Hold the
// incoming save and try again shortly.
function _applyCloudSave(remote, { force = false } = {}) {
  if (!force && state.mode !== 'idle') {
    pendingRemoteSave = remote;
    clearTimeout(remoteRetryTimer);
    remoteRetryTimer = setTimeout(() => {
      const held = pendingRemoteSave;
      pendingRemoteSave = null;
      if (held) _applyCloudSave(held);
    }, 1000);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(remote.json);
  } catch {
    _setCloudStatus('error', 'the account holds a save this version cannot read');
    return;
  }

  applySavePayload(payload);
  autoSave(); // not scheduleSaveAndSync(), which would push it straight back
  renderLiveCharacter(); // the whole working copy was just replaced
  renderHomeScreen();
  retryMissingRoute();          // the character a character# URL asked for may be here now
  syncRoute({ replace: true }); // the save may name another active character — not a navigation
  _setCloudStatus('synced');
}

// ─── FIRST SIGN-IN: TWO INVENTORIES ──────────────────────────────────────────
// `describeSavePayload` in characters.js reads either save version.
function _describeSave(payload, savedAt) {
  const when = savedAt ? new Date(savedAt).toLocaleString() : 'unknown date';
  return `${describeSavePayload(payload)}\nlast saved ${when}`;
}

function _openCloudConflictModal(remote, localJson) {
  let remotePayload = null;
  try { remotePayload = JSON.parse(remote.json); } catch { /* shown as unreadable */ }

  document.getElementById('cloud-local-summary').textContent =
    _describeSave(JSON.parse(localJson), null).replace('last saved unknown date', 'in this browser now');
  document.getElementById('cloud-remote-summary').textContent =
    remotePayload ? _describeSave(remotePayload, remote.updatedAt) : 'Unreadable save';

  const keepLocal = () => {
    hideModal('cloud-conflict-modal');
    _pushCloudSave();          // this browser wins; the account is overwritten
    _listenForRemoteSaves();
  };
  const keepRemote = () => {
    hideModal('cloud-conflict-modal');
    _applyCloudSave(remote, { force: true });
    _listenForRemoteSaves();
  };

  // Fresh listeners each time — the modal can be opened again on the next
  // sign-in, and a stale handler would resolve against the wrong save.
  const localBtn  = _replaceWithClone(document.getElementById('cloud-keep-local'));
  const remoteBtn = _replaceWithClone(document.getElementById('cloud-keep-remote'));
  localBtn.addEventListener('click', keepLocal);
  remoteBtn.addEventListener('click', keepRemote);

  _setCloudStatus('syncing', 'waiting for you to choose');
  showModal('cloud-conflict-modal');
}

function _replaceWithClone(el) {
  const clone = el.cloneNode(true);
  el.parentNode.replaceChild(clone, el);
  return clone;
}

// ─── STATUS ──────────────────────────────────────────────────────────────────
function _getCloudErrorDetail(err) {
  if (err && err.code === 'PERMISSION_DENIED') {
    return 'your database rules do not allow users/<uid>/save — see database.rules.example.json';
  }
  return (err && err.message) || 'unknown error';
}

function _setCloudStatus(status, detail = '') {
  cloudStatus = status;
  cloudStatusDetail = detail;
  updateCloudStatusUI();
}

// Shows the current sync status in the Settings account row.
function updateCloudStatusUI() {
  const el = document.getElementById('account-sync-status');
  if (!el) return;

  const text = {
    off:     '',
    syncing: 'Syncing…',
    synced:  'Inventory synced to this account',
    error:   'Sync failed',
  }[cloudStatus] ?? '';

  el.textContent = cloudStatusDetail ? `${text} — ${cloudStatusDetail}` : text;
  el.classList.toggle('sync-error', cloudStatus === 'error');
  el.classList.toggle('hidden', !text);
}
