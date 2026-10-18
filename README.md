# Bag of Holding

A browser-based inventory manager for tabletop RPGs (D&D 5e and similar
systems). Items have physical shapes that occupy cells in a grid, inspired by
games like Resident Evil and Escape from Tarkov — a greatsword takes up real
space, and so does the loot you were greedy about.

## Features

- **Grid-based inventory** — items occupy 2D shapes on a tetris-style grid
- **Encumbrance that follows from it** — carried/capacity readout with STR-based carry zones
- **Drag and drop** — within the grid, into containers, or onto equipment slots
- **Character sheet** — abilities, skills, combat stats and class features, with
  drag-to-rearrange sections
- **Item editor** — custom items with shapes, images, damage, rarity and tags
- **Equipment panel** — fully configurable slots, sections and layout
- **Shops** — the GM stocks them, reveals them, and the party draws from one
  shared pile of stock
- **Battle maps** — the GM imports them, lines a grid up on them and reveals
  them; anyone drops creatures on the board, and fog of war hides whatever the
  party cannot see in a straight line
- **Party play** — share a session code so a GM can see and edit the party's
  sheets
- **Light and dark themes**, plus a custom accent colour
- **Auto-save** to the browser, and optional cloud save to an account

## Running

No build step, no dependencies. Serve the project root over HTTP:

```bash
python3 tools/serve.py 8787
```

Then open [http://localhost:8787/home](http://localhost:8787/home).
(`tools/serve.py` is `python3 -m http.server` that also answers the app's own
pages — `/home`, `/character#…` — so a reload of one doesn't 404.)

> Opening `index.html` as a `file://` URL mostly works, but party play will not:
> the browser refuses to let a `file://` page read `.env`.

## Party play and accounts

Everything above works signed out, offline, saved to your browser. An account
adds two things: **party play**, and **cloud save**, which mirrors your
characters to the account so they follow you between machines. Both need a
Firebase project.

1. Create a project at the [Firebase Console](https://console.firebase.google.com/),
   and enable the **Realtime Database**.
2. Under **Authentication → Sign-in method**, enable **Email/Password** and
   **Google**.
3. Under **Authentication → Settings → Authorized domains**, add the domain you
   host on. `localhost` is there already, and Google sign-in refuses to run
   anywhere else.
4. Set your **Realtime Database rules** so each account has sole access to its
   own `users/<uid>` save, and the party tree is closed to signed-in users. This
   is what stops strangers reading your data.
5. Copy `.env.example` to `.env` and fill in your project's values:

```bash
cp .env.example .env
```

```ini
FIREBASE_API_KEY=AIza...
FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
FIREBASE_DATABASE_URL=https://your-project-default-rtdb.firebaseio.com
FIREBASE_PROJECT_ID=your-project
FIREBASE_STORAGE_BUCKET=your-project.firebasestorage.app
FIREBASE_MESSAGING_SENDER_ID=000000000000
FIREBASE_APP_ID=1:000000000000:web:abc123
```

Without `.env` the app runs fully offline and the party features are simply
unavailable — you get one informational line in the console, and nothing else
changes.

> **`.env` is not a secret store.** It is fetched by the browser, so anyone who
> can reach the site can read it at `/.env`. That is fine for Firebase web
> config — those values are public by design, and access is enforced by your
> [database security rules](https://firebase.google.com/docs/database/security),
> not by hiding the keys. Never put real secrets in it.

## Deploying

The site is static, so any host serves it as-is. Party play needs the Firebase
settings to reach the deployed site, and `.env` cannot carry them: it is
gitignored, so it never reaches the host.

On **Cloudflare Pages**, add the seven `FIREBASE_*` keys from `.env.example`
under Settings → Variables and Secrets, then redeploy. No build command —
`functions/firebase-env.js` is turned into a Worker automatically, and serves the
keys to the page at request time. With no variables set the route 404s and the
site still works, with party play off. `_redirects` tells Pages to answer the
app's pages (`/home`, `/character`, `/campaign`) with `index.html`; any other
host needs the same rewrite, or a reload of one of those pages 404s.

> **On GitHub Pages**, Jekyll skips files beginning with `.`, which makes
> `/.env` a 404 and silently disables party play. Add an empty `.nojekyll` file
> at the repo root to turn that off.

## Using it

| Key | Action |
|-----|--------|
| `R` | Rotate the held item 90° clockwise |
| `Escape` | Cancel placement or drag |
| `Tab` | Switch between a character's inventory and sheet |
| `Shift`+`Tab` | Move to the next character tab |
| `1`–`9` | Jump to a character tab by position |
| Right-click | Open the context menu on a placed item |

**⚙ Configure Slots**, at the bottom of the equipment panel, opens the layout
editor: **+ Header** adds a section label, **+ Slot** adds a slot, **⠿** drags to
reorder, **👁** shows or hides a slot, **⇔** puts a slot side-by-side with its
neighbours, **✦** restricts it to items requiring attunement, and **↺** resets to
the standard 5e layout.

Themes and the accent colour live under **⚙ Settings → Appearance**. To change
the default item list, edit `data/items.csv` — see
[ARCHITECTURE.md](ARCHITECTURE.md#data-files) for the columns.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — how the code is arranged, and the data formats
- [CONTRIBUTING.md](CONTRIBUTING.md) — conventions, commits, pull requests
- [CLAUDE.md](CLAUDE.md) — the detailed rationale behind each subsystem

## License

[Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International](LICENSE)
(CC BY-NC-SA 4.0). In short: you may share and adapt this, with credit, for
non-commercial purposes, as long as you license what you build on it the same
way. The [license deed](https://creativecommons.org/licenses/by-nc-sa/4.0/) is
the readable summary; [LICENSE](LICENSE) is the terms that actually bind.

This covers the project's own code and content. Bundled third-party assets keep
their own terms — the icons are from [Flaticon](https://www.flaticon.com/) and
are attributed in [`icons.html`](icons.html).

D&D is a trademark of Wizards of the Coast. This is an unofficial fan project,
not affiliated with or endorsed by them.
