# CLAUDE.md

Guidance for Claude Code when working in this repository.
[ARCHITECTURE.md](ARCHITECTURE.md) has the file maps, load order, and data file
shapes. This file is the non-obvious rationale per subsystem — the load-bearing
facts that would cause a silent bug if violated, not a restatement of the code.

## Git and worktrees

- **Never commit or push anything** — not on `main`, not on a branch, not in a
  worktree. Leave every change as uncommitted, unstaged edits in the working
  tree; Riley reviews and commits.
- **Avoid worktrees for this project.** Work directly in the main checkout.

## Running the App

No build step. Serve the project root over HTTP (needed for `localStorage` and
correct MIME types):

```bash
python3 tools/serve.py 8787
# then open http://localhost:8787/home
```

`tools/serve.py` is `http.server` plus the app's routes (`/home`,
`/character`, `/campaign` → `index.html`); plain `python3 -m http.server`
still loads the app but 404s a reload. `file://` works but is not recommended
— `.env` and `data/*.csv` may not load, and the router is off there.

## Architecture

No framework, no bundler — plain classic scripts sharing globals, not ES
modules. A top-level `function`/`const` in one file is visible to every later
file. **Top-level code runs at load time in file order**, so the `<script>`
order in `index.html` and the `<link>` (cascade) order in `<head>` are both
behavior. `tokens.css` must load first — every other file reads its custom
properties. See ARCHITECTURE.md for the full file maps.

### State model (`src/js/state.js`)

```
state.character   { id, name, race, abilities{str…cha}, classLevels[{name,level,subclass}] (authoritative),
                    classes[]/level/subclass/strength (mirrors), knownSpells[], hp{}, ...sheet fields }
state.characters  { [charId]: { character, instances, equipped, equipLayout, db } }
state.activeCharacterId  charId              (which slot is the live working copy)
state.campaigns   { [code]: { code, name, role, characterId, gmName, memberCount, lastPlayed } }  (bookmarks)
state.grid        2D array [row][col] → instanceId | null       (authoritative occupancy)
state.instances   { [instanceId]: { id, templateId, rotation, row, col, stackCount } }
state.db          { [templateId]: ItemTemplate }                (default + custom items)
state.shops / state.battlemap   Firebase read-through caches — not in the save file
state.view        'inventory' | 'sheet' | 'spells' | 'map'
state.mode        'idle' | 'placing' | 'dragging'
```

### Grid geometry

15 columns fixed; rows = `strength × 3` (Normal / Encumbered / Heavily
Encumbered zones), cell size 44px. `state.grid` is authoritative; placed-item
`<div>`s are purely visual, rebuilt by `renderAllItems()`.

- **The grid can shrink under the items on it** (Strength down, or a
  container's interior resized). `rebuildGrid()` fit-tests every instance and
  unplaces whatever no longer fits — skipping that and not clearing
  `row`/`col` leaves an item invisibly clipped, still charged for weight.
- **The deferred resize.** A Strength edit on the sheet only resizes the grid
  once the reader returns to the inventory (`markGridSizeDirty()` /
  `rebuildGridIfSizeDirty()`) — a number box passing through 0 and 1 en route
  from 8 to 16 would otherwise eject the whole pack mid-keystroke.

### Item shapes and variants

Shapes are 2D arrays of `0`/`1`; weight = count of `1`s. Stackable items use
`[[1]]` plus `stackSize` (units per cell) — read it through
`stackSizeOf`/`isStackable`/`unitWeight` in `helpers.js`, never off the
template (those helpers also translate the older `stackable`+`weightEach`
pair in old saves).

A row's `variants` column (`+1 (uncommon, 500gp); +2 (rare); +3`) is
materialized into full item templates once at load (`materializeVariants()`),
appended to `DEFAULT_ITEMS` so each is placeable/sellable like any other item.
**A variant is never a top-level Browse entry** — `renderItemList()` filters
out anything with `variantOf`; on a card with variants, the whole card's click
just expands the fold (`expandedVariantIds`, session-only) rather than placing
or opening details.

### Side panels

Both side panels resize by their inner-border handle (`panels.js`) and fold
below `PANEL_COLLAPSE_AT` into a round reopen button. Widths/collapsed state
are this browser's furniture (`dnd_inventory_panels`), never in the save file.

### Campaigns

A **campaign** is a persistent party — name, GM, roster of who plays and which
character they bring (`campaigns.js`; live session in `party.js`).

> A roster entry is keyed by the player's **account uid**, not a per-join
> session id — the whole duplicate-player fix. A rejoin lands on the same
> node, and the roster can be read as membership rather than session history.

- **The GM is the exception** — one node (`parties/<code>/gm`), uid also in
  `meta.gmUid` so the campaign remembers who runs it.
- Two halves, neither a copy: Firebase (`parties/<code>/…`) is shared and
  authoritative; `state.campaigns[code]` in the save file is this account's
  *bookmark*, read only before Firebase answers — `enterCampaign()` always
  asks the party who the GM is, never the local `role`.
- **Leaving the session ≠ leaving the campaign.** Closing the tab keeps the
  roster entry; `leaveCampaign()` gives up the seat and, for a **GM, deletes
  the campaign outright**.

### The sidebar's tabs

```
inventory view    Browse · Details · Party
sheet / map view  Chat · Party
spells view       Spells · Party   (Spells takes Chat's place)
```

`SIDEBAR_TAB_VIEW` values are a view name, an array of them (none today), or
`null` (Party, every view) — `sidebarTabView()` callers must handle all three.
Dice are not a tab: see *Chat and Dice*. `sidebarView()` ≠ `state.view` — a GM who
deselects a player keeps `state.view === 'sheet'` while the panel shows a
placeholder, so reading the raw field would strand them with no Browse tab.
The battle map still answers `'sheet'` (no fourth row for it), but the spell
sheet gets its own row precisely because it now has its own side panel — see
*Spells*.

### Chat and Dice

`parties/<code>/chat/<pushId> { uid, name, text, at }` — one log per campaign
(`chat.js`), a **push id** (server-ordered, no coordination needed), only the
last 200 subscribed, nothing in the save file. `textContent`, never
`innerHTML` — chat is the one pane where another player's typing lands in
your browser continuously, and markdown.js is deliberately not involved.

**Enter opens the chat modal** (`#chat-modal`; ✕, Escape or the backdrop
close it). It has no log of its own — `openChatModal()` *moves* the tab's
`#chat-empty`/`#chat-body` into it and `closeChatModal()` moves them back, so
there is one log and one set of listeners. That is why it opts out of the
shared backdrop close: hiding it any other way strands the log in the modal.

**There is no `parties/<code>/rolls` — a roll is a chat message**
(`kind: 'roll', roll: {...}`, `dice.js`), riding the log's existing ordering,
subscription and cap. Rolling therefore works with **no campaign at all**;
`canChat()` just silently drops the table/bubble audiences.

- **The dice dock** (`#dice-dock`, top right of the middle panel, every view
  but the map) builds a *handful*: each face click adds one die, right-click
  takes one back, and Roll throws it plus the optional modifier. A handful can
  mix sizes, so a roll carries `pool: [{faces, count}]` (largest first; `dice`
  and `dropped` flat in that order) — read it through `rollGroups()`, never
  `faces`/`count` directly. `faces`/`count` still hold the first group, and
  `pool` is only put in the chat payload when mixed, so an older client reads
  a sheet roll unchanged.
- `parts` (which ability/score/proficiency built the modifier) is kept out of
  the payload — it only powers the hover card on your *own* corner chip.
- **Advantage rolls the whole pool twice and keeps the better total**; the
  loser is kept, greyed, as `dropped`. A crit is a natural 20/1 on a single
  d20 only, read off the *kept* die.
- **Every new line pops a bubble under its speaker's tab** (`noteBubbleFeed()`
  in dice.js), held 3–8 s by length and cut short past
  `TAB_BUBBLE_MAX_CHARS`. The first snapshot is backlog, never bubbled; your
  own *roll* is skipped — it's posted as the tumble starts, so a bubble would
  give the number away before the flier lands.
- Not gated by `isReadOnly()` — rolling writes nothing, and a GM rolling a
  player's Perception is correctly attributed to the GM's account.

### Presence, party membership, and shops

Presence (`party.js`): green dot iff the app is open on this campaign right
now. Two separate facts — `connected` (last claimed) and `lastSeen` (when); a
claim with no heartbeat lapses on its own. **`onDisconnect` is re-armed from
`.info/connected` on every reconnect**, not just once at join — RTDB consumes
the handler when it fires and never re-arms it itself.

Party membership: the roster is shortened only by the GM's **Kick**, which is
just removing the entry — no "you were kicked" flag; the player's client sees
itself gone from the snapshot and leaves. This is **pacing, not security** — a
kicked client reading the database directly could still write to the party.

Shops: read-through cache, nothing in the save file. **Stock is claimed by an
RTDB `transaction()` before any coin leaves the buyer's purse** (two players
racing the last item: one wins, the loser isn't charged). Reveal is pacing,
not security (`shopVisibleToMe()` filters client-side). A stock entry
snapshots the item as **JSON in a string field** since RTDB drops the
nulls/empty-objects a real template is full of.

### Battle maps and initiative

No map without a campaign (`battlemap.js`/`battlemap-library.js`/
`battlemap-view.js`); `state.battlemap` is a read-through cache, nothing in
the save file.

- **Every coordinate is in the picture's own pixels**, never screen pixels or
  cells — the camera is per-browser furniture and the grid can move under the
  tokens, so image pixels are the one frame every client already agrees on.
- **The fog is a polygon per party member**, not a lit-cell grid — cast as a
  ray fan, rendered once to an offscreen canvas, sampled under each creature.
  **A map with nobody on it has no fog at all** (the GM would otherwise see an
  all-black board), and fog only settles when a drag ends, never mid-drag.
- **Elevation tapers vision, never blocks it outright** — looking down is
  free at any distance; looking up is cut off past a distance-scaled tile
  count, so standing back always sees *some* distance onto higher ground.
- The GM alone edits terrain/grid/fog; a creature is removable by whoever
  added it, or the GM (`ownerUid`).

Initiative lives with the map it's fought on, thrown away with the map
(`battlemap-initiative.js`). **The turn is an entry id, never an index** (a
late roller drops into the middle; the GM can remove a group), ordered by
score → roll moment → id. A player joins by rolling Initiative — the same roll
dice.js already handles — gated to **your own first roll only**.

### The left panel and its tabs

Equipment rack plus a GM's own tools (`syncLeftPanel()` in `shop.js`); tabs
only appear with two-plus panes. **A GM with nobody picked has no character**,
so Shop is the whole panel rather than an empty rack. Maps is GM-only; a
player reaches their one revealed map via the corner button.

### Characters and the home screen

The save holds a roster (`state.characters`); one slot is live at a time.
`commitActiveCharacter()` (working copy → slot) and
`loadActiveCharacterIntoLive()` (slot → working copy) are the only two
bridges, and the former **refuses when the working copy isn't your own
character** (another member's sheet, or a GM viewing none). The roster is
never empty — deleting the last hands back a new one. A **GM's character
cards aren't selectable** on the home screen; their way back is the campaign
card.

**A boot opens the home screen** unless the URL names one of this roster's
characters (see *URLs*). Because the roster is never empty, "no
characters" means *only untouched placeholders* (`isUntouchedSlot()` — judged
by content, since `commitActiveCharacter()` rebuilds a slot and would drop a
flag). A placeholder is **never drawn as a card** — otherwise deleting the last
character would appear not to work — and any new character replaces it. With
only placeholders and no campaign bookmarks, the page shows a welcome in place
of the roster.

### URLs

Still one page — `router.js` writes the address bar *from* state, never the
other way round: `home`, `character#<charId>` (solo), `campaign#<code>`
(seated, GM or player — a GM has no character to name). Each is **one path
segment, written relative**, so every relative asset path still resolves from
the root and a sub-folder deploy keeps working — never add a second segment
(`/character/<id>`) without first making every asset path absolute. The host
must answer those paths with `index.html` (`_redirects` on Pages,
`tools/serve.py` locally).

- A screen change pushes a history entry (Back returns to the roster); a
  Back/Forward, the boot, and a cloud save swapping the active character only
  *replace* it (`applyingRoute` suppresses the pushes inside a popstate).
- **An id not in this roster gets the not-found page** (`state.screen ===
  'missing'`), and the bad URL stays in the bar like a 404. The roster is
  local, so "not here" may just mean "not pulled yet" — `applyCloudSave()`
  retries the route, and the page offers Sign in while signed out. Anything
  else unhonourable (a campaign this tab isn't seated at, a character while
  seated) falls back to home and the URL is corrected. **A URL never joins a campaign**: that's `enterCampaign()`,
  async and signed in; a reload of `campaign#…` lands on home to rejoin.
- Other members' sheets and the Inventory/Sheet/Spells view aren't in the URL.

### Multiclassing and Character Setup

Classes are **`classLevels`**: `[{ name, level, subclass }]`, one entry per
class (Warlock 5/Bard 2 is two entries, level 7 total). Three mirrors —
`classes`, `level` (sum, capped 20), `subclass` (first set) — are written only
by `normalizeCharacterMeta()`. Proficiency bonus is worked out off the
**total**, never per class. The Character Setup modal owns everything about
*what a character is*; the sheet itself only derives, or takes numbers that
change at the table (HP, XP).

### The character sheet and its layout

`character-sheet.js` reads/writes `state.character`, owns no data.
**Derive, don't box**: anything the rules settle unambiguously (modifiers,
prof bonus, passive Perception) is rendered text; what they can't (AC, HP) is
an input. Scores run **0–30**, zero included. Read-only when `isReadOnly()`.

Each section is a **widget**; where they sit is a tree of row/col splits
(`sheet-layout.js`) the reader drags to rearrange — `size` lives on the node
so it travels with a moved section. **The identity block is pinned outside
the tree entirely** (`index.html`, outside `#sheet-layout`) — whose sheet this
is cannot be dragged away. Layout is this browser's furniture, never synced —
a read-only sheet is still freely rearrangeable.

### Class features, species traits, and spells

Class features and species traits share one registry shape/card/toggle
(`class-features.js` reads `classes`+`level`; `species-traits.js` reads
`race`+`level`). Data lives in `data/classes.json`/`data/species.json` —
content, not code. **Matched by name, not id**; every class is read at its
**own** level (a Warlock 5/Bard 2 sees each list to its own level). Subclasses
nest under a class, folded in by matching the character's free-text
`subclass`. `description` is Markdown, run through the same sanitizer as the
written sections.

Spells (`spells.js`) are a character's **third view**, not a sheet section,
because "what can I cast now" differs from "what am I". Same two-registry
shape (`data/spell-slots.json`, `data/spells.json`); the **Spell Slots**
total follows the rules' own Multiclass Spellcaster table
(`multiclassCasterLevel()`): full-caster levels count in full, half-caster
levels (Paladin, Ranger, Artificer) and Eldritch Knight/Arcane Trickster
levels count floored by 2 and 3 respectively — **each class's contribution
floored before summing**, not the total floored once — and the blended level
is looked up in `multiclassSlotsByLevel`, a table read off RAW `classLevels`
(name+level+subclass), not the class-registry-filtered list the Known/
Available sections use, since Eldritch Knight/Arcane Trickster contribute
slots despite this app having no spell-list data under "Fighter"/"Rogue".
**Warlock's Pact Magic is never blended into that total** — it is its own
pool, read off the Warlock entry alone (`pactMagicSlots()`) and drawn as a
separate line in `#spell-slots` only when another pool is also shown.
Per-character on/off via `character.spellsEnabled`
(default on). **Availability ≠ "on the list"**: `character.knownSpells` (an id
array) is what the player actually picked, toggled from the **Available
Spells** panel (`#spellbook-list`, a whole-card click) — which lives in the
sidebar's Spells tab (see *The sidebar's tabs*), not beside the sheet.
A spell's `description` is Markdown too, same as class features/species
traits — `spellCard()` renders it through `renderMarkdownInto`, cached by raw
string the same way `class-features.js`'s `featureDescCache` is, since
`data/spells.json` never changes at runtime.

- **The panel's pool is wider than the character's own classes**
  (`spellbookAvailableSpells()`) — a spell tagged with one of the character's
  real classes is still level-gated by that class's own slots, but a spell
  tagged only with classes the character has no levels in is included
  unconditionally, because there's no level to gate it by. This is what lets a
  feat (Magic Initiate and the like) grant a spell the character's own classes
  never would; it also means `available` no longer shrinks to `[]` just
  because the checkboxes below hide everything — what's actually *displayed*
  is a separate, later question.
- **Every class is a checkbox option; only the character's own start checked**
  (`spellbookClassRows()` builds the full list — every class this app's spell
  data knows of — tagging each `own: true/false`). An owned class is an
  opt-OUT preference (`hiddenClasses`, shown unless hidden, same as schools);
  any other class is opt-IN (`shownExtraClasses`, hidden unless revealed) — so
  "all classes are options, but only yours are checked" needs no first-run
  logic: an empty prefs object already means exactly that.
- **Sort/group modes: Class, School, or All** (`spellbookSections()`), always
  sorted by level then name within whatever grouping results. A spell reachable
  via two checked classes is listed once per class group, but once only for
  School or All (one school, and All has no groups to repeat it into). All
  drops the group heading entirely — a single flat list.
- **Prefs are this browser's furniture** (`dnd_inventory_spellbook`, own key
  like `item-sort.js`), not per-character, never synced — a reading
  preference, not a fact about anyone's spell list. A settings change calls
  `renderSpellSheetContent()` directly, the same signature-bypass
  `toggleKnownSpell()` uses — neither changes classes/level, which is all
  `renderSpellSheet()`'s gate watches.
- **Hiding a class or school never touches `knownSpells`** — same "filtered,
  not deleted" rule as a reclass (above): `known` is always computed from the
  full, unfiltered `available` pool, so a spell you've already picked keeps
  showing in Spells Known even after you uncheck the class or school that
  grants it.

### Statuses

The sheet's Statuses section (`statuses.js`, `data/statuses.json`) shows two
kinds of chip. **Picked** ones are `character.statuses`, an id list saved and
synced like any sheet field. **Derived** ones (`derived:` in the data file —
Encumbered / Heavily Encumbered) are recomputed on every render from
`encumbranceLevel()` in render-stats.js, the same function the header readout
uses, and **never stored** — a saved copy would go stale the moment an item
moved. The chips only redraw when their signature changes, or a sync would
orphan an open hover card.

### Markdown and the written sections

Backstory/Appearance are plain `data-sheet` string fields, synced like any
other box (`sheet-prose.js` swaps editor/preview).

**`markdown.js` is the only place in the app that turns a string into markup**,
and its sanitizer is not optional:

> A character sheet is not private — party sync copies it to Firebase and
> every other member renders it in their own browser. Unsanitized, a
> `<script>` in a player's backstory would run on the GM's machine, in the
> GM's signed-in Firebase session.

Raw HTML is allowed on purpose (formatting), behavior is not —
`on*` attributes are dropped before the allowlist runs, and URLs are checked
after invisible characters are stripped (`java&#9;script:` is a real bypass).

### Character tabs

One tab per party member; clicking opens a menu of that character's views.
`state.party.viewingPlayerId` (who) and `state.view` (which view) are
independent and both session-only. **Tab** walks the shown character's own
view ring, **Shift+Tab** walks to the next character, **1–9** jump by
position, **C/I/S** jump straight to Sheet/Inventory/Spells — all suppressed
while typing, a modal is open, or `state.mode !== 'idle'`.

### Coins

Ordinary stackable items — the purse is a readout over `state.instances`.
**A default item's id is its CSV row number**, so it shifts if a row is
inserted above it — never hardcode one. Coins are found by identity
(`getCoinTemplates()`: the `currency`-tagged item whose cost is exactly one of
its own denomination).

### Interaction state machine

```
IDLE
  click sidebar card  → PLACING (ghost follows cursor, snaps to grid)
  pointerdown on item → DRAGGING (item removed from grid, ghost appears)

PLACING
  mousemove  → moveGhost + highlightCells
  R key      → increment rotation, rebuild ghost in place
  click grid → finalizePlacement (stays in PLACING for rapid multi-drop)
  right-click / Escape → cancelPlacing → IDLE

DRAGGING
  pointermove → moveGhost + highlightCells
  pointerup   → place at new position / equip slot, or restore → IDLE
  Escape      → restore original position/rotation → IDLE
```

`cursorToGridPos` returns `null` outside `#grid-scroll`, gating all snapping.
Edge auto-scroll (`drag-scroll.js`) applies only to held drags, never placing
mode (a free cursor near an edge would scroll forever).

### Persistence

`saveState`/`loadState` use `localStorage` key `dnd_inventory_v1`. Only custom
items are saved; defaults re-hydrate from `data/items.csv` on init. The
payload is **version 4**: `{ version, activeCharacterId, characters,
campaigns, homebrew }` — V1 (a single character at the top level, still what an older
browser or cloud save may hold) is folded into a one-character roster by
`normalizeSavePayload()`. The storage key never changed across versions.

### Homebrew

The home screen's third section (`homebrew.js`): a file tree of everything
custom. **Custom items are not copied into it** — they stay in each character
slot's `db` and are collected from every slot at render, deduplicated by
template id (`item:<templateId>` is the tree key). Every other kind lives in
`state.homebrew.entries`, written through `addHomebrewEntry()`. Folders and
placements are in the save file and synced (account content, unlike the
Browse folders); which folders are open is furniture
(`dnd_inventory_homebrew_open`). Deleting a folder moves its contents up a
level, never deletes homebrew.

The New Homebrew panel (`homebrew-editor.js`) builds every kind's form from a
field-spec list (`HB_FORMS`), and **saves each kind in the shape its data file
already uses** — class/subclass `features` as `data/classes.json` features
(the subclass pick is `unlocks: ['subclass']` on a feature), species `traits`
as `data/species.json` traits, a spell with `data/spells.json`'s keys, an item
as an item template — so feeding homebrew into `allClasses()`/`allSpecies()`/
the spell list is a read, not a translation. Its modal opts out of the shared backdrop close
(`data-backdrop-close="false"`) to ask before discarding a filled-in form.

**Enabling** (`homebrew-share.js`): `state.homebrew.enabled[key] = { characters,
campaigns }` on a folder or a file, and **a folder's targets reach everything
inside it** — a file is enabled for the union of its own and every ancestor's.
A character target is usable on that character alone; a campaign target by
everyone at that table. `usableHomebrew()` answers for whatever is on screen
(own character solo, own character seated, another member's sheet, a GM with
nobody picked), and `allClasses()`/`allSpecies()`/`allSpells()` merge it in —
**their signature gates include `homebrewUsableKey()`**, or a toggle wouldn't
redraw the sheet. Usable items go into `state.db` flagged `_homebrew`, and
`getCustomDb()` drops a flagged one **unless an instance still uses it** — a
disabled item you carry stays; one you don't leaves the Browse list.

Seated, each member publishes `parties/<code>/homebrew/<uid> { json }` (one
JSON string, like cloud save) holding their campaign-enabled entries and their
seated character's. Nodes count only while their uid is in the roster or is
`meta.gmUid`. Other members' campaign homebrew is cached on the bookmark
(`sharedHomebrew`) so a character keeps the party's homebrew class between
sessions. Pacing, not security, same as shops.

### Browse-list folders and sorting

Folders (`folders.js`, own `localStorage` key) describe the *catalogue*, not
the character — never saved or synced. `state.folderAssign` holds only
overrides; an unlisted item follows tag/id/name matching, or lands in the
virtual, never-stored **Unfiled**. Sorting (`item-sort.js`) is a **chain of
keys** (default rarity → name → weight); the toolbar's arrow negates the
whole chain.

### Theming and the accent colour

Two palettes as CSS custom properties in `tokens.css`. **Every colour is a
token** — never a literal in a rule. An inline script in `<head>` sets
`data-theme` and the custom accent before first paint (no flash of the wrong
look).

- **The user picks a hue and saturation, never a lightness** — each theme
  supplies its own lightness so a custom colour stays legible on either
  background. Both themes are resolved to a finished CSS-property map at
  *pick* time, so a theme switch is just reading strings.
- **Crit colours dodge the accent.** Dice paint nat 20/1 with `--crit`/
  `--fumble`, aliases of `--crit-main`/`--fumble-main`; when a custom primary
  lands too close to one (OKLab distance, or same hue family),
  `critColorSwaps()` points the alias at `--crit-alt`/`--fumble-alt` in that
  theme's resolved vars. Never override the `-main`/`-alt` tokens themselves —
  they're what the check reads.
- Rarity/coin colours are read from CSS by JS and cached — **any render path
  that inlines a palette colour must be re-run from `rerenderThemedContent()`**
  on a theme or accent change.

### Icons and versioning

Icons (`img/icon/*.png`) are drawn as CSS **masks over `currentColor`**, never
`<img>` — a mask takes the colour of whatever it sits in, working in both
themes for free. `VERSION` is a one-line file at the project root, fetched
**asynchronously** (unlike the blocking `items.csv`/`.env` loads `init()`
needs) — a missing file just leaves the footer blank.

### Accounts and cloud save

Usable fully signed out, on `localStorage` — an account only unlocks party
play and cloud save. Every gated entry point goes through `requireAuth()`;
**never gate the inventory itself**.

`cloud-save.js` stores the whole save as **one JSON string**, not a tree —
RTDB drops the nulls/empty objects the save file is full of, so a tree write
would silently fail to replicate a deletion. Conflicts are last-writer-wins,
except the first sign-in with real data on both sides
(`openCloudConflictModal`) — **never resolve that prompt on the user's
behalf**; it discards one of two real saves.

### Configuration

`firebase-config.js` reads `KEY=value` text from `.env` (local) or
`/firebase-env` (deploy — Cloudflare Pages won't serve a dot-prefixed path);
first hit wins, both always tried. A missing file doesn't reliably 404 (Pages
answers unknown paths with its index page), so a body starting with `<` is
rejected rather than trusted. **When neither source answers, `FIREBASE_CONFIG`
is `null` and the app must stay fully usable offline** — preserve that guard
when touching party code.
