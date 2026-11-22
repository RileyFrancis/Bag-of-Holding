// =============================================================================
// PANELS — Resizing and collapsing the two side panels
// =============================================================================
'use strict';

// Both side panels resize by the handle on their inner border, and fold away
// when dragged narrower than PANEL_COLLAPSE_AT. Browser furniture: its own
// localStorage key, never in the save file or party data.

const PANELS_KEY = 'dnd_inventory_panels';

// A panel narrower than MIN is not useful, so the handle stops there; keep
// pulling past COLLAPSE_AT and it folds away instead of shrinking further.
const PANEL_MIN = 150;          // px
const PANEL_COLLAPSE_AT = 100;  // px
const PANEL_MAX_FRACTION = 0.4; // of the window, so a panel can never crowd out the grid

const PANEL_DEFAULTS = { equip: 210, sidebar: 300 }; // px

const panelLayout = {
  equip: PANEL_DEFAULTS.equip,
  sidebar: PANEL_DEFAULTS.sidebar,
  equipCollapsed: false,
  sidebarCollapsed: false,
};

function _getPanelMaxWidth() {
  return Math.round(window.innerWidth * PANEL_MAX_FRACTION);
}

function _clampPanelWidth(px) {
  return Math.round(Math.max(PANEL_MIN, Math.min(px, _getPanelMaxWidth())));
}

// Restores the stored panel widths and collapsed states, then applies them.
function loadPanelLayout() {
  try {
    const raw = localStorage.getItem(PANELS_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (Number.isFinite(data.equip))   panelLayout.equip   = _clampPanelWidth(data.equip);
      if (Number.isFinite(data.sidebar)) panelLayout.sidebar = _clampPanelWidth(data.sidebar);
      panelLayout.equipCollapsed   = !!data.equipCollapsed;
      panelLayout.sidebarCollapsed = !!data.sidebarCollapsed;
    }
  } catch (e) {
    // Corrupt entry or storage disabled — the defaults are already in place.
  }
  _applyPanelLayout();
}

function _savePanelLayout() {
  try {
    localStorage.setItem(PANELS_KEY, JSON.stringify(panelLayout));
  } catch (e) { /* non-fatal */ }
}

function _applyPanelLayout() {
  const app = document.getElementById('app');
  app.style.setProperty('--equip-w', panelLayout.equip + 'px');
  app.style.setProperty('--sidebar-w', panelLayout.sidebar + 'px');
  // One class per side drives everything: the panel and its handle go away, the
  // round reopen button appears, and the top of the middle panel makes room for it.
  app.classList.toggle('equip-collapsed', panelLayout.equipCollapsed);
  app.classList.toggle('sidebar-collapsed', panelLayout.sidebarCollapsed);
}

function _setPanelCollapsed(side, isCollapsed) {
  panelLayout[side + 'Collapsed'] = isCollapsed;
  // Reopening a panel that was dragged down to the minimum would give back a
  // sliver — hand back the default width instead.
  if (!isCollapsed && panelLayout[side] < PANEL_MIN) panelLayout[side] = PANEL_DEFAULTS[side];
  _applyPanelLayout();
  _savePanelLayout();
}

// ─── DRAGGING THE HANDLE ─────────────────────────────────────────────────────
function _startPanelResize(e, side) {
  if (e.button !== 0) return;
  e.preventDefault(); // no text selection while dragging

  const layout = document.getElementById('main-layout').getBoundingClientRect();
  const handle = e.currentTarget;
  handle.classList.add('dragging');
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';

  const onMove = moveEvent => {
    // Width the panel WOULD have following the cursor exactly — collapse and
    // un-collapse happen live from this raw number, so dragging back out brings
    // the panel straight back.
    const rawWidth = side === 'equip' ? moveEvent.clientX - layout.left : layout.right - moveEvent.clientX;
    if (rawWidth < PANEL_COLLAPSE_AT) {
      panelLayout[side + 'Collapsed'] = true;
    } else {
      panelLayout[side + 'Collapsed'] = false;
      panelLayout[side] = _clampPanelWidth(rawWidth);
    }
    _applyPanelLayout();
  };

  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    handle.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    _savePanelLayout();
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

document.querySelectorAll('.panel-resizer').forEach(handle => {
  const side = handle.dataset.side;
  handle.addEventListener('pointerdown', e => _startPanelResize(e, side));
  handle.addEventListener('dblclick', () => _setPanelCollapsed(side, true));
});

document.getElementById('show-equip-btn')
  .addEventListener('click', () => _setPanelCollapsed('equip', false));
document.getElementById('show-sidebar-btn')
  .addEventListener('click', () => _setPanelCollapsed('sidebar', false));

// A window narrow enough can put a stored width over the cap — pull it back in
// rather than letting a panel squeeze the grid to nothing.
window.addEventListener('resize', () => {
  const maxWidth = _getPanelMaxWidth();
  if (panelLayout.equip <= maxWidth && panelLayout.sidebar <= maxWidth) return;
  panelLayout.equip   = _clampPanelWidth(panelLayout.equip);
  panelLayout.sidebar = _clampPanelWidth(panelLayout.sidebar);
  _applyPanelLayout();
  _savePanelLayout();
});
