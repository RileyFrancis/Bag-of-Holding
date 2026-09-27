// =============================================================================
// SHEET LAYOUT — the character sheet's sections as rearrangeable widgets
// =============================================================================
'use strict';

// Each sheet section is a widget; where the widgets sit is a tree of splits, not
// a list. A widget has no width of its own — it fills its slot, and the drop
// chooses which slot, so a section's extent is set by the depth it was dropped
// at. A node is `{ t:'w', id, size }` or `{ t:'s', dir:'row'|'col', size, kids[] }`.
//
//   col[ Proficiencies, row[ Abilities, col[ Combat, HP ] ] ]
//
// The JS writes only `--share` on a node; sheet-layout.css spends it per the
// parent's direction — horizontal splits share width and get a draggable seam,
// vertical ones stack at natural height. The identity block is pinned outside
// `#sheet-layout` and is not in the tree. The layout is this browser's furniture
// (own localStorage key, not saved, not synced) — so a read-only sheet is still
// rearrangeable. See CLAUDE.md § The sheet's layout.

const SHEET_LAYOUT_KEY = 'dnd_inventory_sheet_layout';

// How far inside the layout's rim a drop targets the *root* (a full-width band /
// full-height column) rather than splitting the section under the cursor.
const SHEET_RIM = 24;

// The narrowest a section may be — one number for both: a seam will not drag a
// column below it, and a row whose width cannot give every child that much stops
// being a row and stacks (`foldNarrowRows`).
const SHEET_MIN_COL = 200;

// Movement that turns a press on a title into a drag rather than a click.
const SHEET_DRAG_SLOP = 4;

// The widgets, in index.html order. Read from the markup, not written out again
// here — the sections ARE the markup.
const SHEET_WIDGET_IDS = Array.from(
  document.querySelectorAll('#sheet-widget-store .sheet-widget')
).map(el => el.dataset.widget);

// =============================================================================
// THE TREE
// =============================================================================
// A node is `{ t:'w', id, size }` or `{ t:'s', dir:'row'|'col', size, kids:[…] }`.
// `size` is the node's share of its parent — used only by `row` parents. Stored
// on the node so it travels with the node when one is moved.

function sheetWidgetNode(id, size) { return { t: 'w', id, size: size ?? 1 }; }

// The sheet as it has always looked below the identity block: Abilities & Skills
// beside a column of the shorter boxes, at the same 2:1 `flex: 2 1 420px` used
// to give it.
function defaultSheetLayout() {
  return {
    t: 's', dir: 'col', size: 1,
    kids: [
      {
        t: 's', dir: 'row', size: 1,
        kids: [
          sheetWidgetNode('abilities', 2),
          {
            t: 's', dir: 'col', size: 1,
            kids: ['statuses', 'combat', 'hp', 'death', 'prof'].map(id => sheetWidgetNode(id)),
          },
        ],
      },
      // Bands across the bottom — a run of feature cards and the written sections
      // want the width. Species sits beside Class Features because the two read
      // together.
      {
        t: 's', dir: 'row', size: 1,
        kids: [sheetWidgetNode('features'), sheetWidgetNode('species')],
      },
      sheetWidgetNode('backstory'),
      sheetWidgetNode('appearance'),
    ],
  };
}

let sheetLayout = null;

// Tidies a tree into one canonical shape, after every edit — without it the tree
// accumulates rubbish (a split holding one child, a row nested in a row, an
// emptied container) that makes the next drop behave oddly. Mutates and returns,
// preserving node identity, because a drop holds a reference to the node it
// landed on.
function normalizeSheetLayout(node) {
  if (!node) return null;
  if (node.t === 'w') return node;

  const kids = [];
  node.kids.forEach(kid => {
    const n = normalizeSheetLayout(kid);
    if (!n) return;
    if (n.t === 's' && n.dir === node.dir) {
      // A row inside a row is the same row — fold it in, scaling its children so
      // they keep between them exactly the share the container had.
      const total = n.kids.reduce((sum, k) => sum + k.size, 0) || 1;
      n.kids.forEach(k => { k.size = k.size / total * n.size; kids.push(k); });
      return;
    }
    kids.push(n);
  });

  if (kids.length === 0) return null;
  if (kids.length === 1) { kids[0].size = node.size; return kids[0]; }
  node.kids = kids;
  return node;
}

function eachSheetNode(node, fn) {
  if (!node) return;
  fn(node);
  if (node.t === 's') node.kids.forEach(k => eachSheetNode(k, fn));
}

function findSheetWidgetNode(id) {
  let found = null;
  eachSheetNode(sheetLayout, n => { if (n.t === 'w' && n.id === id) found = n; });
  return found;
}

function findSheetParent(node, child) {
  if (!node || node.t !== 's') return null;
  if (node.kids.includes(child)) return node;
  for (const kid of node.kids) {
    const p = findSheetParent(kid, child);
    if (p) return p;
  }
  return null;
}

// Takes a widget out of the tree wherever it is. The caller normalizes after —
// the same pass that closes the hole is the one that folds emptied containers away.
function detachSheetWidget(node, id) {
  if (!node || node.t !== 's') return false;
  const i = node.kids.findIndex(k => k.t === 'w' && k.id === id);
  if (i >= 0) { node.kids.splice(i, 1); return true; }
  return node.kids.some(k => detachSheetWidget(k, id));
}

// Every widget exactly once, no unknown ids, a shape that draws. Runs on whatever
// came out of localStorage, which may be from an older version with a different
// set of sections.
function sanitizeSheetLayout(raw) {
  const seen = new Set();

  function walk(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.t === 'w') {
      if (!SHEET_WIDGET_IDS.includes(node.id) || seen.has(node.id)) return null;
      seen.add(node.id);
      return sheetWidgetNode(node.id, sizeOrOne(node.size));
    }
    if (node.t !== 's' || !Array.isArray(node.kids)) return null;
    return {
      t: 's',
      dir: node.dir === 'row' ? 'row' : 'col',
      size: sizeOrOne(node.size),
      kids: node.kids.map(walk).filter(Boolean),
    };
  }

  let tree = normalizeSheetLayout(walk(raw));

  // A section added after this layout was stored — down the bottom is the one
  // answer that displaces nothing.
  const missing = SHEET_WIDGET_IDS.filter(id => !seen.has(id));
  if (missing.length) {
    const added = missing.map(id => sheetWidgetNode(id));
    tree = normalizeSheetLayout(
      tree ? { t: 's', dir: 'col', size: 1, kids: [tree, ...added] }
           : { t: 's', dir: 'col', size: 1, kids: added }
    );
  }
  return tree ?? normalizeSheetLayout(defaultSheetLayout());
}

function sizeOrOne(n) {
  const v = parseFloat(n);
  return Number.isFinite(v) && v > 0.01 ? v : 1;
}

// =============================================================================
// PERSISTENCE
// =============================================================================
function loadSheetLayout() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(SHEET_LAYOUT_KEY)); } catch (e) { raw = null; }
  sheetLayout = sanitizeSheetLayout(raw ?? defaultSheetLayout());
}

function saveSheetLayout() {
  try { localStorage.setItem(SHEET_LAYOUT_KEY, JSON.stringify(sheetLayout)); } catch (e) { /* full or blocked */ }
}

// No caller yet — the button it used to sit behind has been taken off the page,
// waiting to be wired up somewhere better (Settings). Kept because the
// arrangement is otherwise only recoverable by clearing browser storage.
function resetSheetLayout() {
  sheetLayout = normalizeSheetLayout(defaultSheetLayout());
  saveSheetLayout();
  renderSheetLayout();
}

// =============================================================================
// RENDERING
// =============================================================================
// Builds the split containers and *moves* the widget elements into them. The
// widgets are never rebuilt — they are the static markup from index.html, with
// every id, value and listener — so a rearrange cannot cost an input its
// contents. Called when the sheet is first built and after a drop or reset; NOT
// from `renderCharacterSheet()`, which runs on every roster update.
function renderSheetLayout() {
  const host = document.getElementById('sheet-layout');
  const store = document.getElementById('sheet-widget-store');
  if (!host || !store) return;
  if (!sheetLayout) loadSheetLayout();

  // Park the widgets before clearing the scaffolding, or emptying the host
  // destroys them with it.
  host.querySelectorAll('.sheet-widget').forEach(el => store.appendChild(el));
  host.innerHTML = '';
  host.appendChild(buildSheetNode(sheetLayout));
  foldNarrowRows();
}

function buildSheetNode(node) {
  const el = node.t === 'w' ? sheetWidgetEl(node.id) : buildSheetSplit(node);
  applySheetNodeSize(el, node);
  return el;
}

function buildSheetSplit(node) {
  const box = document.createElement('div');
  box.className = 'sheet-split';
  box.dataset.dir = node.dir;

  node.kids.forEach((kid, i) => {
    // A seam per gap, and only in a row — a column's children are their own
    // height and have nothing to divide.
    if (i > 0 && node.dir === 'row') box.appendChild(sheetSeamEl(node, i - 1));
    box.appendChild(buildSheetNode(kid));
  });
  return box;
}

// A node's share of its parent, and only that. Whether it is spent on width or
// ignored for natural height is settled in sheet-layout.css by the parent's
// direction — which is what lets a row fold into a column with one class.
function applySheetNodeSize(el, node) {
  el.style.setProperty('--share', node.size);
}

// A row too narrow to give every child `SHEET_MIN_COL` stops being a row and
// stacks — the same fold the sheet has always done, moved from `flex-wrap`
// (which cannot honour the shares the seams set) to a measurement. Applied
// outermost-in, which `querySelectorAll`'s document order gives for free. The
// hysteresis is not a nicety: folding makes the sheet taller, a taller sheet can
// bring in the scrollbar, and the scrollbar takes back the width that was
// measured. `scrollbar-gutter: stable` removes most of it; this makes it
// impossible.
const SHEET_FOLD_SLACK = 28;

function foldNarrowRows() {
  const host = document.getElementById('sheet-layout');
  if (!host) return;
  host.querySelectorAll('.sheet-split[data-dir="row"]').forEach(row => {
    const kids = row.querySelectorAll(':scope > :not(.sheet-seam)').length;
    const need = kids * SHEET_MIN_COL;
    const width = row.getBoundingClientRect().width;
    if (row.classList.contains('folded')) {
      if (width >= need + SHEET_FOLD_SLACK) row.classList.remove('folded');
    } else if (width < need) {
      row.classList.add('folded');
    }
  });
}

function sheetWidgetEl(id) {
  return document.querySelector(`.sheet-widget[data-widget="${id}"]`);
}

function sheetWidgetLabel(id) {
  const el = sheetWidgetEl(id);
  return el ? el.querySelector('.widget-title').textContent.trim() : id;
}

// =============================================================================
// RESIZING A ROW
// =============================================================================
// The seam between two of a row's children moves width from one to the other and
// leaves every other child alone. Double-click evens the two out.
function sheetSeamEl(split, index) {
  const seam = document.createElement('div');
  seam.className = 'sheet-seam';
  seam.title = 'Drag to resize · double-click to even out';

  seam.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    seam.setPointerCapture(e.pointerId);
    seam.classList.add('dragging');

    const a = split.kids[index], b = split.kids[index + 1];
    const aEl = seam.previousElementSibling, bEl = seam.nextElementSibling;
    const startX = e.clientX;
    const aPx = aEl.getBoundingClientRect().width;
    const bPx = bEl.getBoundingClientRect().width;
    const totalPx = aPx + bPx;
    const totalSize = a.size + b.size;

    const onMove = ev => {
      // Clamped in pixels, not shares — "too narrow" is a width on screen.
      const wanted = Math.max(SHEET_MIN_COL, Math.min(totalPx - SHEET_MIN_COL, aPx + (ev.clientX - startX)));
      a.size = totalSize * (wanted / totalPx);
      b.size = totalSize - a.size;
      applySheetNodeSize(aEl, a);
      applySheetNodeSize(bEl, b);
    };
    const onUp = () => {
      seam.classList.remove('dragging');
      seam.removeEventListener('pointermove', onMove);
      seam.removeEventListener('pointerup', onUp);
      seam.removeEventListener('pointercancel', onUp);
      saveSheetLayout();
    };
    seam.addEventListener('pointermove', onMove);
    seam.addEventListener('pointerup', onUp);
    seam.addEventListener('pointercancel', onUp);
  });

  seam.addEventListener('dblclick', () => {
    const a = split.kids[index], b = split.kids[index + 1];
    const half = (a.size + b.size) / 2;
    a.size = b.size = half;
    saveSheetLayout();
    renderSheetLayout();
  });

  return seam;
}

// =============================================================================
// DRAGGING A SECTION
// =============================================================================
// Press on a section's title and move — pointer events and bounding-rect hit
// tests, not the HTML5 DnD API, to agree with the browse list and equip rack.
let sheetDrag = null;

document.getElementById('character-sheet').addEventListener('pointerdown', e => {
  const title = e.target.closest('.widget-title');
  if (!title || e.button !== 0) return;
  // A section's header may carry its own controls (Class Features's show/hide) —
  // pressing one is not the start of a drag.
  if (e.target.closest('button, a, input, select, textarea')) return;
  const widget = title.closest('.sheet-widget');
  if (!widget || !widget.closest('#sheet-layout')) return;

  e.preventDefault(); // or the title's text selects instead of dragging
  sheetDrag = {
    id: widget.dataset.widget,
    el: widget,
    startX: e.clientX,
    startY: e.clientY,
    live: false,
    target: null,
    pointerId: e.pointerId,
  };
  window.addEventListener('pointermove', onSheetDragMove);
  window.addEventListener('pointerup', onSheetDragEnd);
  window.addEventListener('pointercancel', onSheetDragCancel);
  window.addEventListener('keydown', onSheetDragKey, true);
});

function onSheetDragMove(e) {
  if (!sheetDrag) return;
  if (!sheetDrag.live) {
    // A press that never moves is a click on a heading.
    if (Math.abs(e.clientX - sheetDrag.startX) < SHEET_DRAG_SLOP &&
        Math.abs(e.clientY - sheetDrag.startY) < SHEET_DRAG_SLOP) return;
    sheetDrag.live = true;
    document.getElementById('character-sheet').classList.add('sheet-arranging');
    sheetDrag.el.classList.add('dragging');
    // The sheet is taller than the panel, so the slot being aimed at is often
    // scrolled out of sight. Same edge pull the browse list and grid use.
    startDragAutoScroll(e.clientX, e.clientY, sheetDragRefresh);
  }
  updateDragAutoScroll(e.clientX, e.clientY);
  sheetDragRefresh(e.clientX, e.clientY);
}

// Re-run on a frame that auto-scrolled: the cursor has not moved but the
// sections under it have.
function sheetDragRefresh(x, y) {
  if (!sheetDrag) return;
  sheetDrag.target = sheetDropTargetAt(x, y);
  showSheetDropFeedback(sheetDrag.target, x, y);
}

function onSheetDragEnd() {
  const drag = sheetDrag;
  if (!drag) return;
  endSheetDrag();
  if (!drag.live || !drag.target) return;
  applySheetDrop(drag.id, drag.target);
}

function onSheetDragCancel() { endSheetDrag(); }

function onSheetDragKey(e) {
  if (e.key === 'Escape' && sheetDrag) { e.stopPropagation(); endSheetDrag(); }
}

function endSheetDrag() {
  if (!sheetDrag) return;
  stopDragAutoScroll();
  sheetDrag.el.classList.remove('dragging');
  document.getElementById('character-sheet').classList.remove('sheet-arranging');
  hideSheetDropFeedback();
  sheetDrag = null;
  window.removeEventListener('pointermove', onSheetDragMove);
  window.removeEventListener('pointerup', onSheetDragEnd);
  window.removeEventListener('pointercancel', onSheetDragCancel);
  window.removeEventListener('keydown', onSheetDragKey, true);
}

// =============================================================================
// WHERE THE DROP LANDS
// =============================================================================
//   `root`   — cursor on the sheet's rim: a band across the full width / height.
//   a widget — cursor over a section: that section's slot splits, and the arrival
//              is stopped by whatever already bounds that slot.
// The rim is tested first and is thin. Everywhere else resolves to a section (a
// drag that lands on nothing reads as broken), so a cursor in a gap takes the
// nearer one.
function sheetDropTargetAt(x, y) {
  const host = document.getElementById('sheet-layout');
  const paper = document.querySelector('#character-sheet .sheet-scroll');
  if (!host || !paper) return null;

  const pr = paper.getBoundingClientRect();
  if (x < pr.left || x > pr.right || y < pr.top || y > pr.bottom) return null;

  const hr = host.getBoundingClientRect();

  // Distances to the layout's four edges. Only an on-screen edge can be close —
  // scroll the sheet away from the top and `dTop` grows past the band on its own.
  const d = {
    top: y - hr.top, bottom: hr.bottom - y,
    left: x - hr.left, right: hr.right - x,
  };
  const nearest = Object.keys(d).reduce((a, b) => (d[a] <= d[b] ? a : b));
  if (d[nearest] < SHEET_RIM) return { root: true, edge: nearest, rect: hr };

  // Otherwise: the section under the cursor, or the nearest to it.
  let best = null, bestDist = Infinity;
  host.querySelectorAll('.sheet-widget').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) { bestDist = dist; best = { el, rect: r }; }
  });
  if (!best) return null;

  const node = findSheetWidgetNode(best.el.dataset.widget);
  if (!node) return null;
  return { root: false, node, el: best.el, rect: best.rect, edge: nearestEdgeOf(best.rect, x, y) };
}

// Which edge the cursor is nearest, as a FRACTION of each dimension rather than
// in pixels — a section can be short and wide or tall and narrow.
function nearestEdgeOf(r, x, y) {
  const fx = (x - r.left) / (r.width || 1);
  const fy = (y - r.top) / (r.height || 1);
  const f = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  return Object.keys(f).reduce((a, b) => (f[a] <= f[b] ? a : b));
}

// =============================================================================
// DROP FEEDBACK
// =============================================================================
// The shaded slab is where the section will go; the chip names the drop, because
// on a long sheet the slab often runs off the bottom and "full width" and
// "beside Combat" then look the same. Both from this one call.
function showSheetDropFeedback(target, x, y) {
  const zone = document.getElementById('sheet-drop-zone');
  const hint = document.getElementById('sheet-drop-hint');
  const paper = document.querySelector('#character-sheet .sheet-scroll');
  if (!zone || !hint || !paper) return;

  // Dropping a section back onto itself is not a move — say so rather than
  // showing a slab where it already is.
  const onSelf = target && !target.root && target.node.id === sheetDrag.id;
  if (!target || onSelf) {
    zone.classList.add('hidden');
    if (!target) { hint.classList.add('hidden'); return; }
  }

  const base = paper.getBoundingClientRect();

  if (target && !onSelf) {
    const r = target.rect;
    // The rim's slab is a band along the sheet's edge; a section's is the half
    // of it the arrival will take.
    const depth = target.root
      ? Math.max(56, (target.edge === 'top' || target.edge === 'bottom' ? r.height : r.width) * 0.18)
      : (target.edge === 'top' || target.edge === 'bottom' ? r.height : r.width) / 2;

    const box = {
      left: r.left, top: r.top, width: r.width, height: r.height,
    };
    if (target.edge === 'top')    box.height = depth;
    if (target.edge === 'bottom') { box.top = r.bottom - depth; box.height = depth; }
    if (target.edge === 'left')   box.width = depth;
    if (target.edge === 'right')  { box.left = r.right - depth; box.width = depth; }

    zone.classList.remove('hidden');
    zone.classList.toggle('root', !!target.root);
    zone.style.left   = (box.left - base.left) + 'px';
    zone.style.top    = (box.top - base.top) + 'px';
    zone.style.width  = box.width + 'px';
    zone.style.height = box.height + 'px';
  }

  hint.classList.remove('hidden');
  hint.classList.toggle('inert', !!onSelf);
  hint.textContent = describeSheetDrop(target, onSelf);
  // Measured after the text is in — the chip is as wide as the section's name.
  const hw = hint.offsetWidth, hh = hint.offsetHeight;
  const flipX = x + 16 + hw > window.innerWidth;
  hint.style.left = (x - base.left + (flipX ? -16 - hw : 16)) + 'px';
  hint.style.top  = (y - base.top - hh - 12) + 'px';
}

function describeSheetDrop(target, onSelf) {
  if (onSelf) return 'Back where it started';
  if (target.root) {
    return {
      top: 'Full width, across the top',
      bottom: 'Full width, across the bottom',
      left: 'Full height, down the left',
      right: 'Full height, down the right',
    }[target.edge];
  }
  const name = sheetWidgetLabel(target.node.id);
  return { left: 'Left of ', right: 'Right of ', top: 'Above ', bottom: 'Below ' }[target.edge] + name;
}

function hideSheetDropFeedback() {
  document.getElementById('sheet-drop-zone').classList.add('hidden');
  document.getElementById('sheet-drop-hint').classList.add('hidden');
}

// =============================================================================
// APPLYING THE DROP
// =============================================================================
// Take the section out, normalize, then put it back where the drop said — in
// that order, so the tree the insert works on is the one the drop will produce.
function applySheetDrop(id, target) {
  if (!target.root && target.node.id === id) return;

  const moving = findSheetWidgetNode(id);
  if (!moving) return;

  detachSheetWidget(sheetLayout, id);
  sheetLayout = normalizeSheetLayout(sheetLayout);
  // Nothing left to be moved relative to.
  if (!sheetLayout || sheetLayout === moving) { sheetLayout = moving; return; }
  if (target.root) sheetLayout = insertAtSheetRoot(moving, target.edge);
  else sheetLayout = insertBesideSheetNode(moving, target.node, target.edge);

  sheetLayout = normalizeSheetLayout(sheetLayout);
  saveSheetLayout();
  renderSheetLayout();
}

// The section splits the target's slot. If the target already sits in a split
// running the right way, the arrival joins beside it and takes half its share
// (so nothing else shuffles); otherwise the target's slot becomes a new split
// holding the two.
function insertBesideSheetNode(moving, target, edge) {
  const dir = (edge === 'left' || edge === 'right') ? 'row' : 'col';
  const before = (edge === 'left' || edge === 'top');
  const parent = findSheetParent(sheetLayout, target);

  if (parent && parent.dir === dir) {
    const i = parent.kids.indexOf(target);
    target.size = target.size / 2;
    moving.size = target.size;
    parent.kids.splice(before ? i : i + 1, 0, moving);
    return sheetLayout;
  }

  const split = { t: 's', dir, size: target.size, kids: [] };
  target.size = 1;
  moving.size = 1;
  split.kids = before ? [moving, target] : [target, moving];

  if (!parent) return split;                              // the target was the root
  parent.kids[parent.kids.indexOf(target)] = split;
  return sheetLayout;
}

// The rim: a band across the whole sheet. Joins the root split when it already
// runs the right way, else the whole layout is demoted to one side of a new one.
function insertAtSheetRoot(moving, edge) {
  const dir = (edge === 'left' || edge === 'right') ? 'row' : 'col';
  const before = (edge === 'left' || edge === 'top');
  moving.size = 1;

  if (sheetLayout.t === 's' && sheetLayout.dir === dir) {
    sheetLayout.kids.splice(before ? 0 : sheetLayout.kids.length, 0, moving);
    return sheetLayout;
  }
  sheetLayout.size = 1;
  return {
    t: 's', dir, size: 1,
    kids: before ? [moving, sheetLayout] : [sheetLayout, moving],
  };
}

// =============================================================================
// WIRING
// =============================================================================
// Called from `buildCharacterSheet()`, so the layout is put together with the
// rest of the sheet the first time it is shown and not before.
function ensureSheetLayout() {
  loadSheetLayout();
  renderSheetLayout();
  watchSheetWidth();
}

// The panel is dragged wider and narrower, and whether a row still has room to
// be a row changes as it does. Only the folds are recomputed — never the tree,
// never the DOM.
let sheetWidthObserver = null;
let lastSheetWidth = -1;

function watchSheetWidth() {
  if (sheetWidthObserver || typeof ResizeObserver === 'undefined') return;
  sheetWidthObserver = new ResizeObserver(entries => {
    // Width only. Folding a row changes the layout's height, which would
    // otherwise call this straight back to answer the same question.
    const w = Math.round(entries[0].contentRect.width);
    if (w === lastSheetWidth) return;
    lastSheetWidth = w;
    foldNarrowRows();
  });
  sheetWidthObserver.observe(document.getElementById('sheet-layout'));
}
