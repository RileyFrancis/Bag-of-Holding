// =============================================================================
// SHAPE PAINTER — The item shape editor, a dialog over the item form
// =============================================================================
'use strict';

// Both item forms (the New Item dialog, the homebrew editor's Item kind) show a
// small preview of the shape and open this to change it. Press on a cell and
// drag to paint; starting on a filled cell erases instead. There are no row or
// column buttons: the canvas keeps a margin of empty cells around the shape and
// grows *while* you paint into it, as tools/item-editor.html's grid does, and
// Done crops the result back down to the shape itself (normalizeShape()).
//
// Growing must not move a cell out from under the pointer mid-stroke. So the
// grid is positioned by hand inside a fixed-size scroll area rather than
// centred by layout: rows or columns added on the top or left move the grid
// up or left by exactly what they add, and the cells already there stay put.

const SHAPE_PAINTER_MARGIN = 2;  // empty cells kept on every side of the shape
const SHAPE_PAINTER_MIN    = 5;  // the canvas is never smaller than this square
const SHAPE_PAINTER_PITCH  = 30; // one cell plus the gap: 28px + 2px (modals.css)
// The biggest an item may be either way. Wider than GRID_COLS could never be
// placed in an inventory; taller is held to the same, the grid being square-ish.
const SHAPE_MAX_CELLS      = GRID_COLS;

const shapePainterEl       = document.getElementById('shape-modal');
const shapePainterScrollEl = document.getElementById('shape-painter-scroll');
const shapePainterGridEl   = document.getElementById('shape-painter-grid');

// The canvas being painted, where its top-left corner sits in the scroll area
// (px), and who gets the result. Null while closed.
let shapePainter = null; // { canvas: 0/1 rows, x, y, onDone }
// The stroke under way: 1 paints, 0 erases. Null between strokes.
let shapeStroke = null;

function openShapePainter(shape, onDone) {
  shapePainter = { canvas: normalizeShape(shape).map(r => [...r]), x: 0, y: 0, onDone };
  showModal('shape-modal'); // first, so the scroll area can be measured
  resetShapePainter();
}

// Grows the canvas to its margins and centres it in the scroll area — on
// opening and after Clear, the only times the grid is allowed to jump.
function resetShapePainter() {
  growShapeCanvas();
  const { canvas } = shapePainter;
  const w = canvas[0].length * SHAPE_PAINTER_PITCH, h = canvas.length * SHAPE_PAINTER_PITCH;
  shapePainter.x = Math.max(0, Math.floor((shapePainterScrollEl.clientWidth - w) / 2));
  shapePainter.y = Math.max(0, Math.floor((shapePainterScrollEl.clientHeight - h) / 2));
  shapePainterScrollEl.scrollLeft = shapePainterScrollEl.scrollTop = 0;
  renderShapePainter();
}

function closeShapePainter(apply) {
  if (!shapePainter) return;
  const { canvas, onDone } = shapePainter;
  shapePainter = null;
  shapeStroke = null;
  hideModal('shape-modal');
  if (apply) onDone(normalizeShape(canvas));
}

// Adds whatever rows and columns the canvas needs to keep SHAPE_PAINTER_MARGIN
// empty cells on every side of the shape, and to be SHAPE_PAINTER_MIN square.
// Only ever grows — an erase never pulls the canvas in; Done does the cropping.
// Returns whether anything was added.
function growShapeCanvas() {
  const p = shapePainter;
  let s = p.canvas;
  let minR = Infinity, maxR = -1, minC = Infinity, maxC = -1;
  s.forEach((row, r) => row.forEach((v, c) => {
    if (!v) return;
    minR = Math.min(minR, r); maxR = Math.max(maxR, r);
    minC = Math.min(minC, c); maxC = Math.max(maxC, c);
  }));

  let top = 0, bottom = 0, left = 0, right = 0;
  if (maxR >= 0) {
    // No margin past what the shape may still grow into: a shape already
    // SHAPE_MAX_CELLS wide gets no new columns at all.
    const roomR = Math.min(SHAPE_PAINTER_MARGIN, SHAPE_MAX_CELLS - (maxR - minR + 1));
    const roomC = Math.min(SHAPE_PAINTER_MARGIN, SHAPE_MAX_CELLS - (maxC - minC + 1));
    top    = Math.max(0, roomR - minR);
    bottom = Math.max(0, roomR - (s.length - 1 - maxR));
    left   = Math.max(0, roomC - minC);
    right  = Math.max(0, roomC - (s[0].length - 1 - maxC));
  }
  // Short of the minimum, split evenly so the shape stays central.
  const shortRows = Math.max(0, SHAPE_PAINTER_MIN - (s.length + top + bottom));
  const shortCols = Math.max(0, SHAPE_PAINTER_MIN - (s[0].length + left + right));
  top += Math.floor(shortRows / 2);  bottom += Math.ceil(shortRows / 2);
  left += Math.floor(shortCols / 2); right += Math.ceil(shortCols / 2);
  if (!(top || bottom || left || right)) return false;

  const blank = n => Array(n).fill(0);
  s = s.map(r => [...blank(left), ...r, ...blank(right)]);
  const w = s[0].length;
  p.canvas = [...Array.from({ length: top }, () => blank(w)), ...s,
              ...Array.from({ length: bottom }, () => blank(w))];
  // Pull the grid back by what was added above and to the left, so the cells
  // already there don't move.
  p.x -= left * SHAPE_PAINTER_PITCH;
  p.y -= top * SHAPE_PAINTER_PITCH;
  return true;
}

function renderShapePainter() {
  const p = shapePainter;
  // Past the area's top or left edge there is nothing to scroll back to, so the
  // grid is set at the edge and the area scrolled by the difference instead —
  // the same picture, as long as there is room to scroll.
  const dx = Math.max(0, -p.x), dy = Math.max(0, -p.y);
  p.x += dx;
  p.y += dy;
  shapePainterGridEl.style.left = p.x + 'px';
  shapePainterGridEl.style.top  = p.y + 'px';
  shapePainterGridEl.style.gridTemplateColumns = `repeat(${p.canvas[0].length}, 28px)`;
  shapePainterGridEl.innerHTML = '';
  p.canvas.forEach((row, r) => row.forEach((v, c) => {
    const cell = document.createElement('div');
    cell.className = 'shape-cell';
    cell.dataset.r = r;
    cell.dataset.c = c;
    shapePainterGridEl.appendChild(cell);
  }));
  shapePainterScrollEl.scrollLeft += dx;
  shapePainterScrollEl.scrollTop  += dy;
  refreshShapeCells();
}

// Fills in the cells, and greys out every empty one that painting would push
// the shape past SHAPE_MAX_CELLS — which ones depends on the whole shape, so it
// is all of them, every change.
function refreshShapeCells() {
  const canvas = shapePainter.canvas;
  const box = shapeBounds(canvas);
  shapePainterGridEl.querySelectorAll('.shape-cell').forEach(cell => {
    const r = +cell.dataset.r, c = +cell.dataset.c;
    const on = !!canvas[r][c];
    cell.classList.toggle('on', on);
    cell.classList.toggle('blocked', !on && !shapeCellAllowed(box, r, c));
  });
  updateShapePainterReadout();
}

function updateShapePainterReadout() {
  const cropped = normalizeShape(shapePainter.canvas);
  const weight = shapeCellCount(cropped);
  document.getElementById('shape-painter-weight').textContent = weight;
  document.getElementById('shape-painter-size').textContent =
    weight ? `${cropped[0].length} × ${cropped.length}` : '—';
  // An item has to take up at least one cell.
  document.getElementById('shape-painter-done').disabled = !weight;
}

// The filled cells' bounding box, or null for an empty canvas.
function shapeBounds(canvas) {
  let box = null;
  canvas.forEach((row, r) => row.forEach((v, c) => {
    if (!v) return;
    if (!box) box = { minR: r, maxR: r, minC: c, maxC: c };
    box.minR = Math.min(box.minR, r); box.maxR = Math.max(box.maxR, r);
    box.minC = Math.min(box.minC, c); box.maxC = Math.max(box.maxC, c);
  }));
  return box;
}

// Whether filling (r, c) keeps the shape within SHAPE_MAX_CELLS each way.
function shapeCellAllowed(box, r, c) {
  if (!box) return true;
  return Math.max(box.maxC, c) - Math.min(box.minC, c) + 1 <= SHAPE_MAX_CELLS
      && Math.max(box.maxR, r) - Math.min(box.minR, r) + 1 <= SHAPE_MAX_CELLS;
}

function paintShapeCell(cell) {
  if (!cell || !cell.classList.contains('shape-cell')) return;
  const r = +cell.dataset.r, c = +cell.dataset.c;
  const canvas = shapePainter.canvas;
  if (canvas[r][c] === shapeStroke) return;
  if (shapeStroke && !shapeCellAllowed(shapeBounds(canvas), r, c)) return;
  canvas[r][c] = shapeStroke;
  // Painting toward an edge grows the canvas there and then; the cells are
  // rebuilt, which is fine — the next move finds its cell by position.
  if (shapeStroke && growShapeCanvas()) { renderShapePainter(); return; }
  refreshShapeCells();
}

// Pointer capture keeps the stroke alive past the canvas edge (and makes touch
// work), so the cell under the pointer is found by position, not by events on
// the cells themselves — they are rebuilt whenever the canvas grows.
shapePainterGridEl.addEventListener('pointerdown', e => {
  if (!shapePainter || e.button !== 0) return;
  const cell = e.target.closest('.shape-cell');
  if (!cell) return;
  e.preventDefault();
  shapeStroke = shapePainter.canvas[+cell.dataset.r][+cell.dataset.c] ? 0 : 1;
  shapePainterGridEl.setPointerCapture(e.pointerId);
  paintShapeCell(cell);
});
shapePainterGridEl.addEventListener('pointermove', e => {
  if (shapeStroke === null) return;
  paintShapeCell(document.elementFromPoint(e.clientX, e.clientY));
});
function endShapeStroke() { shapeStroke = null; }
shapePainterGridEl.addEventListener('pointerup', endShapeStroke);
shapePainterGridEl.addEventListener('pointercancel', endShapeStroke);

document.getElementById('shape-painter-clear').addEventListener('click', () => {
  shapePainter.canvas = [[0]];
  resetShapePainter();
});
document.getElementById('shape-painter-done').addEventListener('click', () => closeShapePainter(true));
document.getElementById('shape-painter-cancel').addEventListener('click', () => closeShapePainter(false));

// It sits over another modal, so the shared backdrop must not close it — that
// would take the item form underneath with it. A click beside the box is a
// Cancel, the same as Escape.
shapePainterEl.addEventListener('click', e => {
  if (e.target === shapePainterEl) closeShapePainter(false);
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !shapePainter) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  closeShapePainter(false);
}, true);

// =============================================================================
// THE PREVIEW — the shape as it sits in the form, and the way into the painter
// =============================================================================
function renderShapePreview(el, shape) {
  const s = normalizeShape(shape);
  el.style.gridTemplateColumns = `repeat(${s[0].length}, 14px)`;
  el.innerHTML = '';
  s.forEach(row => row.forEach(v => {
    const cell = document.createElement('div');
    cell.className = 'shape-preview-cell' + (v ? ' on' : '');
    el.appendChild(cell);
  }));
}
