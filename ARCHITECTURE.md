# Architecture

How the code is arranged and why. This is the map; [CLAUDE.md](CLAUDE.md) is the
detailed rationale — the reasoning behind each subsystem, and which parts are
load-bearing. Read this first, then that file for whatever you're about to touch.

## The shape of it

No framework, no bundler, no dependencies, no build step. Static files served
as-is. Everything below follows from that.

```
index.html              Static shell — every DOM element referenced by JS, with stable IDs
VERSION                 The app version, one line — bumped by hand
_redirects              Cloudflare Pages: /home, /character, /campaign all serve index.html
.env                    Firebase credentials for local dev (gitignored, optional)
.env.example            Template for .env
icons.html              Attribution for the icon set
src/css/                All styles, one file per concern
src/js/                 Application logic, one file per concern
data/
  items.csv             Default item database, loaded at startup
  _item_dtypes.csv      Reference: the allowed values for each items.csv column
  classes.json          The classes the app knows, and the features each grants
  species.json          The species the app knows, and the traits each grants
  spell-slots.json      Spell slots each class grants, indexed by that class's level
  spells.json           Every spell the app knows, each tagged with its classes
img/                    Image assets — the icon set and the paper texture
functions/
  firebase-env.js       Cloudflare Pages Function: serves the Firebase keys on a
                        deploy, from the host's environment variables
tools/
  serve.py              Local dev server: http.server plus the app's routes
  make-og-image.py      Draws img/og-preview.jpg, the link-preview picture (needs Pillow)
  shape-editor.html     Standalone helper for drawing item shapes
  spell-editor.html     Standalone helper for authoring data/spells.json entries
```

## Load order is behavior

The JS files are **classic scripts sharing globals — not ES modules**. There are
no `import`/`export` statements: a `function` or `const` at the top level of one
file is visible to every file after it, and each carries its own `'use strict'`,
since strict mode is per-script. Top-level code (element lookups,
`addEventListener` calls) runs at load time in file order.

So the `<script>` block at the bottom of `index.html` is the dependency order,
and changing it changes behavior. Adding a file means adding a tag there, in the
right position.

The same goes for `src/css/`: the `<link>` tags in `<head>` are in cascade
order, and reordering them is a cascade change. `tokens.css` must stay first —
it defines every colour and geometry custom property the other files read.

## `src/js/`

In load order.

| File | Contents |
|------|----------|
| `items.js` | CSV parsing into `DEFAULT_ITEMS` |
| `constants.js` | `CELL`, `GRID_COLS`, `RARITY_META`, `RARITY_ORDER`, `getDefaultEquipLayout` |
| `state.js` | The `state` object and convenience accessors |
| `folders.js` | Browse-list folders: model, persistence, folder modals |
| `item-sort.js` | The Browse list's sort order: the modes, their persistence, the menu |
| `shapes.js` | Rotation, shape cell and bounding-box math |
| `grid.js` | Fit tests, place/remove, `rebuildGrid`, id generation |
| `render-grid.js` | `renderGrid`, `renderAllItems` |
| `render-sidebar.js` | `renderItemList`, details panel |
| `render-stats.js` | Header weight / encumbrance readout |
| `drag-ghost.js` | The ghost element that follows the cursor |
| `drag-scroll.js` | Edge auto-scroll: a held drag near a panel's edge pulls it along |
| `interaction-placing.js` | PLACING mode |
| `interaction-drag.js` | DRAGGING mode, plus R-key rotation |
| `interaction-context.js` | Item clicks, context menu |
| `modals.js` | Tabs, filters, character / item-editor / stack modals |
| `helpers.js` | Shared formatting and lookup helpers |
| `persistence.js` | `saveState`, `loadState`, `exportItemsCSV` |
| `theme.js` | Light/dark palette switching and the settings modal |
| `panels.js` | Side-panel resize handles, collapse, and reopen buttons |
| `appearance.js` | The accent colour, its per-theme resolution, and the hue wheel |
| `firebase-config.js` | Parses `.env` into `FIREBASE_CONFIG` (`null` when absent) |
| `party.js` | Firebase party sync and party UI |
| `auth.js` | Firebase sign-in, the login modal, the Settings account row |
| `cloud-save.js` | Mirrors the save file to `users/<uid>/save` while signed in |
| `character-tabs.js` | Per-character tabs, and the sheet/inventory switch |
| `characters.js` | The account's roster of characters, and the home screen |
| `campaigns.js` | Campaigns: the bookmark model, entering and leaving, the home section |
| `homebrew.js` | The account's homebrew: its store, the home screen's file tree, drag-to-refile |
| `homebrew-editor.js` | The New Homebrew panel: the kind picker, and each kind's form |
| `homebrew-share.js` | Enabling homebrew for characters/campaigns, what is usable now, the party node |
| `router.js` | The address bar: `home` / `character#<id>` / `campaign#<code>`, Back/Forward |
| `character-sheet.js` | Page one of the 2024 sheet: abilities, skills, combat stats |
| `class-features.js` | The class registry, and the sheet's Class Features section |
| `species-traits.js` | The species registry, and the sheet's Species Traits section |
| `markdown.js` | Markdown to HTML for the written sections, and the sanitizer |
| `sheet-prose.js` | Backstory & Appearance: the editor/preview swap |
| `sheet-layout.js` | The sheet's sections as widgets: the split tree, drag-to-tile |
| `character-setup.js` | The Character Setup modal: name, species, background, class rows |
| `equipment.js` | Equip slots, layout editor, equip/unequip |
| `shop.js` | The left panel's tabs, GM shop editor, player shopfront, paying |
| `chat.js` | The campaign's chat log, and the sidebar's Chat pane |
| `dice.js` | Rolling: the tumbling number, the corner stack, the advantage wheel, the tray |
| `battlemap.js` | Battle maps: the model, the Firebase seam, and line of sight |
| `battlemap-library.js` | The GM's Maps pane, and the import / creature dialogs |
| `battlemap-view.js` | The map itself: the camera, the canvas, the fog, the pointer |
| `battlemap-initiative.js` | The turn order: the model, the panel, the GM's group roll |
| `tooltip.js` | Hover tooltip |
| `main.js` | `init()` and the single call to it |

## `src/css/`

In cascade order. A rule's file is its subject; where two could claim it, the one
that owns the element wins.

| File | Contents |
|------|----------|
| `tokens.css` | Both palettes, `--cell` / `--cols`, and the map of this set |
| `base.css` | Reset, body, the grain overlay, type, form controls, buttons |
| `icons.css` | The icon PNGs as `.ico` glyphs, masked over `currentColor` |
| `layout.css` | The app shell: header, weight bar, main split, panel resizing |
| `inventory.css` | The torn sheet, grid cells, placed items, the drag ghost |
| `sidebar.css` | The right panel: browse list, folders, details, menus |
| `modals.css` | Modal chrome, and the shape editor inside the item editor |
| `character.css` | The character tabs, and page one of the 2024 sheet |
| `character-setup.css` | The sheet's gear button, and the class rows in the setup modal |
| `sheet-layout.css` | The sheet's split containers, resize seams, drop feedback |
| `class-features.css` | The feature cards and badges — Class Features and Species Traits both |
| `sheet-prose.css` | The written sections: the bar, the editor, and the rendered prose |
| `party.css` | Party header badge, sidebar Party tab, party modal, kick |
| `campaigns.css` | The home screen's Campaigns section, its cards, and the campaign modal |
| `homebrew.css` | The home screen's Homebrew section, its file tree, and the New Homebrew panel |
| `chat.css` | The sidebar's Chat pane, its messages and composer, and a roll said in it |
| `dice.css` | The flying number, the corner stack, the wheel, the hover card, the tray |
| `battlemap.css` | The map button, the map view, and the GM's library pane |
| `initiative.css` | The turn order panel over the board, and its group-roll dialog |
| `equipment.css` | The equip rack, the left-panel tabs, the layout editor |
| `shop.css` | The GM shop editor, the player shopfront, and their modals |
| `tooltip.css` | The hover tooltip |
| `stash.css` | The stash (items needing placement) and the container tabs |
| `coins.css` | The multi-denomination cost input and the coin purse |
| `settings.css` | The settings modal, the theme picker, and the info pages |
| `appearance.css` | The Appearance page's colour rows and the hue wheel |
| `auth.css` | The sign-in modal, the Settings account row, cloud conflict |
| `home.css` | The home button, the roster page, and the character cards |

## The grid

- 15 columns fixed (`GRID_COLS`), rows = `strength × 3` — three equal zones:
  normal carry, encumbered, heavily encumbered.
- Cell size is 44px (`CELL`).
- `state.grid` is the authoritative occupancy map. The placed-item `<div>`s are
  purely visual and are rebuilt from it by `renderAllItems()`.
- **The grid can shrink under the items on it.** Strength going down takes rows
  away, and so does editing a container's interior size. `rebuildGrid()`
  fit-tests every instance before re-placing it and unplaces whatever no longer
  fits, which drops it into that grid's Needs Placement list.

Shapes are 2D arrays of `0`/`1`, and weight is the count of `1`s — 1 lb per
cell. Stackable items always use `[[1]]` and carry a `stackSize`: how many units
fit in that one cell, so each unit weighs `1 / stackSize`.

## Persistence

Four kinds of state, kept deliberately apart:

| What | Where | Synced? |
|------|-------|---------|
| The character roster — inventories, sheets, custom items | `localStorage`, `dnd_inventory_v1` | Yes, to `users/<uid>/save` |
| Browser furniture — theme, accent, panel widths, folders, sort order, sheet layout | One `localStorage` key each | Never |
| Party state — the roster, and everyone's shared view | Firebase, live | It *is* the sync |
| Shops, battle maps, and the table's chat log — a roll included | Firebase only | Not in the save file at all |

That split is the rule to preserve: anything describing *how this browser shows
the app* stays out of the save file, because a GM paging through the party must
keep their own arrangement rather than adopting each player's.

The save file's shape is version 4 —
`{ version, activeCharacterId, characters, campaigns, homebrew }`. Version 3 was
the same without `homebrew`, and version 2 without `campaigns` either (no
migration needed for either). Version 1 was a single character at
the top level, and `normalizeSavePayload()` folds one into a one-character
roster; it is the only place that knows there were ever earlier shapes. Only
custom items are saved, since the defaults are re-hydrated from `data/items.csv`
on every boot.

Cloud save stores the whole save as **one JSON string**, not a tree: RTDB drops
nulls and empty objects, and the save file is full of both, so a tree write would
silently fail to replicate a deletion.

## Data files

`data/items.csv` is the default item database — one row per item, and **an
item's `id` is its row number**, so inserting a row above another changes its id.
Never write one into the code.

| Column | Notes |
|--------|-------|
| `name` | Required — rows with a blank name are skipped |
| `rarity` | `common` \| `uncommon` \| `rare` \| `very_rare` \| `legendary` \| `artifact` \| `special` |
| `description` | Free text |
| `cost` | `15 gp`, `2 gp 5 sp`, … (a bare number is read as gp) |
| `tags` | Pipe-separated — `weapon\|melee\|finesse`; drives the sidebar tag filter |
| `damage`, `damageType`, `mastery` | Optional weapon fields |
| `attunement`, `container` | `true`, or blank for false |
| `stackSize` | How many units fit in one cell; blank or `1` means it does not stack |
| `shape` | Rows pipe-separated, each row 0/1 digits — `11\|01\|10` |
| `containerRows`, `containerCols` | Interior grid size for containers (blank = 5) |
| `properties` | Semicolon-separated — `Finesse; Light; Thrown` |
| `image` | Path to artwork, relative to the project root |
| `source` | Source material — `PHB`, `DMG`, `TCoE`, … ; `HB` (homebrew) for items the player adds in-app |

`data/_item_dtypes.csv` lists the allowed values for every column and is the
reference to check against. `tools/shape-editor.html` draws a shape visually and
prints the `shape` string to paste in.

`data/classes.json` and `data/species.json` are the class and species
registries — `{ id, name, source?, features: [...], subclasses?: [...] }` and
`{ id, name, traits: [...] }` — read at load the same blocking way. Both are
**content, not code**: adding a class or a species should never mean a code
change, and both files are already the shape a user-authored one will take. A
class nests its subclasses (`{ id, name, source?, features: [...] }`); the
character's one free-text `subclass` field is matched against them and a match
folds that subclass's features into the Class Features list. `source` is a
short book label shown as a caption above the cards.

`data/spells.json` is `{ id, name, level, school, castingTime, range, components,
duration, classes: [...], description }` per spell — `description` is Markdown
too, same rules as `classes.json`/`species.json`, but always a single string
here rather than an array. `classes` names entries in `data/spell-slots.json`'s
own class list, matched by name the same case-insensitive way `class-features.js`
matches a character's `classLevels`. `tools/spell-editor.html` is a form for
adding or editing entries in this file without hand-writing JSON, with a live
preview rendered through the real `markdown.js`; it writes the file directly via
the File System Access API when the browser supports picking a file to save in
place, and falls back to a download otherwise.

The character sheet's written sections (Backstory, Appearance) are Markdown, and
**raw HTML in them is allowed on purpose**. `src/js/markdown.js` is the only
place in the app that turns a string into markup, so its sanitizer is what keeps
one party member's backstory from running code in another's browser. Formatting
survives; anything that can execute, fetch or navigate does not.

## Theming

Two palettes, both defined as CSS custom properties in `tokens.css`: `:root`
holds the light (aged parchment) tokens, `:root[data-theme="dark"]` the dark
(candlelit) ones.

**Every colour is a token — never write a literal colour in a rule**, or it will
be wrong in one of the two themes. The single exception is the hue wheel in
`appearance.css`, which is not a themed surface but the spectrum itself.

- `<html data-theme>` is always `light` or `dark`, never unset. An inline script
  in `<head>` sets it before first paint, so there is no flash of the wrong theme.
- The accent colour is separately customisable per browser. What the user picks
  is a **hue and a saturation, never a lightness** — each theme supplies its own
  lightness, which is what keeps a custom colour readable on either ground.
- Rarity and coin colours differ per theme and are read out of CSS by JS. Any
  render path that bakes a palette colour into an inline style must be re-run
  from `rerenderThemedContent()` on a theme switch.

## Configuration

`firebase-config.js` reads `KEY=value` text from `.env` locally, or
`/firebase-env` on a deploy — first hit wins, and both are always tried, so
neither environment is locked out. When neither answers, `FIREBASE_CONFIG` is
`null` and the app runs fully offline with party play simply unavailable.
**Preserve that guard when touching party code.**

A missing file does not reliably 404: Cloudflare Pages answers unknown paths with
its index page, so a body starting with `<` is rejected as "not a config".

## Versioning

`VERSION` is one line at the project root, deliberately not in the source, so a
release bump never means editing code. `loadAppVersion()` in `main.js` fetches it
**asynchronously**, unlike `items.csv` and `.env` — nothing waits on it, so it
must not hold up the boot. A missing file leaves the Settings footer blank and
changes nothing else.
