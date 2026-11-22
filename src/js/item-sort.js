// =============================================================================
// ITEM-SORT — The order the Browse list puts items in
// =============================================================================
'use strict';

// A catalogue-view preference with its own localStorage key, never saved or
// synced. Every mode is a chain of keys so ties stay stable; the reverse toggle
// negates the whole chain, not just the leading key.

const ITEM_SORT_KEY = 'dnd_inventory_sort';

const ITEM_SORT_KEYS = {
  // Descending: an unknown rarity indexes -1 and falls to the bottom.
  rarity: (a, b) => RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity),
  name:   (a, b) => a.name.localeCompare(b.name),
  weight: (a, b) => _getItemSortWeight(a) - _getItemSortWeight(b),
};

// First entry is the default; the menu is built from this list. `dir` names the
// two directions in that mode's own words ("Worst first", not "reversed").
const ITEM_SORTS = [
  { id: 'rarity', label: 'Rarity', keys: ['rarity', 'name', 'weight'], dir: ['Best first', 'Worst first'] },
  { id: 'name',   label: 'Name',   keys: ['name', 'rarity', 'weight'], dir: ['A to Z', 'Z to A'] },
  { id: 'weight', label: 'Weight', keys: ['weight', 'rarity', 'name'], dir: ['Lightest first', 'Heaviest first'] },
];

const sortMenuEl   = document.getElementById('sort-menu');
const sortBtnEl    = document.getElementById('sort-btn');
const sortDirBtnEl = document.getElementById('sort-dir-btn');

// What a card claims to weigh, the same figure the Browse card prints, so the
// order matches what the reader can see.
function _getItemSortWeight(t) {
  return isStackable(t) ? getItemUnitWeight(t) : getShapeWeight(t.shape);
}

function _getItemSort() {
  return ITEM_SORTS.find(s => s.id === state.itemSort) ?? ITEM_SORTS[0];
}

// Read the stored sort mode and direction into state. A value that is not JSON
// is a bare mode id, read with the default direction.
function loadItemSort() {
  try {
    const raw = localStorage.getItem(ITEM_SORT_KEY);
    if (raw) {
      const data = raw.startsWith('{') ? JSON.parse(raw) : { id: raw };
      if (ITEM_SORTS.some(s => s.id === data.id)) state.itemSort = data.id;
      state.itemSortReverse = !!data.reverse;
    }
  } catch (e) { /* storage disabled or corrupt: the defaults stand */ }
  _updateSortButton();
}

function _saveItemSort() {
  try {
    localStorage.setItem(ITEM_SORT_KEY, JSON.stringify({
      id: state.itemSort,
      reverse: state.itemSortReverse,
    }));
  } catch (e) { /* non-fatal */ }
}

function _setItemSort(id) {
  if (!ITEM_SORTS.some(s => s.id === id)) return;
  state.itemSort = id;
  _saveItemSort();
  _updateSortButton();
}

function _setItemSortReverse(isReversed) {
  state.itemSortReverse = !!isReversed;
  _saveItemSort();
  _updateSortButton();
}

// Sort templates by the chosen mode and direction. Sorts in place and returns
// the same array, the way Array#sort does.
function sortItems(items) {
  const chain = _getItemSort().keys.map(k => ITEM_SORT_KEYS[k]);
  const sign = state.itemSortReverse ? -1 : 1;
  return items.sort((a, b) => {
    for (const compare of chain) {
      const d = compare(a, b);
      if (d !== 0) return d * sign;
    }
    return 0;
  });
}

// ─── SORT MENU (built from ITEM_SORTS, not written into index.html) ───
// The arrow points the way the chain runs: down for the mode's own order, up
// for its reverse.
function _updateSortButton() {
  const sort = _getItemSort();
  sortBtnEl.textContent = '⇅ ' + sort.label;
  sortBtnEl.title = `Sorted by ${sort.label.toLowerCase()} — click to change`;
  sortDirBtnEl.textContent = state.itemSortReverse ? '↑' : '↓';
  sortDirBtnEl.title = `${sort.dir[state.itemSortReverse ? 1 : 0]} — click to reverse`;
}

function _buildSortMenu() {
  sortMenuEl.innerHTML = '';
  ITEM_SORTS.forEach(sort => {
    const btn = document.createElement('button');
    const check = document.createElement('span');
    check.className = 'sort-check';
    check.textContent = sort.id === _getItemSort().id ? '✓' : '';
    btn.appendChild(check);
    btn.appendChild(document.createTextNode(sort.label));
    btn.addEventListener('click', () => {
      _hideSortMenu();
      _setItemSort(sort.id);
      renderItemList();
    });
    sortMenuEl.appendChild(btn);
  });
}

function _showSortMenu() {
  _buildSortMenu();
  sortMenuEl.classList.remove('hidden');
  // Anchored under the button, and nudged back on screen if the panel is narrow
  // enough that the menu would hang off the right edge.
  const r = sortBtnEl.getBoundingClientRect();
  const w = sortMenuEl.offsetWidth;
  sortMenuEl.style.left = Math.max(4, Math.min(r.left, window.innerWidth - w - 4)) + 'px';
  sortMenuEl.style.top  = (r.bottom + 4) + 'px';
}

function _hideSortMenu() {
  sortMenuEl.classList.add('hidden');
}

sortDirBtnEl.addEventListener('click', () => {
  _setItemSortReverse(!state.itemSortReverse);
  renderItemList();
});

sortBtnEl.addEventListener('click', e => {
  e.stopPropagation(); // the document listener below would close it again
  if (sortMenuEl.classList.contains('hidden')) _showSortMenu();
  else _hideSortMenu();
});
document.addEventListener('click', _hideSortMenu);
