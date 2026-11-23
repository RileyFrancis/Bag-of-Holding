# CLAUDE.md

Guidance for Claude Code in this repository. This file holds only the non-obvious facts that
would cause a silent bug if violated; [ARCHITECTURE.md](ARCHITECTURE.md) has the file maps, load
order and data file shapes. Follow the style rules imported below for all code and docs.

@STYLE.md

## Git

- **Never commit or push anything**, on any branch. Leave every change as uncommitted, unstaged edits.
- **Do not use worktrees.** Work directly in the main checkout unless specified otherwise.

## Running the app

`python3 tools/serve.py 8787`, then open `http://localhost:8787/home`. Plain `http.server` lacks the
app's routes and 404s a reload; `file://` may not load `.env` or `data/*.csv`.

## Architecture

Classic scripts sharing globals, not ES modules. **Top-level code runs at load time in file
order**, so the `<script>` order in `index.html` and the `<link>` cascade order are both behavior.
`tokens.css` must load first.

### State (`state.js`)

```
state.character   { id, name, race, abilities{str…cha}, classLevels[{name,level,subclass}] (authoritative),
                    classes[]/level/subclass/strength (mirrors), knownSpells[], hp{}, ...sheet fields }
state.characters  { [charId]: { character, instances, equipped, equipLayout, db } }
state.activeCharacterId  charId              (which slot is the live working copy)
state.campaigns   { [code]: { code, name, role, characterId, gmName, memberCount, lastPlayed } }  (bookmarks)
state.grid        2D array [row][col] → instanceId | null       (authoritative occupancy)
state.instances   { [instanceId]: { id, templateId, rotation, row, col, stackCount } }
state.db          { [templateId]: ItemTemplate }                (default + custom items)
state.shops / state.battlemap   Firebase read-through caches, not in the save file
state.view        'inventory' | 'sheet' | 'spells' | 'map'
state.mode        'idle' | 'placing' | 'dragging'
```

### Grid and items

- `state.grid` is authoritative; placed-item `<div>`s are only visual, rebuilt by `renderAllItems()`.
- **The grid can shrink under its items.** `rebuildGrid()` must unplace (clear `row`/`col`)
  whatever no longer fits, or the item stays invisibly clipped and still charged for weight.
- A Strength edit resizes the grid only on return to the inventory (`markGridSizeDirty()` /
  `rebuildGridIfSizeDirty()`), so a number box passing through 0 doesn't eject the pack.
- Read stack data through `getItemStackSize`/`isStackable`/`getItemUnitWeight` (`helpers.js`),
  never off the template; they also translate the old saves' `stackable`+`weightEach` pair.
- **A variant is never a top-level Browse entry** (`renderItemList()` filters `variantOf`); a card
  with variants only expands its fold on click. Filters reach into a family (`_doesFamilyPassFilter()`).
- Magic items (`magic-items.json`) are crossed with matching items.csv bases at load. A family
  header is an **`abstract` template**: in `state.db` but never placeable, draggable, sellable or
  saved. Guard any new way of placing or selling an item against it.
- **A default item's id is the slug of its name.** Renaming a row changes it, so add the old id to
  `LEGACY_ITEM_IDS`; never hardcode an id. Every intake of saved instances goes through
  `migrateInstanceTemplateIds()`/`getCurrentTemplateId()`, and that table is frozen.
- Edge auto-scroll (`drag-scroll.js`) applies only to held drags, never PLACING mode.

### Persistence and accounts

- `normalizeSavePayload()` is the only place that reads the single-character save shape.
- **Browser furniture never goes in the save file**: panel widths, folders, sort order, sheet
  layout, spellbook prefs, homebrew open folders each have their own `localStorage` key.
- Cloud save is **one JSON string**, not a tree: RTDB drops nulls and empty objects, so a tree
  write would silently fail to replicate a deletion. The same reason puts shop stock entries and
  party homebrew in JSON string fields.
- **Never resolve `_openCloudConflictModal` on the user's behalf**; it discards one of two saves.
- The app is fully usable signed out. Gate entry points with `requireAuth()`; **never gate the
  inventory itself**.
- With no Firebase config, `FIREBASE_CONFIG` is `null` and the app must stay usable offline.
  Preserve that guard in party code.

### Characters and URLs

- `commitActiveCharacter()` (working copy → slot) and `loadActiveCharacterIntoLive()` (slot →
  working copy) are the only bridges. The former **refuses when the working copy isn't your own
  character** (another member's sheet, or a GM viewing none).
- The roster is never empty; deleting the last hands back a placeholder. Placeholders are judged by
  content (`isUntouchedSlot()`), not a flag, because a commit rebuilds the slot. **A placeholder is
  never drawn as a card**, and any new character replaces it.
- `router.js` writes the address bar *from* state, never the reverse. Routes are `home`,
  `character#<charId>`, `campaign#<code>`, each **one relative path segment** so asset paths and
  sub-folder deploys keep working; never add a second segment without making every asset path
  absolute.
- A screen change pushes history; Back/Forward, boot and a cloud save swapping characters only
  replace it (`applyingRoute`). An id not in the roster shows the not-found page and
  `_applyCloudSave()` retries the route. **A URL never joins a campaign**; that is
  `_enterCampaign()`, async and signed in.

### Campaigns and party

- **A roster entry is keyed by the player's account uid**, not a session id, so a rejoin lands on
  the same node. The GM is one node (`parties/<code>/gm`), uid also in `meta.gmUid`.
- Firebase is authoritative; `state.campaigns[code]` is only a bookmark. `_enterCampaign()` always
  asks the party who the GM is, never the local `role`.
- Closing the tab keeps the roster entry. `_leaveCampaign()` gives up the seat and, **for a GM,
  deletes the campaign**.
- Presence: `connected` and `lastSeen` are separate facts. **`onDisconnect` is re-armed from
  `.info/connected` on every reconnect**; RTDB consumes the handler and never re-arms it.
- Kick just removes the roster entry; the client sees itself gone and leaves. Kick, shop reveal
  (`_isShopVisibleToMe()`) and party homebrew are **pacing, not security**.
- **Shop stock is claimed by an RTDB `transaction()` before any coin leaves the purse**, so the
  loser of a race for the last item isn't charged.

### Sidebar and left panel

```
inventory view    Browse · Details · Party
sheet / map view  Chat · Party
spells view       Spells · Party
```

`SIDEBAR_TAB_VIEW` values are a view name, an array of names, or `null` (every view);
`_getSidebarTabView()` callers must handle all three. **Read `getSidebarView()`, not
`state.view`**: a GM who deselects a player keeps `state.view === 'sheet'` under a placeholder.
A GM with nobody picked has no character, so Shop is the whole left panel (`syncLeftPanel()`).

### Chat and dice

- Chat lives at `parties/<code>/chat/<pushId>`, last 200 subscribed, nothing saved. Render with
  **`textContent`, never `innerHTML`**; markdown.js is deliberately not involved.
- `#chat-modal` *moves* the tab's `#chat-empty`/`#chat-body` into itself and back, so there is one
  log. It opts out of the shared backdrop close, since any other hide strands the log.
- **A roll is a chat message** (`kind: 'roll'`); there is no `rolls` node. Rolling works with no
  campaign (`canChat()` drops the audiences) and is not gated by `isReadOnly()`.
- Read a roll's dice through `_getRollGroups()`, never `faces`/`count` (those hold only the first
  group). `pool` is sent only when sizes are mixed so older clients still read a plain roll.
  `parts` stays out of the payload.
- Advantage rolls the whole pool twice and keeps the better total (`dropped` is the loser). A crit
  is a natural 20/1 on a single d20, read off the kept die.
- `noteBubbleFeed()` never bubbles the first snapshot (backlog) or your own roll (it would reveal
  the number before the tumble lands).

### Battle maps and initiative

- **Every coordinate is in the map image's own pixels**, never screen pixels or cells.
- Fog is a ray-fan polygon per party member. **A map with nobody on it has no fog**; fog settles
  only when a drag ends. Elevation tapers vision looking up, never blocks it outright.
- **The initiative turn is an entry id, never an index** (late rollers and removed groups shift
  positions). Order: score → roll moment → id. Only a player's own first Initiative roll joins.

### Character sheet and classes

- `classLevels` is authoritative. The mirrors `classes`, `level` (sum, capped 20) and `subclass`
  are written only by `_normalizeCharacterMeta()`. Proficiency bonus uses the **total** level.
- Every class is read at its **own** level; features and traits are matched by name, not id.
- Derive what the rules settle (modifiers, prof bonus, passive Perception) as text; only what they
  don't (AC, HP) is an input. Scores run 0–30. Read-only when `isReadOnly()`.
- Statuses: a stacking status stores **each level as the id repeated**; derived ones (Encumbered)
  are **never stored**. Chips redraw only on a signature change, or a sync orphans a hover card.
- Feature picks live in `featureChoices` by card key; both feature sections' signatures **must
  include `getFeatureChoicesSignature()`**. An ASI writes into `abilities`; Undo subtracts its picks.

### Spells

- **Spell slots follow the Multiclass Spellcaster table**: half-casters floored by 2, Eldritch
  Knight/Arcane Trickster by 3, **each class floored before summing**. It reads RAW `classLevels`,
  not the registry-filtered list, because EK/AT have no spell-list data but still add slots.
- **Pact Magic is never blended into that total** (`_getPactMagicSlots()`).
- `character.spellSlotsUsed` stores slots **spent**, never slots left, so a level-up's new slot
  arrives fresh. It is in `_getSpellSheetSignature()` so a synced cast redraws for viewers.
- A cast is a chat message (`kind: 'cast'`) and is gated by `isReadOnly()` (it writes).
- The Available pool includes spells tagged only with classes the character lacks, ungated, so a
  feat can grant them. Owned classes are opt-out (`hiddenClasses`), others opt-in
  (`shownExtraClasses`), so empty prefs already mean "only yours checked".
- **Hiding a class or school never touches `knownSpells`**; Known is computed from the unfiltered
  pool.
- A prefs change calls `_renderSpellSheetContent()` directly, because `renderSpellSheet()`'s gate
  watches only classes and level.

### Homebrew

- Custom items are not copied into the homebrew tree; they are collected from every slot's `db` at
  render. Other kinds go through `addHomebrewEntry()`, saved in the shape their data file uses.
- A folder's enable targets reach everything inside it. `getAllClasses()`/`getAllSpecies()`/
  `_getAllSpells()` signature gates **must include `getHomebrewUsableKey()`**, or a toggle won't
  redraw.
- `getCustomDb()` drops a `_homebrew` item **unless an instance still uses it**.
- Party nodes count only while their uid is in the roster or is `meta.gmUid`.

### Folders and sorting

`state.folderAssign` holds only overrides. Rules run in `DEFAULT_FOLDER_MATCH_ORDER`, not display
order. Changing the default set means bumping `FOLDER_LAYOUT_VERSION` and teaching
`_upgradeFolderLayout()` the step; it renames only folders still carrying their default name.

### Markdown

**`markdown.js` is the only place that turns a string into markup, and its sanitizer is not
optional**: synced sheets render in every member's browser, so a `<script>` in a backstory would
run in the GM's signed-in session. `on*` attributes are dropped before the allowlist, and URLs are
checked after invisible characters are stripped (`java&#9;script:`).

### Theming

- `_getCritColorSwaps()`/`_getPendingColorSwaps()` re-point `--crit`/`--fumble`/`--pending` when a
  custom colour is too close. Never override the `-main`/`-alt` tokens; they are what the check reads.
- **Any render path that inlines a palette colour must re-run from `_rerenderThemedContent()`.**
