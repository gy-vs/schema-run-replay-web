# Schema Evolution Studio

Run `npm install`, then `npm run dev` (Express API on :4174, Vite UI on :4173).

- `npm test` — Vitest unit + API tests
- `npm run build` — typecheck and production build

## What it is

A workbench for directed **version-node migration graphs**: nodes carry
schemas, edges carry a cost / applicability condition / migration function,
and functions publish immutable revisions. You can:

- enumerate and **rank candidate paths** by real total cost (never hop count);
- **compare all paths on one fixed sample** (the multi-path experiment), with
  per-edge intermediate outputs, precise failure edges and cancellation;
- **replay a historical run against the current graph** (below).

Runs freeze their bindings at creation: each step pins the exact function
revision body, condition text, cost and node schema, so a publish that lands a
millisecond later can never change what an existing run executes.

## Sourced replay comparison

The **Historical replay** tab takes one *finished* stored run and compares it
to a fresh execution on the graph as it stands now. The two sides are kept
strictly separate:

- **Historical side — fact, never re-executed.** Bound function revisions, the
  original sample, every retained intermediate output, the failure/cancel
  position and the historical graph revision number are copied from the run
  record. Old function bodies are never swapped for new revisions and called a
  "replay".
- **Current side — fresh, pinned at bind time.** One graph snapshot drives both
  the candidate query (its ranking is frozen onto the comparison) and the new
  run, which binds to that snapshot's revisions, costs, conditions and node
  schemas. Historical costs never enter the new-side ordering. Editing the
  graph after the replay starts cannot silently rewrite either side.
- `drift` says which graph revision the new side is bound to, whether the graph
  had already moved relative to the page (`expectedRevision`) or during
  preparation.
- The **diff pairs steps by position** and tags each divergence independently
  (`path`, `revision`, `condition`, `cost`, `status`, `output`, `missing`),
  names the **first step where the journeys differ**, and reports whether the
  terminal JSON is equal as a *separate* question — equal finals with different
  intermediates are still shown.
- A **failed/cancelled historical run** is replayed as-is: retained
  intermediates and the precise failing edge survive even without a final
  document. If the current graph offers no applicable path the new side is
  `blocked` with its frozen ranking, rather than dropping the comparison.
- Comparisons are **persisted server-side** and reopenable
  (`GET /api/replays/:id`); on the client a monotonic request token guarantees
  a slow response from a previous selection never overwrites the newly chosen
  run/comparison.

This is a traceable comparison between a migration that already happened and
the current graph — not a fresh all-paths single-sample experiment.

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/runs` | list stored runs (newest first) for the replay picker |
| POST | `/api/replays` | create a comparison `{runId, start, goal, reversibleOnly?, expectedRevision?}` |
| GET | `/api/replays/:id` | fetch / poll a comparison (refreshes the current-side run, freezes on completion) |
| GET | `/api/replays` | list stored comparison summaries |

The single-path query (`/api/paths`), run cancellation (`/api/runs/:id/cancel`)
and the normal multi-path compare (`/api/compare`) are unchanged.
