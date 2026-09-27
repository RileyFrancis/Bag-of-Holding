// =============================================================================
// RENDER-STATS — Header weight / encumbrance readout
// =============================================================================
'use strict';

function getZoneEncumbrance() {
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
// weight-based encumbrance upward. The header's readout and the sheet's
// Statuses section (statuses.js) both ask here, so they can never disagree.
function encumbranceLevel() {
  const str = state.character.strength;
  const carried = Math.round(totalCarriedWeight() * 100) / 100;
  const zoneStatus = getZoneEncumbrance();
  if (carried > str * 30 || zoneStatus >= 2) return 2;
  if (carried > str * 15 || zoneStatus >= 1) return 1;
  return 0;
}

function updateWeightDisplay() {
  const str = state.character.strength;
  const normal = str * 15;
  const enc = str * 30;
  const heavy = str * 45;
  const carried = Math.round(totalCarriedWeight() * 100) / 100;

  document.getElementById('weight-carried').textContent = `${carried} lb carried`;
  document.getElementById('weight-limits').textContent  = `${normal} / ${enc} / ${heavy} lb`;

  const level = encumbranceLevel();
  const statusEl = document.getElementById('encumbrance-status');
  if (level >= 2) {
    statusEl.textContent = 'Heavily Encumbered'; statusEl.className = 'heavy';
  } else if (level >= 1) {
    statusEl.textContent = 'Encumbered'; statusEl.className = 'enc';
  } else {
    statusEl.textContent = ''; statusEl.className = '';
  }

  // Dynamic bar max: expands from normal → enc → heavy as thresholds are crossed.
  // Floored at 1 because a Strength of 0 is a legal score and makes all three
  // thresholds 0 — without it every ratio below is 0/0, and a NaN length is
  // dropped by the browser, leaving the bar silently showing its last width.
  const barMax = Math.max(1, carried > enc ? heavy : (carried > normal ? enc : normal));
  const pct    = Math.min(carried / barMax, 1) * 100;

  const fillEl = document.getElementById('weight-bar-fill');
  fillEl.style.width = pct + '%';
  // Keep gradient colors anchored to absolute weights by scaling backgroundSize
  // so the color at the fill edge always reflects the real encumbrance level
  fillEl.style.backgroundSize = (heavy / barMax * 100).toFixed(2) + '% 100%';

  // Enc marker always visible at the normal threshold
  document.getElementById('weight-enc-marker').style.left = (normal / barMax * 100) + '%';

  // Heavy marker only appears once the bar has expanded into the heavy zone
  const heavyMarkerEl = document.getElementById('weight-heavy-marker');
  heavyMarkerEl.style.left = (enc / barMax * 100) + '%';
  heavyMarkerEl.style.display = barMax === heavy ? '' : 'none';

  // Header — the name only. Strength is read off the sheet and shown by the
  // limits above rather than printed again as a number.
  document.getElementById('char-name-display').textContent = state.character.name;
}
