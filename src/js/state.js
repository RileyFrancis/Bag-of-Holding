// =============================================================================
// STATE — The single mutable app state object + convenience accessors
// =============================================================================
'use strict';

// See CLAUDE.md § State model for the full shape and what is / isn't saved.

const state = {
  // The character on screen — the working copy of one slot out of
  // `state.characters`; characters.js is the only place that swaps them over.
  character: { id: null, name: 'Unnamed Hero', strength: 10, level: 1, race: '', classLevels: [] },
  characters: {},         // { [charId]: { character, instances, equipped, equipLayout, db } }
  activeCharacterId: null,
  // Bookmarks, not the campaigns themselves (those live under parties/<code>).
  campaigns: {},          // { [code]: { code, name, role, characterId, gmName, memberCount, lastPlayed } }
  // The account's homebrew: its own entries, and the folder tree over them and
  // the roster's custom items (homebrew.js).
  homebrew: { entries: {}, folders: {}, placement: {} },
  screen: 'app',          // 'app' | 'home' — the home screen is a page in front, never saved

  grid: [],               // 2D array [row][col] = instanceId | null
  instances: {},          // instanceId -> PlacedInstance
  db: {},                 // item templates, keyed by id

  mode: 'idle',           // 'idle' | 'placing' | 'dragging'
  placing: null,          // { templateId, rotation }
  dragging: null,         // { instanceId, anchorRow, anchorCol, origRow, origCol, origRotation }
  selected: null,         // { type:'instance'|'template', id } — shown in the Details tab

  editorShape: [[1]],     // shape editor state (inside the item modal)
  editingItemId: null,    // null = new item

  // Browse-list folders and sort — catalogue view, persisted per browser (not in the save file).
  folders: [],            // ordered [{ id, name }]
  folderAssign: {},       // { [templateId]: folderId }
  folderCollapsed: {},    // { [folderId]: true }
  itemSort: 'rarity',     // an id from ITEM_SORTS
  itemSortReverse: false, // that sort's chain, negated

  equipped: {},           // { [slotId]: instanceId | null }
  equipLayout: [],        // ordered array of header/slot items (persisted separately)

  leftTab: 'equip',       // 'equip' | 'shop' | 'map' — UI position, never saved
  shopOpenId: null,       // null = the list of shops
  shops: {},              // { [shopId]: Shop } — read-through cache of Firebase, not in the save file
  battlemap: { activeId: null, maps: {} }, // read-through cache of parties/<code>/battlemap
  mapLibraryOpenId: null, // which map the GM has open in their library pane

  view: 'inventory',      // 'inventory' | 'sheet' | 'spells' | 'map' — WHICH character is state.party.viewingPlayerId
  activeContainer: null,  // null = main inventory, instanceId = that container's interior
  containerGrids: {},     // { [instanceId]: 2D array }

  auth: { user: null, ready: false }, // identity only; `ready` flips once Firebase reports the restored session
  party: {
    active: false,
    code: null,
    role: null,            // 'gm' | 'player'
    playerId: null,        // our account uid, or 'gm' — see party.js on identity
    playerName: null,
    campaignName: null,    // from parties/<code>/meta
    viewingPlayerId: null, // which player's inventory we're viewing (null = own for player, none for GM)
    ownState: null,        // saved own state while a player views another's inventory
    players: {},           // Firebase cache: { [uid]: { name, connected, lastSeen, character, instances, customDb } }
  },
};

// Convenience
function gridRows() { return state.character.strength * 3; }
function normalRows() { return state.character.strength; }

function activeGrid() {
  return state.activeContainer
    ? (state.containerGrids[state.activeContainer] ?? state.grid)
    : state.grid;
}
function activeGridCols() {
  if (!state.activeContainer) return GRID_COLS;
  const t = state.db[state.instances[state.activeContainer]?.templateId];
  return t?.containerCols ?? 5;
}
function activeGridRows() {
  if (!state.activeContainer) return gridRows();
  const t = state.db[state.instances[state.activeContainer]?.templateId];
  return t?.containerRows ?? 5;
}
