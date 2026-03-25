# Family Tree Webapp MVP

A TypeScript/React family tree app with:

- interactive family tree visualization with pan + zoom via React Flow
- manual add/edit for people
- manual relationship creation for parent/child and spouse links
- heuristic duplicate detection with explicit merge review
- GEDCOM import/export for core tree portability
- multi-provider search/import workflow for online records using a pluggable provider layer
- **shared server-backed persistence** using a local JSON file instead of browser-only storage
- graceful load/save error handling in the UI

## Tech choices

- **Frontend:** React + TypeScript + Vite
- **Graph / pan / zoom:** `@xyflow/react` (React Flow)
- **Persistence:** local Node server + file-backed JSON store at `server/data/tree.json`
- **Server:** small built-in Node HTTP server that serves the API and the app from the same origin
- **State:** React state with a simple in-app data model

## Shared seed data

The server-side tree is seeded with this branch:

- Jens Sorenson
- Olaf Sorenson
- Joanne Sorenson
- Dale Sorenson
- Elizabeth Sorenson
- Jacqueline Langham
- Edgar Langham

Relationships included in the seed:

- Olaf + Joanne are spouses and parents of Jens
- Dale + Elizabeth are spouses and parents of Olaf
- Edgar + Jacqueline are spouses and parents of Joanne

The shared data lives in `server/data/tree.json`, so every browser using the same running app sees the same tree.

## Run locally

```bash
cd family-tree-webapp
npm install
npm run dev
```

Then open `http://localhost:5173`.

That single command starts:

- the React app
- the local `/api/tree` backend
- the shared JSON-backed store

If you expose that local server through Cloudflare Tunnel, any browser hitting the tunneled URL will see the same shared tree data.

## Build and run the production bundle

```bash
npm run build
npm run serve
```

`npm run serve` serves `dist/` plus the same `/api/tree` backend, still backed by `server/data/tree.json`.

## Build and lint

```bash
npm run lint
npm run build
```

## What changed

### Shared persistence

- Replaced browser `localStorage` persistence with a local server-backed JSON API.
- The frontend now loads from `GET /api/tree` and saves to `PUT /api/tree`.
- The shared tree file is created automatically if it does not already exist.
- Save status is shown in the UI.
- Load/save failures now surface as readable inline messages instead of failing silently.

### Existing features preserved

- Interactive tree rendering and navigation
- Manual editing of people
- Manual creation of relationships
- Duplicate detection and reviewed merge workflow
- GEDCOM import/export for core family structures
- Live public search via Wikidata and Wikipedia
- Provider abstraction so more live sources can be added later

## How to demo it

1. Start the app with `npm run dev`.
2. Open the app — it loads the shared seeded tree from the server.
3. Open the same app URL in another browser or computer hitting the same server/tunnel.
4. Edit a person or add a relationship in one browser.
5. The changes save to `server/data/tree.json` and are available to every browser using that same server.
6. Import/export GEDCOM as needed.
7. Use **Reload from server** if you want to manually refresh another browser session after changes elsewhere.

## Limitations

- This is an MVP single-file datastore, not a multi-user conflict-resolution system.
- Concurrent edits from multiple browsers are last-write-wins.
- There is no authentication yet; anyone who can reach the app can edit the tree.
- Search ranking and family matching are heuristic, not identity-proof.
- GEDCOM support is intentionally MVP-grade and focuses on common person/family structures, not every GEDCOM tag.
- Imported GEDCOM notes and places are flattened into simple text fields in the app model.
- Layout now uses a deterministic-ish D3-force simulation rather than a hand-rolled iterative solver.
- The simulation combines `forceManyBody`, `forceCollide`, generation-targeted `forceY`, gentle anchor `forceX`, plus custom genealogy forces for spouse pairing, child-centering under parent households, previous-position stability, and stronger same-row household separation.
- The solver is seeded from prior node positions and a deterministic random source, so edits stay much more stable instead of wildly reshuffling the whole tree.
- This is still not a full genealogy-grade pedigree engine for every edge case (complex remarriage loops, dense cousin loops, and highly interwoven remarriage graphs still require compromise).
- Dragging nodes is intentionally disabled; layout is generated from relationships for consistency.

## Files of interest

- `src/App.tsx` – main UI and interactions
- `src/tree-utils.ts` – duplicate detection + merge logic
- `src/gedcom.ts` – GEDCOM import/export parser/serializer
- `src/data.ts` – empty fallback tree state
- `src/providers.ts` – provider adapters, ranking, normalization, and live public source parsing
- `server/server.mjs` – local app + API server
- `server/tree-store.mjs` – file-backed JSON persistence and seeded server data
- `server/data/tree.json` – shared tree data file
