# Process maps

A shared, Miro-style board for mapping how the back office actually works. The team signs in, opens a process, and maps it together: sticky notes, steps, decisions, swimlanes and arrows, with who does each step, in which system, how long it takes, and where it hurts.

Built as a self-contained module on Peggy's stack (Netlify functions, Netlify DB, plain HTML and JavaScript), so it can move into Peggy as its process-mapping page. See [Moving into Peggy](#moving-into-peggy).

## What it does

**Maps list**
- Every map with a thumbnail, status (Draft, In review, Agreed), area (Workforce, HSEQ, Finance…) and who last edited it.
- Search, filter by area and status, rename, duplicate, archive and restore.
- New map from a template: swimlanes, as-is and to-be, or blank. Import a map from a JSON export.

**The board**
- Infinite canvas. Pan with Space + drag, middle or right drag, or two fingers; zoom with Ctrl + wheel, pinch, or the zoom bar.
- Sticky notes, process steps, decisions, start and end, free text, and swimlanes.
- Connectors that re-route themselves as things move, with labels (Yes, No, Approved…), dashed or solid, one or two arrowheads, elbow or straight.
- The blue **+** on a selected step: click to add the next step already connected, drag onto another step to connect, drag onto empty board to put the next step there.
- Smart alignment guides while dragging. Lanes carry whatever sits inside them.
- Double-click to edit text, or on empty board to drop a sticky note.
- Multi-select by dragging an area, Shift-click, copy and paste (across maps and browser tabs), Alt-drag to copy, duplicate, undo and redo, keyboard shortcuts (press `?` on a board).

**Details on every step** (the Details panel, or press `I`)
- Who does it, which system, how long it takes, notes, and a flag: pain point, improvement idea, automated, manual, or open question.
- With nothing selected, the panel shows the map's description and a summary: steps, notes, pain points, ideas, who is involved and which systems are used.

**Working together**
- Everybody on a map sees each other's changes within about two seconds, who else is on the board, and what each person has selected (outlined in their colour with their name).
- Roles: **admin** (edits, manages the team), **editor** (edits), **viewer** (reads).

**Getting it out**
- Export a PNG of the whole map or the selection, drawn from the data rather than screenshotted, so it is sharp for Notion, an IC pack or an email.
- Export and import JSON as a backup or to move a map between sites.

## Run it locally

```sh
cd process-maps
npm install
npm run serve
```

Open http://localhost:8888/maps/ and sign in as `admin@example.com` / `local-admin-password`. With no `DATABASE_URL`, everything is held in memory and gone when the server stops. To use Postgres:

```sh
createdb process_maps
psql -d process_maps -f netlify/database/migrations/001_process-maps/migration.sql
DATABASE_URL=postgres://localhost/process_maps npm run serve
```

## Tests

```sh
npm run check            # typecheck + unit and API tests (in-memory store)
DATABASE_URL=postgres://localhost/process_maps_test npm test   # adds the Postgres store contract
npm run test:browser     # the real pages in Chromium: two people on one board, every tool, phone layout
```

CI runs all three on every pull request, the Postgres contract against the same migration Netlify DB applies.

## Deploy on its own (Netlify)

1. Create a Netlify site from this repository. `netlify.toml` at the repository root points the build at `process-maps/`.
2. Enable Netlify DB for the site. It provisions Postgres and applies `netlify/database/migrations/` on deploy.
3. Set environment variables: `SESSION_SECRET` (32+ random bytes), `ADMIN_BOOTSTRAP_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD`, `ADMIN_BOOTSTRAP_NAME`. See `.env.example`.
4. Open `/api/health`; it says plainly what is still missing.
5. Sign in, add the team on the **Team** page (each person gets a one-time password and picks their own on first sign-in), then remove `ADMIN_BOOTSTRAP_PASSWORD`.

## Moving into Peggy

The module is laid out the way Peggy is, so the move is mostly copying files. Everything is namespaced to avoid collisions: tables are `pm_*`, API routes are `/api/maps/*`, pages live under `/maps/`, CSS classes and tokens are `pm-*`.

| Copy into Peggy | Notes |
|---|---|
| `src/domain/items.ts`, `maps.ts`, `templates.ts` | Unchanged. |
| `src/store/` (the `maps` half) | Merge into Peggy's store, or keep as its own module. |
| `netlify/functions/maps.ts`, `map-sync.ts` | Unchanged. |
| `netlify/database/migrations/001_process-maps` | Renumber after Peggy's latest migration. Drop `pm_users` and `pm_throttle` and point the `created_by`, `updated_by` and `pm_presence.user_id` foreign keys at Peggy's users table. |
| `web/maps/` | Leave out `team.html` and `js/team.js`. |
| `tests/` | The store contract, API and browser tests come across as they are. |

Then change three things:

1. **Who is signed in.** `src/lib/auth.ts` is the only file that reads the session. Make `requireUser()` read Peggy's session and return `{ userId, name, role }`, mapping Peggy's roles onto admin, editor and viewer.
2. **The header.** `web/maps/js/shell.js` draws this module's header and sign-in. Replace `boot()` with Peggy's header; the pages only need it to hand back the signed-in user.
3. **Navigation.** Add a "Process maps" link to Peggy's nav pointing at `/maps/`.

Drop the standalone-only pieces: `netlify/functions/auth-*.ts`, `team.ts`, `src/domain/team.ts`, `src/domain/bootstrap.ts`, and `scripts/dev-server.mjs` if Peggy has its own.

## How collaboration works

Each item on a board (a sticky, a step, a connector) is its own row, so two people editing different things never collide. Every save takes a lock on the board, stamps the items it changed with the board's next revision number, and commits. Browsers ask "what changed since revision N?" in the same request that sends their own edits, so one round trip both saves and refreshes, and nothing can be missed or applied out of order. Deletes are kept as tombstones so a browser that was away still learns about them.

If two people change the same item at the same moment, the later save wins, which is what Miro does too. A browser never lets an incoming change overwrite something its user is still typing or dragging; its own version goes up next and wins.

Netlify functions cannot hold a live connection open, so browsers poll: every 1.5 seconds while someone else is on the board, every 6 seconds when alone, every 30 seconds in a background tab, and within 300 ms of any local edit. Offline edits wait in the browser and go with the next successful request. Polling is contained in `web/maps/board/sync.js`; moving to a push channel later would change that file and nothing else.

## Limits, on purpose

- Up to 4,000 items per map. Bigger than that is two processes.
- Changes from others arrive within about two seconds, not keystroke by keystroke, and other people's cursors are not shown (their selections are).
- No images or file attachments on the board yet; link to documents from a step's notes.
- No version history beyond undo. Deleted items are kept as tombstones in the database, so a deletion is recoverable by hand.

## Layout

```
process-maps/
  netlify/database/migrations/   schema (pm_* tables)
  netlify/functions/             API: maps, map-sync, auth-*, team, health
  src/domain/                    items and validation, maps and sync, templates, team
  src/store/                     Postgres and in-memory stores behind one interface
  src/lib/                       auth seam, HTTP helpers, passwords, sessions
  web/maps/                      list, board and team pages; board/ is the canvas
  tests/                         unit, API, store contract, browser
  scripts/dev-server.mjs         local server without the Netlify CLI
```
