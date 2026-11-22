// =============================================================================
// RENDER-STATS — Weight / encumbrance readout, and the header name
// =============================================================================
'use strict';

// Encumbrance from placement alone: 0 none, 1 below row Str, 2 below row 2×Str.
function _getZoneEncumbranceLevel() {
  const str = state.character.strength;
  let status = 0; // 0 = none, 1 = enc, 2 = heavy
  Object.values(state.instances).forEach(inst => {
    if (inst.containerId) return; // skip items stored inside containers
    if (inst.row === null || inst.row === undefined) return;
    const t = state.db[inst.templateId];
    if (!t) return;
    const shape = getRotatedShape(t.shape, inst.rotation);
    const bottomRow = inst.row + shape.length - 1;
    if (bottomRow >= str * 2) {
      status = Math.max(status, 2);
    } else if (bottomRow >= str) {
      status = Math.max(status, 1);
    }
  });
  return status;
}

// 0 = none, 1 = Encumbered, 2 = Heavily Encumbered. Zone placement overrides
// weight-based encumbrance upward. The inventory's readout and the sheet's
// Statuses section (statuses.js) both ask here, so they can never disagree.
function getEncumbranceLevel() {
  const str = state.character.strength;
  const carried = Math.round(getTotalCarriedWeight() * 100) / 100;
  const zoneStatus = _getZoneEncumbranceLevel();
  if (carried > str * 30 || zoneStatus >= 2) return 2;
  if (carried > str * 15 || zoneStatus >= 1) return 1;
  return 0;
}

// The inventory's bottom-left readout: carried / the most that can be carried
// before Encumbered. Its hover card (CSS-shown, so no timer) lists what each
// level costs and marks the one the character is at.
function updateWeightDisplay() {
  const str = state.character.strength;
  const normal = str * 15;
  const carried = Math.round(getTotalCarriedWeight() * 100) / 100;
  const level = getEncumbranceLevel();

  document.getElementById('weight-carried').textContent  = carried;
  document.getElementById('weight-capacity').textContent = normal;
  const indicator = document.getElementById('weight-indicator');
  indicator.dataset.level = level;
  indicator.setAttribute('aria-label', `${carried} of ${normal} lb carried`
    + (level >= 2 ? ', Heavily Encumbered' : level >= 1 ? ', Encumbered' : ''));

  document.querySelectorAll('#weight-card .weight-level').forEach(row => {
    row.classList.toggle('current', Number(row.dataset.level) === level);
  });

  // Header: the name only; Strength shows through the capacity above.
  document.getElementById('char-name-display').textContent = state.character.name;
}

// The card's effects are the Statuses' own descriptions, so card and chips agree.
// Filled once on first hover, because statuses.js loads after this file.
document.getElementById('weight-indicator').addEventListener('pointerenter', () => {
  document.querySelectorAll('#weight-card .weight-level[data-status]').forEach(row => {
    const desc = row.querySelector('.weight-level-desc');
    const status = getStatusById(row.dataset.status);
    if (desc.childElementCount || !status) return;
    renderMarkdownInto(desc, status.description);
  });
});
