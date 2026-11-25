// =============================================================================
// REST EFFECTS — what a short or long rest restores on the live character,
// spending Hit Dice, and the food a long rest's camp is stocked from
// =============================================================================
'use strict';

// Every function here edits the live character, so callers make sure it is the
// player's own (not another member's sheet) before calling.

const CAMP_SUPPLIES_PER_CHARACTER = 20; // supplies one resting character needs per long rest
const FOOD_CAMP_SUPPLY_FALLBACK   = 5;  // supplies per unit of a food item with no value of its own

// ─── RESTORING ───

// A Short Rest: Pact Magic slots come back. Hit Dice are spent separately.
function applyShortRestRecovery() {
  restoreSpellSlotsForShortRest();
  commitSheetEdit('spellSlotsUsed');
}

// A Long Rest: all HP and every spent Hit Die, every spell slot, death saves
// cleared, Temporary HP gone, and one level of Exhaustion off.
function applyLongRestRecovery() {
  const c = state.character;
  const hp = c.hp ?? (c.hp = { current: 0, max: 0, temp: 0 });
  if (hp.max > 0) hp.current = hp.max;
  hp.temp = 0;
  c.hitDice = { ...(c.hitDice ?? {}), spent: 0 };
  c.deathSaves = { successes: 0, failures: 0 };

  // A stacking status is its id repeated, so one level off is one copy removed.
  const statuses = Array.isArray(c.statuses) ? [...c.statuses] : [];
  const exhaustionAt = statuses.indexOf('exhaustion');
  if (exhaustionAt >= 0) statuses.splice(exhaustionAt, 1);
  c.statuses = statuses;

  restoreSpellSlotsForLongRest();
  commitSheetEdit('hp.current');
}

// ─── HIT DICE ───

// The live character's Hit Dice: the die size and how many are left to spend.
function getHitDiceStatus() {
  const hd = state.character.hitDice ?? {};
  const faces = parseInt(String(hd.die ?? 'd8').replace(/\D/g, ''), 10);
  const max = Math.max(0, parseInt(hd.max, 10) || 0);
  const spent = Math.max(0, Math.min(max, parseInt(hd.spent, 10) || 0));
  return { faces: DICE_FACES.includes(faces) ? faces : 8, max, spent, left: max - spent };
}

// Whether the live character is already at full HP. An unset maximum (0)
// never counts as full, so healing still works on a sheet without one.
function isAtFullHp() {
  const hp = state.character.hp ?? {};
  return hp.max > 0 && (hp.current ?? 0) >= hp.max;
}

// Rolls `count` Hit Dice as one roll at the table and heals by it: each die
// gives its roll plus the Constitution modifier, at least 1. Returns the HP
// gained, or null when nothing was rolled.
function spendHitDice(count) {
  const status = getHitDiceStatus();
  const n = Math.max(0, Math.min(status.left, parseInt(count, 10) || 0));
  if (!n || isReadOnly()) return null;

  const con = getAbilityModifier('con');
  const roll = performRoll({
    label: 'Hit Dice',
    pool: [{ faces: status.faces, count: n }],
    mod: con * n,
    parts: con ? [{ label: n > 1 ? `Constitution ×${n}` : 'Constitution', value: con * n }] : [],
  });
  if (!roll) return null;

  const healed = roll.dice.reduce((sum, d) => sum + Math.max(1, d + con), 0);
  const c = state.character;
  const hp = c.hp ?? (c.hp = { current: 0, max: 0, temp: 0 });
  const before = hp.current ?? 0;
  hp.current = hp.max > 0 ? Math.min(hp.max, before + healed) : before + healed;
  if (hp.current > 0) c.deathSaves = { successes: 0, failures: 0 };
  c.hitDice = { ...(c.hitDice ?? {}), spent: status.spent + n };
  commitSheetEdit('hp.current');
  return hp.current - before;
}

// ─── CAMP SUPPLIES ───

// Whether a template is food: a whole `food` tag, any case.
function _isFoodTemplate(t) {
  return !!t && !t.abstract && (t.tags ?? []).some(tag => String(tag).trim().toLowerCase() === 'food');
}

// How many camp supplies one unit of a food item is worth.
function getFoodCampSupplyValue(t) {
  const n = Number(t?.campSupplies);
  return Number.isFinite(n) && n >= 0 ? n : FOOD_CAMP_SUPPLY_FALLBACK;
}

// Food instances the live character could give up, smallest stack first so
// giving food away clears whole cells before breaking into big stacks. An
// equipped item is being held, so it is left alone.
function _getFoodInstances(templateId) {
  const equippedIds = new Set(Object.values(state.equipped ?? {}));
  return Object.values(state.instances)
    .filter(inst => !equippedIds.has(inst.id))
    .filter(inst => inst.templateId === templateId)
    .sort((a, b) => (a.stackCount ?? 1) - (b.stackCount ?? 1));
}

function _getInstanceUnits(inst) {
  const t = state.db[inst.templateId];
  return t && isStackable(t) ? Math.max(1, inst.stackCount ?? 1) : 1;
}

// Every food item the live character carries, one row per item, sorted by
// name: `[{ templateId, name, units, value, isSpoiled }]`, `value` per unit.
function getOwnFoodStock() {
  const equippedIds = new Set(Object.values(state.equipped ?? {}));
  const byTemplate = new Map();
  Object.values(state.instances).forEach(inst => {
    if (equippedIds.has(inst.id)) return;
    const t = state.db[inst.templateId];
    if (!_isFoodTemplate(t)) return;
    const row = byTemplate.get(t.id) ?? { templateId: t.id, name: t.name, units: 0,
                                          value: getFoodCampSupplyValue(t), isSpoiled: isSpoiledItem(t) };
    row.units += _getInstanceUnits(inst);
    byTemplate.set(t.id, row);
  });
  return [...byTemplate.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Takes the given food out of the live inventory: `[{ templateId, count }]`.
// Asks for no more than is there; anything missing is skipped.
function consumeFood(items) {
  let isChanged = false;
  (items ?? []).forEach(({ templateId, count }) => {
    let owed = Math.max(0, parseInt(count, 10) || 0);
    for (const inst of _getFoodInstances(templateId)) {
      if (!owed) break;
      const units = _getInstanceUnits(inst);
      if (units > owed) {
        inst.stackCount = units - owed;
        owed = 0;
      } else {
        owed -= units;
        removeFromGrid(inst.id);
        delete state.instances[inst.id];
      }
      isChanged = true;
    }
  });
  if (!isChanged) return;
  renderAllItems();
  updateWeightDisplay();
  scheduleSaveAndSync();
}
