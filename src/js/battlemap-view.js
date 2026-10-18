// =============================================================================
// BATTLEMAP VIEW — the map itself: the camera, the canvas, the fog, the pointer
// =============================================================================
'use strict';

// The map is the third view of the middle panel (`state.view === 'map'`,
// `.map-view` on `#inventory-panel`), beside the grid and the character sheet —
// but it is not a view of a *character*, so it is reached from the corner button
// and a GM with nobody selected may be on it.
//
// One `<canvas>`, drawn on demand (not a rAF loop) — every path that changes the
// screen ends in `drawBattlemap()`. The camera is this browser's furniture: not
// saved, never synced. The fog is a second canvas at the picture's resolution,
// rebuilt only when something that could change visibility moves, then read
// twice (drawn over the map, and sampled under each creature). See CLAUDE.md § Battle maps.

// =============================================================================
// THE VIEW'S OWN STATE
// =============================================================================
let mapOpen = false;
let mapViewId = null;          // which map a GM has open; players follow the party's
let mapCam = { x: 0, y: 0, scale: 1 };   // the world point at the centre, and the zoom
// 'select' | 'grid' | 'erase' | 'draw' — a shape and a mode are chosen
// independently (see THE TOOLBAR) and only take effect once `mapTool` is
// 'draw'; picking either one puts it there. They stay set switching away and
// back, so leaving 'draw' to pan or select does not lose your place.
let mapTool = 'select';
let mapShape = 'rect';   // 'rect' | 'circle' | 'lasso' — the selection outline
let mapMode = 'wall';    // 'wall' | 'fog-hide' | 'fog-show' | 'elev' — what it does
let mapSelectedTokenId = null;
let elevNewHeight = 0;   // feet — the height a freshly drawn Height zone starts at

let mapCanvas = null, mapCtx = null;
let mapCanvasW = 0, mapCanvasH = 0;      // CSS pixels

// The picture, kept as one <img> and reloaded only when the map changes.
let mapImage = null, mapImageSrc = null, mapImageReady = false;

// The fog, at the picture's resolution (capped). `fogDirty` keeps it from being
// recomputed on every pan.
let fogCanvas = null, fogCtx = null, fogScale = 1, fogDirty = true;
let hiddenTokenIds = new Set();
const FOG_MAX_DIM = 1600;

// Fog-edge softness as a fraction of the map's longer side, so it reads the same
// on any map size (and is measured against the picture, not the fog canvas whose
// resolution is a FOG_MAX_DIM detail).
const FOG_BLUR_FRACTION = 0.008;
const FOG_BLUR_MIN_PX = 2;

// A gesture in flight: a pan, a token drag, a shape being drawn, or the grid
// being stretched or slid.
let mapPan = null;      // { sx, sy, camX, camY }
let mapTokenDrag = null;// { id, x, y, dx, dy, moved }
let mapDrawing = null;  // { tool, x0, y0, x1, y1 }
let mapGridDrag = null; // { mode, held, pivot, sx, sy, grid0, grid, moved }
let mapErasing = false; // the Erase tool's button is held — every point the cursor crosses is wiped

const MAP_MIN_SCALE = 0.05;
const MAP_MAX_SCALE = 8;

// The Grid tool's handles are the picture's own corners and edges (see THE
// GRID'S HANDLES below). Their reach is in *screen* pixels — a handle is
// something the hand aims at, the same size however far the board is zoomed.
const GRID_HANDLE_PX = 13;

// =============================================================================
// WHAT IS BEING LOOKED AT
// =============================================================================
// A player is always shown the map the party is on. A GM is shown the one they
// opened (normally the one in play, since opening from the library puts the
// party on it first).
function viewedMap() {
  if (!isMapGM()) return mapForViewer();
  return mapById(mapViewId) || mapForViewer();
}

// Whether the middle panel is showing the board — NOT the same as
// `state.view === 'map'`: the map can be pulled out from under the reader (a GM
// deleting or un-revealing it) and the panel falls back to the grid while the
// field still says 'map'. `viewedMap()` not `mapForViewer()`: a GM opening a map
// from their library shows it before the "active map" write comes back.
function mapViewIsShowing() {
  return state.view === 'map' && !!viewedMap();
}

// The corner button exists only when there is something behind it — no revealed
// map, or no campaign, means no button; and none while the map is already up.
function syncMapButton() {
  const btn = document.getElementById('map-btn');
  if (!btn) return;
  const map = mapForViewer();
  const show = !!map && state.view !== 'map';
  btn.classList.toggle('hidden', !show);
  btn.title = map ? 'Open the battle map — ' + map.name : 'Battle map';
  // The stash header runs along the bottom of the panel; pad it clear of the button.
  document.getElementById('inventory-panel').classList.toggle('has-map-btn', show);
}

// =============================================================================
// OPENING AND CLOSING
// =============================================================================
// Which view the reader was on before the map took the panel. Session only.
let mapReturnView = 'inventory';

function openBattlemap(mapId) {
  const map = mapId ? mapById(mapId) : mapForViewer();
  if (!map) return;
  mapViewId = map.id;
  mapSelectedTokenId = null;
  mapTool = 'select';
  fogDirty = true;
  if (state.view !== 'map') mapReturnView = state.view;
  // The GM's grid controls live in the Maps pane, and lining a grid up is done
  // while looking at the picture — so opening a map puts that pane in front.
  if (isMapGM()) {
    state.mapLibraryOpenId = map.id;
    if (leftTabsAvailable().includes('map')) state.leftTab = 'map';
  }
  // The panel's actual work happens in onMapViewShown(), from the single "what
  // are we looking at" entry point, so every way in agrees.
  setInventoryView('map');
}

function closeBattlemap() {
  if (state.view !== 'map') return;
  setInventoryView(mapReturnView === 'map' ? 'inventory' : mapReturnView);
}

// Which map the camera was last framed for — a GM who zoomed into a doorway,
// glanced at a sheet and came back must find the doorway. Only a *different* map
// gets framed.
let mapFramedId = null;

// The panel has just started showing the map. Called on every pass through
// `syncCharacterViewUI()` (a roster snapshot drives it), so it does nothing
// unless the map was not already up — setting the canvas size and rebuilding the
// toolbar must not run on a presence heartbeat.
function onMapViewShown() {
  const wasOpen = mapOpen;
  mapOpen = true;
  if (!wasOpen) {
    // The canvas has no size until the panel is showing it.
    ensureMapCanvas();
    resizeMapCanvas();
    const map = viewedMap();
    if (map) {
      loadMapImage(map);
      if (mapFramedId !== map.id) { mapFramedId = map.id; fitMapToView(map); }
    }
    fogDirty = true;
    renderMapToolbar();
    drawBattlemap();
    renderInitiativePanel();
    renderMapSpeedIndicator();
  }
  syncGridHint();
}

// The panel has stopped showing the map. A gesture in flight is abandoned.
function onMapViewHidden() {
  if (!mapOpen) return;
  mapOpen = false;
  mapPan = mapTokenDrag = mapDrawing = mapGridDrag = null;
  mapErasing = false;
  mapSelectedTokenId = null;
  setInitiativeHover(null);
  syncGridHint();
  renderInitiativePanel();   // which, with the board gone, is what hides it
  renderMapSpeedIndicator();
}

// Everything arriving from Firebase lands here.
function onBattlemapDataChanged() {
  if (!mapOpen) return;
  const map = viewedMap();
  // The map was deleted, or a player's map hidden again — hand the reader back
  // their inventory rather than standing empty.
  if (!map) { closeBattlemap(); return; }
  loadMapImage(map);
  fogDirty = true;
  renderMapToolbar();
  drawBattlemap();
  renderInitiativePanel();
  // Catches both a movement spend echoing back and a turn's reset arriving —
  // see the MOVEMENT section of battlemap-initiative.js.
  renderMapSpeedIndicator();
}

// =============================================================================
// THE PICTURE
// =============================================================================
function loadMapImage(map) {
  if (mapImageSrc === map.image && mapImage) return;
  mapImageSrc = map.image;
  mapImageReady = false;
  mapImage = new Image();
  mapImage.crossOrigin = 'anonymous';
  mapImage.onload = () => { mapImageReady = true; drawBattlemap(); };
  mapImage.onerror = () => { mapImageReady = false; drawBattlemap(); };
  mapImage.src = map.image || '';
}

// The stored dimensions are the model's frame of reference — never the <img>'s,
// which are not known until it loads and are not what coordinates were written in.
function mapBounds(map) {
  return { x: 0, y: 0, w: map.w || 1000, h: map.h || 1000 };
}

// =============================================================================
// THE CAMERA
// =============================================================================
function worldToScreen(wx, wy) {
  return {
    x: (wx - mapCam.x) * mapCam.scale + mapCanvasW / 2,
    y: (wy - mapCam.y) * mapCam.scale + mapCanvasH / 2,
  };
}

function screenToWorld(clientX, clientY) {
  const b = mapCanvas.getBoundingClientRect();
  return {
    x: (clientX - b.left - mapCanvasW / 2) / mapCam.scale + mapCam.x,
    y: (clientY - b.top - mapCanvasH / 2) / mapCam.scale + mapCam.y,
  };
}

function fitMapToView(map) {
  const b = mapBounds(map);
  if (!mapCanvasW || !mapCanvasH) return;
  const s = Math.min(mapCanvasW / b.w, mapCanvasH / b.h) * 0.96;
  mapCam = { x: b.w / 2, y: b.h / 2, scale: Math.max(MAP_MIN_SCALE, Math.min(MAP_MAX_SCALE, s)) };
}

// Zoom about the cursor — the thing under the pointer should stay put.
function zoomMapAt(clientX, clientY, factor) {
  const before = screenToWorld(clientX, clientY);
  mapCam.scale = Math.max(MAP_MIN_SCALE, Math.min(MAP_MAX_SCALE, mapCam.scale * factor));
  const after = screenToWorld(clientX, clientY);
  mapCam.x += before.x - after.x;
  mapCam.y += before.y - after.y;
  drawBattlemap();
}

// =============================================================================
// THE FOG
// =============================================================================
// Black means "the party cannot see here"; vision punches holes in it. Used
// twice: painted over the board, and sampled under each creature. A map with
// nobody on it has no fog at all (nothing to see out of; an all-black board
// reads as broken). The edge of a shadow is blurred — applied to the shapes as
// they are cut, never the finished canvas, so the fog's own outer boundary (the
// edge of the map) stays hard.

// Returns null where the browser has no canvas filters; the caller then draws a
// crisp edge (a worse shadow, not a broken one).
function fogBlurFilter(fx) {
  const px = Math.max(FOG_BLUR_MIN_PX, Math.round(Math.max(fogCanvas.width, fogCanvas.height) * FOG_BLUR_FRACTION));
  const filter = 'blur(' + px + 'px)';
  fx.filter = filter;
  const supported = fx.filter === filter;
  fx.filter = 'none';
  return supported ? filter : null;
}

function buildFog(map) {
  const b = mapBounds(map);
  const sources = visionSources(map);
  const masks = mapMasks(map);
  hiddenTokenIds = new Set();

  if (!sources.length && !masks.length) { fogCanvas = fogCtx = null; fogDirty = false; return; }

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
  const blur = fogBlurFilter(fx);

  // What each party member can see, cut straight out of the dark.
  const walls = mapWalls(map);
  fx.globalCompositeOperation = 'destination-out';
  fx.fillStyle = '#000';
  if (blur) fx.filter = blur;
  sources.forEach(t => {
    const at = tokenDrawPos(t);
    const elev = elevationViewFor(map, at.x, at.y);
    const poly = computeVisionPolygon(at.x, at.y, walls, b, elev);
    if (poly.length < 3) return;
    fx.beginPath();
    fx.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) fx.lineTo(poly[i][0], poly[i][1]);
    fx.closePath();
    fx.fill();
  });

  // The GM's hand, over the arithmetic: Reveal beats the walls, Obscure beats
  // everything so it goes last. Softened alike. A mask can be any shape now
  // (rect/circle/lasso), same as a wall — traceMapShape() is what lets Reveal
  // and Obscure not care which.
  masks.filter(m => m.mode === 'show').forEach(m => { traceMapShape(fx, m); fx.fill(); });
  fx.globalCompositeOperation = 'source-over';
  fx.fillStyle = '#000';
  masks.filter(m => m.mode === 'hide').forEach(m => { traceMapShape(fx, m); fx.fill(); });
  fx.filter = 'none';

  // Which creatures that leaves off the board — sampled from the fog, so what is
  // hidden and what is dark are one answer. On screen if any probe is in the
  // light. The blur costs this nothing: half-alpha on a soft edge is the middle
  // of the ramp, where the hard edge used to be.
  mapTokens(map).forEach(t => {
    const at = tokenDrawPos(t);
    const r = tokenRadius(map, t) * 0.7;
    const probes = [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]];
    const seen = probes.some(p => fogAlphaAt(at.x + p[0], at.y + p[1]) < 128);
    if (!seen) hiddenTokenIds.add(t.id);
  });

  fogDirty = false;
}

function fogAlphaAt(wx, wy) {
  if (!fogCtx) return 0;
  const x = Math.round(wx * fogScale), y = Math.round(wy * fogScale);
  if (x < 0 || y < 0 || x >= fogCanvas.width || y >= fogCanvas.height) return 255; // off the map is dark
  try { return fogCtx.getImageData(x, y, 1, 1).data[3]; } catch { return 0; }
}

// A dragged token is drawn — and casts its vision — from where the cursor has
// it, not where the database still says it is.
function tokenDrawPos(token) {
  if (mapTokenDrag && mapTokenDrag.id === token.id) return { x: mapTokenDrag.x, y: mapTokenDrag.y };
  return { x: token.x, y: token.y };
}

// =============================================================================
// DRAWING
// =============================================================================
function ensureMapCanvas() {
  if (mapCanvas) return;
  mapCanvas = document.getElementById('map-canvas');
  mapCtx = mapCanvas.getContext('2d');
  mapCanvas.addEventListener('pointerdown', onMapPointerDown);
  mapCanvas.addEventListener('pointermove', onMapPointerMove);
  mapCanvas.addEventListener('pointerup', onMapPointerUp);
  mapCanvas.addEventListener('pointercancel', onMapPointerUp);
  mapCanvas.addEventListener('dblclick', onMapDoubleClick);
  // The cursor leaving the board ends a hover — pointermove just stops arriving,
  // so the last creature would stay lit in the panel forever.
  mapCanvas.addEventListener('pointerleave', () => setInitiativeHover(null));
  mapCanvas.addEventListener('wheel', onMapWheel, { passive: false });
  mapCanvas.addEventListener('contextmenu', e => e.preventDefault()); // right button pans
  new ResizeObserver(() => { resizeMapCanvas(); drawBattlemap(); }).observe(mapCanvas.parentElement);
}

function resizeMapCanvas() {
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

function drawBattlemap() {
  if (!mapOpen || !mapCanvas) return;
  const map = viewedMap();
  const ctx = mapCtx;
  const dpr = window.devicePixelRatio || 1;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, mapCanvasW, mapCanvasH);
  document.getElementById('map-empty').classList.toggle('hidden', !!map);
  if (!map) return;

  if (fogDirty) buildFog(map);

  const b = mapBounds(map);
  ctx.save();
  ctx.translate(mapCanvasW / 2 - mapCam.x * mapCam.scale, mapCanvasH / 2 - mapCam.y * mapCam.scale);
  ctx.scale(mapCam.scale, mapCam.scale);

  // The board itself
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(b.x, b.y, b.w, b.h);
  if (mapImageReady) ctx.drawImage(mapImage, b.x, b.y, b.w, b.h);

  drawMapGrid(ctx, map, b);
  if (canEditMap()) drawMapElevation(ctx, map);
  if (canEditMap()) drawMapWalls(ctx, map);
  drawMapFog(ctx, b);
  if (canEditMap()) drawMapMasks(ctx, map);
  drawMapTokens(ctx, map);
  drawMapHighlight(ctx, map);
  drawMapDrawing(ctx);
  if (mapTool === 'grid' && canEditMap()) drawGridHandles(ctx, map);

  ctx.restore();
}

// The grid as it is *being* dragged, not yet as it is stored (written once, on
// release). Everything that draws the grid asks these, so what is under the
// cursor is what the release will commit.
function viewGrid(map) {
  return mapGridDrag ? mapGridDrag.grid : mapGrid(map);
}
function viewCellSize(map) {
  const s = viewGrid(map).size;
  return Number.isFinite(s) && s >= 4 ? s : mapCellSize(map);
}

function drawMapGrid(ctx, map, b) {
  const g = viewGrid(map);
  // While the Grid tool is up the grid is drawn whether or not it is switched on
  // for play — it is the thing being worked on.
  const tuning = mapTool === 'grid';
  if (g.visible === false && !tuning) return;
  const cell = viewCellSize(map);
  if (cell * mapCam.scale < 4) return; // too fine to read; drawing it is just noise

  ctx.save();
  ctx.beginPath();
  ctx.rect(b.x, b.y, b.w, b.h);
  ctx.clip();
  ctx.strokeStyle = tuning ? 'rgba(255, 196, 64, 0.85)' : 'rgba(0,0,0,0.38)';
  ctx.lineWidth = Math.max(tuning ? 1 : 0.6, (tuning ? 1.5 : 1) / mapCam.scale);
  const startX = g.offsetX - Math.ceil((g.offsetX - b.x) / cell) * cell;
  const startY = g.offsetY - Math.ceil((g.offsetY - b.y) / cell) * cell;
  ctx.beginPath();
  for (let x = startX; x <= b.x + b.w; x += cell) { ctx.moveTo(x, b.y); ctx.lineTo(x, b.y + b.h); }
  for (let y = startY; y <= b.y + b.h; y += cell) { ctx.moveTo(b.x, y); ctx.lineTo(b.x + b.w, y); }
  ctx.stroke();
  ctx.restore();
}

// A wall, a fog mask and an elevation zone are all the same three shapes now
// (rect/circle/lasso — see THE TOOLBAR), so this is the one place any of them
// is turned into a canvas path. Traces only — the caller fills/strokes.
function traceMapShape(ctx, s) {
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
function mapShapeCenter(s) {
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

// The GM's own read of the terrain — a player never sees these, only their
// effect on the fog. Raised ground reads warm, lowered ground cool, so the two
// are never confused at a glance the way two reds or two purples would be. A
// zone at exactly base height (0) does nothing and reads neutral grey.
const ELEVATION_TONE = {
  up:      { fill: 'rgba(235, 150, 60, 0.16)', stroke: 'rgba(245, 175, 90, 0.95)' },
  down:    { fill: 'rgba(90, 150, 230, 0.14)', stroke: 'rgba(120, 175, 240, 0.9)' },
  neutral: { fill: 'rgba(150, 150, 150, 0.12)', stroke: 'rgba(180, 180, 180, 0.85)' },
};
function drawMapElevation(ctx, map) {
  ctx.save();
  ctx.lineWidth = Math.max(1, 2 / mapCam.scale);
  const fs = Math.max(10, 13 / mapCam.scale);
  mapElevationZones(map).forEach(z => {
    const h = elevZoneHeight(z);
    const tone = ELEVATION_TONE[h > 0 ? 'up' : h < 0 ? 'down' : 'neutral'];
    traceMapShape(ctx, z);
    ctx.fillStyle = tone.fill;
    ctx.strokeStyle = tone.stroke;
    ctx.fill();
    ctx.stroke();

    const c = mapShapeCenter(z);
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
function drawMapWalls(ctx, map) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 92, 92, 0.9)';
  ctx.fillStyle = 'rgba(255, 92, 92, 0.16)';
  ctx.lineWidth = Math.max(1, 2 / mapCam.scale);
  mapWalls(map).forEach(w => {
    traceMapShape(ctx, w);
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();
}

function drawMapMasks(ctx, map) {
  ctx.save();
  ctx.lineWidth = Math.max(1, 2 / mapCam.scale);
  ctx.setLineDash([8 / mapCam.scale, 6 / mapCam.scale]);
  mapMasks(map).forEach(m => {
    ctx.strokeStyle = m.mode === 'hide' ? 'rgba(150, 110, 220, 0.95)' : 'rgba(90, 210, 130, 0.95)';
    traceMapShape(ctx, m);
    ctx.stroke();
  });
  ctx.restore();
}

// The GM sees the fog as a wash, not a wall — they need both what the players
// cannot see and what is standing in it.
function drawMapFog(ctx, b) {
  if (!fogCanvas) return;
  ctx.save();
  ctx.globalAlpha = canEditMap() ? 0.45 : 1;
  ctx.drawImage(fogCanvas, b.x, b.y, b.w, b.h);
  ctx.restore();
}

function drawMapTokens(ctx, map) {
  const cell = mapCellSize(map);
  // Whose turn it is, and the turn-order hover — worked out once for the frame.
  const marks = initiativeMarks(map);
  mapTokens(map).forEach(token => {
    if (!canEditMap() && hiddenTokenIds.has(token.id)) return;
    const at = tokenDrawPos(token);
    const r = tokenRadius(map, token);
    const color = hostilityColor(token.hostility);
    const dim = canEditMap() && hiddenTokenIds.has(token.id);

    ctx.save();
    ctx.globalAlpha = dim ? 0.5 : 1;

    const hostilityLW = Math.max(2, r * 0.14);
    ctx.beginPath();
    ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(16, 12, 8, 0.82)';
    ctx.fill();
    ctx.lineWidth = hostilityLW;
    ctx.strokeStyle = color;
    ctx.stroke();

    // A player's own marker — the visual half of the ownership rule that
    // gates who may drag it (canControlToken()). A ring, not a fill, so it
    // never fights the hostility colour for the same pixels.
    const ownedByPlayer = tokenOwnedByPlayer(token);
    if (ownedByPlayer) {
      ctx.beginPath();
      ctx.arc(at.x, at.y, r + hostilityLW * 0.9, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.5, r * 0.09);
      ctx.strokeStyle = 'rgba(168, 96, 255, 0.95)';
      ctx.stroke();
    }

    if (token.id === mapSelectedTokenId) {
      ctx.beginPath();
      ctx.arc(at.x, at.y, r + hostilityLW + (ownedByPlayer ? r * 0.13 : 0), 0, Math.PI * 2);
      ctx.setLineDash([r * 0.3, r * 0.22]);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(1.5, r * 0.08);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // The turn order, drawn on the creature: the active one wears the panel's
    // accent (gold), the hovered one white — so the turn, the hover and the
    // dashed selection ring never look alike.
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

    // The cost of the drag in progress, said where the reader is looking —
    // beside the token, not the bottom-right tally (see drawMoveCostLabel).
    if (mapTokenDrag && mapTokenDrag.id === token.id) drawMoveCostLabel(ctx, map, token, at, r);
  });
}

// What this drag would spend, next to the token being dragged. Silent (no
// entry, no tracked speed) when the token is not on a movement budget at all —
// see the MOVEMENT section of battlemap-initiative.js.
function drawMoveCostLabel(ctx, map, token, at, r) {
  const entry = tokenMoveEntry(map, token);
  if (!entry) return;
  const speed = tokenSpeed(token);
  const usedBefore = entry.moveUsed || 0;
  const distFeet = gridManhattanFeet(map, mapTokenDrag.ox, mapTokenDrag.oy, at.x, at.y, token.size);
  const remaining = Math.max(0, speed - usedBefore - distFeet);
  const maxedOut = distFeet >= speed - usedBefore;
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
  ctx.fillStyle = maxedOut ? 'rgba(122, 26, 26, 0.88)' : 'rgba(12, 9, 5, 0.82)';
  ctx.fillRect(x - pad * 0.4, y - fs * 0.85, w + pad * 1.6, fs * 1.7);
  ctx.fillStyle = '#ffd479';
  ctx.fillText(text, x, y);
  ctx.restore();
}

// The shape under the cursor while it is dragged out, from the same numbers the
// write will use.
// Coloured by mode, shaped by shape — the two are independent (see THE
// TOOLBAR), so this is the one place they come back together.
const MAP_MODE_TONE = {
  'wall':      'rgba(255, 92, 92, 0.95)',
  'fog-hide':  'rgba(150, 110, 220, 0.95)',
  'fog-show':  'rgba(90, 210, 130, 0.95)',
  'elev':      'rgba(245, 175, 90, 0.95)',
};
function drawMapDrawing(ctx) {
  if (!mapDrawing) return;
  ctx.save();
  ctx.lineWidth = Math.max(1, 2 / mapCam.scale);
  ctx.setLineDash([8 / mapCam.scale, 6 / mapCam.scale]);
  const tone = MAP_MODE_TONE[mapDrawing.mode] || 'rgba(255, 255, 255, 0.95)';
  ctx.strokeStyle = tone;
  ctx.fillStyle = tone.replace(/[\d.]+\)$/, '0.18)');
  ctx.beginPath();
  if (mapDrawing.shape === 'circle') {
    ctx.arc(mapDrawing.x0, mapDrawing.y0, drawingRadius(mapDrawing), 0, Math.PI * 2);
  } else if (mapDrawing.shape === 'lasso') {
    const pts = mapDrawing.points;
    if (pts.length) {
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      if (pts.length > 2) ctx.closePath();
    }
  } else {
    const r = drawingRect(mapDrawing);
    ctx.rect(r.x, r.y, r.w, r.h);
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawingRect(d) {
  return {
    x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1),
    w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0),
  };
}
function drawingRadius(d) { return Math.hypot(d.x1 - d.x0, d.y1 - d.y0); }

// =============================================================================
// THE GRID'S HANDLES
// =============================================================================
// The grid is lined up by dragging the picture it has to line up with. Pull a
// corner or edge and the grid magnifies about the point opposite (which stays
// welded); drag anywhere else and the whole grid slides. A scale about a fixed
// point answers both "how big is a square" and "where does the run start" at
// once — the pivot IS the start. A corner asks both axes; an edge asks only the
// axis it faces (movement along the edge is ignored), which makes it the finer
// of the two. Nothing here is stored. See CLAUDE.md § Lining the grid up.

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

function mapGridHandles(map) {
  const b = mapBounds(map);
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
function gridHandleAtPoint(map, clientX, clientY) {
  const r = mapCanvas.getBoundingClientRect();
  const px = clientX - r.left, py = clientY - r.top;
  let best = null, bestD = GRID_HANDLE_PX + 5;
  mapGridHandles(map).forEach(h => {
    const at = worldToScreen(h.x, h.y);
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
function scaleGridDrag(map, drag, w) {
  const held = drag.held, pivot = drag.pivot;
  const spanX = held.x - pivot.x, spanY = held.y - pivot.y;
  const kx = held.axis === 'y' || !spanX ? null : Math.abs((w.x - pivot.x) / spanX);
  const ky = held.axis === 'x' || !spanY ? null : Math.abs((w.y - pivot.y) / spanY);
  const ks = [kx, ky].filter(k => k !== null);
  if (!ks.length) return;
  const k = ks.reduce((a, b) => a + b, 0) / ks.length;
  drag.grid = { ...drag.grid0, ...scaleGridAbout(drag.grid0, pivot, k) };
}

function slideGridDrag(map, drag, e) {
  const dx = (e.clientX - drag.sx) / mapCam.scale;
  const dy = (e.clientY - drag.sy) / mapCam.scale;
  drag.grid = { ...drag.grid0, ...slideGridBy(drag.grid0, dx, dy) };
}

// An edge moves one way, a corner both.
function gridHandleCursor(h) {
  if (h.axis === 'x') return 'ew-resize';
  if (h.axis === 'y') return 'ns-resize';
  return h.ix === h.iy ? 'nwse-resize' : 'nesw-resize';
}

// The handles, and — while one is held — what the drag has made of the squares.
// A corner is a square block, an edge a bar along its own edge, so which axis a
// handle moves is legible before it is touched.
function drawGridHandles(ctx, map) {
  const accent = 'rgba(255, 196, 64, ';
  const px = 1 / mapCam.scale;           // one screen pixel, in image pixels
  const size = GRID_HANDLE_PX * px;
  const held = mapGridDrag && mapGridDrag.mode === 'scale' ? mapGridDrag.held : null;

  ctx.save();
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(20, 14, 6, 0.9)';
  ctx.lineWidth = Math.max(1, px);
  const LONG = size * 2.6, THIN = size * 0.55;
  mapGridHandles(map).forEach(h => {
    const on = held && held.ix === h.ix && held.iy === h.iy;
    ctx.fillStyle = accent + (on ? '1)' : '0.9)');
    const w = h.axis === 'y' ? LONG : h.axis === 'x' ? THIN : size;
    const t = h.axis === 'y' ? THIN : h.axis === 'x' ? LONG : size;
    // Tucked inside the picture — half a handle off the map is half a handle to aim at.
    const x = h.x - (h.ix === 1 ? w : h.ix === 0.5 ? w / 2 : 0);
    const y = h.y - (h.iy === 1 ? t : h.iy === 0.5 ? t / 2 : 0);
    ctx.fillRect(x, y, w, t);
    ctx.strokeRect(x, y, w, t);
  });
  if (held) drawGridScaleLabel(ctx, map, held);
  ctx.restore();
}

// The size the squares have reached, said at the handle being pulled (the reader
// mid-drag is looking there, not at the bar by their knee).
function drawGridScaleLabel(ctx, map, held) {
  const text = roundGridValue(viewCellSize(map)) + ' px per square';
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

// =============================================================================
// THE POINTER
// =============================================================================
function tokenAtPoint(map, x, y) {
  // Backwards, so the one drawn last (on top) is the one hit.
  const tokens = mapTokens(map);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (!canEditMap() && hiddenTokenIds.has(t.id)) continue;
    const at = tokenDrawPos(t);
    const r = tokenRadius(map, t);
    if (Math.hypot(x - at.x, y - at.y) <= r) return t;
  }
  return null;
}

function onMapPointerDown(e) {
  const map = viewedMap();
  if (!map) return;
  mapCanvas.setPointerCapture(e.pointerId);
  const w = screenToWorld(e.clientX, e.clientY);

  // Right-click on a Height zone (with the Height tool up) edits its height —
  // otherwise middle and right buttons always pan, whatever tool is up.
  if (e.button === 2 && canEditMap() && mapTool === 'draw' && mapMode === 'elev') {
    const zone = mapElevationZones(map).slice().reverse().find(z => pointInWall(w.x, w.y, z));
    if (zone) { promptElevationHeight(map.id, zone); return; }
  }
  if (e.button === 1 || e.button === 2) { mapPan = { sx: e.clientX, sy: e.clientY, camX: mapCam.x, camY: mapCam.y }; return; }
  if (e.button !== 0) return;

  if (mapTool === 'erase') { mapErasing = true; eraseMapPieceAt(map, w); return; }

  // Grid tool: a corner or edge magnifies about the point opposite, anywhere
  // else slides the whole grid (it runs over the whole picture, so the whole
  // picture is its middle).
  if (mapTool === 'grid') {
    const handle = gridHandleAtPoint(map, e.clientX, e.clientY);
    const grid0 = mapGrid(map);
    mapGridDrag = handle
      ? { mode: 'scale', held: handle, pivot: handle.pivot, grid0, grid: grid0, moved: false }
      : { mode: 'slide', sx: e.clientX, sy: e.clientY, grid0, grid: grid0, moved: false };
    drawBattlemap();
    return;
  }

  if (mapTool === 'select') {
    const token = tokenAtPoint(map, w.x, w.y);
    if (token) {
      mapSelectedTokenId = token.id;
      // Selecting is free (it is how you reach Edit); dragging is not — only
      // the GM or whoever owns the token may move it. ox/oy stay put for the
      // whole gesture: x/y follow the cursor and are not a stable place to
      // measure this drag's own distance from.
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

  // mapTool === 'draw' from here — the shape and mode chosen independently in
  // the toolbar (see THE TOOLBAR).
  mapDrawing = mapShape === 'lasso'
    ? { shape: 'lasso', mode: mapMode, points: [[w.x, w.y]] }
    : { shape: mapShape, mode: mapMode, x0: w.x, y0: w.y, x1: w.x, y1: w.y };
}

function onMapPointerMove(e) {
  if (mapPan) {
    mapCam.x = mapPan.camX - (e.clientX - mapPan.sx) / mapCam.scale;
    mapCam.y = mapPan.camY - (e.clientY - mapPan.sy) / mapCam.scale;
    drawBattlemap();
    return;
  }
  const map = viewedMap();
  if (!map) return;
  const w = screenToWorld(e.clientX, e.clientY);

  if (mapGridDrag) {
    if (mapGridDrag.mode === 'scale') scaleGridDrag(map, mapGridDrag, w);
    else slideGridDrag(map, mapGridDrag, e);
    mapGridDrag.moved = true;
    syncGridHint();
    drawBattlemap();
    return;
  }

  if (mapErasing) { eraseMapPieceAt(map, w); drawBattlemap(); return; }

  if (mapTokenDrag) {
    let nx = w.x + mapTokenDrag.dx;
    let ny = w.y + mapTokenDrag.dy;
    // A token with a tracked budget cannot be dragged past what it has left —
    // the leash is the Manhattan (grid) distance from where this drag started,
    // pulled back onto that line rather than just refused outright. Unsnapped
    // for a smooth pull rather than a stepped one; what actually gets spent is
    // always the snapped figure (drawMoveCostLabel, and the spend on release).
    const token = (map.tokens || {})[mapTokenDrag.id];
    const remaining = token ? tokenMoveRemaining(map, token) : null;
    if (remaining !== null) {
      const distFeet = gridManhattanFeetRaw(map, mapTokenDrag.ox, mapTokenDrag.oy, nx, ny);
      if (distFeet > remaining) {
        const k = remaining / distFeet;
        nx = mapTokenDrag.ox + (nx - mapTokenDrag.ox) * k;
        ny = mapTokenDrag.oy + (ny - mapTokenDrag.oy) * k;
      }
    }
    mapTokenDrag.x = nx;
    mapTokenDrag.y = ny;
    mapTokenDrag.moved = true;
    // The fog does not follow the drag — it settles on pointerup (see below).
    drawBattlemap();
    return;
  }

  if (mapDrawing) {
    if (mapDrawing.shape === 'lasso') {
      const pts = mapDrawing.points;
      const last = pts[pts.length - 1];
      // Only a point every few *screen* pixels — a freehand trace at native
      // pointer resolution is thousands of points for a modest loop, and the
      // screen (not world) distance is what keeps that true at any zoom.
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

  // Nothing held: whatever creature is under the cursor is lit in the turn
  // order. Asked on every move, so noteMapTokenHover() returns early when the
  // answer has not changed — no redraw per pointermove for the same answer.
  noteMapTokenHover(map, (tokenAtPoint(map, w.x, w.y) || {}).id || null);

  if (mapTool === 'grid') {
    const handle = gridHandleAtPoint(map, e.clientX, e.clientY);
    mapCanvas.style.cursor = handle ? gridHandleCursor(handle) : 'move';
  }
}

function onMapPointerUp(e) {
  if (mapCanvas.hasPointerCapture(e.pointerId)) mapCanvas.releasePointerCapture(e.pointerId);
  const map = viewedMap();
  mapPan = null;
  mapErasing = false;

  // The grid is written once, on release — a write per pointermove would be a
  // write per move into a database every other member is reading.
  if (mapGridDrag) {
    const drag = mapGridDrag;
    mapGridDrag = null;
    // A click that never moved is not an edit.
    if (map && drag.moved) updateMapGrid(map.id, drag.grid);

    syncGridHint();
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
      // Whole cells, start to end — gridManhattanFeet() snaps both points
      // itself, so this agrees exactly with the squares the token actually
      // crossed on the board.
      if (token) spendTokenMovement(map, token, gridManhattanFeet(map, drag.ox, drag.oy, drag.x, drag.y, token.size));
    }
    // The fog settles here, and only here: a fog that followed the drag would
    // let anyone sweep their token across the board and read the whole map back
    // out of the shadows without letting go. Where a creature is put down is a
    // decision; where it passed through is not.
    fogDirty = true;
    drawBattlemap();
    return;
  }

  if (mapDrawing && map) {
    commitMapDrawing(map, mapDrawing);
    mapDrawing = null;
    drawBattlemap();
  }
}

function onMapDoubleClick(e) {
  const map = viewedMap();
  if (!map) return;
  const w = screenToWorld(e.clientX, e.clientY);
  const token = tokenAtPoint(map, w.x, w.y);
  // On a creature: edit it. On bare board: put a new one where the pointer is.
  if (token) openCreatureModal(map.id, token.id, null);
  else if (canAddCreature()) openCreatureModal(map.id, null, w);
}

function onMapWheel(e) {
  e.preventDefault();
  zoomMapAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
}

// A shape too small to have been meant is a click that slipped, not a wall.
const MAP_MIN_SHAPE = 6;
// A freehand trace running out of road — past this it stops taking new
// points, not the gesture (see onMapPointerMove). At the 3-screen-px spacing
// between points, this is ~9000 screen px of total path before it stops —
// generous enough that reaching it means something runaway is happening, not
// an ordinary trace around a room.
const MAP_LASSO_MAX_POINTS = 3000;

// The shape a drag actually committed to, in the { kind, ... } form every
// wall/mask/elevation entry is stored as — or null if it was too small (or,
// for a lasso, too short) to have been meant. One function for every mode,
// since what varies is only *what* gets built from the same three shapes.
function mapDrawingShape(d) {
  if (d.shape === 'circle') {
    const r = drawingRadius(d);
    return r < MAP_MIN_SHAPE ? null : { kind: 'circle', x: d.x0, y: d.y0, r };
  }
  if (d.shape === 'lasso') {
    const pts = d.points;
    if (pts.length < 3) return null;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    return (w < MAP_MIN_SHAPE || h < MAP_MIN_SHAPE) ? null : { kind: 'poly', points: pts };
  }
  const r = drawingRect(d);
  return (r.w < MAP_MIN_SHAPE || r.h < MAP_MIN_SHAPE) ? null : { kind: 'rect', x: r.x, y: r.y, w: r.w, h: r.h };
}

function commitMapDrawing(map, d) {
  if (!canEditMap()) return;
  const shape = mapDrawingShape(d);
  if (!shape) return;
  if (d.mode === 'wall') addWall(map.id, shape);
  else if (d.mode === 'fog-hide' || d.mode === 'fog-show') addMask(map.id, { ...shape, mode: d.mode === 'fog-hide' ? 'hide' : 'show' });
  else if (d.mode === 'elev') addElevationZone(map.id, { ...shape, height: clampElevHeight(elevNewHeight) });
  fogDirty = true;
}

// Newest first, whatever its kind — where a wall, a fog edit and a height zone
// overlap, the one drawn last comes off first (pieceTime()), so an eraser
// click undoes the stack in the order it was built.
function eraseMapPieceAt(map, w) {
  let best = null;
  [['masks', mapMasks(map)], ['elevation', mapElevationZones(map)], ['walls', mapWalls(map)]].forEach(([kind, list]) => {
    list.forEach(p => {
      if (!pointInWall(w.x, w.y, p)) return;
      if (!best || pieceTime(p) > pieceTime(best.piece)) best = { kind, piece: p };
    });
  });
  if (!best) return;
  removePiece(map.id, best.kind, best.piece.id);
  fogDirty = true;
}

// The Maps pane's piece list (battlemap-library.js) points at one piece on the
// board while it is hovered — { kind, id } or null. Session only.
let mapHighlight = null;

function setMapHighlight(kind, id) {
  const same = kind && mapHighlight && mapHighlight.kind === kind && mapHighlight.id === id;
  if (same || (!kind && !mapHighlight)) return;
  mapHighlight = kind ? { kind, id } : null;
  drawBattlemap();
}

// The colour each piece is drawn in on the board, so the pane's swatch and the
// hover halo match what the GM is looking at.
function mapPieceColor(kind, piece) {
  if (kind === 'tokens') return hostilityColor(piece.hostility);
  if (kind === 'walls') return MAP_MODE_TONE.wall;
  if (kind === 'masks') return MAP_MODE_TONE[piece.mode === 'hide' ? 'fog-hide' : 'fog-show'];
  const h = elevZoneHeight(piece);
  return ELEVATION_TONE[h > 0 ? 'up' : h < 0 ? 'down' : 'neutral'].stroke;
}

// A glowing outline round the hovered piece, over everything else. A piece
// that went away while hovered (removed from the list) simply draws nothing.
function drawMapHighlight(ctx, map) {
  if (!mapHighlight) return;
  const piece = (map[mapHighlight.kind] || {})[mapHighlight.id];
  if (!piece) return;
  const color = mapPieceColor(mapHighlight.kind, piece);
  ctx.save();
  ctx.beginPath();
  if (mapHighlight.kind === 'tokens') {
    const at = tokenDrawPos(piece);
    const r = tokenRadius(map, piece);
    ctx.arc(at.x, at.y, r + Math.max(4 / mapCam.scale, r * 0.28), 0, Math.PI * 2);
  } else {
    traceMapShape(ctx, piece);
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

// =============================================================================
// THE TOOLBAR
// =============================================================================
// Rebuilt whenever what it can offer changes: the drawing tools are the GM's,
// the creature buttons need a selection.
//
// Drawing is two independent choices, not one flat list of tools — a shape
// (what outline a drag makes) and a mode (what it's for), so a Wall, an
// Obscure region and a Height zone can each be a rectangle, a circle or a
// freehand lasso. Picking either one switches `mapTool` to 'draw';
// Select/Grid/Erase are their own standalone tools alongside it. In Height
// mode a number box also rides the strip — the height new zones start at.
// See mapShape/mapMode at the top of this file.
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

// The height a freshly drawn Height zone starts at — only on the strip while the
// Height tool is up. Existing zones are re-set by right-clicking them on the map
// (see onMapPointerDown).
function buildElevHeightBox() {
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
function promptElevationHeight(mapId, zone) {
  const raw = prompt('Height of this zone in feet, from the base map (−500 to 500):', String(elevZoneHeight(zone)));
  if (raw === null) return;
  const n = Number(raw);
  if (!Number.isFinite(n)) return;
  setElevationHeight(mapId, zone.id, n);
  fogDirty = true;
  drawBattlemap();
}

// The Grid tool's own bar, under the map: what the two gestures are, and what
// the grid is at this moment (the same three numbers the Maps pane has in
// boxes). There is nothing to set here.
function syncGridHint() {
  const el = document.getElementById('map-grid-hint');
  if (!el) return;
  const map = viewedMap();
  const on = mapOpen && mapTool === 'grid' && !!map && canEditMap();
  el.classList.toggle('hidden', !on);
  if (!on) return;
  const g = viewGrid(map);
  el.textContent = 'Drag a corner or an edge of the map to grow or shrink the squares — the far side stays put. '
    + 'Drag anywhere else to slide the grid. '
    + 'Now: ' + roundGridValue(g.size) + ' px, offset ' + roundGridValue(g.offsetX)
    + ' / ' + roundGridValue(g.offsetY) + '.';
}

// The reader's own remaining movement this turn, when they have a marker on
// the board and it is on a tracked budget — see the MOVEMENT section of
// battlemap-initiative.js. Hidden for a GM (their creatures have no speed
// stat) and before there is anything to track it against.
function renderMapSpeedIndicator() {
  const el = document.getElementById('map-speed');
  if (!el) return;
  const map = mapOpen ? viewedMap() : null;
  const token = map ? mapTokens(map).find(t => t.hostility === 'party' && t.ownerUid === ownPlayerId()) : null;
  const remaining = token ? tokenMoveRemaining(map, token) : null;
  el.classList.toggle('hidden', remaining === null);
  if (remaining === null) return;
  const speed = tokenSpeed(token);
  document.getElementById('map-speed-remaining').textContent = Math.round(remaining);
  document.getElementById('map-speed-total').textContent = '/' + speed + ' ft';
}

function renderMapToolbar() {
  const map = viewedMap();
  document.getElementById('map-title').textContent = map ? map.name : 'Battle Map';

  const gm = canEditMap();
  if (!gm && mapTool !== 'select') mapTool = 'select'; // a player has nothing else

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

  buildToolGroup(MAP_STANDALONE_TOOLS.filter(t => !t.gm || gm), mapTool, id => { mapTool = id; });
  if (gm) {
    // Picking a shape or a mode is also picking "I want to draw" — see
    // mapShape/mapMode at the top of this file. Their buttons only read as
    // "selected" while draw is actually the live tool — switching to
    // Select/Grid/Erase must not leave every group looking chosen at once.
    const drawActive = mapTool === 'draw';
    buildToolGroup(MAP_SHAPES, drawActive ? mapShape : null, id => { mapShape = id; mapTool = 'draw'; });
    buildToolGroup(MAP_MODES, drawActive ? mapMode : null, id => { mapMode = id; mapTool = 'draw'; });
    if (mapMode === 'elev' && mapTool === 'draw') tools.appendChild(buildElevHeightBox());
    buildToolGroup([MAP_ERASE_TOOL], mapTool, id => { mapTool = id; });
  }
  syncGridHint();

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

  if (gm && map) {
    const g = mapGrid(map);
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
  fit.addEventListener('click', () => { if (map) { fitMapToView(map); drawBattlemap(); } });
  acts.appendChild(fit);
}

// =============================================================================
// WIRING
// =============================================================================
document.getElementById('map-btn').addEventListener('click', () => openBattlemap());
document.getElementById('map-close-btn').addEventListener('click', closeBattlemap);

document.addEventListener('keydown', e => {
  if (!mapOpen) return;
  if (document.querySelector('.modal:not(.hidden)')) return;
  // The map is in a panel beside a chat box and a sheet full of fields — a key
  // pressed into one of those is not a key pressed at the board.
  const t = e.target;
  if (t && t.matches && t.matches('input, textarea, select')) return;
  if (t && t.isContentEditable) return;
  if (e.key === 'Escape') {
    // A shape half drawn — or a grid half dragged — is what Escape refuses, not the map.
    if (mapDrawing) { mapDrawing = null; drawBattlemap(); return; }
    if (mapGridDrag) { mapGridDrag = null; drawBattlemap(); return; }
    closeBattlemap();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && mapSelectedTokenId) {
    const map = viewedMap();
    const token = map ? (map.tokens || {})[mapSelectedTokenId] : null;
    if (token && canControlToken(token)) {
      removeToken(map.id, token.id);
      mapSelectedTokenId = null;
      renderMapToolbar();
    }
  }
});
