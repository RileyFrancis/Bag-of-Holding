// =============================================================================
// HELPERS — Shared formatting and lookup helpers
// =============================================================================
'use strict';

const COIN_DENOMS = ['cp', 'sp', 'ep', 'gp', 'pp'];

// Resolved palette colours by rarity (and 'coin:<denom>'); cleared on a theme swap.
let rarityColorCache = {};

// ─── STACKING ──────────────────────────────────────────────────────────────
// `stackSize` = units per cell; each weighs 1 / stackSize lb. Absent or 1 = does
// not stack. These helpers also translate the `stackable` + `weightEach` pair
// still found in old saves and party data.

// Units of this template that fit in one cell; 1 for an item that doesn't stack.
function getItemStackSize(t) {
  if (t?.stackSize) return t.stackSize;
  if (t?.stackable && t.weightEach) return Math.round(1 / t.weightEach);
  return 1;
}

// Whether more than one unit of this template fits in a cell.
function isStackable(t) {
  return getItemStackSize(t) > 1;
}

// Weight in lb of one unit of this template.
function getItemUnitWeight(t) {
  return 1 / getItemStackSize(t);
}

// Stack weights are fractions of a pound; trim the float noise (1/3 → 0.333).
function formatWeight(lb) {
  return String(Math.round(lb * 1000) / 1000);
}

// Normalizes a cost (object, bare gp number, or missing) to { cp, sp, ep, gp, pp }.
function parseCostObj(val) {
  if (typeof val === 'object' && val !== null) return { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0, ...val };
  if (typeof val === 'number') return { cp: 0, sp: 0, ep: 0, gp: val, pp: 0 };
  return { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
}

// Whether a cost is anything above zero.
function hasCost(cost) {
  const c = parseCostObj(cost);
  return !!(c.cp || c.sp || c.ep || c.gp || c.pp);
}

// A cost as text, largest coin first ("1 gp 5 sp"), or '—' when free.
function formatCost(cost) {
  const c = parseCostObj(cost);
  const parts = [];
  if (c.pp) parts.push(`${c.pp} pp`);
  if (c.gp) parts.push(`${c.gp} gp`);
  if (c.ep) parts.push(`${c.ep} ep`);
  if (c.sp) parts.push(`${c.sp} sp`);
  if (c.cp) parts.push(`${c.cp} cp`);
  return parts.length ? parts.join(' ') : '—';
}

// ─── ICONS ─────────────────────────────────────────────────────────────────
// One icon from img/icon, as an element — a CSS mask over currentColor
// (icons.css), so the caller sets no colour. `lead` adds the gap for an icon in
// front of a button's label.
function createIconEl(name, lead) {
  const el = document.createElement('span');
  el.className = 'ico ico-' + name + (lead ? ' lead' : '');
  return el;
}

// A button (or any element) whose label is an icon followed by text.
function setIconLabel(el, name, text) {
  el.textContent = '';
  el.appendChild(createIconEl(name, true));
  el.appendChild(document.createTextNode(text));
}

// ─── COINS ─────────────────────────────────────────────────────────────────
// Coin templates are found by identity, never hard-coded, since a default item's
// id changes when its row is renamed. A coin is the `currency` item whose cost is
// exactly one of its own denomination.

// The template id of each coin denomination, or null where none is loaded.
function getCoinTemplates() {
  const found = { cp: null, sp: null, ep: null, gp: null, pp: null };
  Object.values(state.db).forEach(t => {
    if (!t.tags?.includes('currency')) return;
    const cost = parseCostObj(t.cost);
    const denom = COIN_DENOMS.find(d => cost[d] === 1 && COIN_DENOMS.every(o => o === d || !cost[o]));
    if (denom && !found[denom]) found[denom] = t.id;
  });
  return found;
}

function _getCoinDenom(templateId) {
  const templates = getCoinTemplates();
  return COIN_DENOMS.find(d => templates[d] === templateId) ?? null;
}

// Every coin carried, wherever it sits — stashed or placed on the grid.
function getCoinCounts() {
  const counts = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
  const templates = getCoinTemplates();
  const denomOf = {};
  COIN_DENOMS.forEach(d => { if (templates[d]) denomOf[templates[d]] = d; });
  Object.values(state.instances).forEach(inst => {
    const denom = denomOf[inst.templateId];
    if (denom) counts[denom] += inst.stackCount ?? 1;
  });
  return counts;
}

// Add units of a stackable item, topping up part-filled stacks before starting
// new ones in the stash. Mutation only — the caller re-renders.
function addStackableUnits(templateId, totalToAdd) {
  if (totalToAdd <= 0) return;
  const t = state.db[templateId];
  if (!t) return;
  const maxStack = getItemStackSize(t);
  let remaining = totalToAdd;

  // Fill existing non-full stacks first (least-full first)
  const partial = Object.values(state.instances)
    .filter(inst => inst.templateId === templateId && (inst.stackCount ?? 1) < maxStack)
    .sort((a, b) => (a.stackCount ?? 1) - (b.stackCount ?? 1));

  for (const inst of partial) {
    if (remaining <= 0) break;
    const space = maxStack - (inst.stackCount ?? 1);
    const adding = Math.min(space, remaining);
    inst.stackCount = (inst.stackCount ?? 1) + adding;
    remaining -= adding;
  }

  // Create new stash stacks for any remainder
  while (remaining > 0) {
    const count = Math.min(maxStack, remaining);
    const id = createInstanceId();
    state.instances[id] = { id, templateId, rotation: 0, row: null, col: null, stackCount: count };
    remaining -= count;
  }
}

// Adds coins to the stash and re-renders.
function addCoinsToInventory(templateId, totalToAdd) {
  addStackableUnits(templateId, totalToAdd);
  renderAllItems();
  updateWeightDisplay();
  scheduleSaveAndSync();
}

// Asks how many of a coin to add, through the shared stack-count modal.
function openAddCoinsModal(templateId) {
  if (isReadOnly()) return;
  const t = state.db[templateId];
  if (!t) return;
  stackModalCallback = count => addCoinsToInventory(templateId, count);
  document.getElementById('stack-modal-desc').textContent = `How many ${t.name}s to add?`;
  const input = document.getElementById('stack-count-input');
  input.removeAttribute('max');
  input.min = '1';
  input.value = '1';
  document.getElementById('stack-confirm-btn').textContent = 'Add';
  showModal('stack-modal');
}

// Removes coins, emptying the smallest stacks first, and re-renders.
function removeCoinsFromInventory(templateId, totalToRemove) {
  if (totalToRemove <= 0) return;
  let remaining = totalToRemove;

  // Remove from smallest stacks first to eliminate partials before touching full stacks
  const instances = Object.values(state.instances)
    .filter(inst => inst.templateId === templateId)
    .sort((a, b) => (a.stackCount ?? 1) - (b.stackCount ?? 1));

  for (const inst of instances) {
    if (remaining <= 0) break;
    const count = inst.stackCount ?? 1;
    if (count <= remaining) {
      if (inst.row !== null && inst.row !== undefined) {
        unequipInstance(inst.id);
        removeFromGrid(inst.id);
      }
      delete state.instances[inst.id];
      remaining -= count;
    } else {
      inst.stackCount = count - remaining;
      remaining = 0;
    }
  }

  renderAllItems();
  updateWeightDisplay();
  scheduleSaveAndSync();
}

// Asks how many of a coin to remove, capped at the number carried.
function openRemoveCoinsModal(templateId) {
  if (isReadOnly()) return;
  const t = state.db[templateId];
  if (!t) return;
  const denom = _getCoinDenom(templateId);
  const total = denom ? getCoinCounts()[denom] : 0;
  if (total === 0) return;
  stackModalCallback = count => removeCoinsFromInventory(templateId, count);
  document.getElementById('stack-modal-desc').textContent = `How many ${t.name}s to remove? (have ${total.toLocaleString()})`;
  const input = document.getElementById('stack-count-input');
  input.max = total;
  input.min = '1';
  input.value = '1';
  document.getElementById('stack-confirm-btn').textContent = 'Remove';
  showModal('stack-modal');
}

// ─── RARITY COLOURS ────────────────────────────────────────────────────────
// The palette lives in CSS (--rarity-*) so each theme can tune it. These values
// are baked into inline styles at render time, so theme.js clears the cache and
// re-renders on a palette swap.

// The theme's colour for a rarity tier, cached.
function getRarityColor(rarity) {
  if (rarityColorCache[rarity]) return rarityColorCache[rarity];
  const fromCss = getComputedStyle(document.documentElement)
    .getPropertyValue('--rarity-' + rarity).trim();
  const color = fromCss || RARITY_META[rarity]?.color || '#888';
  rarityColorCache[rarity] = color;
  return color;
}

// Coin metals get the same treatment — bright gold and silver vanish on parchment.
function getCoinColor(denom) {
  const key = 'coin:' + denom;
  if (rarityColorCache[key]) return rarityColorCache[key];
  const color = getComputedStyle(document.documentElement)
    .getPropertyValue('--coin-' + denom).trim() || 'currentColor';
  rarityColorCache[key] = color;
  return color;
}

// Forgets cached rarity and coin colours; call after a palette change.
function clearRarityColorCache() {
  rarityColorCache = {};
}
