// =============================================================================
// GRID — Grid occupancy: fit tests, place/remove, id generation
// =============================================================================
'use strict';

// Deferred resize: a Strength box passes through 0 on its way from 8 to 16, and
// rebuilding on each keystroke would eject the pack into Needs Placement. So the
// sheet marks the grid dirty and the resize runs once, back on the inventory.
// Only the weight readout reads strength while it waits.
let isGridSizeDirty = false;

let nextInstanceNumber = 1;

// Flags the grid for a resize on the next return to the inventory.
function markGridSizeDirty() { isGridSizeDirty = true; }

// Rebuilds the grid if a Strength edit left its size stale.
function rebuildGridIfSizeDirty() {
  if (!isGridSizeDirty) return;
  rebuildGrid();   // clears the flag by way of initGrid()
}

// ─── GRID LOGIC ───

// Replaces state.grid with an empty grid sized for the current Strength.
function initGrid() {
  const rows = getGridRows();
  state.grid = Array.from({ length: rows }, () => Array(GRID_COLS).fill(null));
  // Any rebuild is the pending resize, so clearing here stops a stale flag
  // firing a second identical rebuild.
  isGridSizeDirty = false;
}

// Whether `shape` fits at (gridRow, gridCol) in the given grid (the active one or
// a container's).
function fitsInGrid(grid, cols, shape, gridRow, gridCol, excludeInstanceId = null) {
  const cells = getShapeCells(shape, gridRow, gridCol);
  for (const { row, col } of cells) {
    if (row < 0 || row >= grid.length || col < 0 || col >= cols) return false;
    const occupant = grid[row][col];
    if (occupant && occupant !== excludeInstanceId) return false;
  }
  return true;
}

// Whether `shape` fits at (gridRow, gridCol) in the active grid.
function canPlace(shape, gridRow, gridCol, excludeInstanceId = null) {
  return fitsInGrid(getActiveGrid(), getActiveGridCols(), shape, gridRow, gridCol, excludeInstanceId);
}

// Marks the shape's cells in the active grid as held by the instance.
function placeOnGrid(instanceId, shape, gridRow, gridCol) {
  const grid = getActiveGrid();
  getShapeCells(shape, gridRow, gridCol).forEach(({ row, col }) => {
    if (grid[row]) grid[row][col] = instanceId;
  });
}

// Clears every cell the instance holds in its own grid (main or container).
function removeFromGrid(instanceId) {
  const inst = state.instances[instanceId];
  const grid = (inst?.containerId)
    ? (state.containerGrids[inst.containerId] ?? null)
    : state.grid;
  if (!grid) return;
  grid.forEach(row => row.forEach((v, i, arr) => {
    if (v === instanceId) arr[i] = null;
  }));
}

// Moves an instance to the stash (`row: null` = owned, not on the grid). Never
// leave one off the edge: the grid clips it unseen while it is still weighed.
function unplaceInstance(inst) {
  inst.row = null;
  inst.col = null;
}

// Total weight of every owned instance, placed or not.
function getTotalCarriedWeight() {
  return Object.values(state.instances).reduce((sum, inst) => {
    const template = state.db[inst.templateId];
    if (!template) return sum;
    if (isStackable(template)) return sum + getItemUnitWeight(template) * inst.stackCount;
    return sum + getShapeWeight(getRotatedShape(template.shape, inst.rotation));
  }, 0);
}

// ─── ID GENERATION ───

// A fresh instance id ('inst_<n>').
function createInstanceId() { return 'inst_' + (nextInstanceNumber++); }

// Moves the id counter past every instance id already in state.
function syncNextId() {
  const max = Object.keys(state.instances)
    .map(id => parseInt(id.slice(5), 10))  // strip 'inst_'
    .filter(n => !isNaN(n))
    .reduce((a, b) => Math.max(a, b), 0);
  if (max >= nextInstanceNumber) nextInstanceNumber = max + 1;
}

// A fresh custom item template id.
function createTemplateId() { return 'custom_' + Date.now() + '_' + Math.floor(Math.random() * 1000); }
