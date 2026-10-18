// =============================================================================
// BATTLEMAP — the table's maps: the model, the GM's library, and line of sight
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
// A wall, a fog mask and an elevation zone are three uses of the same shape —
// the GM's Shape and Mode toolbar picks one of each independently (see THE
// TOOLBAR in battlemap-view.js). `rayShapeHit()`/`rayShapeSpan()`/
// `pointInWall()`/`traceMapShape()` are the one place each `kind` is handled,
// so nothing that draws or casts a ray against a wall has to know a lasso
// from a rectangle.
//
// Every coordinate in the model is in the image's own pixels — never screen
// pixels, never cells — because that is the one frame every client agrees on.
// Reveal and fog are pacing, not security. This file is the model, the Firebase
// seam and the geometry; battlemap-view.js is the canvas. See CLAUDE.md § Battle maps.

// =============================================================================
// SHAPE OF A MAP
// =============================================================================
const MAP_GRID_DEFAULT = { type: 'square', size: 70, offsetX: 0, offsetY: 0, visible: true };

// The `color` here is only the fallback — the real one is the `--hostility-*`
// token (see hostilityColor()).
const HOSTILITY = {
  party:   { label: 'Party',   color: '#2f7d3f' },
  neutral: { label: 'Neutral', color: '#b08108' },
  hostile: { label: 'Hostile', color: '#a5312a' },
};
const HOSTILITY_ORDER = ['party', 'neutral', 'hostile'];

// A token's `size` is stored as a number of cells, not a word, so the geometry
// never has to look one up and a homebrew size still works.
const CREATURE_SIZES = [
  { id: 'tiny',        label: 'Tiny',        cells: 0.5 },
  { id: 'medium',      label: 'Small / Medium', cells: 1 },
  { id: 'large',       label: 'Large',       cells: 2 },
  { id: 'huge',        label: 'Huge',        cells: 3 },
  { id: 'gargantuan',  label: 'Gargantuan',  cells: 4 },
];

// A short opinionated list, not free text — a token is read at a glance across a
// shared board.
const CREATURE_ICONS = [
  '🗡️', '🏹', '🛡️', '🪄', '✨', '🎵', '🐺', '🐉', '🕷️', '🦇',
  '💀', '👹', '👻', '🧟', '🐻', '🐍', '🔥', '🧊', '⭐', '❓',
];

function mapGrid(map) {
  return { ...MAP_GRID_DEFAULT, ...(map?.grid ?? {}) };
}

// One cell, in image pixels. Never zero — it divides.
function mapCellSize(map) {
  const s = mapGrid(map).size;
  return Number.isFinite(s) && s >= 4 ? s : MAP_GRID_DEFAULT.size;
}

// This app assumes the standard 5-foot square — nothing about a map says
// otherwise, and it is the unit a character's Speed stat is already written
// in.
const MAP_FEET_PER_CELL = 5;

// Movement is measured on the grid a creature actually stands on, not the
// picture underneath it: Manhattan distance between the cells a drag starts
// and ends in (a diagonal step costs both axes, not the shorter straight line
// between them), snapped through the same snapToGrid() a token's real
// position is always in — so the answer is always a whole number of squares,
// never a fraction of one. See the MOVEMENT section of
// battlemap-initiative.js.
function gridManhattanFeet(map, x0, y0, x1, y1, sizeCells) {
  const cell = mapCellSize(map);
  const p0 = snapToGrid(map, x0, y0, sizeCells);
  const p1 = snapToGrid(map, x1, y1, sizeCells);
  const cells = Math.round(Math.abs(p1.x - p0.x) / cell) + Math.round(Math.abs(p1.y - p0.y) / cell);
  return cells * MAP_FEET_PER_CELL;
}

// The same distance, unsnapped — continuous rather than stepped, so a live
// drag in progress can be pulled back smoothly instead of jumping cell to
// cell. Only for that: what is actually shown and spent is always the snapped
// figure above.
function gridManhattanFeetRaw(map, x0, y0, x1, y1) {
  const cell = mapCellSize(map);
  return (Math.abs(x1 - x0) + Math.abs(y1 - y0)) / cell * MAP_FEET_PER_CELL;
}

// A grid figure is fractional, stored to two places — somebody else's picture is
// rarely a whole number of pixels per square, and rounding to one drifts up to
// half a pixel per square (unmissable by the thirtieth).
function roundGridValue(v) {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

// An offset means the same thing every cell along, so it is kept inside one cell
// — an offset of 1840 in a number box means 24.
function wrapGridOffset(v, cell) {
  if (!Number.isFinite(v) || !(cell > 0)) return 0;
  return roundGridValue(((v % cell) + cell) % cell);
}

// The size range a grid may be given. Floor is what mapCellSize() accepts back,
// ceiling is the number boxes' own, so a dragged size and a typed one agree.
const MAP_GRID_MIN_SIZE = 8;
const MAP_GRID_MAX_SIZE = 600;

function clampGridSize(v) {
  if (!Number.isFinite(v)) return MAP_GRID_DEFAULT.size;
  return Math.max(MAP_GRID_MIN_SIZE, Math.min(MAP_GRID_MAX_SIZE, v));
}

function gridSizeOf(grid) {
  const s = grid?.size;
  return Number.isFinite(s) && s >= 4 ? s : MAP_GRID_DEFAULT.size;
}

// Scale the whole grid about one point: a line at `x` lands at
// `pivot + (x - pivot) * k`, so the offset moves by that and the size multiplies
// — one transform describes the whole grid. The applied factor is read off the
// CLAMPED size, or an offset would go on scaling past the size limits and slide
// the grid sideways.
function scaleGridAbout(grid, pivot, k) {
  const base = gridSizeOf(grid);
  const size = clampGridSize(base * k);
  const applied = size / base;
  return {
    size: roundGridValue(size),
    offsetX: wrapGridOffset(pivot.x + (grid.offsetX - pivot.x) * applied, size),
    offsetY: wrapGridOffset(pivot.y + (grid.offsetY - pivot.y) * applied, size),
  };
}

// Slide: the size is untouched and both offsets take the pointer's delta.
function slideGridBy(grid, dx, dy) {
  const cell = gridSizeOf(grid);
  return {
    offsetX: wrapGridOffset(grid.offsetX + dx, cell),
    offsetY: wrapGridOffset(grid.offsetY + dy, cell),
  };
}

function mapTokens(map) {
  return Object.values(map?.tokens ?? {}).filter(t => t && t.id);
}
function mapWalls(map) {
  return Object.values(map?.walls ?? {}).filter(w => w && w.id);
}
function mapMasks(map) {
  return Object.values(map?.masks ?? {}).filter(m => m && m.id);
}

// A token's radius in image pixels. Tokens are circular.
function tokenRadius(map, token) {
  return (token.size ?? 1) * mapCellSize(map) / 2;
}

// Read out of CSS and cached, like rarityColor() — baked into a canvas fill and
// the icon buttons' inline `--hc`, so a palette swap must clear the cache and
// redraw (`rerenderThemedContent()`).
let _hostilityColorCache = {};

function hostilityColor(h) {
  const key = HOSTILITY[h] ? h : 'neutral';
  if (_hostilityColorCache[key]) return _hostilityColorCache[key];
  const fromCss = getComputedStyle(document.documentElement)
    .getPropertyValue('--hostility-' + key).trim();
  const color = fromCss || HOSTILITY[key].color;
  _hostilityColorCache[key] = color;
  return color;
}

function clearHostilityColorCache() { _hostilityColorCache = {}; }

function newMapId()   { return 'map_'  + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6); }
function newPieceId(p) { return p + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6); }

// =============================================================================
// FIREBASE
// =============================================================================
function battlemapPath(rest) {
  return `parties/${state.party.code}/battlemap` + (rest ? '/' + rest : '');
}
function battlemapRef(rest) { return firebaseDb.ref(battlemapPath(rest)); }
function mapRef(mapId, rest) { return battlemapRef('maps/' + mapId + (rest ? '/' + rest : '')); }

let partyBattlemapRef = null;

function subscribeToBattlemap(code) {
  unsubscribeFromBattlemap();
  if (!firebaseDb) return;
  partyBattlemapRef = firebaseDb.ref(`parties/${code}/battlemap`);
  partyBattlemapRef.on('value', snap => {
    const val = snap.val() ?? {};
    state.battlemap = { activeId: val.activeId ?? null, maps: val.maps ?? {} };
    // The map the GM was editing may have been deleted from another tab.
    if (state.mapLibraryOpenId && !state.battlemap.maps[state.mapLibraryOpenId]) state.mapLibraryOpenId = null;
    onBattlemapChanged();
  });
}

function unsubscribeFromBattlemap() {
  if (partyBattlemapRef) { partyBattlemapRef.off(); partyBattlemapRef = null; }
  state.battlemap = { activeId: null, maps: {} };
  state.mapLibraryOpenId = null;
  onBattlemapChanged();
}

// Everything that has to notice a map changing, in one place.
function onBattlemapChanged() {
  syncLeftPanel();      // a first map makes the GM's Maps tab appear
  syncMapButton();
  onBattlemapDataChanged(); // battlemap-view.js — redraws, or closes a map that went away
  // Against the party's actual map, not whichever one a GM has open — see
  // syncMyTurnBorder() in battlemap-initiative.js. Runs even off the map view,
  // since the turn border is meant to reach a reader looking at their sheet.
  syncMyTurnBorder();
}

// =============================================================================
// WHO SEES WHAT
// =============================================================================
function isMapGM() { return state.party.active && state.party.role === 'gm'; }

// The GM alone edits the terrain, the grid and the fog. Adding a creature is
// everyone's — see canAddCreature().
function canEditMap() { return isMapGM(); }

// A creature is anybody's — deliberately NOT gated by isReadOnly(), which guards
// a *character*.
function canAddCreature() { return state.party.active && isSignedIn(); }

function allMaps() {
  return Object.values(state.battlemap?.maps ?? {})
    .filter(m => m && m.id)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function mapById(id) { return id ? (state.battlemap?.maps ?? {})[id] ?? null : null; }

function activeMapId() { return state.battlemap?.activeId ?? null; }

// The map the party is on, as this reader may see it. A GM always gets it; a
// player only once it is revealed.
function mapForViewer() {
  const map = mapById(activeMapId());
  if (!map) return null;
  if (isMapGM()) return map;
  return map.revealed ? map : null;
}

// =============================================================================
// GM EDITS
// =============================================================================
function setActiveMap(mapId) {
  if (!canEditMap() || !firebaseDb) return;
  battlemapRef('activeId').set(mapId ?? null);
}

function setMapRevealed(mapId, revealed) {
  if (!canEditMap() || !firebaseDb) return;
  mapRef(mapId).update({ revealed: !!revealed });
}

function deleteMap(map) {
  if (!canEditMap() || !firebaseDb) return;
  if (!confirm(`Delete “${map.name}”? Its creatures, walls and fog go with it.`)) return;
  if (state.mapLibraryOpenId === map.id) state.mapLibraryOpenId = null;
  if (activeMapId() === map.id) battlemapRef('activeId').set(null);
  mapRef(map.id).remove();
  renderMapPanel();
}

function updateMapGrid(mapId, patch) {
  if (!canEditMap() || !firebaseDb) return;
  const map = mapById(mapId);
  if (!map) return;
  mapRef(mapId, 'grid').set({ ...mapGrid(map), ...patch });
}

// ─── CREATURES ─────────────────────────────────────────────────────────────
function addToken(mapId, token) {
  if (!canAddCreature() || !firebaseDb) return null;
  const id = newPieceId('tok');
  // Ordinarily a marker belongs to whoever placed it — but the GM may hand one
  // straight to a player (creature-owner-field in the creature modal), which is
  // why `token.ownerUid` is honoured first and only for the GM.
  const ownerUid = (isMapGM() && token.ownerUid) ? token.ownerUid : (ownPlayerId() ?? '');
  mapRef(mapId, 'tokens/' + id).set({ ...token, id, ownerUid });
  return id;
}

function updateToken(mapId, tokenId, patch) {
  if (!firebaseDb || !state.party.active) return;
  mapRef(mapId, 'tokens/' + tokenId).update(patch);
}

// Removed, or dragged (see onMapPointerDown in battlemap-view.js), by whoever
// put it there, or by the GM. Pacing, like everything else a token permits —
// see CLAUDE.md § Party membership.
function canControlToken(token) {
  return canEditMap() || (token.ownerUid && token.ownerUid === ownPlayerId());
}

// The account behind a token's ownerUid is one of the party's players (as
// opposed to the GM, or nobody) — what the purple ring on the board means, and
// half of what canControlToken() gates.
function tokenOwnedByPlayer(token) {
  return !!(token && token.ownerUid && state.party.players && state.party.players[token.ownerUid]);
}

function removeToken(mapId, tokenId) {
  if (!firebaseDb) return;
  mapRef(mapId, 'tokens/' + tokenId).remove();
}

// ─── WALLS AND FOG REGIONS ─────────────────────────────────────────────────
function addWall(mapId, wall) {
  if (!canEditMap() || !firebaseDb) return;
  const id = newPieceId('wall');
  mapRef(mapId, 'walls/' + id).set({ ...wall, id });
}

function addMask(mapId, mask) {
  if (!canEditMap() || !firebaseDb) return;
  const id = newPieceId('mask');
  mapRef(mapId, 'masks/' + id).set({ ...mask, id });
}

function addElevationZone(mapId, zone) {
  if (!canEditMap() || !firebaseDb) return;
  const id = newPieceId('elev');
  mapRef(mapId, 'elevation/' + id).set({ ...zone, id });
}

function setElevationHeight(mapId, id, height) {
  if (!canEditMap() || !firebaseDb) return;
  mapRef(mapId, 'elevation/' + id + '/height').set(clampElevHeight(height));
}

function removePiece(mapId, kind, id) {
  if (!canEditMap() || !firebaseDb) return;
  mapRef(mapId, kind + '/' + id).remove();
}

// When a piece was placed, read back out of its id (newPieceId() leads with
// Date.now() in base 36) — so every piece already on a map has one, with no
// field to add or migrate. 0 for an id that doesn't parse.
function pieceTime(piece) {
  const m = /^[a-z]+_([0-9a-z]+)_/.exec(String(piece?.id ?? ''));
  return m ? parseInt(m[1], 36) : 0;
}

function clearMapPieces(mapId, kind, label) {
  if (!canEditMap() || !firebaseDb) return;
  if (!confirm(`Remove every ${label} from this map?`)) return;
  mapRef(mapId, kind).remove();
}

// =============================================================================
// GEOMETRY — line of sight
// =============================================================================
// Straight lines from every party member, stopped by a wall the GM drew. Worked
// out as a polygon per source, not a grid of lit cells — a map is a picture, and
// the grid can be moved under it. Pacing, not security (computed and drawn on
// the reader's own machine).

// A ray against an axis-aligned rectangle (slab method). Returns the distance to
// the near face, or null for a miss. The ray direction is a unit vector, so t is
// in image pixels.
function rayRect(ox, oy, dx, dy, r) {
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

function rayCircle(ox, oy, dx, dy, c) {
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

// Even-odd ray casting, the standard test — a ray to +∞ along x crosses the
// polygon's edges an odd number of times iff the point is inside.
function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function pointInWall(x, y, w) {
  if (w.kind === 'circle') {
    const dx = x - w.x, dy = y - w.y;
    return dx * dx + dy * dy <= (w.r ?? 0) * (w.r ?? 0);
  }
  if (w.kind === 'poly') return pointInPolygon(x, y, w.points || []);
  return x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h;
}

// The angles worth casting at: a uniform sweep, plus three rays at every corner
// (one either side by a hair) — the straddling pair makes a shadow's edge a
// straight line. Every angle is normalized into [0, 2π) before the sort — NOT a
// tidy-up: `Math.atan2` answers in (-π, π] while the fan is written over
// [0, 2π), so a raw sort interleaves two numberings and the coarse pass paints
// over the shadow the corner rays cut.
const TAU = Math.PI * 2;
const VISION_SWEEP = 180;   // the uniform fan, in rays
const VISION_NUDGE = 0.0006; // radians either side of a corner

function normAngle(a) {
  const m = a % TAU;
  return m < 0 ? m + TAU : m;
}

// `extraShapes` is aimed at too but never blocks a ray outright — elevation
// zones ride along here so their edges cut a crisp line in the fog exactly
// like a wall's, even though what happens at that edge (see the ELEVATION
// section) is a distance-dependent taper rather than a hard stop.
function visionAngles(ox, oy, walls, bounds, extraShapes) {
  const angles = [];
  const push = a => angles.push(normAngle(a));

  for (let i = 0; i < VISION_SWEEP; i++) push(i * TAU / VISION_SWEEP);

  const aim = (px, py) => {
    const a = Math.atan2(py - oy, px - ox);
    push(a - VISION_NUDGE); push(a); push(a + VISION_NUDGE);
  };

  const aimShape = w => {
    if (w.kind === 'circle') {
      // The two tangents — past either the ray misses the disc, which is where
      // the shadow's edge is.
      const dx = w.x - ox, dy = w.y - oy;
      const d = Math.hypot(dx, dy);
      if (d <= (w.r ?? 0) || !d) return;
      const base = Math.atan2(dy, dx);
      const spread = Math.asin(Math.min(1, (w.r ?? 0) / d));
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

  // Two rays a ten-thousandth of a radian apart are the same ray — drop the
  // duplicates so the polygon carries no zero-length edges.
  const out = [];
  for (const a of angles) if (!out.length || a - out[out.length - 1] > 1e-7) out.push(a);
  return out;
}

// The polygon one creature can see, in image pixels. A wall containing the
// source is skipped. `elev` is optional — { zones, sourceHeight, ownZone,
// cellPx } from elevationViewFor() — and shortens rays exactly as a wall
// would, except by how far rather than whether at all. See the ELEVATION
// section below and CLAUDE.md § The fog / Elevation.
function computeVisionPolygon(ox, oy, walls, bounds, elev) {
  const live = walls.filter(w => !pointInWall(ox, oy, w));
  // Never further than the far corner of the map, so the fan always terminates.
  const reach = Math.hypot(bounds.w, bounds.h) + Math.hypot(ox - bounds.x, oy - bounds.y);
  const higherZones = elev ? elev.zones.filter(z => elevZoneHeight(z) > elev.sourceHeight) : [];

  return visionAngles(ox, oy, live, bounds, elev ? elev.zones : null).map(a => {
    const dx = Math.cos(a), dy = Math.sin(a);
    let t = reach;
    for (const w of live) {
      const hit = rayShapeHit(ox, oy, dx, dy, w);
      if (hit !== null && hit < t) t = hit;
    }
    if (elev) t = Math.min(t, elevationRayLimit(ox, oy, dx, dy, elev, higherZones));
    return [ox + dx * t, oy + dy * t];
  });
}

// Every creature the party can see out of — a union, so one player sees what
// another sees.
function visionSources(map) {
  return mapTokens(map).filter(t => t.hostility === 'party');
}

// =============================================================================
// GEOMETRY — elevation
// =============================================================================
// The GM paints zones, each with a `height` in feet in [-500, 500]. The base
// map is height 0 and has no shape; every zone's height is measured from it.
// Looking down is always free (a viewer sees every level below their own, no
// matter the distance); looking up is not blocked outright, only *tapered*: the
// farther back a viewer stands from a rise, the more of it they can see past its
// edge, on the reasoning that a shallow enough sightline clears it. Right at the
// foot of a cliff you see none of what is above it.
//
// f(d) = floor(2d / h)   — d is how far the viewer is from the zone and h is the
// zone's height RELATIVE to the viewer's own ground (zoneHeight − viewerHeight),
// both in feet. f(d) is a count of tiles the viewer can see into the zone past
// its near edge. h ≤ 0 means the viewer is level with or above the zone and
// f(d) ≤ 0 — they see into it unimpeded.
function elevZoneHeight(z) {
  const h = Number(z?.height);
  if (Number.isFinite(h)) return h;
  return z?.level === 'low' ? -20 : z?.level === 'high' ? 20 : 0; // legacy zones
}
function clampElevHeight(v) {
  return Math.max(-500, Math.min(500, Math.round(Number(v) || 0)));
}

function mapElevationZones(map) {
  return Object.values(map?.elevation ?? {}).filter(z => z && z.id);
}

// Last drawn wins where two zones overlap — the same rule a fog mask follows.
function elevationZoneAt(map, x, y) {
  const zones = mapElevationZones(map);
  for (let i = zones.length - 1; i >= 0; i--) if (pointInWall(x, y, zones[i])) return zones[i];
  return null;
}
// The ground height at a point, in feet from the base map (0 where unpainted).
function elevationAt(map, x, y) {
  const zone = elevationZoneAt(map, x, y);
  return zone ? elevZoneHeight(zone) : 0;
}

// What a vision source needs to know about elevation, worked out once per
// source rather than once per ray (computeVisionPolygon casts ~180 of them).
// Null when the map has no elevation painted at all — the cheap, common case.
function elevationViewFor(map, ox, oy) {
  const zones = mapElevationZones(map);
  if (!zones.length) return null;
  const ownZone = elevationZoneAt(map, ox, oy);
  return { zones, sourceHeight: ownZone ? elevZoneHeight(ownZone) : 0, ownZone, cellPx: mapCellSize(map) };
}

// f(d) = floor(2d / h) — how many tiles past a rise's near edge a viewer
// standing `dFeet` back from it can see, where `hFeet` is the rise's height
// relative to the viewer. h ≤ 0 (level or looking down) is unimpeded.
function elevationVisibleTiles(dFeet, hFeet) {
  if (hFeet <= 0) return Infinity;
  return Math.max(0, Math.floor(2 * dFeet / hFeet));
}

// Both roots of the ray/shape intersection, not just the near one — where
// rayRect()/rayCircle() answer "does this block the ray, and from how far",
// this answers "how far does the ray travel while inside this shape", which is
// what is needed to find where a low source's own ground ends.
function rayRectSpan(ox, oy, dx, dy, r) {
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
function rayCircleSpan(ox, oy, dx, dy, c) {
  const fx = ox - c.x, fy = oy - c.y;
  const b = 2 * (fx * dx + fy * dy);
  const cc = fx * fx + fy * fy - c.r * c.r;
  const disc = b * b - 4 * cc;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  return { enter: (-b - s) / 2, exit: (-b + s) / 2 };
}

// One ray (from ox,oy, unit direction dx,dy — t unrestricted in sign) against
// one segment (x1,y1)-(x2,y2). Returns t, or null if they never cross or run
// parallel.
function raySegment(ox, oy, dx, dy, x1, y1, x2, y2) {
  const ex = x2 - x1, ey = y2 - y1;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((x1 - ox) * ey - (y1 - oy) * ex) / denom;
  const u = ((x1 - ox) * dy - (y1 - oy) * dx) / denom;
  if (u < 0 || u > 1) return null;
  return t;
}

// The nearest positive crossing with a lasso's edges (the loop implied
// between consecutive points, last back to first) — a polygon's answer to
// rayRect()/rayCircle().
function rayPolygon(ox, oy, dx, dy, points) {
  let best = null;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
    const t = raySegment(ox, oy, dx, dy, x1, y1, x2, y2);
    if (t !== null && t > 1e-6 && (best === null || t < best)) best = t;
  }
  return best;
}

// The polygon's answer to rayRectSpan()/rayCircleSpan() — enter is the
// smallest crossing, exit the largest, across every edge. Exact for a convex
// trace (at most two crossings, matching the rect/circle case exactly); for a
// concave one it is an approximation that can miss an inner lobe, accepted
// for the same reason the whole shape is freehand rather than exact.
function rayPolygonSpan(ox, oy, dx, dy, points) {
  let enter = null, exit = null;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
    const t = raySegment(ox, oy, dx, dy, x1, y1, x2, y2);
    if (t === null) continue;
    if (enter === null || t < enter) enter = t;
    if (exit === null || t > exit) exit = t;
  }
  return enter === null ? null : { enter, exit };
}

// The one place a wall/mask/elevation shape's `kind` decides which ray test
// to run — computeVisionPolygon() and elevationRayLimit() both go through
// these rather than repeating the three-way branch.
function rayShapeHit(ox, oy, dx, dy, s) {
  if (s.kind === 'circle') return rayCircle(ox, oy, dx, dy, s);
  if (s.kind === 'poly') return rayPolygon(ox, oy, dx, dy, s.points || []);
  return rayRect(ox, oy, dx, dy, s);
}
function rayShapeSpan(ox, oy, dx, dy, s) {
  if (s.kind === 'circle') return rayCircleSpan(ox, oy, dx, dy, s);
  if (s.kind === 'poly') return rayPolygonSpan(ox, oy, dx, dy, s.points || []);
  return rayRectSpan(ox, oy, dx, dy, s);
}

// How far along one ray elevation lets it travel, independent of walls —
// computeVisionPolygon() takes the smaller of this and whatever a wall gives.
// Distances along the ray are in image pixels; the formula works in feet, so
// each is scaled by MAP_FEET_PER_CELL / cellPx. Two things can shorten a ray,
// and both can apply at once (a viewer in a pit looking across the base map at
// a rise beyond it):
//   - if the viewer's own zone is below the base map, leaving it is itself a
//     rise to base — `d` is measured to wherever that ground ends (span.exit),
//     because that is how far back the viewer is from that particular edge;
//   - entering a zone higher than the viewer, at whatever distance the ray
//     first reaches it, using that zone's own height relative to the viewer —
//     regardless of the ground in between, because h describes how far up the
//     *viewer* is trying to see, not the local terrain step.
// Both are independent, and the ray takes whichever cuts it shortest — seeing
// a rise beyond a rise needs both to allow it.
function elevationRayLimit(ox, oy, dx, dy, elev, higherZones) {
  let limit = Infinity;
  const pxToFeet = MAP_FEET_PER_CELL / elev.cellPx;

  const ownHeight = elev.ownZone ? elevZoneHeight(elev.ownZone) : 0;
  if (elev.ownZone && ownHeight < 0) {
    const span = rayShapeSpan(ox, oy, dx, dy, elev.ownZone);
    if (span && span.exit > 0) {
      const tiles = elevationVisibleTiles(span.exit * pxToFeet, -ownHeight);
      limit = Math.min(limit, span.exit + tiles * elev.cellPx);
    }
  }

  higherZones.forEach(z => {
    const hit = rayShapeHit(ox, oy, dx, dy, z);
    if (hit === null) return;
    const tiles = elevationVisibleTiles(hit * pxToFeet, elevZoneHeight(z) - elev.sourceHeight);
    limit = Math.min(limit, hit + tiles * elev.cellPx);
  });

  return limit;
}

// =============================================================================
// GEOMETRY — snapping
// =============================================================================
// Where a creature snaps depends on how many cells it covers: an odd footprint
// centres on a square, an even one on the line between two (where a Large
// creature sits). Tiny centres like Medium.
function snapToGrid(map, x, y, sizeCells) {
  const g = mapGrid(map);
  const cell = mapCellSize(map);
  const cells = Math.max(1, Math.round(sizeCells ?? 1));
  const half = cells % 2 === 1 ? cell / 2 : 0;
  const snap = (v, off) => Math.round((v - off - half) / cell) * cell + off + half;
  return { x: snap(x, g.offsetX), y: snap(y, g.offsetY) };
}
