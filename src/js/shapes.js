// =============================================================================
// SHAPES — Item shape math: rotation, cell coords, bounding boxes
// =============================================================================
'use strict';

// Number of filled cells in a shape.
function getShapeCellCount(shape) {
  return shape.reduce((s, row) => s + row.reduce((a, v) => a + v, 0), 0);
}

// An item's weight from its shape: one pound per filled cell.
function getShapeWeight(shape) { return getShapeCellCount(shape); }

// Bounding-box size of a shape as { rows, cols }.
function getShapeDims(shape) {
  return { rows: shape.length, cols: shape[0].length };
}

// Trims empty border rows and columns; an all-empty shape becomes [[0]].
function normalizeShape(shape) {
  let minR = shape.length, maxR = -1, minC = shape[0].length, maxC = -1;
  shape.forEach((row, r) => row.forEach((v, c) => {
    if (v) { minR = Math.min(minR, r); maxR = Math.max(maxR, r); minC = Math.min(minC, c); maxC = Math.max(maxC, c); }
  }));
  if (maxR < 0) return [[0]];
  return shape.slice(minR, maxR + 1).map(row => row.slice(minC, maxC + 1));
}

function _rotateShapeCW(shape) {
  const rows = shape.length, cols = shape[0].length;
  const result = Array.from({ length: cols }, () => Array(rows).fill(0));
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      result[c][rows - 1 - r] = shape[r][c];
  return result;
}

// The base shape turned clockwise `rotation` quarter turns.
function getRotatedShape(baseShape, rotation) {
  let s = baseShape;
  for (let i = 0; i < rotation; i++) s = _rotateShapeCW(s);
  return s;
}

// Absolute grid coords of every filled cell, with (gridRow, gridCol) as the bounding box's top-left.
function getShapeCells(shape, gridRow, gridCol) {
  const cells = [];
  shape.forEach((row, r) => row.forEach((v, c) => {
    if (v) cells.push({ row: gridRow + r, col: gridCol + c });
  }));
  return cells;
}

// Bottom-right-most filled cell — where a corner badge must sit so it lands on the
// item itself and not in the hollow of a non-rectangular shape
function getBottomRightFilledCell(shape) {
  for (let r = shape.length - 1; r >= 0; r--)
    for (let c = shape[r].length - 1; c >= 0; c--)
      if (shape[r][c]) return { row: r, col: c };
  return { row: shape.length - 1, col: shape[0].length - 1 };
}

// An anchor cell's position after one clockwise rotation of a rows × cols shape.
function getRotatedAnchorCW(anchorRow, anchorCol, rows, cols) {
  return { row: anchorCol, col: rows - 1 - anchorRow };
}
