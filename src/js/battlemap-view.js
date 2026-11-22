// =============================================================================
// BATTLEMAP VIEW — the map itself: the camera, the canvas, the fog, the pointer
// =============================================================================
'use strict';

// The map is the middle panel's third view (`state.view === 'map'`). It is not a
// view of a character, so a GM with nobody selected may be on it. One canvas,
// drawn on demand: every path that changes the screen ends in drawBattlemap().
// The camera is browser furniture, never saved or synced. The fog is a second
// canvas at the picture's resolution, rebuilt only when visibility could change.

// ─── CONSTANTS ───

const FOG_MAX_DIM = 1600; // px, the fog canvas's longer side at most
// Fog-edge softness as a fraction of the map's longer side, so it reads the same
// on any map size.
const FOG_BLUR_FRACTION = 0.008;
const FOG_BLUR_MIN_PX = 2;

const MAP_MIN_SCALE = 0.05;
const MAP_MAX_SCALE = 8;

// Grid handle reach in screen pixels: something the hand aims at stays the same
// size however far the board is zoomed.
const GRID_HANDLE_PX = 13;

// `ix`/`iy` run 0→1 across the map; the pivot is always `1 - i`.
const GRID_HANDLE_SPOTS = [
  { ix: 0,   iy: 0,   axis: null },   // the four corners: both axes speak
  { ix: 1,   iy: 0,   axis: null },
  { ix: 0,   iy: 1,   axis: null },
  { ix: 1,   iy: 1,   axis: null },
  { ix: 0.5, iy: 0,   axis: 'y' },    // the four edges: only the axis they face
  { ix: 0.5, iy: 1,   axis: 'y' },
  { ix: 0,   iy: 0.5, axis: 'x' },
  { ix: 1,   iy: 0.5, axis: 'x' },
];

// The GM's view of the terrain; players see only its effect on the fog. Raised
// reads warm, lowered cool, so the two are never confused. Height 0 is neutral.
const ELEVATION_TONE = {
  up:      { fill: 'rgba(235, 150, 60, 0.16)', stroke: 'rgba(245, 175, 90, 0.95)' },
  down:    { fill: 'rgba(90, 150, 230, 0.14)', stroke: 'rgba(120, 175, 240, 0.9)' },
  neutral: { fill: 'rgba(150, 150, 150, 0.12)', stroke: 'rgba(180, 180, 180, 0.85)' },
};

// A drawing's colour comes from its mode, independent of its shape.
const MAP_MODE_TONE = {
  'wall':      'rgba(255, 92, 92, 0.95)',
  'fog-hide':  'rgba(150, 110, 220, 0.95)',
  'fog-show':  'rgba(90, 210, 130, 0.95)',
  'elev':      'rgba(245, 175, 90, 0.95)',
};

// Image px; a smaller shape is a click that slipped, not a wall.
const MAP_MIN_SHAPE = 6;
// A lasso stops taking points past this (~9000 screen px of path at 3 px spacing),
// which only a runaway trace reaches.
const MAP_LASSO_MAX_POINTS = 3000;

// Drawing is two independent choices, a shape and a mode, so any region kind can
// be any outline. Picking either switches `mapTool` to 'draw'.
const MAP_STANDALONE_TOOLS = [
  { id: 'select', label: 'Select', hint: 'Move creatures · drag the board to pan', gm: false },
  { id: 'grid',   label: 'Grid',   hint: 'Line the grid up: drag a corner or edge of the map to size the squares, anywhere else to slide them', gm: true },
];
const MAP_SHAPES = [
  { id: 'rect',   label: 'Rectangle', hint: 'Drag a rectangle' },
  { id: 'circle', label: 'Circle',    hint: 'Drag out a circle' },
  { id: 'lasso',  label: 'Lasso',     hint: 'Trace a freehand outline' },
];
const MAP_MODES = [
  { id: 'wall',      label: 'Wall',        hint: 'The region blocks sight' },
  { id: 'fog-hide',  label: 'Obscure',     hint: 'The players cannot see into the region' },
  { id: 'fog-show',  label: 'Reveal',      hint: 'The players can always see the region' },
  { id: 'elev',      label: 'Height',      hint: 'A raised or lowered zone — set its height (ft from the base map) in the box, or right-click a zone to change it' },
];
const MAP_ERASE_TOOL = { id: 'erase', label: 'Erase', hint: 'Click, or hold and drag, over a wall, a fog edit, or an elevation region to remove it — the most recently drawn one first where they overlap' };

// ─── THE VIEW'S OWN STATE ───

let isMapOpen = false;
let mapViewId = null;          // which map a GM has open; players follow the party's
let mapCam = { x: 0, y: 0, scale: 1 };   // the world point at the centre, and the zoom
// 'select' | 'grid' | 'erase' | 'draw'. The shape and mode take effect only under
// 'draw' and stay set while away, so panning or selecting does not lose them.
let mapTool = 'select';
let mapShape = 'rect';   // 'rect' | 'circle' | 'lasso' — the selection outline
let mapMode = 'wall';    // 'wall' | 'fog-hide' | 'fog-show' | 'elev' — what it does
let mapSelectedTokenId = null;
let elevNewHeight = 0;   // feet — the height a freshly drawn Height zone starts at

let mapCanvas = null, mapCtx = null;
let mapCanvasW = 0, mapCanvasH = 0;      // CSS pixels

// The picture, kept as one <img> and reloaded only when the map changes.
let mapImage = null, mapImageSrc = null, isMapImageReady = false;

// The fog, at the picture's resolution (capped). `isFogDirty` keeps it from being
// recomputed on every pan.
let fogCanvas = null, fogCtx = null, fogScale = 1, isFogDirty = true;
let hiddenTokenIds = new Set();

// A gesture in flight: a pan, a token drag, a shape being drawn, or the grid
// being stretched or slid.
let mapPan = null;      // { sx, sy, camX, camY }
let mapTokenDrag = null;// { id, x, y, ox, oy, dx, dy, moved }
let mapDrawing = null;  // { shape, mode, x0, y0, x1, y1 } or, for a lasso, { shape, mode, points }
let mapGridDrag = null; // { mode, held, pivot, sx, sy, grid0, grid, moved }
let isMapErasing = false; // the Erase button is held; every point the cursor crosses is wiped

let mapReturnView = 'inventory'; // the view the map took the panel from
// The map the camera was last framed for, so a GM returning from a sheet finds
// their zoom intact; only a different map gets re-framed.
let mapFramedId = null;
// The piece the Maps pane's list is hovering, { kind, id } or null.
let mapHighlight = null;

// ─── WHAT IS BEING LOOKED AT ───

// A player is always shown the map the party is on. A GM is shown the one they
// opened (normally the one in play, since opening from the library puts the
// party on it first).
function getViewedMap() {
  if (!isMapGM()) return getMapForViewer();
  return getMapById(mapViewId) || getMapForViewer();
}

// Whether the middle panel is showing the board — NOT the same as
// `state.view === 'map'`: the map can be pulled out from under the reader (a GM
// deleting or un-revealing it) and the panel falls back to the grid while the
// field still says 'map'. `getViewedMap()` not `getMapForViewer()`: a GM opening a map
// from their library shows it before the "active map" write comes back.
function isMapViewShowing() {
  return state.view === 'map' && !!getViewedMap();
}

// The corner button exists only when there is something behind it — no revealed
// map, or no campaign, means no button; and none while the map is already up.
function syncMapButton() {
  const btn = document.getElementById('map-btn');
  if (!btn) return;
  const map = getMapForViewer();
  const shouldShow = !!map && state.view !== 'map';
  btn.classList.toggle('hidden', !shouldShow);
  btn.title = map ? 'Open the battle map — ' + map.name : 'Battle map';
  // The stash header runs along the bottom of the panel; pad it clear of the button.
  document.getElementById('inventory-panel').classList.toggle('has-map-btn', shouldShow);
}

// ─── OPENING AND CLOSING ───

// Opens a map (the party's, by default) in the middle panel.
function openBattlemap(mapId) {
  const map = mapId ? getMapById(mapId) : getMapForViewer();
  if (!map) return;
  mapViewId = map.id;
  mapSelectedTokenId = null;
  mapTool = 'select';
  isFogDirty = true;
  if (state.view !== 'map') mapReturnView = state.view;
  // The GM's grid controls live in the Maps pane, and lining a grid up is done
  // while looking at the picture — so opening a map puts that pane in front.
  if (isMapGM()) {
    state.mapLibraryOpenId = map.id;
    if (getAvailableLeftTabs().includes('map')) state.leftTab = 'map';
  }
  // The real work is in onMapViewShown(), so every way in agrees.
  setInventoryPanelView('map');
}

function _closeBattlemap() {
  if (state.view !== 'map') return;
  setInventoryPanelView(mapReturnView === 'map' ? 'inventory' : mapReturnView);
}

// The panel has just started showing the map. Called on every syncCharacterViewUI()
// pass, so the setup runs only if the map was not already up (not per heartbeat).
function onMapViewShown() {
  const wasOpen = isMapOpen;
  isMapOpen = true;
  if (!wasOpen) {
    // The canvas has no size until the panel is showing it.
    _ensureMapCanvas();
    _resizeMapCanvas();
    const map = getViewedMap();
    if (map) {
      _loadMapImage(map);
      if (mapFramedId !== map.id) { mapFramedId = map.id; _fitMapToView(map); }
    }
    isFogDirty = true;
    renderMapToolbar();
    drawBattlemap();
    renderInitiativePanel();
    renderMapSpeedIndicator();
  }
  _syncGridHint();
}

// The panel has stopped showing the map. A gesture in flight is abandoned.
function onMapViewHidden() {
  if (!isMapOpen) return;
  isMapOpen = false;
  mapPan = mapTokenDrag = mapDrawing = mapGridDrag = null;
  isMapErasing = false;
  mapSelectedTokenId = null;
  setInitiativeHover(null);
  _syncGridHint();
  renderInitiativePanel();   // which, with the board gone, is what hides it
  renderMapSpeedIndicator();
}

// Everything arriving from Firebase lands here.
function onBattlemapDataChanged() {
  if (!isMapOpen) return;
  const map = getViewedMap();
  // The map was deleted, or a player's map hidden again — hand the reader back
  // their inventory rather than standing empty.
  if (!map) { _closeBattlemap(); return; }
  _loadMapImage(map);
  isFogDirty = true;
  renderMapToolbar();
  drawBattlemap();
  renderInitiativePanel();
  // Catches both a movement spend echoing back and a turn's reset arriving —
  // see the MOVEMENT section of battlemap-initiative.js.
  renderMapSpeedIndicator();
}

// ─── THE PICTURE ───

function _loadMapImage(map) {
  if (mapImageSrc === map.image && mapImage) return;
  mapImageSrc = map.image;
  isMapImageReady = false;
  mapImage = new Image();
  mapImage.crossOrigin = 'anonymous';
  mapImage.onload = () => { isMapImageReady = true; drawBattlemap(); };
  mapImage.onerror = () => { isMapImageReady = false; drawBattlemap(); };
  mapImage.src = map.image || '';
}

// The stored dimensions are the model's frame of reference — never the <img>'s,
// which are not known until it loads and are not what coordinates were written in.
function _getMapBounds(map) {
  return { x: 0, y: 0, w: map.w || 1000, h: map.h || 1000 };
}

// ─── THE CAMERA ───

function _convertWorldToScreen(wx, wy) {
  return {
    x: (wx - mapCam.x) * mapCam.scale + mapCanvasW / 2,
    y: (wy - mapCam.y) * mapCam.scale + mapCanvasH / 2,
  };
}

function _convertScreenToWorld(clientX, clientY) {
  const b = mapCanvas.getBoundingClientRect();
  return {
    x: (clientX - b.left - mapCanvasW / 2) / mapCam.scale + mapCam.x,
    y: (clientY - b.top - mapCanvasH / 2) / mapCam.scale + mapCam.y,
  };
}

function _fitMapToView(map) {
  const b = _getMapBounds(map);
  if (!mapCanvasW || !mapCanvasH) return;
  const s = Math.min(mapCanvasW / b.w, mapCanvasH / b.h) * 0.96;
  mapCam = { x: b.w / 2, y: b.h / 2, scale: Math.max(MAP_MIN_SCALE, Math.min(MAP_MAX_SCALE, s)) };
}

// Zoom about the cursor — the thing under the pointer should stay put.
function _zoomMapAt(clientX, clientY, factor) {
  const before = _convertScreenToWorld(clientX, clientY);
  mapCam.scale = Math.max(MAP_MIN_SCALE, Math.min(MAP_MAX_SCALE, mapCam.scale * factor));
  const after = _convertScreenToWorld(clientX, clientY);
  mapCam.x += before.x - after.x;
  mapCam.y += before.y - after.y;
  drawBattlemap();
}

// ─── THE FOG ───

// Black means the party cannot see here; vision cuts holes in it. It is painted
// over the board and sampled under each creature. A map with nobody on it has no
// fog. Blur goes on the shapes as they are cut, never the finished canvas, so
// the map's outer edge stays hard.

// Returns null where the browser has no canvas filters; the caller then draws a
// crisp edge (a worse shadow, not a broken one).
function _getFogBlurFilter(fx) {
  const px = Math.max(FOG_BLUR_MIN_PX, Math.round(Math.max(fogCanvas.width, fogCanvas.height) * FOG_BLUR_FRACTION));
  const filter = 'blur(' + px + 'px)';
  fx.filter = filter;
  const isSupported = fx.filter === filter;
  fx.filter = 'none';
  return isSupported ? filter : null;
}

// Rebuilds the fog canvas and the set of tokens it hides.
function _buildFog(map) {
  const b = _getMapBounds(map);
  const sources = getVisionSources(map);
  const masks = getMapMasks(map);
  hiddenTokenIds = new Set();

  if (!sources.length && !masks.length) { fogCanvas = fogCtx = null; isFogDirty = false; return; }

  fogScale = Math.min(1, FOG_MAX_DIM / Math.max(b.w, b.h));
  if (!fogCanvas) fogCanvas = document.createElement('canvas');
  fogCanvas.width = Math.max(1, Math.round(b.w * fogScale));
  fogCanvas.height = Math.max(1, Math.round(b.h * fogScale));
  fogCtx = fogCanvas.getContext('2d', { willReadFrequently: true });

  const fx = fogCtx;
  fx.setTransform(fogScale, 0, 0, fogScale, 0, 0);
  fx.filter = 'none';
  fx.globalCompositeOperation = 'source-over';
  fx.fillStyle = '#000';
  fx.fillRect(0, 0, b.w, b.h);

  // The dark is laid down hard; everything cut out of it gets the soft edge.
  const blur = _getFogBlurFilter(fx);

  // What each party member can see, cut straight out of the dark.
  const walls = getMapWalls(map);
  fx.globalCompositeOperation = 'destination-out';
  fx.fillStyle = '#000';
  if (blur) fx.filter = blur;
  sources.forEach(t => {
    const at = _getTokenDrawPos(t);
    const elev = getElevationViewFor(map, at.x, at.y);
    const poly = computeVisionPolygon(at.x, at.y, walls, b, elev);
    if (poly.length < 3) return;
    fx.beginPath();
    fx.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) fx.lineTo(poly[i][0], poly[i][1]);
    fx.closePath();
    fx.fill();
  });

  // The GM's masks override the walls: Reveal beats walls, and Obscure beats
  // everything, so it goes last.
  masks.filter(m => m.mode === 'show').forEach(m => { _traceMapShape(fx, m); fx.fill(); });
  fx.globalCompositeOperation = 'source-over';
  fx.fillStyle = '#000';
  masks.filter(m => m.mode === 'hide').forEach(m => { _traceMapShape(fx, m); fx.fill(); });
  fx.filter = 'none';

  // Hidden creatures are sampled from the fog, so hidden and dark are one answer.
  // A creature is seen if any probe is in the light (half alpha is mid-edge).
  getMapTokens(map).forEach(t => {
    const at = _getTokenDrawPos(t);
    const r = getTokenRadius(map, t) * 0.7;
    const probes = [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]];
    const isSeen = probes.some(p => _getFogAlphaAt(at.x + p[0], at.y + p[1]) < 128);
    if (!isSeen) hiddenTokenIds.add(t.id);
  });

  isFogDirty = false;
}

function _getFogAlphaAt(wx, wy) {
  if (!fogCtx) return 0;
  const x = Math.round(wx * fogScale), y = Math.round(wy * fogScale);
  if (x < 0 || y < 0 || x >= fogCanvas.width || y >= fogCanvas.height) return 255; // off the map is dark
  try { return fogCtx.getImageData(x, y, 1, 1).data[3]; } catch { return 0; }
}

// A dragged token is drawn — and casts its vision — from where the cursor has
// it, not where the database still says it is.
function _getTokenDrawPos(token) {
  if (mapTokenDrag && mapTokenDrag.id === token.id) return { x: mapTokenDrag.x, y: mapTokenDrag.y };
  return { x: token.x, y: token.y };
}

// ─── DRAWING ───

function _ensureMapCanvas() {
  if (mapCanvas) return;
  mapCanvas = document.getElementById('map-canvas');
  mapCtx = mapCanvas.getContext('2d');
  mapCanvas.addEventListener('pointerdown', _onMapPointerDown);
  mapCanvas.addEventListener('pointermove', _onMapPointerMove);
  mapCanvas.addEventListener('pointerup', _onMapPointerUp);
  mapCanvas.addEventListener('pointercancel', _onMapPointerUp);
  mapCanvas.addEventListener('dblclick', _onMapDoubleClick);
  // The cursor leaving the board ends a hover — pointermove just stops arriving,
  // so the last creature would stay lit in the panel forever.
  mapCanvas.addEventListener('pointerleave', () => setInitiativeHover(null));
  mapCanvas.addEventListener('wheel', _onMapWheel, { passive: false });
  mapCanvas.addEventListener('contextmenu', e => e.preventDefault()); // right button pans
  new ResizeObserver(() => { _resizeMapCanvas(); drawBattlemap(); }).observe(mapCanvas.parentElement);
}

function _resizeMapCanvas() {
  if (!mapCanvas) return;
  const b = mapCanvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  mapCanvasW = Math.max(1, Math.round(b.width));
  mapCanvasH = Math.max(1, Math.round(b.height));
  mapCanvas.width = Math.round(mapCanvasW * dpr);
  mapCanvas.height = Math.round(mapCanvasH * dpr);
  mapCanvas.style.width = mapCanvasW + 'px';
  mapCanvas.style.height = mapCanvasH + 'px';
}

// Redraws the whole board. Every path that changes the screen ends here.
function drawBattlemap() {
  if (!isMapOpen || !mapCanvas) return;
  const map = getViewedMap();
  const ctx = mapCtx;
  const dpr = window.devicePixelRatio || 1;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, mapCanvasW, mapCanvasH);
  document.getElementById('map-empty').classList.toggle('hidden', !!map);
  if (!map) return;

  if (isFogDirty) _buildFog(map);

  const b = _getMapBounds(map);
  ctx.save();
  ctx.translate(mapCanvasW / 2 - mapCam.x * mapCam.scale, mapCanvasH / 2 - mapCam.y * mapCam.scale);
  ctx.scale(mapCam.scale, mapCam.scale);

  // The board itself
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(b.x, b.y, b.w, b.h);
  if (isMapImageReady) ctx.drawImage(mapImage, b.x, b.y, b.w, b.h);

  _drawMapGrid(ctx, map, b);
  if (canEditMap()) _drawMapElevation(ctx, map);
  if (canEditMap()) _drawMapWalls(ctx, map);
  _drawMapFog(ctx, b);
  if (canEditMap()) _drawMapMasks(ctx, map);
  _drawMapTokens(ctx, map);
  _drawMapHighlight(ctx, map);
  _drawMapDrawing(ctx);
  if (mapTool === 'grid' && canEditMap()) _drawGridHandles(ctx, map);

  ctx.restore();
}

// The grid as it is *being* dragged, not yet as it is stored (written once, on
// release). Everything that draws the grid asks these, so what is under the
// cursor is what the release will commit.
function _getViewGrid(map) {
  return mapGridDrag ? mapGridDrag.grid : getMapGrid(map);
}
function _getViewCellSize(map) {
  const s = _getViewGrid(map).size;
  return Number.isFinite(s) && s >= 4 ? s : getMapCellSize(map);
}

function _drawMapGrid(ctx, map, b) {
  const g = _getViewGrid(map);
  // The Grid tool shows the grid even when it is switched off for play.
  const isTuning = mapTool === 'grid';
  if (g.visible === false && !isTuning) return;
  const cell = _getViewCellSize(map);
  if (cell * mapCam.scale < 4) return; // too fine to read; drawing it is just noise

  ctx.save();
  ctx.beginPath();
  ctx.rect(b.x, b.y, b.w, b.h);
  ctx.clip();
  ctx.strokeStyle = isTuning ? 'rgba(255, 196, 64, 0.85)' : 'rgba(0,0,0,0.38)';
  ctx.lineWidth = Math.max(isTuning ? 1 : 0.6, (isTuning ? 1.5 : 1) / mapCam.scale);
  const startX = g.offsetX - Math.ceil((g.offsetX - b.x) / cell) * cell;
  const startY = g.offsetY - Math.ceil((g.offsetY - b.y) / cell) * cell;
  ctx.beginPath();
  for (let x = startX; x <= b.x + b.w; x += cell) { ctx.moveTo(x, b.y); ctx.lineTo(x, b.y + b.h); }
  for (let y = startY; y <= b.y + b.h; y += cell) { ctx.moveTo(b.x, y); ctx.lineTo(b.x + b.w, y); }
  ctx.stroke();
  ctx.restore();
}

// Walls, fog masks and elevation zones share three shapes (rect/circle/poly); this
// is the one place any of them becomes a canvas path. The caller fills or strokes.
function _traceMapShape(ctx, s) {
  ctx.beginPath();
  if (s.kind === 'circle') {
    ctx.arc(s.x, s.y, s.r || 1, 0, Math.PI * 2);
  } else if (s.kind === 'poly') {
    const p = s.points || [];
    if (p.length < 2) return;
    ctx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
    ctx.closePath();
  } else {
    ctx.rect(s.x, s.y, s.w, s.h);
  }
}

// Where a label belongs on one of these shapes — the centroid for a lasso,
// since its bounding-box centre can land outside a crescent-shaped trace.
function _getMapShapeCenter(s) {
  if (s.kind === 'circle') return { x: s.x, y: s.y };
  if (s.kind === 'poly') {
    const p = s.points || [];
    if (!p.length) return { x: 0, y: 0 };
    let sx = 0, sy = 0;
    p.forEach(([x, y]) => { sx += x; sy += y; });
    return { x: sx / p.length, y: sy / p.length };
  }
  return { x: s.x + s.w / 2, y: s.y + s.h / 2 };
}

function _drawMapElevation(ctx, map) {
  ctx.save();
  ctx.lineWidth = Math.max(1, 2 / mapCam.scale);
  const fs = Math.max(10, 13 / mapCam.scale);
  getMapElevationZones(map).forEach(z => {
    const h = getElevZoneHeight(z);
    const tone = ELEVATION_TONE[h > 0 ? 'up' : h < 0 ? 'down' : 'neutral'];
    _traceMapShape(ctx, z);
    ctx.fillStyle = tone.fill;
    ctx.strokeStyle = tone.stroke;
    ctx.fill();
    ctx.stroke();

    const c = _getMapShapeCenter(z);
    ctx.font = '700 ' + fs + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = tone.stroke;
    ctx.fillText((h > 0 ? '+' : '') + h + ' ft', c.x, c.y);
  });
  ctx.restore();
}

// Walls are the GM's notes, not part of the picture, so only the GM sees them —
// a player sees the dark behind them.
function _drawMapWalls(ctx, map) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 92, 92, 0.9)';
  ctx.fillStyle = 'rgba(255, 92, 92, 0.16)';
  ctx.lineWidth = Math.max(1, 2 / mapCam.scale);
  getMapWalls(map).forEach(w => {
    _traceMapShape(ctx, w);
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();
}

function _drawMapMasks(ctx, map) {
  ctx.save();
  ctx.lineWidth = Math.max(1, 2 / mapCam.scale);
  ctx.setLineDash([8 / mapCam.scale, 6 / mapCam.scale]);
  getMapMasks(map).forEach(m => {
    ctx.strokeStyle = m.mode === 'hide' ? 'rgba(150, 110, 220, 0.95)' : 'rgba(90, 210, 130, 0.95)';
    _traceMapShape(ctx, m);
    ctx.stroke();
  });
  ctx.restore();
}

// The GM sees the fog as a wash, not a wall — they need both what the players
// cannot see and what is standing in it.
function _drawMapFog(ctx, b) {
  if (!fogCanvas) return;
  ctx.save();
  ctx.globalAlpha = canEditMap() ? 0.45 : 1;
  ctx.drawImage(fogCanvas, b.x, b.y, b.w, b.h);
  ctx.restore();
}

function _drawMapTokens(ctx, map) {
  const cell = getMapCellSize(map);
  // Whose turn it is, and the turn-order hover — worked out once for the frame.
  const marks = getInitiativeMarks(map);
  getMapTokens(map).forEach(token => {
    if (!canEditMap() && hiddenTokenIds.has(token.id)) return;
    const at = _getTokenDrawPos(token);
    const r = getTokenRadius(map, token);
    const color = getHostilityColor(token.hostility);
    const isDimmed = canEditMap() && hiddenTokenIds.has(token.id);

    ctx.save();
    ctx.globalAlpha = isDimmed ? 0.5 : 1;

    const hostilityLW = Math.max(2, r * 0.14);
    ctx.beginPath();
    ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(16, 12, 8, 0.82)';
    ctx.fill();
    ctx.lineWidth = hostilityLW;
    ctx.strokeStyle = color;
    ctx.stroke();

    // A player's own marker (the visual half of canControlToken()). A ring, not a
    // fill, so it never fights the hostility colour.
    const isOwnedByPlayer = isTokenOwnedByPlayer(token);
    if (isOwnedByPlayer) {
      ctx.beginPath();
      ctx.arc(at.x, at.y, r + hostilityLW * 0.9, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.5, r * 0.09);
      ctx.strokeStyle = 'rgba(168, 96, 255, 0.95)';
      ctx.stroke();
    }

    if (token.id === mapSelectedTokenId) {
      ctx.beginPath();
      ctx.arc(at.x, at.y, r + hostilityLW + (isOwnedByPlayer ? r * 0.13 : 0), 0, Math.PI * 2);
      ctx.setLineDash([r * 0.3, r * 0.22]);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(1.5, r * 0.08);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Turn order on the creature: active is gold, hovered white, so neither is
    // mistaken for the dashed selection ring.
    const mark = marks.get(token.id);
    if (mark) {
      const lw = Math.max(2, r * (mark === 'active' ? 0.16 : 0.1));
      ctx.beginPath();
      ctx.arc(at.x, at.y, r + lw * 1.6, 0, Math.PI * 2);
      ctx.strokeStyle = mark === 'active' ? 'rgba(255, 196, 64, 0.95)' : 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = lw;
      ctx.shadowColor = ctx.strokeStyle;
      ctx.shadowBlur = r * 0.5;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    if (token.icon) {
      ctx.font = (r * 1.05) + 'px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(token.icon, at.x, at.y + r * 0.05);
    }

    if (token.name) {
      const fs = Math.max(9, cell * 0.24);
      ctx.font = '600 ' + fs + 'px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const y = at.y + r + fs * 0.35;
      const w = ctx.measureText(token.name).width;
      ctx.fillStyle = 'rgba(12, 9, 5, 0.78)';
      ctx.fillRect(at.x - w / 2 - fs * 0.3, y - fs * 0.12, w + fs * 0.6, fs * 1.25);
      ctx.fillStyle = '#fff';
      ctx.fillText(token.name, at.x, y);
    }
    ctx.restore();

    // The drag's cost goes beside the token, where the reader is looking.
    if (mapTokenDrag && mapTokenDrag.id === token.id) _drawMoveCostLabel(ctx, map, token, at, r);
  });
}

// What this drag would spend, next to the dragged token. Silent when the token
// has no movement budget (see MOVEMENT in battlemap-initiative.js).
function _drawMoveCostLabel(ctx, map, token, at, r) {
  const entry = getTokenMoveEntry(map, token);
  if (!entry) return;
  const speed = getTokenSpeed(token);
  const usedBefore = entry.moveUsed || 0;
  const distFeet = getGridManhattanFeet(map, mapTokenDrag.ox, mapTokenDrag.oy, at.x, at.y, token.size);
  const remaining = Math.max(0, speed - usedBefore - distFeet);
  const isMaxedOut = distFeet >= speed - usedBefore;
  const text = Math.round(distFeet) + ' ft' + (distFeet > 0 ? ' · ' + Math.round(remaining) + ' ft left' : '');

  const fs = 13 / mapCam.scale;
  const pad = 8 / mapCam.scale;
  ctx.save();
  ctx.font = '600 ' + fs + 'px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width;
  const x = at.x + r + pad;
  const y = at.y;
  ctx.fillStyle = isMaxedOut ? 'rgba(122, 26, 26, 0.88)' : 'rgba(12, 9, 5, 0.82)';
  ctx.fillRect(x - pad * 0.4, y - fs * 0.85, w + pad * 1.6, fs * 1.7);
  ctx.fillStyle = '#ffd479';
  ctx.fillText(text, x, y);
  ctx.restore();
}

// The shape being dragged out, from the same numbers the write will use.
function _drawMapDrawing(ctx) {
  if (!mapDrawing) return;
  ctx.save();
  ctx.lineWidth = Math.max(1, 2 / mapCam.scale);
  ctx.setLineDash([8 / mapCam.scale, 6 / mapCam.scale]);
  const tone = MAP_MODE_TONE[mapDrawing.mode] || 'rgba(255, 255, 255, 0.95)';
  ctx.strokeStyle = tone;
  ctx.fillStyle = tone.replace(/[\d.]+\)$/, '0.18)');
  ctx.beginPath();
  if (mapDrawing.shape === 'circle') {
    ctx.arc(mapDrawing.x0, mapDrawing.y0, _getDrawingRadius(mapDrawing), 0, Math.PI * 2);
  } else if (mapDrawing.shape === 'lasso') {
    const pts = mapDrawing.points;
    if (pts.length) {
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      if (pts.length > 2) ctx.closePath();
    }
  } else {
    const r = _getDrawingRect(mapDrawing);
    ctx.rect(r.x, r.y, r.w, r.h);
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function _getDrawingRect(d) {
  return {
    x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1),
    w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0),
  };
}
function _getDrawingRadius(d) { return Math.hypot(d.x1 - d.x0, d.y1 - d.y0); }

// ─── THE GRID'S HANDLES ───

// Pulling a corner or edge of the picture scales the grid about the opposite
// point, which stays fixed and so sets where the run starts; dragging anywhere
// else slides it. A corner reads both axes, an edge only the one it faces.
// Nothing here is stored.

function _getMapGridHandles(map) {
  const b = _getMapBounds(map);
  return GRID_HANDLE_SPOTS.map(h => ({
    ...h,
    x: b.x + h.ix * b.w,
    y: b.y + h.iy * b.h,
    pivot: { x: b.x + (1 - h.ix) * b.w, y: b.y + (1 - h.iy) * b.h },
  }));
}

// Which handle the pointer is on, in *screen* pixels (they are drawn at a fixed
// screen size). A handle scrolled off the edge cannot be grabbed — Fit brings it
// back. Nearest wins.
function _getGridHandleAtPoint(map, clientX, clientY) {
  const r = mapCanvas.getBoundingClientRect();
  const px = clientX - r.left, py = clientY - r.top;
  let best = null, bestD = GRID_HANDLE_PX + 5;
  _getMapGridHandles(map).forEach(h => {
    const at = _convertWorldToScreen(h.x, h.y);
    const d = Math.hypot(px - at.x, py - at.y);
    if (d <= bestD) { bestD = d; best = h; }
  });
  return best;
}

// How far the handle has been pulled, as one number. Each axis says how far the
// pointer now stands from the pivot against how far the handle stood from it. A
// corner averages the two (not a diagonal distance, which would let a wide map's
// sideways movement dominate); an edge asks only the axis it faces. The size
// clamp catches a drag straight past the pivot.
function _scaleGridDrag(map, drag, w) {
  const held = drag.held, pivot = drag.pivot;
  const spanX = held.x - pivot.x, spanY = held.y - pivot.y;
  const kx = held.axis === 'y' || !spanX ? null : Math.abs((w.x - pivot.x) / spanX);
  const ky = held.axis === 'x' || !spanY ? null : Math.abs((w.y - pivot.y) / spanY);
  const ks = [kx, ky].filter(k => k !== null);
  if (!ks.length) return;
  const k = ks.reduce((a, b) => a + b, 0) / ks.length;
  drag.grid = { ...drag.grid0, ...scaleGridAbout(drag.grid0, pivot, k) };
}

// Slides the dragged grid by the pointer's travel since the press.
function _slideGridDrag(map, drag, e) {
  const dx = (e.clientX - drag.sx) / mapCam.scale;
  const dy = (e.clientY - drag.sy) / mapCam.scale;
  drag.grid = { ...drag.grid0, ...slideGridBy(drag.grid0, dx, dy) };
}

// An edge moves one way, a corner both.
function _getGridHandleCursor(h) {
  if (h.axis === 'x') return 'ew-resize';
  if (h.axis === 'y') return 'ns-resize';
  return h.ix === h.iy ? 'nwse-resize' : 'nesw-resize';
}

// The handles, plus the square size while one is held. A corner is a block and
// an edge a bar along its edge, so each handle's axis is legible before use.
function _drawGridHandles(ctx, map) {
  const accent = 'rgba(255, 196, 64, ';
  const px = 1 / mapCam.scale;           // one screen pixel, in image pixels
  const size = GRID_HANDLE_PX * px;
  const held = mapGridDrag && mapGridDrag.mode === 'scale' ? mapGridDrag.held : null;

  ctx.save();
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(20, 14, 6, 0.9)';
  ctx.lineWidth = Math.max(1, px);
  const LONG = size * 2.6, THIN = size * 0.55;
  _getMapGridHandles(map).forEach(h => {
    const isHeld = held && held.ix === h.ix && held.iy === h.iy;
    ctx.fillStyle = accent + (isHeld ? '1)' : '0.9)');
    const w = h.axis === 'y' ? LONG : h.axis === 'x' ? THIN : size;
    const t = h.axis === 'y' ? THIN : h.axis === 'x' ? LONG : size;
    // Tucked inside the picture — half a handle off the map is half a handle to aim at.
    const x = h.x - (h.ix === 1 ? w : h.ix === 0.5 ? w / 2 : 0);
    const y = h.y - (h.iy === 1 ? t : h.iy === 0.5 ? t / 2 : 0);
    ctx.fillRect(x, y, w, t);
    ctx.strokeRect(x, y, w, t);
  });
  if (held) _drawGridScaleLabel(ctx, map, held);
  ctx.restore();
}

// The size the squares have reached, said at the handle being pulled (the reader
// mid-drag is looking there, not at the bar by their knee).
function _drawGridScaleLabel(ctx, map, held) {
  const text = roundGridValue(_getViewCellSize(map)) + ' px per square';
  const fs = 13 / mapCam.scale;
  const pad = 10 / mapCam.scale;

  ctx.save();
  ctx.font = '600 ' + fs + 'px system-ui, sans-serif';
  // Pushed inwards off whichever edges the handle sits on, centred on the one it
  // sits in the middle of.
  ctx.textAlign = held.ix === 0 ? 'left' : held.ix === 1 ? 'right' : 'center';
  ctx.textBaseline = held.iy === 0 ? 'top' : held.iy === 1 ? 'bottom' : 'middle';
  const w = ctx.measureText(text).width;
  const x = held.x + (held.ix === 0 ? pad : held.ix === 1 ? -pad : 0);
  const y = held.y + (held.iy === 0 ? pad : held.iy === 1 ? -pad : 0);
  const boxX = (held.ix === 0 ? x : held.ix === 1 ? x - w : x - w / 2) - fs * 0.5;
  const boxY = (held.iy === 0 ? y : held.iy === 1 ? y - fs * 1.2 : y - fs * 0.6) - fs * 0.25;
  ctx.fillStyle = 'rgba(12, 9, 5, 0.82)';
  ctx.fillRect(boxX, boxY, w + fs, fs * 1.7);
  ctx.fillStyle = '#ffd479';
  ctx.fillText(text, x, y);
  ctx.restore();
}

// ─── THE POINTER ───

// The visible token under a world point, or null.
function _getTokenAtPoint(map, x, y) {
  // Backwards, so the one drawn last (on top) is the one hit.
  const tokens = getMapTokens(map);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (!canEditMap() && hiddenTokenIds.has(t.id)) continue;
    const at = _getTokenDrawPos(t);
    const r = getTokenRadius(map, t);
    if (Math.hypot(x - at.x, y - at.y) <= r) return t;
  }
  return null;
}

function _onMapPointerDown(e) {
  const map = getViewedMap();
  if (!map) return;
  mapCanvas.setPointerCapture(e.pointerId);
  const w = _convertScreenToWorld(e.clientX, e.clientY);

  // Right-click on a Height zone (with the Height tool up) edits its height —
  // otherwise middle and right buttons always pan, whatever tool is up.
  if (e.button === 2 && canEditMap() && mapTool === 'draw' && mapMode === 'elev') {
    const zone = getMapElevationZones(map).slice().reverse().find(z => isPointInWall(w.x, w.y, z));
    if (zone) { _promptElevationHeight(map.id, zone); return; }
  }
  if (e.button === 1 || e.button === 2) { mapPan = { sx: e.clientX, sy: e.clientY, camX: mapCam.x, camY: mapCam.y }; return; }
  if (e.button !== 0) return;

  if (mapTool === 'erase') { isMapErasing = true; _eraseMapPieceAt(map, w); return; }

  // Grid tool: a corner or edge magnifies about the point opposite, anywhere
  // else slides the whole grid (it runs over the whole picture, so the whole
  // picture is its middle).
  if (mapTool === 'grid') {
    const handle = _getGridHandleAtPoint(map, e.clientX, e.clientY);
    const grid0 = getMapGrid(map);
    mapGridDrag = handle
      ? { mode: 'scale', held: handle, pivot: handle.pivot, grid0, grid: grid0, moved: false }
      : { mode: 'slide', sx: e.clientX, sy: e.clientY, grid0, grid: grid0, moved: false };
    drawBattlemap();
    return;
  }

  if (mapTool === 'select') {
    const token = _getTokenAtPoint(map, w.x, w.y);
    if (token) {
      mapSelectedTokenId = token.id;
      // Anyone may select (it reaches Edit); only the GM or the owner may drag.
      // ox/oy stay fixed for the gesture, since x/y follow the cursor and the
      // drag's distance is measured from the start.
      if (canControlToken(token)) {
        mapTokenDrag = { id: token.id, x: token.x, y: token.y, ox: token.x, oy: token.y, dx: token.x - w.x, dy: token.y - w.y, moved: false };
      }
      renderMapToolbar();
      drawBattlemap();
      return;
    }
    mapSelectedTokenId = null;
    renderMapToolbar();
    mapPan = { sx: e.clientX, sy: e.clientY, camX: mapCam.x, camY: mapCam.y };
    drawBattlemap();
    return;
  }

  // mapTool === 'draw' from here.
  mapDrawing = mapShape === 'lasso'
    ? { shape: 'lasso', mode: mapMode, points: [[w.x, w.y]] }
    : { shape: mapShape, mode: mapMode, x0: w.x, y0: w.y, x1: w.x, y1: w.y };
}

function _onMapPointerMove(e) {
  if (mapPan) {
    mapCam.x = mapPan.camX - (e.clientX - mapPan.sx) / mapCam.scale;
    mapCam.y = mapPan.camY - (e.clientY - mapPan.sy) / mapCam.scale;
    drawBattlemap();
    return;
  }
  const map = getViewedMap();
  if (!map) return;
  const w = _convertScreenToWorld(e.clientX, e.clientY);

  if (mapGridDrag) {
    if (mapGridDrag.mode === 'scale') _scaleGridDrag(map, mapGridDrag, w);
    else _slideGridDrag(map, mapGridDrag, e);
    mapGridDrag.moved = true;
    _syncGridHint();
    drawBattlemap();
    return;
  }

  if (isMapErasing) { _eraseMapPieceAt(map, w); drawBattlemap(); return; }

  if (mapTokenDrag) {
    let nx = w.x + mapTokenDrag.dx;
    let ny = w.y + mapTokenDrag.dy;
    // A tracked budget leashes the drag: past the remaining Manhattan distance
    // from the start, the token is pulled back along that line. Unsnapped for a
    // smooth pull; what is spent is always the snapped figure.
    const token = (map.tokens || {})[mapTokenDrag.id];
    const remaining = token ? getTokenMoveRemaining(map, token) : null;
    if (remaining !== null) {
      const distFeet = getGridManhattanFeetRaw(map, mapTokenDrag.ox, mapTokenDrag.oy, nx, ny);
      if (distFeet > remaining) {
        const k = remaining / distFeet;
        nx = mapTokenDrag.ox + (nx - mapTokenDrag.ox) * k;
        ny = mapTokenDrag.oy + (ny - mapTokenDrag.oy) * k;
      }
    }
    mapTokenDrag.x = nx;
    mapTokenDrag.y = ny;
    mapTokenDrag.moved = true;
    // The fog does not follow the drag; it settles on pointerup.
    drawBattlemap();
    return;
  }

  if (mapDrawing) {
    if (mapDrawing.shape === 'lasso') {
      const pts = mapDrawing.points;
      const last = pts[pts.length - 1];
      // One point every few screen pixels (screen, so it holds at any zoom);
      // native pointer resolution would be thousands of points.
      if (pts.length < MAP_LASSO_MAX_POINTS && Math.hypot(w.x - last[0], w.y - last[1]) * mapCam.scale > 3) {
        pts.push([w.x, w.y]);
      }
    } else {
      mapDrawing.x1 = w.x;
      mapDrawing.y1 = w.y;
    }
    drawBattlemap();
    return;
  }

  // Nothing held: light the creature under the cursor in the turn order.
  // noteMapTokenHover() returns early when the answer has not changed.
  noteMapTokenHover(map, (_getTokenAtPoint(map, w.x, w.y) || {}).id || null);

  if (mapTool === 'grid') {
    const handle = _getGridHandleAtPoint(map, e.clientX, e.clientY);
    mapCanvas.style.cursor = handle ? _getGridHandleCursor(handle) : 'move';
  }
}

function _onMapPointerUp(e) {
  if (mapCanvas.hasPointerCapture(e.pointerId)) mapCanvas.releasePointerCapture(e.pointerId);
  const map = getViewedMap();
  mapPan = null;
  isMapErasing = false;

  // The grid is written once, on release, not per move into a shared database.
  if (mapGridDrag) {
    const drag = mapGridDrag;
    mapGridDrag = null;
    // A click that never moved is not an edit.
    if (map && drag.moved) updateMapGrid(map.id, drag.grid);

    _syncGridHint();
    drawBattlemap();
    return;
  }

  if (mapTokenDrag) {
    const drag = mapTokenDrag;
    mapTokenDrag = null;
    if (map && drag.moved) {
      const token = (map.tokens || {})[drag.id];
      const snapped = snapToGrid(map, drag.x, drag.y, token ? token.size : 1);
      updateToken(map.id, drag.id, snapped);
      // getGridManhattanFeet() snaps both ends, so this matches the squares crossed.
      if (token) spendTokenMovement(map, token, getGridManhattanFeet(map, drag.ox, drag.oy, drag.x, drag.y, token.size));
    }
    // The fog settles here and only here: a fog that followed the drag would let
    // anyone sweep a token across the board and read the whole map out of it.
    isFogDirty = true;
    drawBattlemap();
    return;
  }

  if (mapDrawing && map) {
    _commitMapDrawing(map, mapDrawing);
    mapDrawing = null;
    drawBattlemap();
  }
}

function _onMapDoubleClick(e) {
  const map = getViewedMap();
  if (!map) return;
  const w = _convertScreenToWorld(e.clientX, e.clientY);
  const token = _getTokenAtPoint(map, w.x, w.y);
  // On a creature: edit it. On bare board: put a new one where the pointer is.
  if (token) openCreatureModal(map.id, token.id, null);
  else if (canAddCreature()) openCreatureModal(map.id, null, w);
}

function _onMapWheel(e) {
  e.preventDefault();
  _zoomMapAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
}

// The drag as a stored { kind, ... } shape (the form every wall, mask and zone
// uses), or null if it was too small or short to have been meant.
function _getMapDrawingShape(d) {
  if (d.shape === 'circle') {
    const r = _getDrawingRadius(d);
    return r < MAP_MIN_SHAPE ? null : { kind: 'circle', x: d.x0, y: d.y0, r };
  }
  if (d.shape === 'lasso') {
    const pts = d.points;
    if (pts.length < 3) return null;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    return (w < MAP_MIN_SHAPE || h < MAP_MIN_SHAPE) ? null : { kind: 'poly', points: pts };
  }
  const r = _getDrawingRect(d);
  return (r.w < MAP_MIN_SHAPE || r.h < MAP_MIN_SHAPE) ? null : { kind: 'rect', x: r.x, y: r.y, w: r.w, h: r.h };
}

function _commitMapDrawing(map, d) {
  if (!canEditMap()) return;
  const shape = _getMapDrawingShape(d);
  if (!shape) return;
  if (d.mode === 'wall') addWall(map.id, shape);
  else if (d.mode === 'fog-hide' || d.mode === 'fog-show') addMask(map.id, { ...shape, mode: d.mode === 'fog-hide' ? 'hide' : 'show' });
  else if (d.mode === 'elev') addElevationZone(map.id, { ...shape, height: clampElevHeight(elevNewHeight) });
  isFogDirty = true;
}

// Removes the newest piece of any kind under the point (getPieceTime()), so erasing
// an overlap undoes it in the order it was built.
function _eraseMapPieceAt(map, w) {
  let best = null;
  [['masks', getMapMasks(map)], ['elevation', getMapElevationZones(map)], ['walls', getMapWalls(map)]].forEach(([kind, list]) => {
    list.forEach(p => {
      if (!isPointInWall(w.x, w.y, p)) return;
      if (!best || getPieceTime(p) > getPieceTime(best.piece)) best = { kind, piece: p };
    });
  });
  if (!best) return;
  removePiece(map.id, best.kind, best.piece.id);
  isFogDirty = true;
}

// Outlines one piece on the board for the Maps pane's hover; a null kind clears it.
function setMapHighlight(kind, id) {
  const isSame = kind && mapHighlight && mapHighlight.kind === kind && mapHighlight.id === id;
  if (isSame || (!kind && !mapHighlight)) return;
  mapHighlight = kind ? { kind, id } : null;
  drawBattlemap();
}

// The colour each piece is drawn in on the board, so the pane's swatch and the
// hover halo match what the GM is looking at.
function getMapPieceColor(kind, piece) {
  if (kind === 'tokens') return getHostilityColor(piece.hostility);
  if (kind === 'walls') return MAP_MODE_TONE.wall;
  if (kind === 'masks') return MAP_MODE_TONE[piece.mode === 'hide' ? 'fog-hide' : 'fog-show'];
  const h = getElevZoneHeight(piece);
  return ELEVATION_TONE[h > 0 ? 'up' : h < 0 ? 'down' : 'neutral'].stroke;
}

// A glowing outline round the hovered piece, over everything else. A piece
// that went away while hovered (removed from the list) simply draws nothing.
function _drawMapHighlight(ctx, map) {
  if (!mapHighlight) return;
  const piece = (map[mapHighlight.kind] || {})[mapHighlight.id];
  if (!piece) return;
  const color = getMapPieceColor(mapHighlight.kind, piece);
  ctx.save();
  ctx.beginPath();
  if (mapHighlight.kind === 'tokens') {
    const at = _getTokenDrawPos(piece);
    const r = getTokenRadius(map, piece);
    ctx.arc(at.x, at.y, r + Math.max(4 / mapCam.scale, r * 0.28), 0, Math.PI * 2);
  } else {
    _traceMapShape(ctx, piece);
  }
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 14;
  ctx.lineWidth = 7 / mapCam.scale;
  ctx.globalAlpha = 0.45;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 2.5 / mapCam.scale;
  ctx.stroke();
  ctx.restore();
}

// ─── THE TOOLBAR ───

// The number box for the height new zones start at, shown while the Height tool
// is up. Existing zones are re-set by right-clicking them.
function _buildElevHeightBox() {
  const wrap = document.createElement('div');
  wrap.className = 'map-tool-group map-elev-height';
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.min = -500; inp.max = 500; inp.step = 1;
  inp.value = String(elevNewHeight);
  inp.title = 'The height new zones start at, in feet from the base map (−500 to 500)';
  inp.addEventListener('input', () => { elevNewHeight = clampElevHeight(inp.value); });
  inp.addEventListener('change', () => { inp.value = String(elevNewHeight); });
  const unit = document.createElement('span');
  unit.className = 'map-elev-unit';
  unit.textContent = 'ft';
  wrap.append(inp, unit);
  return wrap;
}

// Right-clicking a Height zone (with the Height tool up) re-sets its height.
function _promptElevationHeight(mapId, zone) {
  const raw = prompt('Height of this zone in feet, from the base map (−500 to 500):', String(getElevZoneHeight(zone)));
  if (raw === null) return;
  const n = Number(raw);
  if (!Number.isFinite(n)) return;
  setElevationHeight(mapId, zone.id, n);
  isFogDirty = true;
  drawBattlemap();
}

// The Grid tool's bar under the map: how the gestures work and the grid's current
// numbers. Display only.
function _syncGridHint() {
  const el = document.getElementById('map-grid-hint');
  if (!el) return;
  const map = getViewedMap();
  const isShown = isMapOpen && mapTool === 'grid' && !!map && canEditMap();
  el.classList.toggle('hidden', !isShown);
  if (!isShown) return;
  const g = _getViewGrid(map);
  el.textContent = 'Drag a corner or an edge of the map to grow or shrink the squares — the far side stays put. '
    + 'Drag anywhere else to slide the grid. '
    + 'Now: ' + roundGridValue(g.size) + ' px, offset ' + roundGridValue(g.offsetX)
    + ' / ' + roundGridValue(g.offsetY) + '.';
}

// The reader's remaining movement this turn, when their marker has a tracked
// budget (see MOVEMENT in battlemap-initiative.js). Hidden for a GM.
function renderMapSpeedIndicator() {
  const el = document.getElementById('map-speed');
  if (!el) return;
  const map = isMapOpen ? getViewedMap() : null;
  const token = map ? getMapTokens(map).find(t => t.hostility === 'party' && t.ownerUid === getOwnPlayerId()) : null;
  const remaining = token ? getTokenMoveRemaining(map, token) : null;
  el.classList.toggle('hidden', remaining === null);
  if (remaining === null) return;
  const speed = getTokenSpeed(token);
  document.getElementById('map-speed-remaining').textContent = Math.round(remaining);
  document.getElementById('map-speed-total').textContent = '/' + speed + ' ft';
}

// Rebuilds the map's tool strip and action buttons. GM tools need edit rights,
// creature buttons a selection.
function renderMapToolbar() {
  const map = getViewedMap();
  document.getElementById('map-title').textContent = map ? map.name : 'Battle Map';

  const isGM = canEditMap();
  if (!isGM && mapTool !== 'select') mapTool = 'select'; // a player has nothing else

  const tools = document.getElementById('map-tools');
  tools.innerHTML = '';

  // One group of buttons, one active id among them, one thing a click does to
  // reach it — Select/Grid, Shape and Mode are all built through this.
  const buildToolGroup = (items, activeId, onPick) => {
    const group = document.createElement('div');
    group.className = 'map-tool-group';
    items.forEach(t => {
      const b = document.createElement('button');
      b.className = 'map-tool' + (t.id === activeId ? ' active' : '');
      b.textContent = t.label;
      b.title = t.hint;
      b.addEventListener('click', () => {
        onPick(t.id);
        if (mapTool !== 'grid' && mapCanvas) mapCanvas.style.cursor = ''; // the resize cursor is the Grid tool's
        renderMapToolbar();
        drawBattlemap();
      });
      group.appendChild(b);
    });
    tools.appendChild(group);
  };

  buildToolGroup(MAP_STANDALONE_TOOLS.filter(t => !t.gm || isGM), mapTool, id => { mapTool = id; });
  if (isGM) {
    // Picking a shape or mode also picks 'draw'. They read as selected only
    // while 'draw' is live, so other tools don't leave every group lit.
    const isDrawActive = mapTool === 'draw';
    buildToolGroup(MAP_SHAPES, isDrawActive ? mapShape : null, id => { mapShape = id; mapTool = 'draw'; });
    buildToolGroup(MAP_MODES, isDrawActive ? mapMode : null, id => { mapMode = id; mapTool = 'draw'; });
    if (mapMode === 'elev' && mapTool === 'draw') tools.appendChild(_buildElevHeightBox());
    buildToolGroup([MAP_ERASE_TOOL], mapTool, id => { mapTool = id; });
  }
  _syncGridHint();

  const acts = document.getElementById('map-actions');
  acts.innerHTML = '';

  if (canAddCreature() && map) {
    const add = document.createElement('button');
    add.className = 'btn-sm';
    setIconLabel(add, 'plus', 'Creature');
    add.title = 'Put a creature in the middle of the map — or double-click where you want it';
    add.addEventListener('click', () => openCreatureModal(map.id, null, null));
    acts.appendChild(add);
  }

  const selected = map && mapSelectedTokenId ? (map.tokens || {})[mapSelectedTokenId] : null;
  if (selected) {
    const edit = document.createElement('button');
    edit.className = 'btn-sm';
    edit.textContent = 'Edit ' + (selected.name || 'Creature');
    edit.addEventListener('click', () => openCreatureModal(map.id, selected.id, null));
    acts.appendChild(edit);
    if (canControlToken(selected)) {
      const rm = document.createElement('button');
      rm.className = 'btn-sm danger';
      rm.textContent = 'Remove';
      rm.addEventListener('click', () => {
        removeToken(map.id, selected.id);
        mapSelectedTokenId = null;
        renderMapToolbar();
      });
      acts.appendChild(rm);
    }
  }

  if (isGM && map) {
    const g = getMapGrid(map);
    const gridBtn = document.createElement('button');
    gridBtn.className = 'btn-sm' + (g.visible === false ? '' : ' on');
    gridBtn.textContent = g.visible === false ? 'Grid Off' : 'Grid On';
    gridBtn.title = 'Draw the grid on the map — creatures snap to it either way';
    gridBtn.addEventListener('click', () => updateMapGrid(map.id, { visible: g.visible === false }));
    acts.appendChild(gridBtn);
  }

  const fit = document.createElement('button');
  fit.className = 'btn-sm';
  fit.textContent = 'Fit';
  fit.title = 'Frame the whole map';
  fit.addEventListener('click', () => { if (map) { _fitMapToView(map); drawBattlemap(); } });
  acts.appendChild(fit);
}

// ─── WIRING ───

document.getElementById('map-btn').addEventListener('click', () => openBattlemap());
document.getElementById('map-close-btn').addEventListener('click', _closeBattlemap);

document.addEventListener('keydown', e => {
  if (!isMapOpen) return;
  if (document.querySelector('.modal:not(.hidden)')) return;
  // A key typed into a field beside the board is not meant for the board.
  const t = e.target;
  if (t && t.matches && t.matches('input, textarea, select')) return;
  if (t && t.isContentEditable) return;
  if (e.key === 'Escape') {
    // A shape half drawn — or a grid half dragged — is what Escape refuses, not the map.
    if (mapDrawing) { mapDrawing = null; drawBattlemap(); return; }
    if (mapGridDrag) { mapGridDrag = null; drawBattlemap(); return; }
    _closeBattlemap();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && mapSelectedTokenId) {
    const map = getViewedMap();
    const token = map ? (map.tokens || {})[mapSelectedTokenId] : null;
    if (token && canControlToken(token)) {
      removeToken(map.id, token.id);
      mapSelectedTokenId = null;
      renderMapToolbar();
    }
  }
});
