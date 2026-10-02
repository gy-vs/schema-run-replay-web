# Schema Evolution Studio

Run `npm install`, then `npm run dev`.

## Historical replay comparisons

The middle pane's **historical replay** view (open it from any finished run's
**replay vs current graph** button, or from the empty trace pane) builds a
sourced comparison between a migration as it actually happened and the same
data run through the graph as it exists today:

- **Old side — fact.** The finished historical run is frozen onto the
  comparison record: its steps, bound function revisions, the original sample
  and every retained intermediate output (including the precise failure edge).
  It is never re-executed and never re-bound to newer function bodies.
- **New side — this execution.** The server pins the current graph revision
  when the comparison is created, re-enumerates and **re-ranks candidate paths
  by current costs** (the old run's cost is never presented as the current
  ranking), and executes one chosen path against the pinned state. Candidate
  metadata and results are frozen on the record, so later edge/function edits
  cannot quietly rewrite a completed comparison.

The divergence report aligns the two sides step by step and names the first
index where the route, revision, condition, cost **or intermediate document**
differs — equal final JSON does not imply an identical journey. Failed or
cancelled sides keep their partial outputs; when the current graph offers no
executable path the comparison still completes with the historical facts
intact.

Comparisons are stored server-side: `GET /api/replays` lists them and
`GET /api/replays/:id` recalls a finished one (the UI polls this id while the
fresh run is in flight). The page's claimed revision is sent as `baseRevision`;
when the graph had already advanced, the response carries
`staleViewAtCreate: true` and states the revision the comparison actually
bound.

`POST /api/replays` body:

```json
{ "historicalRunId": "run-…", "start": "v1", "goal": "v3", "pathKey": "optional", "baseRevision": 12 }
```

`start`/`goal` default to the historical run's endpoints; omit `pathKey` to
take the cheapest candidate whose preview projects cleanly, or name any
executable current candidate. `POST /api/replays/:id/cancel` cancels only the
fresh side. The ordinary endpoints (`/api/paths`, `/api/runs` and its cancel,
`/api/compare`) are unchanged.
