// =============================================================================
// DRAG-SCROLL — Edge auto-scroll while an item is being dragged
// =============================================================================
'use strict';

const DRAG_SCROLL_EDGE = 56; // px of a container's edge that pulls
const DRAG_SCROLL_MAX  = 22; // px per frame with the cursor right on the edge

// An explicit list hit-tested by bounding rect, because the ghost sits under the
// cursor and elementFromPoint would keep finding it.
const DRAG_SCROLLERS = ['#item-list', '#grid-scroll', '#equip-slots-scroll', '.shop-body', '#character-sheet'];

let dragScrollRaf = null;
let dragScrollRefresh = null;
let dragScrollX = 0;
let dragScrollY = 0;

// Starts edge auto-scroll for a held drag (never placing mode, whose free cursor
// would scroll forever). `refresh(x, y)` re-runs the drag's hover logic after a scroll.
function startDragAutoScroll(x, y, refresh) {
  dragScrollX = x;
  dragScrollY = y;
  dragScrollRefresh = refresh ?? null;
  // Cancel before queueing, so there is exactly one loop however a previous drag ended.
  _stopDragAutoScrollLoop();
  dragScrollRaf = requestAnimationFrame(_runDragScrollFrame);
}

// Records the drag's latest cursor position.
function updateDragAutoScroll(x, y) {
  dragScrollX = x;
  dragScrollY = y;
}

// Ends edge auto-scroll when the drag ends.
function stopDragAutoScroll() {
  _stopDragAutoScrollLoop();
  dragScrollRefresh = null;
}

function _stopDragAutoScrollLoop() {
  if (dragScrollRaf !== null) cancelAnimationFrame(dragScrollRaf);
  dragScrollRaf = null;
}

// Runs every frame of the drag; velocity is zero away from an edge.
function _runDragScrollFrame() {
  dragScrollRaf = requestAnimationFrame(_runDragScrollFrame);
  const el = _getDragScrollerAtPoint(dragScrollX, dragScrollY);
  if (!el) return;

  const r = el.getBoundingClientRect();
  const dx = _getEdgeScrollVelocity(dragScrollX, r.left, r.right);
  const dy = _getEdgeScrollVelocity(dragScrollY, r.top, r.bottom);
  if (dx === 0 && dy === 0) return;

  const wasLeft = el.scrollLeft, wasTop = el.scrollTop;
  el.scrollLeft += dx;
  el.scrollTop  += dy;
  // Refresh only when the view actually moved.
  if ((el.scrollLeft !== wasLeft || el.scrollTop !== wasTop) && dragScrollRefresh) {
    dragScrollRefresh(dragScrollX, dragScrollY);
  }
}

// The container under the cursor, or null. Horizontally the cursor must be
// INSIDE (the panels sit side by side); vertically the band reaches past both
// edges (above/below a scroller is its own panel's header/footer).
function _getDragScrollerAtPoint(x, y) {
  for (const sel of DRAG_SCROLLERS) {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue; // a hidden panel
      if (x < r.left || x > r.right) continue;
      if (y < r.top - DRAG_SCROLL_EDGE || y > r.bottom + DRAG_SCROLL_EDGE) continue;
      return el;
    }
  }
  return null;
}

// Zero away from the edges, ramping to full speed at the edge itself and staying
// there past it — the pull is strongest exactly where the drag is heading.
function _getEdgeScrollVelocity(pos, min, max) {
  if (pos < min + DRAG_SCROLL_EDGE) return -_getEdgeScrollRamp(pos - min);
  if (pos > max - DRAG_SCROLL_EDGE) return  _getEdgeScrollRamp(max - pos);
  return 0;
}

// `depth` is how far inside the edge the cursor is; negative means past it.
function _getEdgeScrollRamp(depth) {
  const t = 1 - Math.max(0, depth) / DRAG_SCROLL_EDGE;
  return Math.max(1, Math.round(DRAG_SCROLL_MAX * t));
}
