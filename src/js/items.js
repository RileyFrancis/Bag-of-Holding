// =============================================================================
// DEFAULT ITEM DATABASE — data/items.csv
// =============================================================================
// Edit data/items.csv to add, remove, or modify the built-in item list.
//
// Columns: name, rarity, description, cost, tags, damage, damageType,
//          attunement, stackSize, image, shape,
//          container, containerRows, containerCols, properties, mastery,
//          source, variants
//
// source      — the source material the item comes from, e.g. PHB, DMG, TCoE.
//              "HB" (homebrew) is used for items the player adds in-app.
// description — rendered as Markdown (markdown.js), same rules as a sheet's
//              written sections. A row can't hold a real newline (the file is
//              split on \n before any row is parsed), so a paragraph break,
//              list, or heading is written with a literal "\n", unescaped by
//              unescapeDescription() above.
// tags       — pipe-separated list, e.g.  weapon|melee|finesse
// properties — semicolon-separated list, e.g.  finesse;light;thrown
// shape      — rows pipe-separated, each row is 0/1 digits,  e.g.  11|01|10
//              weight = number of 1s (1 lb per cell)
// stackSize  — how many fit in one cell, e.g. 20 (each then weighs 1/20 lb)
//              blank or 1 = does not stack
// variants   — semicolon-separated list of "<label> (<rarity>, <cost>)", e.g.
//              +1 (uncommon, 500gp); +2 (rare); +3
//              Either half of the parens (or the whole thing) may be omitted —
//              whatever's missing is inherited from the base row. Each variant
//              is materialized as its own full item template ("<base name>
//              <label>"), appended to DEFAULT_ITEMS right after loading, so it
//              is placeable/stashable/sellable exactly like any other item —
//              see materializeVariants() below. For magic items, use
//              data/magic-items.json instead (see MAGIC ITEMS below).
// id is the slug of the name (itemSlug) — renaming a row changes its id, so
// add the old one to LEGACY_ITEM_IDS when you do. Saves written before slug
// ids hold row numbers; currentTemplateId() translates them.

let DEFAULT_ITEMS = [];

function parseCSVRow(line) {
  const fields = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) { fields.push(''); break; }
    if (line[i] === '"') {
      let val = '';
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { val += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else { val += line[i++]; }
      }
      fields.push(val);
      if (line[i] === ',') i++;
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) { fields.push(line.slice(i)); break; }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

function parseCost(str) {
  const zero = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
  if (!str || !str.trim()) return zero;
  const trimmed = str.trim();
  // Plain number → treat as gp (backwards compat)
  if (/^[\d.]+$/.test(trimmed)) return { ...zero, gp: parseFloat(trimmed) };
  const result = { ...zero };
  const re = /(\d+(?:\.\d+)?)\s*(cp|sp|ep|gp|pp)/gi;
  let m;
  while ((m = re.exec(trimmed)) !== null) {
    const denom = m[2].toLowerCase();
    if (denom in result) result[denom] += parseFloat(m[1]);
  }
  return result;
}

function parseShape(str) {
  if (!str || !str.trim()) return [[1]];
  return str.trim().split('|').map(row => row.split('').map(c => parseInt(c, 10)));
}

// The loader splits the whole file on real newlines before parsing rows (see
// loadDefaultItems), so a field can never hold one — a description that wants
// paragraphs, a list, or a heading writes a literal "\n" instead, unescaped
// here. description is Markdown (see markdown.js); nothing else in the row
// needs multiple lines.
function unescapeDescription(str) {
  return str.replace(/\\n/g, '\n');
}

function parseStackSize(str, legacyStackable, legacyWeightEach) {
  if (str && str.trim()) return parseInt(str, 10);
  // CSVs written before the stackSize column carried stackable + weightEach.
  if (legacyStackable === 'true' && legacyWeightEach) return Math.round(1 / parseFloat(legacyWeightEach));
  return undefined;
}

// "+1 (uncommon, 500gp)" → { label: '+1', rarity: 'uncommon', cost: '500gp' }.
// Either half of the parens, or the parens entirely, may be absent — a caller
// falls back to the base item's own rarity/cost for whichever is missing.
function parseVariantSpec(spec) {
  const m = spec.trim().match(/^(.+?)(?:\s*\(([^)]*)\))?$/);
  if (!m || !m[1].trim()) return null;
  const out = { label: m[1].trim() };
  if (m[2]) {
    m[2].split(',').map(s => s.trim()).filter(Boolean).forEach(tok => {
      const norm = tok.toLowerCase().replace(/\s+/g, '_');
      if (RARITY_ORDER.includes(norm)) out.rarity = norm;
      else out.cost = tok;
    });
  }
  return out;
}

function parseVariantSpecs(str) {
  if (!str || !str.trim()) return [];
  return str.split(';').map(parseVariantSpec).filter(Boolean);
}

// Turns each base item's `variantSpecs` into full item templates of their own
// (inheriting everything but name/rarity/cost from the base) and appends them
// to `list` — so a magic +1/+2/+3 version of a tool or a suit of armor is just
// another entry in state.db, placeable and sellable like any other item, with
// no special-casing anywhere else in the app. Mutates `base.variantIds` to
// point at what it made.
function materializeVariants(list) {
  const bases = [...list]; // a variant is never itself variant-bearing
  bases.forEach(base => {
    base.variantIds = base.variantSpecs.map((spec, i) => {
      const variant = {
        ...base,
        id: `${base.id}v${i}`,
        name: `${base.name} ${spec.label}`,
        rarity: spec.rarity || base.rarity,
        cost: spec.cost ? parseCost(spec.cost) : base.cost,
        variantSpecs: [],
        variantIds: [],
        variantOf: base.id,
        variantLabel: spec.label,
      };
      list.push(variant);
      return variant.id;
    });
  });
}

function loadDefaultItems() {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'data/items.csv', false); // synchronous
    xhr.send();
    if (xhr.status !== 200) throw new Error(`HTTP ${xhr.status}`);
    const lines = xhr.responseText.split('\n').map(l => l.trim()).filter(l => l);
    if (lines.length < 2) return;
    const headers = parseCSVRow(lines[0]);
    DEFAULT_ITEMS = lines.slice(1).map(line => {
      const vals = parseCSVRow(line);
      const v = col => vals[headers.indexOf(col)] ?? '';
      return {
        id:          itemSlug(v('name')),
        name:        v('name'),
        rarity:      v('rarity') || 'common',
        description: unescapeDescription(v('description')),
        cost:        parseCost(v('cost')),
        tags:        v('tags') ? v('tags').split('|') : [],
        damage:      v('damage')     || undefined,
        damageType:  v('damageType') || undefined,
        attunement:  v('attunement') === 'true',
        stackSize:   parseStackSize(v('stackSize'), v('stackable'), v('weightEach')),
        image:       v('image') || '',
        shape:       parseShape(v('shape')),
        container:      v('container') === 'true',
        containerRows:  v('containerRows') ? parseInt(v('containerRows'), 10) : undefined,
        containerCols:  v('containerCols') ? parseInt(v('containerCols'), 10) : undefined,
        properties:  v('properties') ? v('properties').split(';').map(s => s.trim()).filter(Boolean) : [],
        mastery:     v('mastery') || undefined,
        source:      v('source') || undefined,
        variantSpecs: parseVariantSpecs(v('variants')),
      };
    }).filter(t => t.name);
    materializeVariants(DEFAULT_ITEMS);
  } catch (err) {
    console.error('Failed to load data/items.csv:', err);
  }
  loadMagicItems();
  DEFAULT_ITEM_IDS = new Set(DEFAULT_ITEMS.map(t => t.id));
}

// "Nolzur's Marvelous Pigments" → "nolzurs-marvelous-pigments". The one rule
// for every built-in id — tools/validate-items.py applies the same one.
function itemSlug(name) {
  return String(name).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Membership test for "is this a built-in item" — DEFAULT_ITEMS holds well over
// a thousand templates once magic items are materialized, too many to .find().
let DEFAULT_ITEM_IDS = new Set();

// =============================================================================
// MAGIC ITEMS — data/magic-items.json
// =============================================================================
// A magic item is a record, not a row per item. One that is "any X weapon/armor"
// carries `appliesTo` and is an OVERLAY: crossed with every base item from
// items.csv it matches, each result inheriting the base's shape, damage,
// properties and stacking, and taking the magic item's name (`nameFormat`,
// `{base}`/`{variant}`), rarity, description, attunement and tags. `variants`
// are tiers/types (+1/+2/+3, dragon colours, giant kinds) — one item each.
//
// What lands in DEFAULT_ITEMS is a tree, drawn by the Browse list's fold:
//
//   overlay, many bases       head ─ one item per base           (Flame Tongue)
//   overlay, many bases, tiers head ─ one sub-head per tier ─ bases (Weapon +1/+2/+3)
//   overlay, one base, tiers   head ─ one item per tier           (Shield +1/+2/+3)
//   standalone, tiers          head ─ one item per tier           (Potion of Giant Strength)
//   overlay, one base / plain  just the item                      (Blackrazor, Bag of Holding)
//
// Heads and sub-heads are `abstract` — real templates (so the list, tooltip and
// folders need no special path) that can never be placed, sold or saved. Ids:
// `<id>`, `<id>~<variant>`, `<id>@<base>`, `<id>~<variant>@<base>` — all derived
// from slugs, so adding a row or an item never moves an existing one.
//
// Matching: a base matches when it is in `bases`, or every word of one `any`
// clause is a whole word of its tags (the same test as folders.js's
// hasTagWord) — and it is not in `except`.

// The DMG's price by rarity, in gp; a consumable is half. Used when a record has
// no `cost` of its own. Artifacts are priceless — no price at all.
const MAGIC_ITEM_PRICE_GP = { common: 100, uncommon: 400, rare: 4000, very_rare: 40000, legendary: 200000 };

function magicItemPriceGp(rarity, consumable) {
  const gp = MAGIC_ITEM_PRICE_GP[rarity] ?? 0;
  return consumable ? gp / 2 : gp;
}

function addGp(cost, gp) {
  const out = { ...cost };
  out.gp = (out.gp ?? 0) + gp;
  return out;
}

function tagWordSet(tags) {
  const words = new Set();
  (tags ?? []).forEach(tag => String(tag).toLowerCase().split(/\s+/).forEach(w => words.add(w)));
  return words;
}

function magicItemApplies(base, applies) {
  if ((applies.except ?? []).includes(base.id)) return false;
  if ((applies.bases ?? []).includes(base.id)) return true;
  const words = tagWordSet(base.tags);
  return (applies.any ?? []).some(clause => clause.every(w => words.has(w)));
}

function fillMagicName(fmt, baseName, variantLabel) {
  let out = fmt;
  if (baseName != null) out = out.replace(/\{base\}/g, baseName);
  if (variantLabel != null) out = out.replace(/\{variant\}/g, variantLabel);
  return out;
}

function loadMagicItems() {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'data/magic-items.json', false); // synchronous, like items.csv
    xhr.send();
    if (xhr.status !== 200) throw new Error(`HTTP ${xhr.status}`);
    materializeMagicItems(DEFAULT_ITEMS, JSON.parse(xhr.responseText).items ?? []);
  } catch (err) {
    console.error('Failed to load data/magic-items.json:', err);
  }
}

// Appends every magic item's templates to `list`. The bases are what `list`
// held on entry, minus variants — a magic item never applies to another one.
function materializeMagicItems(list, records) {
  const bases = list.filter(t => !t.variantOf);
  const taken = new Set(list.map(t => t.id));
  const leavesOf = new Map(); // head id → the placeable items under it
  const add = t => {
    if (taken.has(t.id)) { console.warn(`magic-items.json: duplicate id ${t.id}`); return null; }
    taken.add(t.id);
    list.push(t);
    return t;
  };

  records.forEach(m => {
    const applies = m.appliesTo;
    const matched = applies ? bases.filter(b => magicItemApplies(b, applies)) : [];
    if (applies && !matched.length) { console.warn(`magic-items.json: ${m.id} matches no base item`); return; }
    const variants = m.variants ?? [];
    const fmt = m.nameFormat ?? m.name;

    // One finished, placeable item: the record (+ variant) on a base, or alone.
    const leaf = (id, v, base, parentId) => {
      const rarity = v?.rarity ?? m.rarity;
      const consumable = !!m.consumable || !!base && isStackableTemplate(base);
      // Magic ammunition: ten pieces are worth one consumable of the rarity.
      const priceGp = base && isStackableTemplate(base)
        ? magicItemPriceGp(rarity, true) / 10
        : magicItemPriceGp(rarity, consumable);
      const own = m.cost || v?.cost ? parseCost(v?.cost ?? m.cost) : null;
      const description = v?.note ? `${m.description}\n\n${v.note}` : m.description;
      const t = {
        ...(base ?? {}),
        id,
        name:        fillMagicName(fmt, base?.name, v?.label),
        rarity,
        description,
        cost:        own ?? addGp(base?.cost ?? parseCost(''), priceGp),
        tags:        [...new Set([...(base?.tags ?? []), ...(m.tags ?? [])])],
        attunement:  v?.attunement ?? !!m.attunement,
        attunementNote: m.attunementNote,
        source:      m.source,
        consumable,
        magicOf:     m.id,
        variantSpecs: [],
        variantIds:  [],
        variantOf:   parentId,
      };
      if (!base) {
        t.shape      = parseShape(m.shape);
        t.stackSize  = m.stackSize;
        t.damage     = m.damage;
        t.damageType = m.damageType;
        t.properties = m.properties ?? [];
        t.container  = !!m.container;
        t.containerRows = m.containerRows;
        t.containerCols = m.containerCols;
        t.image      = '';
      }
      return add(t);
    };

    // A fold header. Its shape is its first item's, so the card has a picture.
    const head = (id, name, parentId, rarity = m.rarity) => add({
      id, name,
      rarity,
      description: m.description,
      cost:        parseCost(''),
      tags:        [...new Set([...(m.tags ?? []), ...(applies ? [m.type.toLowerCase()] : [])])],
      attunement:  !!m.attunement,
      attunementNote: m.attunementNote,
      source:      m.source,
      shape:       [[1]],
      properties:  [],
      image:       '',
      consumable:  !!m.consumable,
      abstract:    true,
      magicOf:     m.id,
      variantSpecs: [],
      variantIds:  [],
      variantOf:   parentId,
    });
    const fillHead = (h, children) => {
      if (!h) return;
      const rows = children.filter(Boolean);
      h.variantIds = rows.map(c => c.id);
      if (rows.length) h.shape = rows[0].shape;
      const leaves = rows.flatMap(c => leavesOf.get(c.id) ?? [c]);
      leavesOf.set(h.id, leaves);
      h.familySize = leaves.length;
      h.rarityVaries = new Set(leaves.map(l => l.rarity)).size > 1;
    };

    if (!variants.length) {
      if (matched.length > 1) {
        const h = head(m.id, m.name);
        fillHead(h, matched.map(b => leaf(`${m.id}@${b.id}`, null, b, m.id)));
      } else {
        leaf(m.id, null, matched[0] ?? null);
      }
      return;
    }

    const h = head(m.id, m.name);
    fillHead(h, variants.map(v => {
      const vid = `${m.id}~${v.id}`;
      if (matched.length <= 1) return leaf(vid, v, matched[0] ?? null, m.id);
      const sub = head(vid, `${m.name} (${v.label})`, m.id, v.rarity ?? m.rarity);
      fillHead(sub, matched.map(b => leaf(`${vid}@${b.id}`, v, b, vid)));
      return sub;
    }));
  });
}

// isStackable() lives in helpers.js, which loads after this file and reads
// the older stackable/weightEach pair too; a template built from items.csv
// only ever has stackSize.
function isStackableTemplate(t) {
  return (t.stackSize ?? 1) > 1;
}

// =============================================================================
// LEGACY ITEM IDS
// =============================================================================
// Before slug ids, a built-in item's id was its items.csv row number, and a
// CSV variant was `<row>v<n>`. Saves (local, cloud, a party member's published
// state) still hold those, so every place instances arrive runs them through
// currentTemplateId(). Frozen — never regenerate it from the current CSV. The
// +1/+2/+3 variant column became the DMG's Weapon/Armor/Shield records, and the
// eight Adamantine armor rows became the adamantine-armor overlay. No new id is
// all digits, so a lookup can never catch one.
const LEGACY_ITEM_IDS = {
  '1': 'copper-piece', '2': 'silver-piece', '3': 'electrum-piece', '4': 'gold-piece',
  '5': 'platinum-piece', '6': 'club', '6v0': 'weapon-1-2-or-3~1@club',
  '6v1': 'weapon-1-2-or-3~2@club', '6v2': 'weapon-1-2-or-3~3@club', '7': 'dagger',
  '7v0': 'weapon-1-2-or-3~1@dagger', '7v1': 'weapon-1-2-or-3~2@dagger',
  '7v2': 'weapon-1-2-or-3~3@dagger', '8': 'greatclub', '8v0': 'weapon-1-2-or-3~1@greatclub',
  '8v1': 'weapon-1-2-or-3~2@greatclub', '8v2': 'weapon-1-2-or-3~3@greatclub', '9': 'handaxe',
  '9v0': 'weapon-1-2-or-3~1@handaxe', '9v1': 'weapon-1-2-or-3~2@handaxe',
  '9v2': 'weapon-1-2-or-3~3@handaxe', '10': 'javelin', '10v0': 'weapon-1-2-or-3~1@javelin',
  '10v1': 'weapon-1-2-or-3~2@javelin', '10v2': 'weapon-1-2-or-3~3@javelin', '11': 'light-hammer',
  '11v0': 'weapon-1-2-or-3~1@light-hammer', '11v1': 'weapon-1-2-or-3~2@light-hammer',
  '11v2': 'weapon-1-2-or-3~3@light-hammer', '12': 'mace', '12v0': 'weapon-1-2-or-3~1@mace',
  '12v1': 'weapon-1-2-or-3~2@mace', '12v2': 'weapon-1-2-or-3~3@mace', '13': 'quarterstaff',
  '13v0': 'weapon-1-2-or-3~1@quarterstaff', '13v1': 'weapon-1-2-or-3~2@quarterstaff',
  '13v2': 'weapon-1-2-or-3~3@quarterstaff', '14': 'sickle', '14v0': 'weapon-1-2-or-3~1@sickle',
  '14v1': 'weapon-1-2-or-3~2@sickle', '14v2': 'weapon-1-2-or-3~3@sickle', '15': 'spear',
  '15v0': 'weapon-1-2-or-3~1@spear', '15v1': 'weapon-1-2-or-3~2@spear',
  '15v2': 'weapon-1-2-or-3~3@spear', '16': 'dart', '16v0': 'weapon-1-2-or-3~1@dart',
  '16v1': 'weapon-1-2-or-3~2@dart', '16v2': 'weapon-1-2-or-3~3@dart', '17': 'light-crossbow',
  '17v0': 'weapon-1-2-or-3~1@light-crossbow', '17v1': 'weapon-1-2-or-3~2@light-crossbow',
  '17v2': 'weapon-1-2-or-3~3@light-crossbow', '18': 'shortbow',
  '18v0': 'weapon-1-2-or-3~1@shortbow', '18v1': 'weapon-1-2-or-3~2@shortbow',
  '18v2': 'weapon-1-2-or-3~3@shortbow', '19': 'sling', '19v0': 'weapon-1-2-or-3~1@sling',
  '19v1': 'weapon-1-2-or-3~2@sling', '19v2': 'weapon-1-2-or-3~3@sling', '20': 'battleaxe',
  '20v0': 'weapon-1-2-or-3~1@battleaxe', '20v1': 'weapon-1-2-or-3~2@battleaxe',
  '20v2': 'weapon-1-2-or-3~3@battleaxe', '21': 'flail', '21v0': 'weapon-1-2-or-3~1@flail',
  '21v1': 'weapon-1-2-or-3~2@flail', '21v2': 'weapon-1-2-or-3~3@flail', '22': 'glaive',
  '22v0': 'weapon-1-2-or-3~1@glaive', '22v1': 'weapon-1-2-or-3~2@glaive',
  '22v2': 'weapon-1-2-or-3~3@glaive', '23': 'greataxe', '23v0': 'weapon-1-2-or-3~1@greataxe',
  '23v1': 'weapon-1-2-or-3~2@greataxe', '23v2': 'weapon-1-2-or-3~3@greataxe', '24': 'greatsword',
  '24v0': 'weapon-1-2-or-3~1@greatsword', '24v1': 'weapon-1-2-or-3~2@greatsword',
  '24v2': 'weapon-1-2-or-3~3@greatsword', '25': 'halberd', '25v0': 'weapon-1-2-or-3~1@halberd',
  '25v1': 'weapon-1-2-or-3~2@halberd', '25v2': 'weapon-1-2-or-3~3@halberd', '26': 'lance',
  '26v0': 'weapon-1-2-or-3~1@lance', '26v1': 'weapon-1-2-or-3~2@lance',
  '26v2': 'weapon-1-2-or-3~3@lance', '27': 'longsword', '27v0': 'weapon-1-2-or-3~1@longsword',
  '27v1': 'weapon-1-2-or-3~2@longsword', '27v2': 'weapon-1-2-or-3~3@longsword', '28': 'maul',
  '28v0': 'weapon-1-2-or-3~1@maul', '28v1': 'weapon-1-2-or-3~2@maul',
  '28v2': 'weapon-1-2-or-3~3@maul', '29': 'morningstar', '29v0': 'weapon-1-2-or-3~1@morningstar',
  '29v1': 'weapon-1-2-or-3~2@morningstar', '29v2': 'weapon-1-2-or-3~3@morningstar', '30': 'pike',
  '30v0': 'weapon-1-2-or-3~1@pike', '30v1': 'weapon-1-2-or-3~2@pike',
  '30v2': 'weapon-1-2-or-3~3@pike', '31': 'rapier', '31v0': 'weapon-1-2-or-3~1@rapier',
  '31v1': 'weapon-1-2-or-3~2@rapier', '31v2': 'weapon-1-2-or-3~3@rapier', '32': 'scimitar',
  '32v0': 'weapon-1-2-or-3~1@scimitar', '32v1': 'weapon-1-2-or-3~2@scimitar',
  '32v2': 'weapon-1-2-or-3~3@scimitar', '33': 'shortsword', '33v0': 'weapon-1-2-or-3~1@shortsword',
  '33v1': 'weapon-1-2-or-3~2@shortsword', '33v2': 'weapon-1-2-or-3~3@shortsword', '34': 'trident',
  '34v0': 'weapon-1-2-or-3~1@trident', '34v1': 'weapon-1-2-or-3~2@trident',
  '34v2': 'weapon-1-2-or-3~3@trident', '35': 'warhammer', '35v0': 'weapon-1-2-or-3~1@warhammer',
  '35v1': 'weapon-1-2-or-3~2@warhammer', '35v2': 'weapon-1-2-or-3~3@warhammer', '36': 'war-pick',
  '36v0': 'weapon-1-2-or-3~1@war-pick', '36v1': 'weapon-1-2-or-3~2@war-pick',
  '36v2': 'weapon-1-2-or-3~3@war-pick', '37': 'whip', '37v0': 'weapon-1-2-or-3~1@whip',
  '37v1': 'weapon-1-2-or-3~2@whip', '37v2': 'weapon-1-2-or-3~3@whip', '38': 'blowgun',
  '38v0': 'weapon-1-2-or-3~1@blowgun', '38v1': 'weapon-1-2-or-3~2@blowgun',
  '38v2': 'weapon-1-2-or-3~3@blowgun', '39': 'hand-crossbow',
  '39v0': 'weapon-1-2-or-3~1@hand-crossbow', '39v1': 'weapon-1-2-or-3~2@hand-crossbow',
  '39v2': 'weapon-1-2-or-3~3@hand-crossbow', '40': 'heavy-crossbow',
  '40v0': 'weapon-1-2-or-3~1@heavy-crossbow', '40v1': 'weapon-1-2-or-3~2@heavy-crossbow',
  '40v2': 'weapon-1-2-or-3~3@heavy-crossbow', '41': 'longbow', '41v0': 'weapon-1-2-or-3~1@longbow',
  '41v1': 'weapon-1-2-or-3~2@longbow', '41v2': 'weapon-1-2-or-3~3@longbow', '42': 'musket',
  '42v0': 'weapon-1-2-or-3~1@musket', '42v1': 'weapon-1-2-or-3~2@musket',
  '42v2': 'weapon-1-2-or-3~3@musket', '43': 'pistol', '43v0': 'weapon-1-2-or-3~1@pistol',
  '43v1': 'weapon-1-2-or-3~2@pistol', '43v2': 'weapon-1-2-or-3~3@pistol', '44': 'padded-armor',
  '44v0': 'armor-1-2-or-3~1@padded-armor', '44v1': 'armor-1-2-or-3~2@padded-armor',
  '44v2': 'armor-1-2-or-3~3@padded-armor', '45': 'leather-armor',
  '45v0': 'armor-1-2-or-3~1@leather-armor', '45v1': 'armor-1-2-or-3~2@leather-armor',
  '45v2': 'armor-1-2-or-3~3@leather-armor', '46': 'studded-leather-armor',
  '46v0': 'armor-1-2-or-3~1@studded-leather-armor',
  '46v1': 'armor-1-2-or-3~2@studded-leather-armor',
  '46v2': 'armor-1-2-or-3~3@studded-leather-armor', '47': 'hide-armor',
  '47v0': 'armor-1-2-or-3~1@hide-armor', '47v1': 'armor-1-2-or-3~2@hide-armor',
  '47v2': 'armor-1-2-or-3~3@hide-armor', '48': 'chain-shirt',
  '48v0': 'armor-1-2-or-3~1@chain-shirt', '48v1': 'armor-1-2-or-3~2@chain-shirt',
  '48v2': 'armor-1-2-or-3~3@chain-shirt', '49': 'scale-mail',
  '49v0': 'armor-1-2-or-3~1@scale-mail', '49v1': 'armor-1-2-or-3~2@scale-mail',
  '49v2': 'armor-1-2-or-3~3@scale-mail', '50': 'breastplate',
  '50v0': 'armor-1-2-or-3~1@breastplate', '50v1': 'armor-1-2-or-3~2@breastplate',
  '50v2': 'armor-1-2-or-3~3@breastplate', '51': 'half-plate-armor',
  '51v0': 'armor-1-2-or-3~1@half-plate-armor', '51v1': 'armor-1-2-or-3~2@half-plate-armor',
  '51v2': 'armor-1-2-or-3~3@half-plate-armor', '52': 'ring-mail',
  '52v0': 'armor-1-2-or-3~1@ring-mail', '52v1': 'armor-1-2-or-3~2@ring-mail',
  '52v2': 'armor-1-2-or-3~3@ring-mail', '53': 'chain-mail', '53v0': 'armor-1-2-or-3~1@chain-mail',
  '53v1': 'armor-1-2-or-3~2@chain-mail', '53v2': 'armor-1-2-or-3~3@chain-mail',
  '54': 'splint-armor', '54v0': 'armor-1-2-or-3~1@splint-armor',
  '54v1': 'armor-1-2-or-3~2@splint-armor', '54v2': 'armor-1-2-or-3~3@splint-armor',
  '55': 'plate-armor', '55v0': 'armor-1-2-or-3~1@plate-armor',
  '55v1': 'armor-1-2-or-3~2@plate-armor', '55v2': 'armor-1-2-or-3~3@plate-armor', '56': 'shield',
  '56v0': 'shield-1-2-or-3~1', '56v1': 'shield-1-2-or-3~2',
  '56v2': 'shield-1-2-or-3~3', '57': 'alchemists-supplies', '58': 'brewers-supplies',
  '59': 'calligraphers-supplies', '60': 'carpenters-tools', '61': 'cartographers-tools',
  '62': 'cobblers-tools', '63': 'cooks-utensils', '64': 'glassblowers-tools',
  '65': 'jewelers-tools', '66': 'leatherworkers-tools', '67': 'masons-tools',
  '68': 'painters-supplies', '69': 'potters-tools', '70': 'smiths-tools', '71': 'tinkers-tools',
  '72': 'weavers-tools', '73': 'woodcarvers-tools', '74': 'disguise-kit', '75': 'forgery-kit',
  '76': 'herbalism-kit', '77': 'navigators-tools', '78': 'poisoners-kit', '79': 'thieves-tools',
  '80': 'gaming-set-dice', '81': 'gaming-set-dragonchess', '82': 'gaming-set-playing-cards',
  '83': 'gaming-set-three-dragon-ante', '84': 'bagpipes', '85': 'drum', '86': 'dulcimer',
  '87': 'flute', '88': 'horn', '89': 'lute', '90': 'lyre', '91': 'pan-flute', '92': 'shawm',
  '93': 'viol', '94': 'adamantine-armor@chain-shirt', '95': 'adamantine-armor@scale-mail',
  '96': 'adamantine-armor@breastplate', '97': 'adamantine-armor@half-plate-armor',
  '98': 'adamantine-armor@ring-mail', '99': 'adamantine-armor@chain-mail',
  '100': 'adamantine-armor@splint-armor', '101': 'adamantine-armor@plate-armor'
};

function currentTemplateId(id) {
  return LEGACY_ITEM_IDS[id] ?? id;
}

// A fresh copy of an instance map with every templateId current. Cheap enough
// to run on every intake — instances are a character's worth, not thousands.
function migrateInstanceTemplateIds(instances) {
  if (!instances) return instances;
  return Object.fromEntries(Object.entries(instances).map(([k, inst]) =>
    [k, inst && LEGACY_ITEM_IDS[inst.templateId] ? { ...inst, templateId: LEGACY_ITEM_IDS[inst.templateId] } : inst]));
}
