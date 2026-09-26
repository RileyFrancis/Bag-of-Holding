// =============================================================================
// HOMEBREW EDITOR — The New Homebrew panel: pick a kind, then fill in its form
// =============================================================================
'use strict';

// One panel, two faces: "What are we brewing?" (six kinds) and the editor for
// whichever was picked. Each kind is a list of field specs (`HB_FORMS`) drawn by
// one small form builder, so the six forms share their widgets and their read-
// back rather than being six hand-built modals. What a form saves is shaped
// like the data files it will one day sit beside — a class's `features` are
// `data/classes.json` features (`{ id, level, name, description, unlocks }`), a
// species' `traits` are `data/species.json` traits, a spell carries the keys
// `data/spells.json` does, an item is an item template — so wiring homebrew
// into `allClasses()` / `allSpecies()` / the spell list is a read, not a
// translation. Saves go through homebrew.js (`addHomebrewEntry()` /
// `updateHomebrewEntry()`); nothing here touches `state.homebrew` itself.

const HB_LEVELS = 20;

const HB_PICKER_BLURBS = {
  class:      'Hit die, proficiencies, and what unlocks at each level',
  subclass:   'A path within a class, with its own level-by-level features',
  species:    'Size, speed, and the traits it grants',
  background: 'Ability scores, skills, a feat, and starting gear',
  item:       'Gear, weapons, and wondrous things for the grid',
  spell:      'Level, school, casting details, and who can learn it',
};

const HB_RARITIES = [
  ['common', 'Common'], ['uncommon', 'Uncommon'], ['rare', 'Rare'], ['very_rare', 'Very Rare'],
  ['legendary', 'Legendary'], ['artifact', 'Artifact'], ['special', 'Special'],
];
const HB_DAMAGE_TYPES = ['', 'slashing', 'piercing', 'bludgeoning', 'fire', 'cold', 'lightning', 'acid',
  'poison', 'psychic', 'radiant', 'necrotic', 'thunder', 'force'];
const HB_SCHOOLS = ['Abjuration', 'Conjuration', 'Divination', 'Enchantment', 'Evocation',
  'Illusion', 'Necromancy', 'Transmutation'];
const HB_SPELL_LEVELS = [['0', 'Cantrip'], ...Array.from({ length: 9 }, (_, i) => [String(i + 1), 'Level ' + (i + 1)])];

// Read at open time, not load time — the ability/skill tables live in
// character-sheet.js and the class list in class-features.js, both later files.
const hbAbilityOptions = () => ABILITIES.map(a => [a.id, a.label]);
const hbSkillOptions   = () => SKILLS.map(s => [s.id, s.label]);

// Every class a subclass could belong to, or a spell be on the list of: the
// app's own and this account's homebrew ones, by name.
function hbClassNames() {
  const names = allClasses().map(c => c.name)
    .concat(homebrewEntriesOf('class').map(e => e.name));
  return [...new Set(names.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

// =============================================================================
// THE FORMS
// =============================================================================
// Field spec: { key, type, label, … }. `half: true` pairs a field with the next
// half-width one in a two-column row. `showIf(values)` hides a field while false.
const HB_FORMS = {
  class: () => [
    { key: 'name', type: 'text', label: 'Name', required: true, half: true, placeholder: 'e.g. Chronomancer' },
    { key: 'source', type: 'text', label: 'Source', half: true, placeholder: 'HB' },
    { key: 'description', type: 'textarea', label: 'Description', rows: 3, placeholder: 'What this class is, in a paragraph. Markdown works.' },
    { key: 'hitDie', type: 'select', label: 'Hit Die', half: true, options: ['d6', 'd8', 'd10', 'd12'], value: 'd8' },
    { key: 'spellcasting', type: 'select', label: 'Spellcasting', half: true, value: 'none',
      options: [['none', 'None'], ['full', 'Full caster'], ['half', 'Half caster'], ['third', 'Third caster'], ['pact', 'Pact Magic']] },
    { key: 'spellcastingAbility', type: 'select', label: 'Spellcasting Ability', half: true,
      options: () => hbAbilityOptions(), value: 'int', showIf: v => v.spellcasting !== 'none' },
    { key: 'primaryAbility', type: 'checks', label: 'Primary Ability', options: () => hbAbilityOptions() },
    { key: 'savingThrows', type: 'checks', label: 'Saving Throw Proficiencies', options: () => hbAbilityOptions(), max: 2 },
    { key: 'armor', type: 'text', label: 'Armor Training', half: true, placeholder: 'Light and Medium armor, Shields' },
    { key: 'weapons', type: 'text', label: 'Weapon Proficiencies', half: true, placeholder: 'Simple weapons' },
    { key: 'tools', type: 'text', label: 'Tool Proficiencies', half: true, placeholder: 'None' },
    { key: 'skills', type: 'text', label: 'Skill Proficiencies', half: true, placeholder: 'Choose 2: Arcana, History, Insight…' },
    { key: 'equipment', type: 'textarea', label: 'Starting Equipment', rows: 2 },
    { key: 'features', type: 'levels', label: 'Features by Level', subclassToggle: true },
  ],

  subclass: () => [
    { key: 'name', type: 'text', label: 'Name', required: true, half: true, placeholder: 'e.g. Path of the Storm' },
    { key: 'className', type: 'select', label: 'Class', half: true, options: () => hbClassNames(), required: true },
    { key: 'source', type: 'text', label: 'Source', half: true, placeholder: 'HB' },
    { key: 'description', type: 'textarea', label: 'Description', rows: 3 },
    { key: 'features', type: 'levels', label: 'Features by Level' },
  ],

  species: () => [
    { key: 'name', type: 'text', label: 'Name', required: true, half: true, placeholder: 'e.g. Mothfolk' },
    { key: 'source', type: 'text', label: 'Source', half: true, placeholder: 'HB' },
    { key: 'creatureType', type: 'text', label: 'Creature Type', half: true, value: 'Humanoid' },
    { key: 'size', type: 'select', label: 'Size', half: true, value: 'Medium',
      options: () => SIZES.concat('Small or Medium') },
    { key: 'speed', type: 'number', label: 'Speed (ft.)', half: true, value: 30, min: 0, step: 5 },
    { key: 'description', type: 'textarea', label: 'Description', rows: 3 },
    { key: 'traits', type: 'traits', label: 'Traits' },
  ],

  background: () => [
    { key: 'name', type: 'text', label: 'Name', required: true, half: true, placeholder: 'e.g. Lighthouse Keeper' },
    { key: 'source', type: 'text', label: 'Source', half: true, placeholder: 'HB' },
    { key: 'description', type: 'textarea', label: 'Description', rows: 3 },
    { key: 'abilityScores', type: 'checks', label: 'Ability Scores', options: () => hbAbilityOptions(), max: 3 },
    { key: 'skills', type: 'checks', label: 'Skill Proficiencies', options: () => hbSkillOptions(), max: 2 },
    { key: 'feat', type: 'text', label: 'Feat', half: true, placeholder: 'e.g. Alert' },
    { key: 'tools', type: 'text', label: 'Tool Proficiency', half: true, placeholder: "e.g. Navigator's Tools" },
    { key: 'equipment', type: 'textarea', label: 'Equipment', rows: 2, placeholder: 'Choose A or B: (A) … ; or (B) 50 GP' },
  ],

  item: () => [
    { key: 'name', type: 'text', label: 'Name', required: true, half: true, placeholder: 'e.g. Axe of Embers' },
    { key: 'rarity', type: 'select', label: 'Rarity', half: true, options: HB_RARITIES, value: 'common' },
    { key: 'source', type: 'text', label: 'Source', half: true, placeholder: 'HB' },
    { key: 'tags', type: 'text', label: 'Tags (comma separated)', half: true, placeholder: 'weapon, melee, …' },
    { key: 'description', type: 'textarea', label: 'Description', rows: 3 },
    { key: 'cost', type: 'cost', label: 'Cost' },
    { key: 'damage', type: 'text', label: 'Damage', half: true, placeholder: 'e.g. 1d8, 2d6+3' },
    { key: 'damageType', type: 'select', label: 'Damage Type', half: true,
      options: HB_DAMAGE_TYPES.map(t => [t, t ? t[0].toUpperCase() + t.slice(1) : '— None —']) },
    { key: 'mastery', type: 'text', label: 'Mastery', half: true, placeholder: 'e.g. Sap' },
    { key: 'attunement', type: 'toggle', label: 'Requires attunement' },
    { key: 'stackable', type: 'toggle', label: 'Stackable' },
    { key: 'stackSize', type: 'number', label: 'Units per cell', value: 10, min: 2, showIf: v => v.stackable },
    { key: 'shape', type: 'shape', label: 'Shape', showIf: v => !v.stackable },
    { key: 'container', type: 'toggle', label: 'Container (holds a grid of its own)' },
    { key: 'containerCols', type: 'number', label: 'Interior columns', half: true, value: 5, min: 1, showIf: v => v.container },
    { key: 'containerRows', type: 'number', label: 'Interior rows', half: true, value: 5, min: 1, showIf: v => v.container },
  ],

  spell: () => [
    { key: 'name', type: 'text', label: 'Name', required: true, half: true, placeholder: 'e.g. Frost Whisper' },
    { key: 'source', type: 'text', label: 'Source', half: true, placeholder: 'HB' },
    { key: 'level', type: 'select', label: 'Level', half: true, options: HB_SPELL_LEVELS, value: '1' },
    { key: 'school', type: 'select', label: 'School', half: true, options: HB_SCHOOLS, value: 'Evocation' },
    { key: 'castingTime', type: 'text', label: 'Casting Time', half: true, value: 'Action' },
    { key: 'range', type: 'text', label: 'Range', half: true, placeholder: 'e.g. 60 feet' },
    { key: 'componentFlags', type: 'checks', label: 'Components', options: [['V', 'Verbal'], ['S', 'Somatic'], ['M', 'Material']], value: ['V', 'S'] },
    { key: 'material', type: 'text', label: 'Material', placeholder: 'e.g. a sliver of ice', showIf: v => v.componentFlags.includes('M') },
    { key: 'duration', type: 'text', label: 'Duration', half: true, value: 'Instantaneous' },
    { key: 'description', type: 'textarea', label: 'Description', rows: 5,
      placeholder: 'What the spell does. Markdown works — put upcasting under **_Using a Higher-Level Spell Slot._**' },
    { key: 'classes', type: 'checks', label: 'Spell Lists', options: () => hbClassNames() },
  ],
};

// Entry ⇄ form values, where the two differ. An item is saved as a real item
// template (the shape `state.db` holds), a spell gains the `components` string
// the spell data carries.
const HB_TO_ENTRY = {
  item(v) {
    const t = {
      name: v.name, rarity: v.rarity, source: v.source || 'HB', description: v.description,
      tags: String(v.tags ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
      cost: v.cost, image: '',
      damage: v.damage || undefined, damageType: v.damageType || undefined,
      mastery: v.mastery || undefined, attunement: v.attunement || undefined,
      stackSize: v.stackable ? v.stackSize : undefined,
      shape: v.stackable ? [[1]] : v.shape,
      container: v.container || undefined,
      containerRows: v.container ? (parseInt(v.containerRows, 10) || 5) : undefined,
      containerCols: v.container ? (parseInt(v.containerCols, 10) || 5) : undefined,
    };
    // Undefined keys would survive in the entry object but not a JSON round trip.
    Object.keys(t).forEach(k => t[k] === undefined && delete t[k]);
    return t;
  },
  spell(v) {
    const flags = ['V', 'S', 'M'].filter(f => v.componentFlags.includes(f));
    const parts = flags.map(f => (f === 'M' && v.material ? `M (${v.material})` : f));
    return { ...v, level: parseInt(v.level, 10) || 0, components: parts.join(', ') };
  },
};

const HB_FROM_ENTRY = {
  item(e) {
    return {
      ...e,
      tags: (e.tags ?? []).join(', '),
      cost: parseCostObj(e.cost),
      stackable: isStackable(e),
      stackSize: isStackable(e) ? stackSizeOf(e) : 10,
      attunement: !!e.attunement,
      container: !!e.container,
    };
  },
  spell(e) {
    return { ...e, level: String(e.level ?? 0) };
  },
};

// =============================================================================
// THE PANEL
// =============================================================================
const hbModalEl   = document.getElementById('homebrew-modal');
const hbPickerEl  = document.getElementById('homebrew-picker');
const hbEditorEl  = document.getElementById('homebrew-editor');
const hbFormEl    = document.getElementById('homebrew-form');
const hbTitleEl   = document.getElementById('homebrew-editor-title');

// { kind, entryId (null for a new one), fields, values, dirty } while the
// editor face is showing; null on the picker.
let hbEdit = null;

function openHomebrewPanel() {
  showHomebrewPicker();
  showModal('homebrew-modal');
}

// Straight into the editor for an existing entry — a click on its file in the
// tree. There is no picker to go back to, so Back is hidden.
function openHomebrewEntry(id) {
  const entry = state.homebrew.entries[id];
  if (!entry) return;
  showHomebrewEditor(entry.kind, entry);
  showModal('homebrew-modal');
}

function showHomebrewPicker() {
  hbEdit = null;
  hbModalEl.querySelector('.modal-box').classList.remove('editing');
  hbPickerEl.classList.remove('hidden');
  hbEditorEl.classList.add('hidden');
  hbPickerEl.querySelector('.hb-pick')?.focus();
}

function showHomebrewEditor(kind, entry = null) {
  const fields = HB_FORMS[kind]();
  const fromEntry = HB_FROM_ENTRY[kind] ?? (e => e);
  hbEdit = { kind, entryId: entry?.id ?? null, fields, values: {}, dirty: false };

  fields.forEach(f => { hbEdit.values[f.key] = hbDefaultValue(f); });
  if (entry) {
    const saved = fromEntry(entry);
    fields.forEach(f => { if (saved[f.key] !== undefined) hbEdit.values[f.key] = hbClone(saved[f.key]); });
  }

  const label = homebrewKindLabel(kind);
  hbTitleEl.textContent = entry ? `Edit ${label}` : `New ${label}`;
  document.getElementById('homebrew-back-btn').classList.toggle('hidden', !!entry);
  document.getElementById('homebrew-delete-btn').classList.toggle('hidden', !entry);
  document.getElementById('homebrew-save-btn').textContent = entry ? 'Save Changes' : `Create ${label}`;

  hbModalEl.querySelector('.modal-box').classList.add('editing');
  hbPickerEl.classList.add('hidden');
  hbEditorEl.classList.remove('hidden');
  renderHomebrewForm();
  hbFormEl.scrollTop = 0;
  hbModalEl.querySelector('.modal-box').scrollTop = 0;
  hbFormEl.querySelector('input, select, textarea')?.focus();
}

function hbClone(v) { return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v; }

function hbDefaultValue(f) {
  if (f.value !== undefined) return hbClone(f.value);
  switch (f.type) {
    case 'checks':           return [];
    case 'toggle':           return false;
    case 'cost':             return { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
    case 'shape':            return [[1]];
    case 'levels':
    case 'traits':           return [];
    case 'select': {
      const first = hbOptions(f)[0];
      return first ? first[0] : '';
    }
    default:                 return '';
  }
}

// Options as [value, label] pairs, whatever shape the spec gave them in.
function hbOptions(f) {
  const raw = typeof f.options === 'function' ? f.options() : (f.options ?? []);
  return raw.map(o => (Array.isArray(o) ? o : [o, o]));
}

// Any edit: remember there is something to lose, and re-check which fields
// are shown (a toggle can reveal or hide others).
function hbTouched() {
  if (!hbEdit) return;
  hbEdit.dirty = true;
  hbFormEl.querySelectorAll('[data-hb-field]').forEach(el => {
    const f = hbEdit.fields.find(x => x.key === el.dataset.hbField);
    el.classList.toggle('hidden', !!(f?.showIf && !f.showIf(hbEdit.values)));
  });
}

// =============================================================================
// THE FORM BUILDER
// =============================================================================
function renderHomebrewForm() {
  hbFormEl.innerHTML = '';
  const { fields } = hbEdit;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.half && fields[i + 1]?.half) {
      const row = document.createElement('div');
      row.className = 'form-two-col';
      row.append(hbFieldEl(f), hbFieldEl(fields[i + 1]));
      hbFormEl.appendChild(row);
      i++;
    } else {
      hbFormEl.appendChild(hbFieldEl(f));
    }
  }
  hbTouched();
  hbEdit.dirty = false;
}

function hbFieldEl(f) {
  const wrap = document.createElement(['text', 'number', 'textarea', 'select'].includes(f.type) ? 'label' : 'div');
  wrap.className = 'field hb-field hb-field-' + f.type;
  wrap.dataset.hbField = f.key;

  if (f.type !== 'toggle') {
    const label = document.createElement('span');
    label.textContent = f.label + (f.required ? ' *' : '') + (f.max ? ` (pick ${f.max})` : '');
    wrap.appendChild(label);
  }

  const v = hbEdit.values;
  const set = val => { v[f.key] = val; hbTouched(); };

  switch (f.type) {
    case 'text':
    case 'number': {
      const input = document.createElement('input');
      input.type = f.type;
      if (f.type === 'text') input.maxLength = 120;
      if (f.min !== undefined) input.min = f.min;
      if (f.step !== undefined) input.step = f.step;
      input.placeholder = f.placeholder ?? '';
      input.value = v[f.key] ?? '';
      input.addEventListener('input', () =>
        set(f.type === 'number' ? (input.value === '' ? '' : Number(input.value)) : input.value));
      wrap.appendChild(input);
      break;
    }
    case 'textarea': {
      const ta = document.createElement('textarea');
      ta.rows = f.rows ?? 3;
      ta.placeholder = f.placeholder ?? '';
      ta.value = v[f.key] ?? '';
      ta.addEventListener('input', () => set(ta.value));
      wrap.appendChild(ta);
      break;
    }
    case 'select': {
      const sel = document.createElement('select');
      const opts = hbOptions(f);
      // A saved value the list no longer offers (a homebrew class since
      // deleted) is kept as an option rather than silently swapped.
      if (v[f.key] && !opts.some(([val]) => val === v[f.key])) opts.unshift([v[f.key], v[f.key]]);
      opts.forEach(([val, text]) => {
        const o = document.createElement('option');
        o.value = val;
        o.textContent = text;
        sel.appendChild(o);
      });
      sel.value = v[f.key] ?? '';
      sel.addEventListener('change', () => set(sel.value));
      wrap.appendChild(sel);
      break;
    }
    case 'toggle': {
      const label = document.createElement('label');
      label.className = 'checkbox-label';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !!v[f.key];
      box.addEventListener('change', () => set(box.checked));
      label.append(box, document.createTextNode(f.label));
      wrap.appendChild(label);
      break;
    }
    case 'checks':  wrap.appendChild(hbChecksEl(f)); break;
    case 'cost':    wrap.appendChild(hbCostEl(f)); break;
    case 'shape':   wrap.appendChild(hbShapeEl(f)); break;
    case 'levels':  wrap.appendChild(hbLevelsEl(f)); break;
    case 'traits':  wrap.appendChild(hbTraitsEl(f)); break;
  }
  return wrap;
}

// A row of pill checkboxes. `max` stops further picks once reached, rather than
// quietly unticking an earlier one.
function hbChecksEl(f) {
  const box = document.createElement('div');
  box.className = 'hb-checks';
  const picked = () => hbEdit.values[f.key];
  const opts = hbOptions(f);
  // Picks the list no longer offers stay visible, so saving never drops them.
  picked().forEach(val => { if (!opts.some(([o]) => o === val)) opts.push([val, val]); });

  const sync = () => {
    const full = f.max && picked().length >= f.max;
    box.querySelectorAll('input').forEach(input => { input.disabled = !input.checked && !!full; });
  };
  opts.forEach(([val, text]) => {
    const label = document.createElement('label');
    label.className = 'hb-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = picked().includes(val);
    input.addEventListener('change', () => {
      hbEdit.values[f.key] = input.checked
        ? picked().concat(val)
        : picked().filter(x => x !== val);
      sync();
      hbTouched();
    });
    label.append(input, document.createTextNode(text));
    box.appendChild(label);
  });
  if (!opts.length) {
    const none = document.createElement('p');
    none.className = 'modal-note';
    none.textContent = 'Nothing to choose from yet.';
    box.appendChild(none);
  }
  sync();
  return box;
}

function hbCostEl(f) {
  const row = document.createElement('div');
  row.className = 'cost-inputs';
  ['pp', 'gp', 'ep', 'sp', 'cp'].forEach(d => {
    const label = document.createElement('label');
    label.className = 'cost-denom';
    const tag = document.createElement('span');
    tag.textContent = d.toUpperCase();
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '1';
    input.value = hbEdit.values[f.key][d] ?? 0;
    input.addEventListener('input', () => {
      hbEdit.values[f.key][d] = Math.max(0, parseInt(input.value, 10) || 0);
      hbTouched();
    });
    label.append(tag, input);
    row.appendChild(label);
  });
  return row;
}

// The item editor's shape grid, in miniature: click a cell to fill it, the
// buttons grow or shrink the box. Weight is the filled count, 1 lb per cell.
function hbShapeEl(f) {
  const box = document.createElement('div');
  box.className = 'hb-shape';
  const controls = document.createElement('div');
  controls.className = 'hb-shape-controls';
  const grid = document.createElement('div');
  grid.className = 'hb-shape-grid';
  const weight = document.createElement('span');
  weight.className = 'hb-shape-weight';

  const shape = () => hbEdit.values[f.key];
  const draw = () => {
    const s = shape();
    grid.style.gridTemplateColumns = `repeat(${s[0].length}, 26px)`;
    grid.innerHTML = '';
    s.forEach((row, r) => row.forEach((on, c) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'shape-cell' + (on ? ' on' : '');
      cell.setAttribute('aria-label', `Row ${r + 1}, column ${c + 1}`);
      cell.addEventListener('click', () => { s[r][c] = s[r][c] ? 0 : 1; draw(); hbTouched(); });
      grid.appendChild(cell);
    }));
    weight.textContent = `${shapeWeight(s)} lb`;
  };
  const btn = (text, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn-sm';
    b.textContent = text;
    b.addEventListener('click', () => { onClick(shape()); draw(); hbTouched(); });
    controls.appendChild(b);
  };
  btn('+ Col', s => s.forEach(r => r.push(0)));
  btn('− Col', s => { if (s[0].length > 1) s.forEach(r => r.pop()); });
  btn('+ Row', s => s.push(Array(s[0].length).fill(0)));
  btn('− Row', s => { if (s.length > 1) s.pop(); });
  btn('Fill', s => s.forEach(r => r.fill(1)));
  btn('Clear', s => s.forEach(r => r.fill(0)));
  controls.appendChild(weight);
  box.append(controls, grid);
  draw();
  return box;
}

function hbNewPartId(prefix) {
  return prefix + Math.random().toString(36).slice(2, 9);
}

// One feature or trait: a name, a Markdown description, and — per caller — a
// level box or the "this is where the subclass is chosen" toggle.
function hbPartEl(part, list, { onRemove, levelBox, subclassToggle }) {
  const card = document.createElement('div');
  card.className = 'hb-part';

  const head = document.createElement('div');
  head.className = 'hb-part-head';
  const name = document.createElement('input');
  name.type = 'text';
  name.maxLength = 80;
  name.placeholder = 'Name';
  name.value = part.name ?? '';
  name.addEventListener('input', () => { part.name = name.value; hbTouched(); });
  head.appendChild(name);

  if (levelBox) {
    const lvl = document.createElement('label');
    lvl.className = 'hb-part-level';
    lvl.title = 'The character level this trait arrives at';
    const tag = document.createElement('span');
    tag.textContent = 'Lvl';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = String(HB_LEVELS);
    input.value = part.level ?? 1;
    input.addEventListener('input', () => {
      part.level = Math.max(1, Math.min(HB_LEVELS, parseInt(input.value, 10) || 1));
      hbTouched();
    });
    lvl.append(tag, input);
    head.appendChild(lvl);
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'hb-part-remove';
  remove.textContent = '✕';
  remove.title = 'Remove';
  remove.setAttribute('aria-label', 'Remove');
  remove.addEventListener('click', () => {
    list.splice(list.indexOf(part), 1);
    hbTouched();
    onRemove();
  });
  head.appendChild(remove);

  const desc = document.createElement('textarea');
  desc.rows = 2;
  desc.placeholder = 'What it does. Markdown works.';
  desc.value = part.description ?? '';
  desc.addEventListener('input', () => { part.description = desc.value; hbTouched(); });

  card.append(head, desc);

  if (subclassToggle) {
    const label = document.createElement('label');
    label.className = 'checkbox-label hb-part-flag';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = (part.unlocks ?? []).includes('subclass');
    box.addEventListener('change', () => {
      part.unlocks = box.checked ? ['subclass'] : [];
      hbTouched();
    });
    label.append(box, document.createTextNode('The subclass is chosen here'));
    card.appendChild(label);
  }
  return card;
}

// A class's (or subclass's) progression: one band per level, 1 to 20, each
// listing what arrives there, with the proficiency bonus alongside the way the
// book's class table prints it. The features are one flat array, each carrying
// its own `level` — `data/classes.json`'s shape — grouped only for display.
function hbLevelsEl(f) {
  const box = document.createElement('div');
  box.className = 'hb-levels';
  const features = hbEdit.values[f.key];

  const draw = () => {
    box.innerHTML = '';
    for (let level = 1; level <= HB_LEVELS; level++) {
      const band = document.createElement('div');
      band.className = 'hb-level';
      const here = features.filter(x => x.level === level);
      band.classList.toggle('empty', !here.length);

      const head = document.createElement('div');
      head.className = 'hb-level-head';
      const num = document.createElement('span');
      num.className = 'hb-level-num';
      num.textContent = 'Level ' + level;
      const pb = document.createElement('span');
      pb.className = 'hb-level-pb';
      pb.textContent = 'Proficiency +' + (Math.floor((level - 1) / 4) + 2);
      const summary = document.createElement('span');
      summary.className = 'hb-level-summary';
      summary.textContent = here.length ? '' : 'Nothing new';
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'btn-sm hb-level-add';
      setIconLabel(add, 'plus', 'Feature');
      add.addEventListener('click', () => {
        features.push({ id: hbNewPartId('hbfeat_'), level, name: '', description: '', unlocks: [] });
        hbTouched();
        draw();
        // The new feature's name, ready to type into.
        const inputs = box.querySelectorAll(`.hb-level[data-level="${level}"] .hb-part-head input[type=text]`);
        inputs[inputs.length - 1]?.focus();
      });
      head.append(num, pb, summary, add);
      band.dataset.level = level;
      band.appendChild(head);

      here.forEach(part => band.appendChild(hbPartEl(part, features, {
        onRemove: draw, subclassToggle: f.subclassToggle,
      })));
      box.appendChild(band);
    }
  };
  draw();
  return box;
}

// A species' traits: most arrive at level 1, a few later — `level` is optional
// in `data/species.json`, so a level-1 trait is saved without one.
function hbTraitsEl(f) {
  const box = document.createElement('div');
  box.className = 'hb-traits';
  const traits = hbEdit.values[f.key];
  const list = document.createElement('div');
  list.className = 'hb-trait-list';
  const draw = () => {
    list.innerHTML = '';
    traits.forEach(t => list.appendChild(hbPartEl(t, traits, { onRemove: draw, levelBox: true })));
  };
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn-sm';
  setIconLabel(add, 'plus', 'Add Trait');
  add.addEventListener('click', () => {
    traits.push({ id: hbNewPartId('hbtrait_'), name: '', level: 1, description: '' });
    hbTouched();
    draw();
    list.querySelector('.hb-part:last-child input[type=text]')?.focus();
  });
  box.append(list, add);
  draw();
  return box;
}

// =============================================================================
// SAVING
// =============================================================================
function saveHomebrewForm() {
  if (!hbEdit) return;
  const { kind, fields, values, entryId } = hbEdit;

  const name = String(values.name ?? '').trim();
  if (!name) { alert('A name is required.'); return; }
  const missing = fields.find(f => f.required && f.key !== 'name' && !values[f.key]);
  if (missing) { alert(`${missing.label} is required.`); return; }
  if (kind === 'item' && values.stackable && !(values.stackSize >= 2)) {
    alert('Units per cell must be a whole number of 2 or more.');
    return;
  }

  // Unnamed features/traits are the "+ Feature" pressed and never filled in.
  const clean = { ...hbClone(values), name };
  ['features', 'traits'].forEach(key => {
    if (!Array.isArray(clean[key])) return;
    clean[key] = clean[key]
      .map(p => ({ ...p, name: String(p.name ?? '').trim() }))
      .filter(p => p.name)
      .sort((a, b) => (a.level ?? 1) - (b.level ?? 1));
  });
  if (Array.isArray(clean.traits)) {
    clean.traits.forEach(t => { if (!(t.level > 1)) delete t.level; });
  }

  const data = (HB_TO_ENTRY[kind] ?? (v => v))(clean);
  if (entryId) updateHomebrewEntry(entryId, data);
  else addHomebrewEntry(kind, data);

  hbEdit = null;
  hideModal('homebrew-modal');
}

// Leaving with edits unsaved asks first — a class's twenty levels are a lot to
// lose to a stray click on the backdrop.
function confirmHomebrewDiscard() {
  return !hbEdit?.dirty || confirm('Discard this homebrew? What you have filled in will be lost.');
}

function closeHomebrewPanel() {
  if (!confirmHomebrewDiscard()) return;
  hbEdit = null;
  hideModal('homebrew-modal');
}

// =============================================================================
// WIRING
// =============================================================================
HOMEBREW_KINDS.forEach(k => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'hb-pick';
  btn.dataset.kind = k.id;
  const title = document.createElement('span');
  title.className = 'hb-pick-title';
  title.textContent = k.label;
  const blurb = document.createElement('span');
  blurb.className = 'hb-pick-blurb';
  blurb.textContent = HB_PICKER_BLURBS[k.id];
  btn.append(title, blurb);
  btn.addEventListener('click', () => showHomebrewEditor(k.id));
  document.getElementById('homebrew-pick-grid').appendChild(btn);
});

document.getElementById('homebrew-save-btn').addEventListener('click', saveHomebrewForm);
document.getElementById('homebrew-back-btn').addEventListener('click', () => {
  if (confirmHomebrewDiscard()) showHomebrewPicker();
});
document.getElementById('homebrew-delete-btn').addEventListener('click', () => {
  const entry = hbEdit?.entryId && state.homebrew.entries[hbEdit.entryId];
  if (!entry) return;
  if (!confirm(`Delete “${entry.name}”?\n\nThis cannot be undone.`)) return;
  deleteHomebrewEntry(entry.id);
  hbEdit = null;
  hideModal('homebrew-modal');
});
hbModalEl.querySelectorAll('.homebrew-close-btn').forEach(btn =>
  btn.addEventListener('click', closeHomebrewPanel));

// The shared backdrop closes every modal but this one (`data-backdrop-close`,
// modals.js); here it goes through the discard check instead.
document.getElementById('modal-backdrop').addEventListener('click', () => {
  if (!hbModalEl.classList.contains('hidden')) closeHomebrewPanel();
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || hbModalEl.classList.contains('hidden')) return;
  // A modal opened over this one closes first.
  const open = [...document.querySelectorAll('.modal:not(.hidden)')];
  if (open.some(m => m !== hbModalEl)) return;
  e.preventDefault();
  closeHomebrewPanel();
});
