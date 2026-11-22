// =============================================================================
// BATTLEMAP — the table's maps: the model, the Firebase seam, and line of sight
// =============================================================================
'use strict';

// A battle map belongs to the table. `state.battlemap` is a read-through cache
// of `parties/<code>/battlemap`; nothing about a map is in the save file.
//
//   parties/<code>/battlemap/activeId          which map the party is on
//   parties/<code>/battlemap/maps/<mapId>
//     { id, name, image, w, h, order, revealed, createdAt,
//       grid:   { type, size, offsetX, offsetY, visible },
//       tokens: { <id>: { id, name, icon, x, y, size, hostility, ownerUid } },
//       walls:  { <id>: <shape> },
//       masks:  { <id>: { mode:'hide'|'show', ...<shape> } },
//       elevation: { <id>: { height:<feet, -500..500>, ...<shape> } } }
//
//   <shape> = { id, kind:'rect',   x, y, w, h }
//           | { id, kind:'circle', x, y, r }
//           | { id, kind:'poly',   points: [[x,y], [x,y], ...] }
//
// A wall, a fog mask and an elevation zone are three uses of the same shape.
// The ray tests, isPointInWall() and the canvas's shape tracer (battlemap-view.js) are the
// one place each `kind` is handled, so nothing else has to tell a lasso from a
// rectangle.
//
// Every coordinate is in the image's own pixels, never screen pixels or cells:
// that is the one frame every client agrees on. Reveal and fog are pacing, not
// security. battlemap-view.js is the canvas.

// The standard 5-foot square, the unit a character's Speed is written in.
const MAP_FEET_PER_CELL = 5;

// px; the floor is what getMapCellSize() accepts back, the ceiling is the number
// boxes' own, so a dragged size and a typed one agree.
const MAP_GRID_MIN_SIZE = 8;
const MAP_GRID_MAX_SIZE = 600;

const TAU = Math.PI * 2;
const VISION_SWEEP = 180;    // rays in the uniform fan
const VISION_NUDGE = 0.0006; // radians either side of a corner

// Read out of CSS and cached. Baked into canvas fills and inline `--hc`, so a
// palette swap must clear it and redraw (`_rerenderThemedContent()`).
let hostilityColorCache = {};

let partyBattlemapRef = null;

// ─── SHAPE OF A MAP ─────────────────────────────────────────────────────────

// The map's grid settings, with defaults filled in.
function getMapGrid(map) {
  return { ...MAP_GRID_DEFAULT, ...(map?.grid ?? {}) };
}

// One cell, in image pixels. Never zero: it divides.
function getMapCellSize(map) {
  const size = getMapGrid(map).size;
  return Number.isFinite(size) && size >= 4 ? size : MAP_GRID_DEFAULT.size;
}

// Movement in feet: Manhattan distance between the snapped cells a drag starts
// and ends in, so the answer is always a whole number of squares.
function getGridManhattanFeet(map, x0, y0, x1, y1, sizeCells) {
  const cell = getMapCellSize(map);
  const p0 = snapToGrid(map, x0, y0, sizeCells);
  const p1 = snapToGrid(map, x1, y1, sizeCells);
  const cells = Math.round(Math.abs(p1.x - p0.x) / cell) + Math.round(Math.abs(p1.y - p0.y) / cell);
  return cells * MAP_FEET_PER_CELL;
}

// The same distance unsnapped, so a live drag can be pulled back smoothly.
// What is shown and spent is always the snapped figure.
function getGridManhattanFeetRaw(map, x0, y0, x1, y1) {
  const cell = getMapCellSize(map);
  return (Math.abs(x1 - x0) + Math.abs(y1 - y0)) / cell * MAP_FEET_PER_CELL;
}

// Rounds a grid figure to two places. Not to whole pixels: that drifts up to
// half a pixel per square, unmissable by the thirtieth.
function roundGridValue(v) {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

// An offset means the same every cell along, so it is kept inside one cell.
function _wrapGridOffset(v, cell) {
  if (!Number.isFinite(v) || !(cell > 0)) return 0;
  return roundGridValue(((v % cell) + cell) % cell);
}

function _clampGridSize(v) {
  if (!Number.isFinite(v)) return MAP_GRID_DEFAULT.size;
  return Math.max(MAP_GRID_MIN_SIZE, Math.min(MAP_GRID_MAX_SIZE, v));
}

function _getGridSize(grid) {
  const size = grid?.size;
  return Number.isFinite(size) && size >= 4 ? size : MAP_GRID_DEFAULT.size;
}

// Scales the whole grid about one point and returns the { size, offsetX,
// offsetY } patch. The factor is read off the CLAMPED size, or the offset would
// keep scaling past the size limits and slide the grid sideways.
function scaleGridAbout(grid, pivot, k) {
  const base = _getGridSize(grid);
  const size = _clampGridSize(base * k);
  const applied = size / base;
  return {
    size: roundGridValue(size),
    offsetX: _wrapGridOffset(pivot.x + (grid.offsetX - pivot.x) * applied, size),
    offsetY: _wrapGridOffset(pivot.y + (grid.offsetY - pivot.y) * applied, size),
  };
}

// Slides the grid by the pointer's delta; returns the { offsetX, offsetY } patch.
function slideGridBy(grid, dx, dy) {
  const cell = _getGridSize(grid);
  return {
    offsetX: _wrapGridOffset(grid.offsetX + dx, cell),
    offsetY: _wrapGridOffset(grid.offsetY + dy, cell),
  };
}

// The map's creatures, as an array.
function getMapTokens(map) {
  return Object.values(map?.tokens ?? {}).filter(t => t && t.id);
}

// The map's walls, as an array.
function getMapWalls(map) {
  return Object.values(map?.walls ?? {}).filter(w => w && w.id);
}

// The map's fog masks, as an array.
function getMapMasks(map) {
  return Object.values(map?.masks ?? {}).filter(m => m && m.id);
}

// A token's radius in image pixels. Tokens are circular.
function getTokenRadius(map, token) {
  return (token.size ?? 1) * getMapCellSize(map) / 2;
}

// The colour for a hostility key, from the `--hostility-*` token (cached).
function getHostilityColor(h) {
  const key = HOSTILITY[h] ? h : 'neutral';
  if (hostilityColorCache[key]) return hostilityColorCache[key];
  const fromCss = getComputedStyle(document.documentElement)
    .getPropertyValue('--hostility-' + key).trim();
  const color = fromCss || HOSTILITY[key].color;
  hostilityColorCache[key] = color;
  return color;
}

// Forgets the cached hostility colours; call on a palette change.
function clearHostilityColorCache() { hostilityColorCache = {}; }

// A fresh map id.
function createMapId()   { return 'map_'  + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6); }

// A fresh piece id with prefix `p`. It leads with Date.now() (see getPieceTime()).
function createPieceId(p) { return p + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6); }

// ─── FIREBASE ───────────────────────────────────────────────────────────────

function _getBattlemapPath(rest) {
  return `parties/${state.party.code}/battlemap` + (rest ? '/' + rest : '');
}
function _getBattlemapRef(rest) { return firebaseDb.ref(_getBattlemapPath(rest)); }

// The Firebase ref of one map, or of `rest` beneath it.
function getMapRef(mapId, rest) { return _getBattlemapRef('maps/' + mapId + (rest ? '/' + rest : '')); }

// Starts mirroring the party's battlemap node into `state.battlemap`.
function subscribeToBattlemap(code) {
  unsubscribeFromBattlemap();
  if (!firebaseDb) return;
  partyBattlemapRef = firebaseDb.ref(`parties/${code}/battlemap`);
  partyBattlemapRef.on('value', snap => {
    const val = snap.val() ?? {};
    state.battlemap = { activeId: val.activeId ?? null, maps: val.maps ?? {} };
    // The map the GM was editing may have been deleted from another tab.
    if (state.mapLibraryOpenId && !state.battlemap.maps[state.mapLibraryOpenId]) state.mapLibraryOpenId = null;
    _onBattlemapChanged();
  });
}

// Stops mirroring and empties `state.battlemap`.
function unsubscribeFromBattlemap() {
  if (partyBattlemapRef) { partyBattlemapRef.off(); partyBattlemapRef = null; }
  state.battlemap = { activeId: null, maps: {} };
  state.mapLibraryOpenId = null;
  _onBattlemapChanged();
}

// Everything that has to notice a map changing, in one place.
function _onBattlemapChanged() {
  syncLeftPanel();      // a first map makes the GM's Maps tab appear
  syncMapButton();
  onBattlemapDataChanged(); // redraws, or closes a map that went away
  // Runs even off the map view: the turn border must reach a reader on their sheet.
  syncMyTurnBorder();
}

// ─── WHO SEES WHAT ──────────────────────────────────────────────────────────

// Whether this reader is the GM of an active party.
function isMapGM() { return state.party.active && state.party.role === 'gm'; }

// The GM alone edits the terrain, the grid and the fog; adding a creature is
// everyone's (canAddCreature()).
function canEditMap() { return isMapGM(); }

// A creature is anybody's: deliberately NOT gated by isReadOnly(), which guards
// a *character*.
function canAddCreature() { return state.party.active && isSignedIn(); }

// Every map in the library, in the GM's order.
function getAllMaps() {
  return Object.values(state.battlemap?.maps ?? {})
    .filter(m => m && m.id)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// The map with this id, or null.
function getMapById(id) { return id ? (state.battlemap?.maps ?? {})[id] ?? null : null; }

// The id of the map the party is on, or null.
function getActiveMapId() { return state.battlemap?.activeId ?? null; }

// The map the party is on, as this reader may see it: a GM always, a player
// only once it is revealed.
function getMapForViewer() {
  const map = getMapById(getActiveMapId());
  if (!map) return null;
  if (isMapGM()) return map;
  return map.revealed ? map : null;
}

// ─── GM EDITS ───────────────────────────────────────────────────────────────

// Puts the party on a map (null for none).
function setActiveMap(mapId) {
  if (!canEditMap() || !firebaseDb) return;
  _getBattlemapRef('activeId').set(mapId ?? null);
}

// Shows a map to the players or hides it.
function setMapRevealed(mapId, revealed) {
  if (!canEditMap() || !firebaseDb) return;
  getMapRef(mapId).update({ revealed: !!revealed });
}

// Deletes a map and everything on it, after a confirm.
function deleteMap(map) {
  if (!canEditMap() || !firebaseDb) return;
  if (!confirm(`Delete “${map.name}”? Its creatures, walls and fog go with it.`)) return;
  if (state.mapLibraryOpenId === map.id) state.mapLibraryOpenId = null;
  if (getActiveMapId() === map.id) _getBattlemapRef('activeId').set(null);
  getMapRef(map.id).remove();
  renderMapPanel();
}

// Writes a partial grid change over the map's current grid.
function updateMapGrid(mapId, patch) {
  if (!canEditMap() || !firebaseDb) return;
  const map = getMapById(mapId);
  if (!map) return;
  getMapRef(mapId, 'grid').set({ ...getMapGrid(map), ...patch });
}

// ─── CREATURES ──────────────────────────────────────────────────────────────

// Places a creature; returns its new id, or null when not allowed.
function addToken(mapId, token) {
  if (!canAddCreature() || !firebaseDb) return null;
  const id = createPieceId('tok');
  // A marker belongs to whoever placed it, but the GM may hand one straight to
  // a player, so `token.ownerUid` is honoured only for the GM.
  const ownerUid = (isMapGM() && token.ownerUid) ? token.ownerUid : (getOwnPlayerId() ?? '');
  getMapRef(mapId, 'tokens/' + id).set({ ...token, id, ownerUid });
  return id;
}

// Writes a partial change to one creature.
function updateToken(mapId, tokenId, patch) {
  if (!firebaseDb || !state.party.active) return;
  getMapRef(mapId, 'tokens/' + tokenId).update(patch);
}

// Whether this reader may move or remove a token: whoever placed it, or the GM.
// Pacing, not security.
function canControlToken(token) {
  return canEditMap() || (token.ownerUid && token.ownerUid === getOwnPlayerId());
}

// Whether a token's owner is one of the party's players (not the GM, not
// nobody): what the purple ring on the board means.
function isTokenOwnedByPlayer(token) {
  return !!(token && token.ownerUid && state.party.players && state.party.players[token.ownerUid]);
}

// Removes one creature from a map.
function removeToken(mapId, tokenId) {
  if (!firebaseDb) return;
  getMapRef(mapId, 'tokens/' + tokenId).remove();
}

// ─── WALLS AND FOG REGIONS ──────────────────────────────────────────────────

// Adds a wall shape to a map.
function addWall(mapId, wall) {
  if (!canEditMap() || !firebaseDb) return;
  const id = createPieceId('wall');
  getMapRef(mapId, 'walls/' + id).set({ ...wall, id });
}

// Adds a fog mask shape to a map.
function addMask(mapId, mask) {
  if (!canEditMap() || !firebaseDb) return;
  const id = createPieceId('mask');
  getMapRef(mapId, 'masks/' + id).set({ ...mask, id });
}

// Adds an elevation zone shape to a map.
function addElevationZone(mapId, zone) {
  if (!canEditMap() || !firebaseDb) return;
  const id = createPieceId('elev');
  getMapRef(mapId, 'elevation/' + id).set({ ...zone, id });
}

// Sets an elevation zone's height in feet (clamped).
function setElevationHeight(mapId, id, height) {
  if (!canEditMap() || !firebaseDb) return;
  getMapRef(mapId, 'elevation/' + id + '/height').set(clampElevHeight(height));
}

// Removes one wall, mask or elevation zone (`kind` is its model key).
function removePiece(mapId, kind, id) {
  if (!canEditMap() || !firebaseDb) return;
  getMapRef(mapId, kind + '/' + id).remove();
}

// When a piece was placed, read back out of its id, so no field is needed.
// 0 for an id that doesn't parse.
function getPieceTime(piece) {
  const match = /^[a-z]+_([0-9a-z]+)_/.exec(String(piece?.id ?? ''));
  return match ? parseInt(match[1], 36) : 0;
}

// Removes every piece of one kind from a map, after a confirm.
function clearMapPieces(mapId, kind, label) {
  if (!canEditMap() || !firebaseDb) return;
  if (!confirm(`Remove every ${label} from this map?`)) return;
  getMapRef(mapId, kind).remove();
}

// ─── GEOMETRY: LINE OF SIGHT ────────────────────────────────────────────────
// Straight lines from every party member, stopped by walls. A polygon per
// source, not lit cells: a map is a picture and the grid can move under it.

// Ray against an axis-aligned rectangle (slab method). Distance to the near
// face in image pixels (the direction is a unit vector), or null for a miss.
function _getRayRectHit(ox, oy, dx, dy, r) {
  let tmin = -Infinity, tmax = Infinity;
  const slab = (o, d, lo, hi) => {
    if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
    const t1 = (lo - o) / d, t2 = (hi - o) / d;
    tmin = Math.max(tmin, Math.min(t1, t2));
    tmax = Math.min(tmax, Math.max(t1, t2));
    return true;
  };
  if (!slab(ox, dx, r.x, r.x + r.w)) return null;
  if (!slab(oy, dy, r.y, r.y + r.h)) return null;
  if (tmax < Math.max(tmin, 0)) return null;
  return tmin > 0 ? tmin : null; // a source inside the box is handled by the caller
}

function _getRayCircleHit(ox, oy, dx, dy, c) {
  const fx = ox - c.x, fy = oy - c.y;
  const b = 2 * (fx * dx + fy * dy);
  const cc = fx * fx + fy * fy - c.r * c.r;
  const disc = b * b - 4 * cc;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t1 = (-b - s) / 2, t2 = (-b + s) / 2;
  if (t1 > 0) return t1;
  if (t2 > 0) return t2;
  return null;
}

// Even-odd ray casting.
function _isPointInPolygon(x, y, points) {
  let isInside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) isInside = !isInside;
  }
  return isInside;
}

// Whether a point lies inside a shape (wall, mask or elevation zone).
function isPointInWall(x, y, w) {
  if (w.kind === 'circle') {
    const dx = x - w.x, dy = y - w.y;
    return dx * dx + dy * dy <= (w.r ?? 0) * (w.r ?? 0);
  }
  if (w.kind === 'poly') return _isPointInPolygon(x, y, w.points || []);
  return x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h;
}

function _normalizeAngle(a) {
  const m = a % TAU;
  return m < 0 ? m + TAU : m;
}

// The angles worth casting at: a uniform sweep plus three rays at every corner
// (one either side by a hair), so a shadow's edge is straight. Every angle is
// normalized into [0, 2π) before the sort, NOT a tidy-up: atan2 answers in
// (-π, π], and a mixed sort lets the coarse pass paint over corner shadows.
// `extraShapes` (elevation zones) are aimed at but never block outright.
function _getVisionAngles(ox, oy, walls, bounds, extraShapes) {
  const angles = [];
  const push = a => angles.push(_normalizeAngle(a));

  for (let i = 0; i < VISION_SWEEP; i++) push(i * TAU / VISION_SWEEP);

  const aim = (px, py) => {
    const a = Math.atan2(py - oy, px - ox);
    push(a - VISION_NUDGE); push(a); push(a + VISION_NUDGE);
  };

  const aimShape = w => {
    if (w.kind === 'circle') {
      // The two tangents, where the shadow's edge is.
      const dx = w.x - ox, dy = w.y - oy;
      const dist = Math.hypot(dx, dy);
      if (dist <= (w.r ?? 0) || !dist) return;
      const base = Math.atan2(dy, dx);
      const spread = Math.asin(Math.min(1, (w.r ?? 0) / dist));
      push(base - spread - VISION_NUDGE); push(base - spread + VISION_NUDGE);
      push(base + spread - VISION_NUDGE); push(base + spread + VISION_NUDGE);
    } else if (w.kind === 'poly') {
      (w.points || []).forEach(([px, py]) => aim(px, py));
    } else {
      aim(w.x, w.y); aim(w.x + w.w, w.y); aim(w.x, w.y + w.h); aim(w.x + w.w, w.y + w.h);
    }
  };

  walls.forEach(aimShape);
  (extraShapes ?? []).forEach(aimShape);
  // The map's own corners, so the fan reaches them cleanly.
  aim(bounds.x, bounds.y); aim(bounds.x + bounds.w, bounds.y);
  aim(bounds.x, bounds.y + bounds.h); aim(bounds.x + bounds.w, bounds.y + bounds.h);

  angles.sort((a, b) => a - b);

  // Drop near-duplicate rays so the polygon carries no zero-length edges.
  const unique = [];
  for (const a of angles) if (!unique.length || a - unique[unique.length - 1] > 1e-7) unique.push(a);
  return unique;
}

// The polygon one creature can see, in image pixels. A wall containing the
// source is skipped. `elev` (optional, from getElevationViewFor()) shortens rays
// like a wall, by how far rather than whether.
function computeVisionPolygon(ox, oy, walls, bounds, elev) {
  const liveWalls = walls.filter(w => !isPointInWall(ox, oy, w));
  // Never further than the far corner of the map, so the fan always terminates.
  const reach = Math.hypot(bounds.w, bounds.h) + Math.hypot(ox - bounds.x, oy - bounds.y);
  const higherZones = elev ? elev.zones.filter(z => getElevZoneHeight(z) > elev.sourceHeight) : [];

  return _getVisionAngles(ox, oy, liveWalls, bounds, elev ? elev.zones : null).map(a => {
    const dx = Math.cos(a), dy = Math.sin(a);
    let t = reach;
    for (const w of liveWalls) {
      const hit = _getRayShapeHit(ox, oy, dx, dy, w);
      if (hit !== null && hit < t) t = hit;
    }
    if (elev) t = Math.min(t, _getElevationRayLimit(ox, oy, dx, dy, elev, higherZones));
    return [ox + dx * t, oy + dy * t];
  });
}

// Every creature the party sees out of: a union, so one player sees what
// another sees.
function getVisionSources(map) {
  return getMapTokens(map).filter(t => t.hostility === 'party');
}

// ─── GEOMETRY: ELEVATION ────────────────────────────────────────────────────
// Each zone has a `height` in feet in [-500, 500], measured from the base map
// (height 0). Looking down is always free. Looking up is tapered, never blocked
// outright: the farther a viewer stands from a rise, the more of it they see.
//
// f(d) = floor(2d / h): tiles visible past the zone's near edge, where d is the
// viewer's distance to it and h its height RELATIVE to the viewer's ground, both
// in feet. h ≤ 0 is unimpeded.

// A zone's height in feet from the base map.
function getElevZoneHeight(z) {
  const h = Number(z?.height);
  if (Number.isFinite(h)) return h;
  return z?.level === 'low' ? -20 : z?.level === 'high' ? 20 : 0; // zones saved with a `level` word
}

// Clamps a typed height to a whole number of feet in [-500, 500].
function clampElevHeight(v) {
  return Math.max(-500, Math.min(500, Math.round(Number(v) || 0)));
}

// The map's elevation zones, as an array.
function getMapElevationZones(map) {
  return Object.values(map?.elevation ?? {}).filter(z => z && z.id);
}

// Last drawn wins where two zones overlap, the same rule a fog mask follows.
function _getElevationZoneAt(map, x, y) {
  const zones = getMapElevationZones(map);
  for (let i = zones.length - 1; i >= 0; i--) if (isPointInWall(x, y, zones[i])) return zones[i];
  return null;
}

// What a vision source needs about elevation, worked out once per source
// rather than per ray. Null when the map has no elevation (the common case).
function getElevationViewFor(map, ox, oy) {
  const zones = getMapElevationZones(map);
  if (!zones.length) return null;
  const ownZone = _getElevationZoneAt(map, ox, oy);
  return { zones, sourceHeight: ownZone ? getElevZoneHeight(ownZone) : 0, ownZone, cellPx: getMapCellSize(map) };
}

// f(d) above: tiles visible past a rise of `hFeet` from `dFeet` back.
function _getElevationVisibleTiles(dFeet, hFeet) {
  if (hFeet <= 0) return Infinity;
  return Math.max(0, Math.floor(2 * dFeet / hFeet));
}

// Both roots of a ray/shape intersection ({ enter, exit }): how far the ray
// travels inside the shape, needed to find where a low source's ground ends.
function _getRayRectSpan(ox, oy, dx, dy, r) {
  let tmin = -Infinity, tmax = Infinity;
  const slab = (o, d, lo, hi) => {
    if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
    const t1 = (lo - o) / d, t2 = (hi - o) / d;
    tmin = Math.max(tmin, Math.min(t1, t2));
    tmax = Math.min(tmax, Math.max(t1, t2));
    return true;
  };
  if (!slab(ox, dx, r.x, r.x + r.w)) return null;
  if (!slab(oy, dy, r.y, r.y + r.h)) return null;
  if (tmax < tmin) return null;
  return { enter: tmin, exit: tmax };
}
function _getRayCircleSpan(ox, oy, dx, dy, c) {
  const fx = ox - c.x, fy = oy - c.y;
  const b = 2 * (fx * dx + fy * dy);
  const cc = fx * fx + fy * fy - c.r * c.r;
  const disc = b * b - 4 * cc;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  return { enter: (-b - s) / 2, exit: (-b + s) / 2 };
}

// A ray (t unrestricted in sign) against segment (x1,y1)-(x2,y2). Returns t, or
// null if they never cross or run parallel.
function _getRaySegmentHit(ox, oy, dx, dy, x1, y1, x2, y2) {
  const ex = x2 - x1, ey = y2 - y1;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((x1 - ox) * ey - (y1 - oy) * ex) / denom;
  const u = ((x1 - ox) * dy - (y1 - oy) * dx) / denom;
  if (u < 0 || u > 1) return null;
  return t;
}

// The nearest positive crossing with a lasso's closed loop of edges.
function _getRayPolygonHit(ox, oy, dx, dy, points) {
  let best = null;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
    const t = _getRaySegmentHit(ox, oy, dx, dy, x1, y1, x2, y2);
    if (t !== null && t > 1e-6 && (best === null || t < best)) best = t;
  }
  return best;
}

// Smallest and largest crossing across every edge. Exact for a convex trace; for
// a concave one it can miss an inner lobe, accepted since the shape is freehand.
function _getRayPolygonSpan(ox, oy, dx, dy, points) {
  let enter = null, exit = null;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
    const t = _getRaySegmentHit(ox, oy, dx, dy, x1, y1, x2, y2);
    if (t === null) continue;
    if (enter === null || t < enter) enter = t;
    if (exit === null || t > exit) exit = t;
  }
  return enter === null ? null : { enter, exit };
}

// The one place a shape's `kind` picks which ray test to run.
function _getRayShapeHit(ox, oy, dx, dy, s) {
  if (s.kind === 'circle') return _getRayCircleHit(ox, oy, dx, dy, s);
  if (s.kind === 'poly') return _getRayPolygonHit(ox, oy, dx, dy, s.points || []);
  return _getRayRectHit(ox, oy, dx, dy, s);
}
function _getRayShapeSpan(ox, oy, dx, dy, s) {
  if (s.kind === 'circle') return _getRayCircleSpan(ox, oy, dx, dy, s);
  if (s.kind === 'poly') return _getRayPolygonSpan(ox, oy, dx, dy, s.points || []);
  return _getRayRectSpan(ox, oy, dx, dy, s);
}

// How far elevation lets one ray travel, in image pixels (the formula works in
// feet, scaled by MAP_FEET_PER_CELL / cellPx). Two independent limits, the
// shortest wins:
//   - a viewer in a zone below base: leaving it is a rise to base, with d
//     measured to where that ground ends (span.exit);
//   - entering a zone higher than the viewer: d is where the ray first reaches
//     it, h that zone's height relative to the viewer, whatever lies between.
function _getElevationRayLimit(ox, oy, dx, dy, elev, higherZones) {
  let limit = Infinity;
  const pxToFeet = MAP_FEET_PER_CELL / elev.cellPx;

  const ownHeight = elev.ownZone ? getElevZoneHeight(elev.ownZone) : 0;
  if (elev.ownZone && ownHeight < 0) {
    const span = _getRayShapeSpan(ox, oy, dx, dy, elev.ownZone);
    if (span && span.exit > 0) {
      const tiles = _getElevationVisibleTiles(span.exit * pxToFeet, -ownHeight);
      limit = Math.min(limit, span.exit + tiles * elev.cellPx);
    }
  }

  higherZones.forEach(z => {
    const hit = _getRayShapeHit(ox, oy, dx, dy, z);
    if (hit === null) return;
    const tiles = _getElevationVisibleTiles(hit * pxToFeet, getElevZoneHeight(z) - elev.sourceHeight);
    limit = Math.min(limit, hit + tiles * elev.cellPx);
  });

  return limit;
}

// ─── GEOMETRY: SNAPPING ─────────────────────────────────────────────────────

// Snaps a creature's centre to the grid: an odd footprint centres on a square,
// an even one on the line between two. Tiny centres like Medium.
function snapToGrid(map, x, y, sizeCells) {
  const g = getMapGrid(map);
  const cell = getMapCellSize(map);
  const cells = Math.max(1, Math.round(sizeCells ?? 1));
  const half = cells % 2 === 1 ? cell / 2 : 0;
  const snap = (v, off) => Math.round((v - off - half) / cell) * cell + off + half;
  return { x: snap(x, g.offsetX), y: snap(y, g.offsetY) };
}
