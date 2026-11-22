// =============================================================================
// SHOP — GM-built shops the party buys from, and the left panel's tabs
// =============================================================================
'use strict';

// A shop belongs to the table, not a character. `state.shops` is a read-through
// cache of `parties/<code>/shops`; nothing about a shop enters the save file.
// Stock is claimed by an RTDB transaction before coins move. Reveal is pacing,
// not security (client-side filter). See CLAUDE.md § Campaigns and party.

const SHOP_UNLIMITED = -1; // qty sentinel: RTDB drops nulls, so it cannot be one
const LEFT_TAB_LABELS = { equip: 'Equipment', shop: 'Shop', map: 'Maps' };
const SHOP_ADD_LIMIT = 200; // max rows in the add picker; the catalogue can be thousands, search narrows it
const PRICE_DENOMS = ['pp', 'gp', 'ep', 'sp', 'cp'];
const COIN_VALUE = { cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000 }; // worth of each coin in cp
const COIN_ASC = ['cp', 'sp', 'ep', 'gp', 'pp'];
// Change comes back in the coins people actually use: electrum is a curiosity,
// and nobody wants five of them instead of two gold and a half.
const CHANGE_DENOMS = ['pp', 'gp', 'sp', 'cp'];

// ─── SHOP — MODEL ──────────────────────────────────────────────────────────────
function _getShopsPath(shopId) {
  return `parties/${state.party.code}/shops` + (shopId ? '/' + shopId : '');
}
function _getShopRef(shopId) { return firebaseDb.ref(_getShopsPath(shopId)); }

function _isShopGM() { return state.party.active && state.party.role === 'gm'; }

// You buy for the character you are actually playing — never while looking at
// somebody else's inventory, which is not yours to spend from.
function _canBuyFromShop() {
  return state.party.active && state.party.role === 'player' && state.party.viewingPlayerId === null;
}

function _isShopVisibleToMe(shop) {
  if (_isShopGM()) return true;
  if (!shop.revealed) return false;
  if (shop.audience === 'all') return true;
  const chosen = shop.players ?? {};
  if (chosen[state.party.playerId]) return true;
  // Name-match fallback for reveals keyed by legacy per-session player ids.
  const names = shop.playerNames ?? {};
  return Object.keys(chosen).some(pid => chosen[pid] && names[pid] && names[pid] === state.party.playerName);
}

function _getVisibleShops() {
  return Object.values(state.shops ?? {})
    .filter(s => s && s.id)
    .filter(_isShopVisibleToMe)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function _getShopStockEntries(shop) {
  return Object.entries(shop.stock ?? {})
    .map(([entryId, e]) => ({ ...e, entryId }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// Snapshotted into the shop as JSON, so a shop can stock something the buyer has
// never owned and a later edit to the GM's catalogue cannot change a listing.
// JSON for cloud-save.js's reason: RTDB drops nulls and empty objects.
function _getShopEntryTemplate(entry) {
  try { return JSON.parse(entry.template); } catch { return null; }
}

// Two prices per line: the *base* (what the GM typed) and the scaled price
// (base × shop markup). The editor edits the base; the listing, buy dialog and
// purse all use the scaled price, so the two cannot disagree.
function _getShopEntryBasePrice(entry) {
  return parseCostObj(entry.price ?? _getShopEntryTemplate(entry)?.cost);
}

// Stored as whole percent, 100 = the price as written. Absent means 100.
function _getShopPriceModifier(shop) {
  const pct = shop?.priceModifier;
  return Number.isFinite(pct) && pct >= 0 ? pct : 100;
}

function _getShopEntryPriceCp(shop, entry) {
  const base = _convertCostToCp(_getShopEntryBasePrice(entry));
  if (!base) return 0; // free stays free, whatever the markup
  // Scaling happens in copper, so a markup can move a price by less than a coin
  // of its own denomination. Never rounds a real cost away to nothing.
  return Math.max(1, Math.round(base * _getShopPriceModifier(shop) / 100));
}

function _getShopEntryPrice(shop, entry) {
  return _convertCpToCoins(_getShopEntryPriceCp(shop, entry));
}

// "+10%" / "−25%", or null when the shop charges what the list says.
function _getPriceModifierLabel(shop) {
  const pct = _getShopPriceModifier(shop);
  if (pct === 100) return null;
  const delta = pct - 100;
  return `${delta > 0 ? '+' : '−'}${Math.abs(delta)}%`;
}

function _getStockLabel(entry) {
  if (entry.qty === SHOP_UNLIMITED) return 'unlimited';
  const q = entry.qty ?? 0;
  return q <= 0 ? 'sold out' : `${q} left`;
}

function _isSoldOut(entry) {
  return entry.qty !== SHOP_UNLIMITED && (entry.qty ?? 0) <= 0;
}

function _getShopAudienceLabel(shop) {
  if (!shop.revealed) return 'Hidden';
  if (shop.audience === 'all') return 'Everyone';
  const n = Object.values(shop.players ?? {}).filter(Boolean).length;
  return n ? `${n} player${n === 1 ? '' : 's'}` : 'Nobody yet';
}

// ─── SHOP — FIREBASE ───────────────────────────────────────────────────────────
let partyShopsRef = null;

// Listens to the party's shops, mirroring them into `state.shops`.
function subscribeToShops(code) {
  unsubscribeFromShops();
  if (!firebaseDb) return;
  partyShopsRef = firebaseDb.ref(`parties/${code}/shops`);
  partyShopsRef.on('value', snap => {
    state.shops = snap.val() ?? {};
    // A shop deleted by the GM must not leave its editor open on somebody else.
    if (state.shopOpenId && !state.shops[state.shopOpenId]) state.shopOpenId = null;
    // A newly revealed shop makes the tab appear, so this goes through the tabs.
    syncLeftPanel();
    if (!document.getElementById('shop-buy-modal').classList.contains('hidden')) updateBuySummary();
  });
}

// Stops the shop listener and empties the cache.
function unsubscribeFromShops() {
  if (partyShopsRef) { partyShopsRef.off(); partyShopsRef = null; }
  state.shops = {};
  state.shopOpenId = null;
}

// ─── LEFT PANEL — TABS ─────────────────────────────────────────────────────────
// Which panes the left panel has right now. A GM has no character, so equipment
// is only theirs while a player is picked, and with nobody picked the Shop is
// the whole panel. Maps is the GM's alone (a player reaches the one map that
// concerns them by the corner button) — hence no `!isGm` branch for it.
function getAvailableLeftTabs() {
  const isGm = _isShopGM();
  const hasShop = state.party.active && (isGm || _getVisibleShops().length > 0);
  const hasMap = isGm;
  const hasEquip = !isGm || state.party.viewingPlayerId !== null;
  const tabs = [];
  if (isGm && hasShop) tabs.push('shop');          // the GM's own tools come first
  if (hasMap) tabs.push('map');
  if (hasEquip) tabs.push('equip');
  if (!isGm && hasShop) tabs.push('shop');
  return tabs.length ? tabs : ['equip'];
}

// Rebuilds the left panel's tab strip and shows the active pane.
function syncLeftPanel() {
  const strip = document.getElementById('left-tabs');
  if (!strip) return;
  const tabs = getAvailableLeftTabs();
  if (!tabs.includes(state.leftTab)) state.leftTab = tabs[0];

  // One pane needs no tabs, so a solo player sees a plain panel.
  strip.classList.toggle('hidden', tabs.length < 2);
  strip.innerHTML = '';
  tabs.forEach(id => {
    const btn = document.createElement('button');
    btn.className = 'ltab-btn' + (id === state.leftTab ? ' active' : '');
    btn.textContent = LEFT_TAB_LABELS[id];
    btn.addEventListener('click', () => _setLeftTab(id));
    strip.appendChild(btn);
  });

  document.getElementById('left-pane-equip').classList.toggle('active', state.leftTab === 'equip');
  document.getElementById('left-pane-shop').classList.toggle('active', state.leftTab === 'shop');
  document.getElementById('left-pane-map').classList.toggle('active', state.leftTab === 'map');
  if (tabs.includes('shop')) renderShopPanel();
  if (tabs.includes('map')) renderMapPanel();
}

function _setLeftTab(id) {
  if (state.leftTab === id) return;
  state.leftTab = id;
  clearTooltip();
  syncLeftPanel();
}

// ─── SHOP — PANEL ──────────────────────────────────────────────────────────────
// Draws the Shop pane: the open shop's page, or the list of shops.
function renderShopPanel() {
  const pane = document.getElementById('left-pane-shop');
  if (!pane) return;
  pane.innerHTML = '';
  if (!state.party.active) return;
  const shop = state.shopOpenId ? state.shops[state.shopOpenId] : null;
  if (shop) _renderShopDetail(pane, shop);
  else _renderShopList(pane);
}

function _renderShopList(pane) {
  const isGm = _isShopGM();

  const head = document.createElement('div');
  head.className = 'shop-head';
  const title = document.createElement('span');
  title.className = 'shop-head-title';
  title.textContent = 'Shops';
  head.appendChild(title);
  pane.appendChild(head);

  const body = document.createElement('div');
  body.className = 'shop-body';

  const shops = _getVisibleShops();
  if (!shops.length) {
    const empty = document.createElement('p');
    empty.className = 'shop-empty';
    empty.textContent = isGm
      ? 'No shops yet. Build one now and reveal it when the party walks in.'
      : 'No shops are open to you right now.';
    body.appendChild(empty);
  }

  shops.forEach(shop => {
    const row = document.createElement('button');
    row.className = 'shop-row' + (shop.revealed ? ' revealed' : '');
    row.dataset.shopId = shop.id; // a card dragged out of Browse can land here
    const nm = document.createElement('span');
    nm.className = 'shop-row-name';
    nm.textContent = shop.name;
    const n = _getShopStockEntries(shop).length;
    const sub = document.createElement('span');
    sub.className = 'shop-row-sub';
    sub.textContent = `${n} item${n === 1 ? '' : 's'}` + (isGm ? ` · ${_getShopAudienceLabel(shop)}` : '');
    row.appendChild(nm);
    row.appendChild(sub);
    row.addEventListener('click', () => { state.shopOpenId = shop.id; renderShopPanel(); });
    body.appendChild(row);
  });

  pane.appendChild(body);

  if (isGm) {
    const footer = document.createElement('div');
    footer.className = 'shop-footer';
    const btn = document.createElement('button');
    btn.className = 'btn-primary';
    setIconLabel(btn, 'plus', 'New Shop');
    btn.addEventListener('click', () => _openShopModal(null));
    footer.appendChild(btn);
    pane.appendChild(footer);
  }
}

function _renderShopDetail(pane, shop) {
  const isGm = _isShopGM();

  const head = document.createElement('div');
  head.className = 'shop-head';
  const back = document.createElement('button');
  back.className = 'shop-back';
  back.textContent = '‹ Shops';
  back.addEventListener('click', () => { state.shopOpenId = null; renderShopPanel(); });
  head.appendChild(back);
  if (isGm) {
    const edit = document.createElement('button');
    edit.className = 'shop-head-btn';
    edit.title = 'Rename or re-describe this shop';
    edit.textContent = '✎';
    edit.addEventListener('click', () => _openShopModal(shop.id));
    const del = document.createElement('button');
    del.className = 'shop-head-btn danger';
    del.title = 'Delete this shop';
    del.textContent = '✕';
    del.addEventListener('click', () => _deleteShop(shop));
    head.appendChild(edit);
    head.appendChild(del);
  }
  pane.appendChild(head);

  const body = document.createElement('div');
  body.className = 'shop-body';

  const title = document.createElement('div');
  title.className = 'shop-title';
  title.textContent = shop.name;
  body.appendChild(title);

  if (shop.description) {
    const d = document.createElement('p');
    d.className = 'shop-desc';
    d.textContent = shop.description;
    body.appendChild(d);
  }

  if (isGm) {
    _buildShopRevealControls(body, shop);
    _buildShopPriceControls(body, shop);
  }

  const hdr = document.createElement('div');
  hdr.className = 'shop-section-hdr';
  hdr.textContent = isGm ? 'Stock' : 'For Sale';
  body.appendChild(hdr);

  const entries = _getShopStockEntries(shop);
  if (!entries.length) {
    const p = document.createElement('p');
    p.className = 'shop-empty';
    p.textContent = isGm ? 'Nothing stocked yet.' : 'The shelves are bare.';
    body.appendChild(p);
  }
  entries.forEach(entry => body.appendChild(_buildStockRow(shop, entry, isGm)));

  pane.appendChild(body);

  if (isGm) {
    const footer = document.createElement('div');
    footer.className = 'shop-footer';
    const add = document.createElement('button');
    add.className = 'btn-primary';
    setIconLabel(add, 'plus', 'Add Items');
    add.addEventListener('click', () => _openShopAddModal(shop));
    footer.appendChild(add);
    pane.appendChild(footer);
  }
}

function _buildShopRevealControls(body, shop) {
  const hdr = document.createElement('div');
  hdr.className = 'shop-section-hdr';
  hdr.textContent = 'Visible To';
  body.appendChild(hdr);

  const current = !shop.revealed ? 'hidden' : (shop.audience === 'all' ? 'all' : 'select');
  const seg = document.createElement('div');
  seg.className = 'segmented shop-seg';
  [['hidden', 'Hidden'], ['all', 'Everyone'], ['select', 'Choose']].forEach(([key, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn' + (key === current ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => _setShopAudience(shop, key));
    seg.appendChild(b);
  });
  body.appendChild(seg);

  if (current !== 'select') return;

  const players = Object.entries(state.party.players ?? {});
  if (!players.length) {
    const p = document.createElement('p');
    p.className = 'shop-empty';
    p.textContent = 'Nobody has joined the party yet.';
    body.appendChild(p);
  }
  players.forEach(([pid, p]) => {
    const lbl = document.createElement('label');
    lbl.className = 'checkbox-label shop-player-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!(shop.players ?? {})[pid];
    cb.addEventListener('change', () => _toggleShopPlayer(shop, pid, p.name, cb.checked));
    const sp = document.createElement('span');
    sp.textContent = p.character?.name ? `${p.name} · ${p.character.name}` : p.name;
    lbl.appendChild(cb);
    lbl.appendChild(sp);
    body.appendChild(lbl);
  });
}

// One number over the whole stock list — it scales the base prices instead of
// rewriting them, so winding it back to 100 restores what the GM typed.
function _buildShopPriceControls(body, shop) {
  const hdr = document.createElement('div');
  hdr.className = 'shop-section-hdr';
  hdr.textContent = 'Prices';
  body.appendChild(hdr);

  const row = document.createElement('div');
  row.className = 'shop-price-row';

  const stepper = (label, delta) => {
    const b = document.createElement('button');
    b.className = 'shop-price-step';
    b.type = 'button';
    b.textContent = label;
    b.title = `${delta > 0 ? 'Raise' : 'Lower'} every price by ${Math.abs(delta)}%`;
    b.addEventListener('click', () => _setShopPriceModifier(shop, _getShopPriceModifier(shop) + delta));
    return b;
  };

  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'shop-price-input';
  input.min = 0;
  input.max = 1000;
  input.step = 5;
  input.value = _getShopPriceModifier(shop);
  input.title = 'Percent of the listed price — 100 is the price as written';
  // On change, not input: every keystroke would be its own write to Firebase.
  input.addEventListener('change', () => _setShopPriceModifier(shop, parseInt(input.value, 10)));

  row.appendChild(stepper('−10', -10));
  row.appendChild(input);
  row.appendChild(stepper('+10', 10));
  body.appendChild(row);

  const note = document.createElement('p');
  note.className = 'shop-price-note';
  const label = _getPriceModifierLabel(shop);
  note.textContent = label
    ? `Everything sells at ${_getShopPriceModifier(shop)}% — ${label} on the listed prices.`
    : 'Everything sells at the listed price.';
  if (label) note.classList.add('marked');
  body.appendChild(note);
}

function _setShopPriceModifier(shop, pct) {
  const clamped = Math.max(0, Math.min(1000, Number.isFinite(pct) ? Math.round(pct) : 100));
  _getShopRef(shop.id).update({ priceModifier: clamped });
}

function _buildStockRow(shop, entry, isGm) {
  const t = _getShopEntryTemplate(entry);
  const sold = _isSoldOut(entry);

  const row = document.createElement('div');
  row.className = 'shop-item clickable' + (sold ? ' sold-out' : '');

  const swatch = document.createElement('span');
  swatch.className = 'shop-item-swatch';
  swatch.style.background = getRarityColor(t?.rarity ?? 'common');

  const info = document.createElement('div');
  info.className = 'shop-item-info';
  const nm = document.createElement('span');
  nm.className = 'shop-item-name';
  nm.textContent = t?.name ?? 'Unknown item';
  const price = _getShopEntryPrice(shop, entry);
  const sub = document.createElement('span');
  sub.className = 'shop-item-sub';
  sub.textContent = hasCost(price) ? formatCost(price) : 'Free';
  info.appendChild(nm);
  info.appendChild(sub);

  row.appendChild(swatch);
  row.appendChild(info);
  row.appendChild(_buildStockCount(entry));

  if (isGm) {
    row.title = 'Set quantity and price';
    row.addEventListener('click', () => _openShopEntryModal(shop, entry));
  } else {
    // The row is small, so looking an item over happens in the Details tab.
    row.addEventListener('click', () => _showShopItemDetails(shop, entry));
    const buy = document.createElement('button');
    buy.className = 'btn-sm shop-buy-btn';
    buy.textContent = sold ? 'Sold' : 'Buy';
    buy.disabled = sold || !_canBuyFromShop();
    if (!sold && !_canBuyFromShop()) buy.title = 'Return to your own inventory to buy.';
    buy.addEventListener('click', e => { e.stopPropagation(); _openBuyModal(shop, entry); });
    row.appendChild(buy);
  }

  return row;
}

// How many are left is the thing you scan a shelf for — a GM checking what has
// sold, a player deciding whether to hurry — so it is read as a number of its
// own rather than tucked on the end of a line of small print.
function _buildStockCount(entry) {
  const wrap = document.createElement('div');
  wrap.className = 'shop-item-qty';

  const num = document.createElement('span');
  num.className = 'shop-qty-num';
  const label = document.createElement('span');
  label.className = 'shop-qty-label';

  if (entry.qty === SHOP_UNLIMITED) {
    wrap.classList.add('unlimited');
    num.textContent = '∞';
    label.textContent = 'stock';
    wrap.title = 'Never runs out';
  } else {
    const q = entry.qty ?? 0;
    num.textContent = q;
    label.textContent = 'left';
    if (q <= 0) { wrap.classList.add('out'); wrap.title = 'Sold out'; }
  }

  wrap.appendChild(num);
  wrap.appendChild(label);
  return wrap;
}

// A shop item may be something the viewer has never owned, so the details panel
// is handed the shop's own snapshot instead of a lookup in state.db — and the
// action buttons go away, since none of them mean anything for goods on a shelf.
function _showShopItemDetails(shop, entry) {
  const t = _getShopEntryTemplate(entry);
  if (!t) return;
  state.selected = null;
  populateDetailsPanel(t);
  const price = _getShopEntryPrice(shop, entry);
  document.getElementById('details-cost').textContent = hasCost(price) ? formatCost(price) : 'Free';
  document.getElementById('details-actions').classList.add('hidden');
  switchTab('details');
}

// ─── SHOP — DROP TARGET ────────────────────────────────────────────────────────
// A card dragged out of Browse can be dropped onto a shop — same bounding-rect
// test the folder headers use, checked by buildItemCard's drag BEFORE the grid.
// On a shop's own page the whole pane is the target; in the list, each row is.
function getShopDropTargetAtPoint(x, y) {
  if (!_isShopGM()) return null;
  const pane = document.getElementById('left-pane-shop');
  if (!pane || !pane.classList.contains('active')) return null;

  const inside = el => {
    const b = el.getBoundingClientRect();
    return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
  };

  for (const row of pane.querySelectorAll('.shop-row')) {
    if (inside(row)) return { el: row, shopId: row.dataset.shopId };
  }
  if (state.shopOpenId && state.shops[state.shopOpenId] && inside(pane)) {
    return { el: pane, shopId: state.shopOpenId };
  }
  return null;
}

// Removes the drop highlight from the Shop pane and its rows.
function clearShopDropTargets() {
  document.querySelectorAll('#left-pane-shop.drop-target, #left-pane-shop .drop-target')
    .forEach(el => el.classList.remove('drop-target'));
}

// ─── SHOP — GM EDITS ───────────────────────────────────────────────────────────
let shopModalId = null;

function _openShopModal(shopId) {
  shopModalId = shopId;
  const shop = shopId ? state.shops[shopId] : null;
  document.getElementById('shop-modal-title').textContent = shop ? 'Edit Shop' : 'New Shop';
  document.getElementById('shop-name-input').value = shop?.name ?? '';
  document.getElementById('shop-desc-input').value = shop?.description ?? '';
  document.getElementById('shop-confirm-btn').textContent = shop ? 'Save' : 'Create';
  showModal('shop-modal');
}

document.getElementById('shop-confirm-btn').addEventListener('click', () => {
  const name = document.getElementById('shop-name-input').value.trim();
  if (!name) { alert('Give the shop a name.'); return; }
  const description = document.getElementById('shop-desc-input').value.trim();

  if (shopModalId) {
    _getShopRef(shopModalId).update({ name, description });
  } else {
    const id = 'shop_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    // Opened before the write, so the echo of our own write lands on a panel
    // that is already showing the new shop rather than bouncing back to the list.
    state.shopOpenId = id;
    _getShopRef(id).set({ id, name, description, revealed: false, audience: 'all', order: Date.now() });
  }
  hideModal('shop-modal');
});

function _deleteShop(shop) {
  if (!confirm(`Delete “${shop.name}”? Its stock goes with it.`)) return;
  state.shopOpenId = null;
  _getShopRef(shop.id).remove();
  renderShopPanel();
}

function _setShopAudience(shop, mode) {
  if (mode === 'hidden') _getShopRef(shop.id).update({ revealed: false });
  else _getShopRef(shop.id).update({ revealed: true, audience: mode === 'all' ? 'all' : 'select' });
}

function _toggleShopPlayer(shop, playerId, name, on) {
  _getShopRef(shop.id).update({
    [`players/${playerId}`]:     on ? true : null,
    [`playerNames/${playerId}`]: on ? (name ?? '') : null,
  });
}

// ─── ADDING STOCK ──────────────────────────────────────────────────────────
let shopAddTargetId = null;
let shopAddSelection = new Set();

function _openShopAddModal(shop) {
  shopAddTargetId = shop.id;
  shopAddSelection = new Set();
  document.getElementById('shop-add-search').value = '';
  renderShopAddList();
  showModal('shop-add-modal');
}

// Redraws the add-stock picker's rows, filtered by its search box.
function renderShopAddList() {
  const list = document.getElementById('shop-add-list');
  const q = document.getElementById('shop-add-search').value.trim().toLowerCase();
  list.innerHTML = '';

  const all = Object.values(state.db)
    .filter(t => !q || t.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));

  all.slice(0, SHOP_ADD_LIMIT).forEach(t => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'shop-add-row' + (shopAddSelection.has(t.id) ? ' selected' : '');

    const sw = document.createElement('span');
    sw.className = 'shop-item-swatch';
    sw.style.background = getRarityColor(t.rarity);
    const nm = document.createElement('span');
    nm.className = 'shop-add-name';
    nm.textContent = t.name;
    const cost = document.createElement('span');
    cost.className = 'shop-add-cost';
    cost.textContent = hasCost(t.cost) ? formatCost(t.cost) : '—';

    row.appendChild(sw);
    row.appendChild(nm);
    row.appendChild(cost);
    row.addEventListener('click', () => {
      if (shopAddSelection.has(t.id)) shopAddSelection.delete(t.id);
      else shopAddSelection.add(t.id);
      row.classList.toggle('selected');
      _updateShopAddButton();
    });
    list.appendChild(row);
  });

  if (all.length > SHOP_ADD_LIMIT) {
    const more = document.createElement('p');
    more.className = 'shop-empty';
    more.textContent = `…and ${all.length - SHOP_ADD_LIMIT} more — search to narrow it down.`;
    list.appendChild(more);
  }
  _updateShopAddButton();
}

function _updateShopAddButton() {
  const n = shopAddSelection.size;
  const btn = document.getElementById('shop-add-confirm-btn');
  btn.textContent = n ? `Add ${n} Item${n === 1 ? '' : 's'}` : 'Add';
  btn.disabled = n === 0;
}

document.getElementById('shop-add-search').addEventListener('input', renderShopAddList);

// The one way stock arrives (picker modal and drag-from-Browse alike). An item
// already on the shelf gains one to its count rather than a second line.
function addItemsToShop(shopId, templateIds) {
  const shop = state.shops[shopId];
  if (!shop || !templateIds.length || !firebaseDb) return 0;

  const existing = _getShopStockEntries(shop);
  const updates = {};
  let order = existing.length;
  let added = 0;

  templateIds.forEach(templateId => {
    const t = state.db[templateId];
    if (!t) return;
    added++;

    const already = existing.find(e => e.templateId === templateId);
    if (already) {
      if (already.qty === SHOP_UNLIMITED) return; // bottomless: nothing to top up
      updates[`${already.entryId}/qty`] = (already.qty ?? 0) + 1;
      return;
    }

    const entryId = 'e_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    updates[entryId] = {
      templateId,
      template: JSON.stringify(t), // undefined fields drop out on the way through
      qty: 1,
      order: order++,
    };
  });

  if (Object.keys(updates).length) firebaseDb.ref(_getShopsPath(shopId) + '/stock').update(updates);
  return added;
}

document.getElementById('shop-add-confirm-btn').addEventListener('click', () => {
  addItemsToShop(shopAddTargetId, [...shopAddSelection]);
  hideModal('shop-add-modal');
});

// ─── ONE STOCK ENTRY ───────────────────────────────────────────────────────
let shopEntryTarget = null; // { shopId, entryId }

function _openShopEntryModal(shop, entry) {
  shopEntryTarget = { shopId: shop.id, entryId: entry.entryId };
  const t = _getShopEntryTemplate(entry);
  document.getElementById('shop-entry-title').textContent = t?.name ?? 'Stock';

  const unlimited = entry.qty === SHOP_UNLIMITED;
  const qtyInput = document.getElementById('shop-entry-qty');
  document.getElementById('shop-entry-unlimited').checked = unlimited;
  qtyInput.value = unlimited ? 1 : (entry.qty ?? 0);
  qtyInput.disabled = unlimited;

  // The field holds the base price; the note under it says what the shop's
  // markup turns that into, so the GM is never guessing at the shelf price.
  _setShopPriceFields(_getShopEntryBasePrice(entry));
  _updateShopEntryPriceNote();
  showModal('shop-entry-modal');
}

function _updateShopEntryPriceNote() {
  const note = document.getElementById('shop-entry-price-note');
  const shop = state.shops[shopEntryTarget?.shopId];
  const label = _getPriceModifierLabel(shop);
  note.classList.toggle('hidden', !label);
  if (!label) return;
  const scaled = _getShopEntryPrice(shop, { price: _readShopPriceFields() });
  note.textContent = `Shop markup ${label} — sells for ${hasCost(scaled) ? formatCost(scaled) : 'free'}.`;
}

function _setShopPriceFields(cost) {
  const c = parseCostObj(cost);
  PRICE_DENOMS.forEach(d => { document.getElementById('shop-price-' + d).value = c[d]; });
}

function _readShopPriceFields() {
  const out = {};
  PRICE_DENOMS.forEach(d => {
    out[d] = Math.max(0, parseInt(document.getElementById('shop-price-' + d).value, 10) || 0);
  });
  return out;
}

document.getElementById('shop-entry-unlimited').addEventListener('change', e => {
  document.getElementById('shop-entry-qty').disabled = e.target.checked;
});

PRICE_DENOMS.forEach(d => {
  document.getElementById('shop-price-' + d).addEventListener('input', _updateShopEntryPriceNote);
});

document.getElementById('shop-entry-reset-price').addEventListener('click', () => {
  const found = _getCurrentStockEntry(shopEntryTarget);
  if (!found) return;
  _setShopPriceFields(_getShopEntryTemplate(found.entry)?.cost);
  _updateShopEntryPriceNote();
});

document.getElementById('shop-entry-save-btn').addEventListener('click', () => {
  if (!shopEntryTarget) return;
  const unlimited = document.getElementById('shop-entry-unlimited').checked;
  const qty = unlimited
    ? SHOP_UNLIMITED
    : Math.max(0, parseInt(document.getElementById('shop-entry-qty').value, 10) || 0);
  firebaseDb.ref(`${_getShopsPath(shopEntryTarget.shopId)}/stock/${shopEntryTarget.entryId}`)
    .update({ qty, price: _readShopPriceFields() });
  hideModal('shop-entry-modal');
});

document.getElementById('shop-entry-remove-btn').addEventListener('click', () => {
  if (!shopEntryTarget) return;
  firebaseDb.ref(`${_getShopsPath(shopEntryTarget.shopId)}/stock/${shopEntryTarget.entryId}`).remove();
  hideModal('shop-entry-modal');
});

// Both halves, because a price cannot be worked out from the entry alone — the
// shop's markup is the other half of it.
function _getCurrentStockEntry(target) {
  const shop = target && state.shops[target.shopId];
  const entry = shop && (shop.stock ?? {})[target.entryId];
  return entry ? { shop, entry: { ...entry, entryId: target.entryId } } : null;
}

// ─── SHOP — PAYING ─────────────────────────────────────────────────────────────
function _convertCostToCp(cost) {
  const c = parseCostObj(cost);
  return COIN_ASC.reduce((sum, d) => sum + (c[d] || 0) * COIN_VALUE[d], 0);
}

function _convertCpToCoins(cp) {
  const out = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
  let left = cp;
  CHANGE_DENOMS.forEach(d => { out[d] = Math.floor(left / COIN_VALUE[d]); left -= out[d] * COIN_VALUE[d]; });
  return out;
}

function _getPurseTotalCp(counts) {
  return COIN_ASC.reduce((sum, d) => sum + counts[d] * COIN_VALUE[d], 0);
}

// What a purchase does to the purse. Small coins are spent first (sheds loose
// change, leaves the big coins whole); when what is left to pay is smaller than
// any coin still in the purse, one is broken and the difference comes back.
function _planPayment(priceCp) {
  const have = getCoinCounts();
  const total = _getPurseTotalCp(have);
  if (total < priceCp) return { error: 'short', short: priceCp - total };

  const spend = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
  let left = priceCp;
  for (const d of COIN_ASC) {
    const n = Math.min(have[d], Math.floor(left / COIN_VALUE[d]));
    spend[d] = n;
    left -= n * COIN_VALUE[d];
  }

  let change = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
  if (left > 0) {
    const toBreak = COIN_ASC.find(d => have[d] - spend[d] > 0 && COIN_VALUE[d] > left);
    if (!toBreak) return { error: 'short', short: left }; // unreachable while total >= price
    spend[toBreak] += 1;
    change = _convertCpToCoins(COIN_VALUE[toBreak] - left);
  }

  // Change is only change if there is a coin to hand it back in. Rather than
  // quietly swallow the difference, refuse and say which coin is missing.
  const templates = getCoinTemplates();
  const missing = CHANGE_DENOMS.find(d => change[d] > 0 && !templates[d]);
  if (missing) return { error: 'nochange', denom: missing };

  return { spend, change, after: _getPurseAfterPayment(have, spend, change) };
}

function _getPurseAfterPayment(have, spend, change) {
  const out = {};
  COIN_ASC.forEach(d => { out[d] = have[d] - spend[d] + (change[d] ?? 0); });
  return out;
}

function _applyPayment(plan) {
  const templates = getCoinTemplates();
  COIN_ASC.forEach(d => {
    if (plan.spend[d] > 0 && templates[d]) removeCoinsFromInventory(templates[d], plan.spend[d]);
  });
  CHANGE_DENOMS.forEach(d => {
    if (plan.change[d] > 0 && templates[d]) addCoinsToInventory(templates[d], plan.change[d]);
  });
}

// The shop carries its own copy, so a buyer can end up holding something never
// in their catalogue. Match an existing entry (a second longsword must not fork
// the catalogue), else register the snapshot as a custom item.
function _resolveShopTemplate(entry) {
  const snap = _getShopEntryTemplate(entry);
  if (!snap) return null;
  const sameId = state.db[entry.templateId];
  if (sameId && sameId.name === snap.name) return sameId.id;
  const byName = Object.values(state.db).find(t => t.name === snap.name && !t.abstract);
  if (byName) return byName.id;
  const id = createTemplateId();
  state.db[id] = { ...snap, id };
  renderItemList();
  return id;
}

function _grantPurchase(entry, count) {
  const templateId = _resolveShopTemplate(entry);
  if (!templateId) return;
  const t = state.db[templateId];
  if (isStackable(t)) {
    addStackableUnits(templateId, count);
  } else {
    for (let i = 0; i < count; i++) {
      const id = createInstanceId();
      state.instances[id] = { id, templateId, rotation: 0, row: null, col: null, stackCount: 1, containerId: null };
    }
  }
  renderAllItems();
  updateWeightDisplay();
  scheduleSaveAndSync();
}

// ─── SHOP — BUYING ─────────────────────────────────────────────────────────────
let shopBuyTarget = null; // { shopId, entryId }

function _openBuyModal(shop, entry) {
  if (!_canBuyFromShop()) return;
  shopBuyTarget = { shopId: shop.id, entryId: entry.entryId };

  const t = _getShopEntryTemplate(entry);
  const price = _getShopEntryPrice(shop, entry);
  document.getElementById('shop-buy-title').textContent = t?.name ?? 'Buy';
  document.getElementById('shop-buy-sub').textContent =
    `${shop.name} · ${hasCost(price) ? formatCost(price) : 'Free'} each · ${_getStockLabel(entry)}`;

  const max = entry.qty === SHOP_UNLIMITED ? 99 : Math.max(1, entry.qty ?? 1);
  const qtyInput = document.getElementById('shop-buy-qty');
  document.getElementById('shop-buy-qty-field').classList.toggle('hidden', max <= 1);
  qtyInput.min = 1;
  qtyInput.max = max;
  qtyInput.value = 1;

  document.getElementById('shop-buy-confirm-btn').textContent = 'Buy';
  updateBuySummary();
  showModal('shop-buy-modal');
}

function _getBuyQuantity() {
  const input = document.getElementById('shop-buy-qty');
  const max = parseInt(input.max, 10) || 1;
  return Math.min(max, Math.max(1, parseInt(input.value, 10) || 1));
}

document.getElementById('shop-buy-qty').addEventListener('input', updateBuySummary);

// Redraws the buy dialog's cost, purse and change lines, and enables Buy if it can be paid.
function updateBuySummary() {
  const box = document.getElementById('shop-buy-summary');
  const btn = document.getElementById('shop-buy-confirm-btn');
  box.innerHTML = '';
  document.getElementById('shop-buy-error').classList.add('hidden');

  const found = _getCurrentStockEntry(shopBuyTarget);
  if (!found) { btn.disabled = true; return; }
  const { shop, entry } = found;

  const count = _getBuyQuantity();
  const priceCp = _getShopEntryPriceCp(shop, entry) * count;
  const plan = _planPayment(priceCp);

  box.appendChild(_buildCoinLine('Total', _convertCpToCoins(priceCp)));
  box.appendChild(_buildCoinLine('Purse', getCoinCounts(), true));
  if (!plan.error) {
    box.appendChild(_buildCoinLine('After', plan.after, true));
    if (Object.values(plan.change).some(Boolean)) box.appendChild(_buildCoinLine('Change', plan.change, true));
  }

  btn.disabled = !!plan.error || _isSoldOut(entry);
  if (plan.error) _showBuyError(plan);
  else if (_isSoldOut(entry)) _showBuyError({ error: 'gone' });
}

function _buildCoinLine(label, coins, dim) {
  const row = document.createElement('div');
  row.className = 'shop-coin-line' + (dim ? ' dim' : '');
  const l = document.createElement('span');
  l.className = 'shop-coin-label';
  l.textContent = label;
  row.appendChild(l);

  const vals = document.createElement('span');
  vals.className = 'shop-coin-vals';
  const shown = PRICE_DENOMS.filter(d => coins[d]);
  if (!shown.length) {
    const zero = document.createElement('span');
    zero.textContent = '—';
    vals.appendChild(zero);
  }
  shown.forEach(d => {
    const s = document.createElement('span');
    s.className = 'shop-coin';
    s.style.color = getCoinColor(d);
    s.textContent = `${coins[d]} ${d}`;
    vals.appendChild(s);
  });
  row.appendChild(vals);
  return row;
}

function _showBuyError(plan) {
  const err = document.getElementById('shop-buy-error');
  err.classList.remove('hidden');
  if (plan.error === 'short') {
    err.textContent = `Not enough coin — you are ${formatCost(_convertCpToCoins(plan.short))} short.`;
  } else if (plan.error === 'nochange') {
    err.textContent = `Your purse cannot make exact change for this, and the item list has no ` +
                      `${plan.denom.toUpperCase()} coin to give it in.`;
  } else if (plan.error === 'gone') {
    err.textContent = 'Someone else got there first — this one is sold.';
  } else {
    err.textContent = 'The purchase could not be recorded: ' + (plan.message ?? 'unknown error');
  }
}

document.getElementById('shop-buy-confirm-btn').addEventListener('click', _confirmPurchase);

async function _confirmPurchase() {
  const found = _getCurrentStockEntry(shopBuyTarget);
  if (!found || !_canBuyFromShop()) { hideModal('shop-buy-modal'); return; }
  const { shop, entry } = found;

  const count = _getBuyQuantity();
  const priceCp = _getShopEntryPriceCp(shop, entry) * count;
  const plan = _planPayment(priceCp);
  if (plan.error) { _showBuyError(plan); return; }

  const btn = document.getElementById('shop-buy-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Buying…';

  // The stock is one shared pile — the claim is staked atomically first, so the
  // player who loses a race for the last sword is told and is not charged.
  let committed = false;
  try {
    const res = await firebaseDb
      .ref(`${_getShopsPath(shopBuyTarget.shopId)}/stock/${shopBuyTarget.entryId}`)
      .transaction(cur => {
        if (!cur) return;                            // pulled from the shelf meanwhile
        if (cur.qty === SHOP_UNLIMITED) return cur;
        if ((cur.qty ?? 0) < count) return;          // someone got there first
        cur.qty -= count;
        return cur;
      });
    committed = res.committed;
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Buy';
    _showBuyError({ error: 'network', message: e.message });
    return;
  }

  btn.disabled = false;
  btn.textContent = 'Buy';
  if (!committed) { _showBuyError({ error: 'gone' }); updateBuySummary(); return; }

  // The purse could have moved under us while the claim was in flight (a cloud
  // save from another device). Re-plan against what is there now; fall back to
  // the original only if the fresh plan cannot be paid — the stock is claimed.
  const fresh = _planPayment(priceCp);
  _applyPayment(fresh.error ? plan : fresh);
  _grantPurchase(entry, count);
  hideModal('shop-buy-modal');
}
