// =============================================================================
// CONSTANTS — Tunables, rarity metadata, equipment slot definitions
// =============================================================================
'use strict';

const CELL = 44;          // px per grid square
const GRID_COLS = 15;     // fixed column count

const RARITY_META = {
  common:    { label: 'Common',           color: '#b0b0b0' },
  uncommon:  { label: 'Uncommon',         color: '#1eff00' },
  rare:      { label: 'Rare',             color: '#0084ff' },
  very_rare: { label: 'Very Rare',        color: '#c040ff' },
  legendary: { label: 'Legendary',        color: '#ff8000' },
  artifact:  { label: 'Artifact',         color: '#e6cc80' },
  special:   { label: 'Special',          color: '#ff4da6' },
};

const RARITY_ORDER = ['common','uncommon','rare','very_rare','legendary','artifact','special'];

// ─── CHARACTER SHEET ───

const ABILITIES = [
  { id: 'str', label: 'Strength' },
  { id: 'dex', label: 'Dexterity' },
  { id: 'con', label: 'Constitution' },
  { id: 'int', label: 'Intelligence' },
  { id: 'wis', label: 'Wisdom' },
  { id: 'cha', label: 'Charisma' },
];

// The eighteen skills, alphabetical as printed, each tied to its ability. That
// tie both lays the sheet out and derives the number, so the two cannot drift.
const SKILLS = [
  { id: 'acrobatics',     label: 'Acrobatics',      ability: 'dex' },
  { id: 'animalHandling', label: 'Animal Handling', ability: 'wis' },
  { id: 'arcana',         label: 'Arcana',          ability: 'int' },
  { id: 'athletics',      label: 'Athletics',       ability: 'str' },
  { id: 'deception',      label: 'Deception',       ability: 'cha' },
  { id: 'history',        label: 'History',         ability: 'int' },
  { id: 'insight',        label: 'Insight',         ability: 'wis' },
  { id: 'intimidation',   label: 'Intimidation',    ability: 'cha' },
  { id: 'investigation',  label: 'Investigation',   ability: 'int' },
  { id: 'medicine',       label: 'Medicine',        ability: 'wis' },
  { id: 'nature',         label: 'Nature',          ability: 'int' },
  { id: 'perception',     label: 'Perception',      ability: 'wis' },
  { id: 'performance',    label: 'Performance',     ability: 'cha' },
  { id: 'persuasion',     label: 'Persuasion',      ability: 'cha' },
  { id: 'religion',       label: 'Religion',        ability: 'int' },
  { id: 'sleightOfHand',  label: 'Sleight of Hand', ability: 'dex' },
  { id: 'stealth',        label: 'Stealth',         ability: 'dex' },
  { id: 'survival',       label: 'Survival',        ability: 'wis' },
];

// Three-state, not a checkbox — 2024 keeps expertise.
const PROF_NONE = 0, PROF_PROFICIENT = 1, PROF_EXPERTISE = 2;

const SIZES = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'];

// The nine, in the order the rules print them. A datalist hint, never a
// constraint — the field is free text.
const ALIGNMENTS = [
  'Lawful Good',    'Neutral Good',    'Chaotic Good',
  'Lawful Neutral', 'True Neutral',    'Chaotic Neutral',
  'Lawful Evil',    'Neutral Evil',    'Chaotic Evil',
];

const MAX_LEVEL = 20;

// A key, not a player id — your own character is local state and works with no
// party at all.
const OWN_TAB = 'own';

// ─── BROWSE FOLDERS AND HOMEBREW ───

const UNFILED_ID = '__unfiled';

const HOMEBREW_KINDS = [
  { id: 'class',      label: 'Class' },
  { id: 'subclass',   label: 'Subclass' },
  { id: 'species',    label: 'Species' },
  { id: 'background', label: 'Background' },
  { id: 'item',       label: 'Item' },
  { id: 'spell',      label: 'Spell' },
];

// ─── BATTLE MAPS ───

const MAP_GRID_DEFAULT = { type: 'square', size: 70, offsetX: 0, offsetY: 0, visible: true };

// `color` is only the fallback; the real one is the `--hostility-*` token
// (see getHostilityColor()).
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

// A short fixed list, not free text: a token is read at a glance across a
// shared board.
const CREATURE_ICONS = [
  '🗡️', '🏹', '🛡️', '🪄', '✨', '🎵', '🐺', '🐉', '🕷️', '🦇',
  '💀', '👹', '👻', '🧟', '🐻', '🐍', '🔥', '🧊', '⭐', '❓',
];

// ─── EQUIP SLOTS ───

// Returns a fresh copy of the default equip layout (headers and slots, in order).
// `state.equipLayout` is the working copy the layout editor edits.
function getDefaultEquipLayout() {
  return [
    { type: 'header', label: 'Body' },
    { type: 'slot', id: 'head',     label: 'Headgear',  panelLabel: 'Head',   attuneOnly: false, inRow: false, visible: true },
    { type: 'slot', id: 'armor',    label: 'Armor',     panelLabel: '',       attuneOnly: false, inRow: false, visible: true },
    { type: 'slot', id: 'cloak',    label: 'Cloak',     panelLabel: '',       attuneOnly: false, inRow: false, visible: true },
    { type: 'slot', id: 'gloves',   label: 'Gloves',    panelLabel: '',       attuneOnly: false, inRow: false, visible: true },
    { type: 'slot', id: 'boots',    label: 'Footwear',  panelLabel: '',       attuneOnly: false, inRow: false, visible: true },
    { type: 'header', label: 'Weapons' },
    { type: 'slot', id: 'mainHand', label: 'Main Hand', panelLabel: 'Main',   attuneOnly: false, inRow: true,  visible: true },
    { type: 'slot', id: 'offHand',  label: 'Off Hand',  panelLabel: 'Off',    attuneOnly: false, inRow: true,  visible: true },
    { type: 'slot', id: 'ranged',   label: 'Ranged',    panelLabel: 'Ranged', attuneOnly: false, inRow: true,  visible: true },
    { type: 'header', label: 'Wondrous' },
    { type: 'slot', id: 'attune1',  label: 'Slot I',    panelLabel: '',       attuneOnly: true,  inRow: false, visible: true },
    { type: 'slot', id: 'attune2',  label: 'Slot II',   panelLabel: '',       attuneOnly: true,  inRow: false, visible: true },
    { type: 'slot', id: 'attune3',  label: 'Slot III',  panelLabel: '',       attuneOnly: true,  inRow: false, visible: true },
  ];
}

// Returns the slot definition with this id from the live layout, or undefined.
function getSlotDef(slotId) {
  return state.equipLayout.find(item => item.type === 'slot' && item.id === slotId);
}
