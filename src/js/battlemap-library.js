// =============================================================================
// BATTLEMAP LIBRARY — the GM's Maps pane, and the import / creature dialogs
// =============================================================================
'use strict';

// The GM's Maps pane (a third left-panel pane, GM-only) and the import /
// creature dialogs. The library is about which maps exist; battlemap-view.js is
// about the one the party is standing on. There is no player half of this file.

function renderMapPanel() {
  const pane = document.getElementById('left-pane-map');
  if (!pane) return;
  // Rebuilt on every map snapshot (a creature dragged, a wall drawn), so keep
  // the reader's place in a long piece list rather than jumping to the top.
  const oldBody = pane.querySelector('.shop-body');
  const scroll = oldBody ? oldBody.scrollTop : 0;
  const openId = pane.dataset.openId || '';
  pane.innerHTML = '';
  if (!state.party.active) return;
  const map = state.mapLibraryOpenId ? mapById(state.mapLibraryOpenId) : null;
  if (map) renderMapDetail(pane, map);
  else { renderMapList(pane); setMapHighlight(null); }
  pane.dataset.openId = map ? map.id : '';
  const body = pane.querySelector('.shop-body');
  if (body && pane.dataset.openId === openId) body.scrollTop = scroll;
}

function renderMapList(pane) {
  const head = document.createElement('div');
  head.className = 'shop-head';
  const title = document.createElement('span');
  title.className = 'shop-head-title';
  title.textContent = 'Battle Maps';
  head.appendChild(title);
  pane.appendChild(head);

  const body = document.createElement('div');
  body.className = 'shop-body';

  const maps = allMaps();
  if (!maps.length) {
    const empty = document.createElement('p');
    empty.className = 'shop-empty';
    empty.textContent = 'No maps yet. Import a picture of one, line the grid up on it, and reveal it when the party walks in.';
    body.appendChild(empty);
  }

  maps.forEach(map => body.appendChild(buildMapRow(map)));
  pane.appendChild(body);

  const footer = document.createElement('div');
  footer.className = 'shop-footer';
  const btn = document.createElement('button');
  btn.className = 'btn-primary';
  setIconLabel(btn, 'plus', 'Import Map');
  btn.addEventListener('click', () => openMapModal(null));
  footer.appendChild(btn);
  pane.appendChild(footer);
}

function buildMapRow(map) {
  const row = document.createElement('div');
  row.className = 'map-row'
    + (map.id === activeMapId() ? ' in-play' : '')
    + (map.revealed ? ' revealed' : '');

  const open = document.createElement('button');
  open.className = 'map-row-open';
  open.title = map.id === activeMapId() ? 'The party is on this map — open its settings' : 'Put the party on this map, and open its settings';

  const thumb = document.createElement('span');
  thumb.className = 'map-thumb';
  if (map.image) thumb.style.backgroundImage = 'url("' + map.image + '")';
  open.appendChild(thumb);

  const info = document.createElement('span');
  info.className = 'map-row-info';
  const nm = document.createElement('span');
  nm.className = 'map-row-name';
  nm.textContent = map.name;
  const n = mapTokens(map).length;
  const sub = document.createElement('span');
  sub.className = 'map-row-sub';
  sub.textContent = [
    map.id === activeMapId() ? 'In play' : null,
    map.revealed ? 'Revealed' : 'Hidden',
    n + ' creature' + (n === 1 ? '' : 's'),
  ].filter(Boolean).join(' · ');
  info.appendChild(nm);
  info.appendChild(sub);
  open.appendChild(info);
  // Clicking a map puts the party on it (what the ▶ button used to do) and
  // opens its settings in one motion — there is no separate "activate" control
  // any more, so the row's own accent outline (.in-play) is the one place "is
  // this the map in play" is answered.
  open.addEventListener('click', () => {
    setActiveMap(map.id);
    state.mapLibraryOpenId = map.id;
    renderMapPanel();
  });
  row.appendChild(open);

  // Reveal stays its own button, deliberately separate from activation — a GM
  // can put the party on a map (lay it out, add creatures) before the players
  // are allowed to see it, then flip this on when it's time.
  const eye = document.createElement('button');
  eye.className = 'map-row-btn' + (map.revealed ? ' on' : '');
  eye.title = map.revealed ? 'Hide this map from the players' : 'Show this map to the players';
  eye.appendChild(iconEl(map.revealed ? 'show' : 'hide'));
  eye.addEventListener('click', () => setMapRevealed(map.id, !map.revealed));

  row.appendChild(eye);
  return row;
}

function renderMapDetail(pane, map) {
  const head = document.createElement('div');
  head.className = 'shop-head';
  const back = document.createElement('button');
  back.className = 'shop-back';
  back.textContent = '‹ Battle Maps';
  back.addEventListener('click', () => { state.mapLibraryOpenId = null; renderMapPanel(); });
  head.appendChild(back);

  const edit = document.createElement('button');
  edit.className = 'shop-head-btn';
  edit.title = 'Rename this map or replace its picture';
  edit.textContent = '✎';
  edit.addEventListener('click', () => openMapModal(map.id));
  const del = document.createElement('button');
  del.className = 'shop-head-btn danger';
  del.title = 'Delete this map';
  del.textContent = '✕';
  del.addEventListener('click', () => deleteMap(map));
  head.appendChild(edit);
  head.appendChild(del);
  pane.appendChild(head);

  const body = document.createElement('div');
  body.className = 'shop-body';

  const title = document.createElement('div');
  title.className = 'shop-title';
  title.textContent = map.name;
  body.appendChild(title);

  const preview = document.createElement('button');
  preview.className = 'map-preview';
  if (map.image) preview.style.backgroundImage = 'url("' + map.image + '")';
  preview.title = 'Put the party here and open it';
  preview.addEventListener('click', () => { setActiveMap(map.id); openBattlemap(map.id); });
  body.appendChild(preview);

  const openBtn = document.createElement('button');
  openBtn.className = 'btn-primary map-open-btn';
  setIconLabel(openBtn, 'map', map.id === activeMapId() ? 'Open Map' : 'Play This Map');
  openBtn.addEventListener('click', () => { setActiveMap(map.id); openBattlemap(map.id); });
  body.appendChild(openBtn);

  // ── Visible to ────────────────────────────────────────────────────────
  body.appendChild(mapSectionHdr('Visible To'));
  const seg = document.createElement('div');
  seg.className = 'segmented shop-seg';
  [[false, 'Hidden'], [true, 'Everyone']].forEach(pair => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn' + (!!map.revealed === pair[0] ? ' active' : '');
    b.textContent = pair[1];
    b.addEventListener('click', () => setMapRevealed(map.id, pair[0]));
    seg.appendChild(b);
  });
  body.appendChild(seg);

  // ── The grid ──────────────────────────────────────────────────────────
  body.appendChild(mapSectionHdr('Grid'));
  body.appendChild(buildGridControls(map));

  // ── What is on the board ──────────────────────────────────────────────
  MAP_PIECE_SECTIONS.forEach(spec => body.appendChild(buildMapPieceSection(map, spec)));

  pane.appendChild(body);
}

function mapSectionHdr(text) {
  const h = document.createElement('div');
  h.className = 'shop-section-hdr';
  h.textContent = text;
  return h;
}

// Everything on the board, one section per kind: [model key, heading, the
// word clearMapPieces() confirms with, the pieces, a row's name and subtitle].
// Listed in the order they were placed (pieceTime()); hovering a row haloes
// its piece on the map (setMapHighlight() in battlemap-view.js), clicking it
// removes it, and the bin beside a heading removes the whole kind.
const MAP_SHAPE_LABEL = { rect: 'Rectangle', circle: 'Circle', poly: 'Lasso' };
const MAP_PIECE_SECTIONS = [
  { kind: 'tokens', title: 'Creatures', word: 'creature', list: mapTokens,
    name: t => t.name || 'Unnamed creature', sub: t => (HOSTILITY[t.hostility] || HOSTILITY.neutral).label },
  { kind: 'walls', title: 'Walls', word: 'wall', list: mapWalls,
    name: (w, i) => 'Wall ' + (i + 1), sub: w => MAP_SHAPE_LABEL[w.kind] || 'Rectangle' },
  { kind: 'masks', title: 'Fog', word: 'fog edit', list: mapMasks,
    name: m => m.mode === 'hide' ? 'Obscure' : 'Reveal', sub: m => MAP_SHAPE_LABEL[m.kind] || 'Rectangle' },
  { kind: 'elevation', title: 'Elevation', word: 'elevation region', list: mapElevationZones,
    name: z => { const h = elevZoneHeight(z); return (h > 0 ? '+' : '') + h + ' ft'; },
    sub: z => MAP_SHAPE_LABEL[z.kind] || 'Rectangle' },
];

function buildMapPieceSection(map, spec) {
  const wrap = document.createElement('div');
  const pieces = spec.list(map).sort((a, b) => pieceTime(a) - pieceTime(b));

  const hdr = mapSectionHdr(spec.title + ' (' + pieces.length + ')');
  hdr.classList.add('map-piece-hdr');
  const bin = document.createElement('button');
  bin.type = 'button';
  bin.className = 'map-piece-clear';
  bin.title = 'Remove every ' + spec.word + ' from this map';
  bin.disabled = !pieces.length;
  bin.appendChild(iconEl('trash'));
  bin.addEventListener('click', () => {
    clearMapPieces(map.id, spec.kind, spec.word);
    if (spec.kind === 'tokens') mapSelectedTokenId = null;
    fogDirty = true;
  });
  hdr.appendChild(bin);
  wrap.appendChild(hdr);

  const list = document.createElement('div');
  list.className = 'map-piece-list';
  pieces.forEach((p, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'map-piece';
    row.title = 'Remove from the map';
    row.style.setProperty('--pc', mapPieceColor(spec.kind, p));
    const dot = document.createElement('span');
    dot.className = 'map-piece-dot';
    const nm = document.createElement('span');
    nm.className = 'map-piece-name';
    nm.textContent = spec.name(p, i);
    const sub = document.createElement('span');
    sub.className = 'map-piece-sub';
    sub.textContent = spec.sub(p);
    const x = document.createElement('span');
    x.className = 'map-piece-x';
    x.textContent = '✕';
    row.append(dot, nm, sub, x);
    row.addEventListener('mouseenter', () => setMapHighlight(spec.kind, p.id));
    row.addEventListener('mouseleave', () => setMapHighlight(null));
    row.addEventListener('click', () => {
      setMapHighlight(null);
      if (spec.kind === 'tokens') {
        removeToken(map.id, p.id);
        if (mapSelectedTokenId === p.id) { mapSelectedTokenId = null; renderMapToolbar(); }
      } else {
        removePiece(map.id, spec.kind, p.id);
      }
      fogDirty = true;
    });
    list.appendChild(row);
  });
  if (!pieces.length) {
    const empty = document.createElement('p');
    empty.className = 'map-piece-empty';
    empty.textContent = 'None';
    list.appendChild(empty);
  }
  wrap.appendChild(list);
  return wrap;
}

// The size and two offsets as number boxes, redrawing the map as they move. The
// figures are fractional — a cell rounded to a whole pixel drifts up to half a
// pixel per square, unmissable by the far edge. The steppers still nudge by a
// whole pixel; only what may be STORED changed. The real answer to sizing is
// the Grid tool on the map itself (battlemap-view.js); these boxes are where an
// exact number somebody else worked out gets typed.
function buildGridControls(map) {
  const wrap = document.createElement('div');
  wrap.className = 'map-grid-controls';

  const row = (label, key, min, max, hint) => {
    const g = mapGrid(map);
    const r = document.createElement('div');
    r.className = 'map-grid-row';
    const lbl = document.createElement('span');
    lbl.className = 'map-grid-label';
    lbl.textContent = label;
    lbl.title = hint;

    const dec = document.createElement('button');
    dec.className = 'shop-price-step';
    dec.type = 'button';
    dec.textContent = '−';
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'shop-price-input';
    input.min = min; input.max = max;
    // `any`, or the browser's validation rounds off an exact size a corner drag
    // worked out — the steppers below are the whole-pixel nudge.
    input.step = 'any';
    input.value = roundGridValue(g[key]);
    input.title = hint;
    const inc = document.createElement('button');
    inc.className = 'shop-price-step';
    inc.type = 'button';
    inc.textContent = '+';

    const set = v => {
      const clamped = Math.max(min, Math.min(max, roundGridValue(v)));
      input.value = clamped;
      updateMapGrid(map.id, { [key]: clamped });
    };
    const cur = () => { const v = parseFloat(input.value); return Number.isFinite(v) ? v : 0; };
    // Nudge by a whole pixel FROM wherever the value is — a dragged 70.42 steps
    // to 69.42, not 69.
    dec.addEventListener('click', () => set(cur() - 1));
    inc.addEventListener('click', () => set(cur() + 1));
    // On change rather than input: every keystroke would be its own write.
    input.addEventListener('change', () => set(Number.isFinite(parseFloat(input.value)) ? parseFloat(input.value) : min));

    r.appendChild(lbl);
    r.appendChild(dec);
    r.appendChild(input);
    r.appendChild(inc);
    return r;
  };

  wrap.appendChild(row('Cell', 'size', 8, 600, 'How many of the picture’s own pixels one square is — decimals welcome, and usually necessary'));
  wrap.appendChild(row('Left', 'offsetX', -600, 600, 'Slide the whole grid sideways'));
  wrap.appendChild(row('Top', 'offsetY', -600, 600, 'Slide the whole grid up and down'));

  const g = mapGrid(map);
  const show = document.createElement('label');
  show.className = 'checkbox-label';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = g.visible !== false;
  cb.addEventListener('change', () => updateMapGrid(map.id, { visible: cb.checked }));
  const sp = document.createElement('span');
  sp.textContent = 'Draw the grid on the map';
  show.appendChild(cb);
  show.appendChild(sp);
  wrap.appendChild(show);

  return wrap;
}

// =============================================================================
// IMPORTING A MAP
// =============================================================================
// The picture is stored WITH the map as a data URL — a link rots and the app
// has no file storage. An imported file is scaled down first. A link the
// browser refuses to redraw cross-origin is kept as the link (works as a
// picture, cannot be shrunk).
const MAP_IMAGE_MAX_DIM = 2400;  // px on the long side after scaling
const MAP_IMAGE_QUALITY = 0.82;  // JPEG, which is what a photographed map wants
const MAP_IMAGE_MAX_BYTES = 6 * 1024 * 1024;

let mapModalId = null;
let mapModalImage = null; // { src, w, h } — the pending picture, not yet written

function openMapModal(mapId) {
  mapModalId = mapId;
  const map = mapId ? mapById(mapId) : null;
  mapModalImage = map && map.image ? { src: map.image, w: map.w, h: map.h } : null;

  document.getElementById('map-modal-title').textContent = map ? 'Edit Map' : 'Import Map';
  document.getElementById('map-name-input').value = map ? map.name : '';
  document.getElementById('map-url-input').value = '';
  document.getElementById('map-file-input').value = '';
  document.getElementById('map-confirm-btn').textContent = map ? 'Save' : 'Import';
  updateMapModalPreview('');
  showModal('map-modal');
}

function updateMapModalPreview(status) {
  const prev = document.getElementById('map-modal-preview');
  prev.style.backgroundImage = mapModalImage ? 'url("' + mapModalImage.src + '")' : '';
  prev.classList.toggle('empty', !mapModalImage);
  document.getElementById('map-modal-status').textContent = status || (mapModalImage
    ? mapModalImage.w + ' × ' + mapModalImage.h + ' pixels'
    : 'No picture chosen yet.');
}

// Loads a picture, scales it down, hands back a data URL with the dimensions
// that URL actually has — every model coordinate is in THESE pixels.
function prepareMapImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // a canvas tainted by the picture cannot be read back
    img.onload = () => {
      const scale = Math.min(1, MAP_IMAGE_MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      if (scale === 1 && src.startsWith('data:') && src.length < MAP_IMAGE_MAX_BYTES) {
        resolve({ src, w, h });
        return;
      }
      try {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve({ src: c.toDataURL('image/jpeg', MAP_IMAGE_QUALITY), w, h });
      } catch {
        resolve({ src, w: img.naturalWidth, h: img.naturalHeight });
      }
    };
    img.onerror = () => reject(new Error('That picture could not be loaded.'));
    img.src = src;
  });
}

document.getElementById('map-file-input').addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  updateMapModalPreview('Reading the picture…');
  const reader = new FileReader();
  reader.onload = () => {
    prepareMapImage(String(reader.result))
      .then(img => { mapModalImage = img; updateMapModalPreview(''); })
      .catch(err => updateMapModalPreview(err.message));
  };
  reader.onerror = () => updateMapModalPreview('That file could not be read.');
  reader.readAsDataURL(file);
});

document.getElementById('map-url-btn').addEventListener('click', () => {
  const url = document.getElementById('map-url-input').value.trim();
  if (!url) return;
  updateMapModalPreview('Fetching the picture…');
  prepareMapImage(url)
    .then(img => { mapModalImage = img; updateMapModalPreview(''); })
    .catch(err => updateMapModalPreview(err.message));
});

document.getElementById('map-confirm-btn').addEventListener('click', () => {
  const name = document.getElementById('map-name-input').value.trim();
  if (!name) { alert('Give the map a name.'); return; }
  if (!mapModalImage) { alert('Choose a picture for the map.'); return; }
  if (mapModalImage.src.length > MAP_IMAGE_MAX_BYTES) {
    alert('That picture is too large to share with the party. Try a smaller one.');
    return;
  }

  const patch = { name, image: mapModalImage.src, w: mapModalImage.w, h: mapModalImage.h };
  if (mapModalId) {
    mapRef(mapModalId).update(patch);
  } else {
    const id = newMapId();
    // Opened before the write, so the echo of our own write lands on a panel
    // already showing the new map rather than bouncing back to the list.
    state.mapLibraryOpenId = id;
    mapRef(id).set({
      id, name: patch.name, image: patch.image, w: patch.w, h: patch.h,
      revealed: false,
      order: Date.now(),
      createdAt: Date.now(),
      grid: Object.assign({}, MAP_GRID_DEFAULT),
    });
  }
  hideModal('map-modal');
});

// =============================================================================
// A CREATURE
// =============================================================================
// One dialog for placing and editing a creature. Three things: what it looks
// like, how big it is, whose side it is on — the third colours it, so the icons
// repaint as it changes.
let creatureModalTarget = null; // { mapId, tokenId } — a null tokenId is a new one
let creatureModalIcon = CREATURE_ICONS[0];
let creatureModalHostility = 'hostile';
let creatureModalOwnerUid = ''; // '' = a custom marker of the GM's own; else a player's uid
let creatureModalPos = null;    // where on the map it was asked for

function openCreatureModal(mapId, tokenId, pos) {
  const map = mapById(mapId);
  if (!map) return;
  const token = tokenId ? (map.tokens || {})[tokenId] : null;

  creatureModalTarget = { mapId, tokenId: tokenId || null };
  creatureModalPos = pos || null;
  creatureModalIcon = (token && token.icon) || CREATURE_ICONS[0];
  // A GM reaching for this is nearly always adding a monster; a player is
  // nearly always adding something of their own.
  creatureModalHostility = (token && token.hostility) || (isMapGM() ? 'hostile' : 'party');
  // Preselect the player it already belongs to — an owner outside today's
  // roster (or none) reads as Custom, the GM's own.
  creatureModalOwnerUid = (token && token.ownerUid && state.party.players?.[token.ownerUid]) ? token.ownerUid : '';

  document.getElementById('creature-modal-title').textContent = token ? 'Edit Creature' : 'New Creature';
  document.getElementById('creature-name-input').value = (token && token.name) || '';
  document.getElementById('creature-confirm-btn').textContent = token ? 'Save' : 'Place';
  document.getElementById('creature-delete-btn').classList.toggle('hidden', !(token && canControlToken(token)));

  const sizeSel = document.getElementById('creature-size-select');
  sizeSel.innerHTML = '';
  CREATURE_SIZES.forEach(s => {
    const opt = document.createElement('option');
    opt.value = String(s.cells);
    opt.textContent = s.label + ' · ' + (s.cells === 0.5 ? '½' : s.cells)
      + ' square' + (s.cells === 1 ? '' : 's');
    sizeSel.appendChild(opt);
  });
  sizeSel.value = String((token && token.size) || 1);

  renderCreatureOwner();
  renderCreatureHostility();
  renderCreatureIcons();
  showModal('creature-modal');
}

// The GM's alone — handing a marker straight to a player instead of keeping it
// as one of their own. Hidden for anyone else: a player's own placements are
// always their own (addToken() only honours this field from the GM).
function renderCreatureOwner() {
  const field = document.getElementById('creature-owner-field');
  const seg = document.getElementById('creature-owner');
  const gm = isMapGM();
  field.classList.toggle('hidden', !gm);
  if (!gm) return;

  seg.innerHTML = '';
  const options = [{ uid: '', name: 'Custom' }].concat(
    Object.entries(state.party.players ?? {}).map(([uid, p]) => ({ uid, name: p.name || 'Player' }))
  );
  options.forEach(opt => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn' + (opt.uid === creatureModalOwnerUid ? ' active' : '');
    b.textContent = opt.name;
    b.addEventListener('click', () => {
      creatureModalOwnerUid = opt.uid;
      if (opt.uid) {
        // Picking a player is almost always for their own marker.
        creatureModalHostility = 'party';
        const nameInput = document.getElementById('creature-name-input');
        if (!nameInput.value.trim()) {
          const p = state.party.players[opt.uid];
          nameInput.value = (p?.character?.name || p?.name || '').slice(0, 40);
        }
      }
      renderCreatureOwner();
      renderCreatureHostility();
      renderCreatureIcons();
    });
    seg.appendChild(b);
  });
}

function renderCreatureHostility() {
  const seg = document.getElementById('creature-hostility');
  seg.innerHTML = '';
  HOSTILITY_ORDER.forEach(key => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn hostility-btn' + (key === creatureModalHostility ? ' active' : '');
    b.style.setProperty('--hc', hostilityColor(key));
    const dot = document.createElement('span');
    dot.className = 'hostility-dot';
    b.appendChild(dot);
    b.appendChild(document.createTextNode(HOSTILITY[key].label));
    b.addEventListener('click', () => {
      creatureModalHostility = key;
      renderCreatureHostility();
      renderCreatureIcons();
    });
    seg.appendChild(b);
  });
}

function renderCreatureIcons() {
  const grid = document.getElementById('creature-icons');
  grid.innerHTML = '';
  CREATURE_ICONS.forEach(icon => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'creature-icon-btn' + (icon === creatureModalIcon ? ' active' : '');
    b.style.setProperty('--hc', hostilityColor(creatureModalHostility));
    b.textContent = icon;
    b.addEventListener('click', () => { creatureModalIcon = icon; renderCreatureIcons(); });
    grid.appendChild(b);
  });
}

document.getElementById('creature-confirm-btn').addEventListener('click', () => {
  if (!creatureModalTarget) return;
  const mapId = creatureModalTarget.mapId;
  const tokenId = creatureModalTarget.tokenId;
  const map = mapById(mapId);
  if (!map) { hideModal('creature-modal'); return; }

  const name = document.getElementById('creature-name-input').value.trim().slice(0, 40);
  const size = parseFloat(document.getElementById('creature-size-select').value) || 1;
  const fields = { name, size, icon: creatureModalIcon, hostility: creatureModalHostility };
  // Only the GM's picker ever touches this — and always explicitly, so
  // choosing Custom on a token that used to be a player's actually hands it
  // back rather than silently leaving the old owner in place.
  if (isMapGM()) fields.ownerUid = creatureModalOwnerUid || (ownPlayerId() ?? '');

  if (tokenId) {
    // The footprint may have changed, so it re-snaps: a Large creature centres
    // on a line where a Medium one centres in a square.
    const token = (map.tokens || {})[tokenId] || { x: 0, y: 0 };
    const snapped = snapToGrid(map, token.x, token.y, size);
    updateToken(mapId, tokenId, Object.assign({}, fields, snapped));
  } else {
    // Dropped where it was asked for, or in the middle of the map when the
    // dialog was opened from the toolbar rather than from a spot on the board.
    const at = creatureModalPos || { x: (map.w || 1000) / 2, y: (map.h || 1000) / 2 };
    const snapped = snapToGrid(map, at.x, at.y, size);
    addToken(mapId, Object.assign({}, fields, snapped));
  }
  hideModal('creature-modal');
});

document.getElementById('creature-delete-btn').addEventListener('click', () => {
  if (!creatureModalTarget || !creatureModalTarget.tokenId) return;
  removeToken(creatureModalTarget.mapId, creatureModalTarget.tokenId);
  hideModal('creature-modal');
});
