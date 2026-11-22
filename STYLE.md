# Style rules for both humans and agents
All agents and humans should follow the rules listed here so that code stays easy to read and
understand.

These rules apply to **code you write or change**. Existing code that predates them does not need
to be rewritten in bulk, but when you substantially edit a function, bring that function up to
these rules.

## Comments (applicable everywhere)
- Comments should be short and descriptive. Use one line where possible, a few lines at most.
- Comments describe the code **as it is now**. Never explain the history of a feature ("this used
  to…", "was changed because…", "the old version…").
- Comment only in these situations:
  1. **Function doc comment**: the short summary above a non-helper function (see below).
  2. **Why, not what**: the reason behind code that would otherwise look wrong, redundant, or
     arbitrary (a workaround, an ordering requirement, a guard against a real edge case).
  3. **Invariants**: a rule that would cause a silent bug if someone broke it (for example, "the
     grid is authoritative; these divs are only visual").
  4. **Block labels**: a single line at the top of a logical block inside a longer function.
  5. **Section banners**: the file header and the `// ─── SECTION ───` dividers that group
     related functions.
  6. **Units and meaning of constants**: for example `const CELL = 44; // px per grid square`.
- Do not write comments that restate the code (`i++; // increment i`), name the author, or leave
  commented-out code behind. Delete dead code instead; git keeps it.

## JavaScript style

### Naming
- Functions and variables use **camelCase** (`renderAllItems`, `getItemUnitWeight`), matching the rest
  of the codebase. Do not use snake_case for functions or variables.
- Constants use **UPPER_SNAKE_CASE** (`GRID_COLS`, `RARITY_ORDER`). This covers fixed values and
  registries that are filled once at load and treated as read-only afterwards
  (`DEFAULT_SPELLS`). Ordinary mutable module state uses camelCase (`let accentPrefs`).
- A function's name alone should tell a reader roughly what it does, without opening it:
  - Start with a verb for the action (`createNPlayers()`, `fetchServerState()`, `renderAllItems()`).
    A function that only looks up or works out a value starts with `get` (`getItemUnitWeight()`).
  - Name the thing it acts on. `getItemUnitWeight()` beats `unitWeight()`, because the second
    leaves the reader guessing which weight and of what.
  - A function that returns a boolean reads as a yes/no question (`isStackable()`, `hasCost()`,
    `canChat()`).
  - A longer name is fine when it is clearer. Clarity matters more than being short.
- Variables get descriptive names, so a reader knows what one holds without a comment. Boolean
  variables read as a yes/no question (`isOpen`, `hasRolled`).

### Helper functions
- A **helper** is a function called only from inside its own file. Prefix helpers with an
  underscore and keep them camelCase: `_getValue()`, not `_get_value()`.
- Because every file shares one global scope (classic scripts, not modules), the underscore is
  the only thing marking a function as file-private. **Never call an `_`-prefixed function from
  another file.** If another file needs it, drop the underscore and give it a doc comment.

### Function length and structure
- A function body should be at most **120 lines**. When a function grows past that, split parts
  of it into helper functions.
- Inside a longer function, separate logical blocks with a blank line and a single-line comment
  at the top of each block describing what it does.
- Prefer early returns over deeply nested `if` blocks.

### Doc comments
- Every non-helper function gets a short `//` comment directly above it (one or two lines) saying
  what it does, and, where it is not obvious, what it returns or when to call it. Do not use
  JSDoc `/** */` blocks; match the existing `//` style.
- Helpers may skip the doc comment if their name makes their purpose obvious.

### Constants and file layout
- Each file starts with the banner comment naming the file and its purpose, then `'use strict';`.
- Constants go at the top of the file, after the banner, before any functions.
- Constants used by more than one file belong in `src/js/constants.js`.

## CSS style
- Every colour is a custom property from `tokens.css`. Never write a colour literal in a rule.
- Each file starts with a banner comment naming the file and what it styles, and groups rules
  under `/* ─── SECTION ─── */` dividers, the same as the JavaScript files.
- Class names use kebab-case (`.spell-slots-sheet`).

## CLAUDE.md and ARCHITECTURE.md
- CLAUDE.md should be kept under 200 lines. Before adding something that would push it over the
  limit, remove or shorten something else first. It holds only the non-obvious facts that would
  cause a silent bug if violated, not a restatement of the code.
- ARCHITECTURE.md lists each functional part of the project and how the parts connect. It also
  explains why ambiguous design decisions were made.
- Update these files only when a meaningful change has taken place: a new subsystem, a new data
  shape or save field, a changed invariant, or a design decision someone would otherwise undo.
  Bug fixes and small tweaks don't need an entry.
- Again, do not describe the history of the project.