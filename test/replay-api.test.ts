import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {StudioStore} from '../src/server/store';
import type {ReplayComparison, Run} from '../src/common/types';

async function waitForRun(app: ReturnType<typeof createApp>, id: string, timeoutMs = 3000): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app).get(`/api/runs/${id}`).expect(200);
    const run = res.body as Run;
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run ${id} stuck in ${run.status}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function waitForReplay(
  app: ReturnType<typeof createApp>,
  id: string,
  timeoutMs = 4000,
): Promise<ReplayComparison> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app).get(`/api/replays/${id}`).expect(200);
    const replay = res.body.replay as ReplayComparison;
    if (replay.status === 'completed' || replay.status === 'blocked') return replay;
    if (Date.now() > deadline) throw new Error(`replay ${id} stuck in ${replay.status}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function createRun(
  app: ReturnType<typeof createApp>,
  steps: Run['steps'],
  sample: Record<string, unknown>,
): Promise<Run> {
  const res = await request(app).post('/api/runs').send({steps, sample}).expect(201);
  return waitForRun(app, res.body.id);
}

/** Delete an edge with optimistic revision tracking. */
async function deleteEdge(app: ReturnType<typeof createApp>, edgeId: string, rev: number): Promise<number> {
  const res = await request(app).delete(`/api/edges/${edgeId}?baseRevision=${rev}`).expect(200);
  return res.body.revision as number;
}

async function publish(
  app: ReturnType<typeof createApp>,
  funcId: string,
  source: string,
  rev: number,
  condition?: string,
): Promise<number> {
  const res = await request(app)
    .put(`/api/funcs/${funcId}/revisions`)
    .send({source, note: `r@${rev}`, baseRevision: rev, ...(condition ? {condition} : {})})
    .expect(200);
  return res.body.revision as number;
}

const E1 = {edgeId: 'e1', from: 'v1', to: 'v2', funcId: 'add-age', funcRevision: 1, cost: 3, reversible: true};
const E2 = {edgeId: 'e2', from: 'v2', to: 'v3', funcId: 'add-tier', funcRevision: 1, cost: 2, reversible: true};
const E10 = {edgeId: 'e10', from: 'v2', to: 'v3', funcId: 'broken-tier', funcRevision: 1, cost: 1, reversible: false};
const SAMPLE = {name: 'Ada'};

describe('sourced replay comparison API', () => {
  it('replays a historical run on the same graph: identical, persisted, retrievable, listed', async () => {
    const app = createApp();
    const source = await createRun(app, [E1, E2], SAMPLE);

    const created = await request(app)
      .post('/api/replays')
      .send({runId: source.id, start: 'v1', goal: 'v3', expectedRevision: 1})
      .expect(201);
    const createdBody = created.body.replay as ReplayComparison;
    expect(createdBody.historical.sourceRunId).toBe(source.id);
    // The historical side is the copied fact: same run id, revisions, cost.
    expect(createdBody.historical.graphRevision).toBe(1);
    expect(createdBody.historical.status).toBe('succeeded');
    expect(createdBody.historical.results[0].output).toEqual({name: 'Ada', age: 0});
    expect(createdBody.drift.changedFromView).toBe(false);

    const replay = await waitForReplay(app, createdBody.id);
    expect(replay.status).toBe('completed');
    expect(replay.current.selectedKey).toBe('e4>e2'); // cheapest valid path on the current graph
    expect(replay.current.graphRevision).toBe(1);
    expect(replay.diff).toBeTruthy();

    // Persisted server-side: GET returns the same id/content again.
    const again = await request(app).get(`/api/replays/${replay.id}`).expect(200);
    expect(again.body.replay.id).toBe(replay.id);
    expect(again.body.replay.diff.firstDifferenceIndex).toBe(replay.diff!.firstDifferenceIndex);

    const list = await request(app).get('/api/replays').expect(200);
    expect(list.body.replays.map((r: {id: string}) => r.id)).toContain(replay.id);

    const runs = await request(app).get('/api/runs').expect(200);
    expect(runs.body.runs.some((r: Run) => r.id === source.id)).toBe(true);
  });

  it('keeps the HISTORICAL side on old revisions while the new side binds new revisions; first divergence is precise', async () => {
    const app = createApp();
    const source = await createRun(app, [E1, E2], SAMPLE);

    // Restructure the current graph so e1>e2 is the only v1->v3 route, then
    // publish r2 of both functions: intermediate gains an audit field which
    // the (also new) add-tier strips away — FINAL JSON STAYS EQUAL.
    let rev = 1;
    rev = await deleteEdge(app, 'e4', rev);
    rev = await deleteEdge(app, 'e3', rev);
    rev = await deleteEdge(app, 'e10', rev);
    rev = await publish(app, 'add-age', '(doc) => ({...doc, age: typeof doc.age === "number" ? doc.age : 0, audit: true})', rev);
    rev = await publish(app, 'add-tier', '(doc) => { const {audit, ...rest} = doc; return {...rest, tier: typeof rest.tier === "string" ? rest.tier : "standard"}; }', rev);

    const created = await request(app)
      .post('/api/replays')
      .send({runId: source.id, start: 'v1', goal: 'v3', expectedRevision: rev})
      .expect(201);
    const replay = await waitForReplay(app, created.body.replay.id);

    // Historical fact is untouched: r1, no audit field.
    expect(replay.historical.results[0].funcRevision).toBe(1);
    expect(replay.historical.results[0].output).toEqual({name: 'Ada', age: 0});
    expect(replay.historical.results[1].funcRevision).toBe(1);

    // New side bound r2.
    expect(replay.current.steps[0].funcRevision).toBe(2);
    expect(replay.current.results[0].output).toEqual({name: 'Ada', age: 0, audit: true});
    expect(replay.current.results[1].funcRevision).toBe(2);
    expect(replay.current.results[1].output).toEqual({name: 'Ada', age: 0, tier: 'standard'});

    const diff = replay.diff!;
    // Divergence begins at step 1: revision AND intermediate output differ.
    expect(diff.firstDifferenceIndex).toBe(0);
    expect(diff.pairs[0].diffs).toEqual(expect.arrayContaining(['revision', 'output']));
    // Step 2 differs only by revision — its output already matched again.
    expect(diff.pairs[1].diffs).toContain('revision');
    expect(diff.pairs[1].diffs).not.toContain('output');
    // Final documents ARE equal — but the mid-path divergence is still shown.
    expect(diff.finalDocumentEqual).toBe(true);
  });

  it('reports drift when the graph changed before the new side started, and pins afterward', async () => {
    const app = createApp();
    const source = await createRun(app, [E1, E2], SAMPLE);

    // Page still believes it is viewing r1 while someone published r2.
    const rev2 = await publish(app, 'add-tier', '(doc) => ({...doc, tier: "gold"})', 1);

    const created = await request(app)
      .post('/api/replays')
      // expectedRevision deliberately stale (the page is behind)
      .send({runId: source.id, start: 'v1', goal: 'v3', expectedRevision: 1})
      .expect(201);
    const replay = created.body.replay as ReplayComparison;
    expect(replay.drift.changedFromView).toBe(true);
    expect(replay.drift.expectedRevision).toBe(1);
    expect(replay.drift.pinnedRevision).toBe(rev2);
    expect(replay.current.graphRevision).toBe(rev2);

    // A further publish AFTER bind cannot rewrite the stored comparison.
    const done = await waitForReplay(app, replay.id);
    await publish(app, 'add-tier', '(doc) => ({...doc, tier: "poisoned"})', rev2);
    const refetched = await waitForReplay(app, replay.id);
    expect(refetched.current.graphRevision).toBe(rev2);
    expect(refetched.current.results.at(-1)!.output).toEqual(done.current.results.at(-1)!.output);
    expect(refetched.current.results.at(-1)!.output).toEqual({name: 'Ada', age: 0, tier: 'gold'});
  });

  it('preserves a FAILED historical run: retained intermediates and failure position survive even without a final document', async () => {
    const app = createApp();
    const source = await createRun(app, [E1, E10], SAMPLE); // broken-tier fails at e10
    expect(source.status).toBe('failed');
    expect(source.failedEdgeId).toBe('e10');

    const created = await request(app)
      .post('/api/replays')
      .send({runId: source.id, start: 'v1', goal: 'v3', expectedRevision: 1})
      .expect(201);
    const replay = await waitForReplay(app, created.body.replay.id);

    // The historical failure is shown as fact.
    expect(replay.historical.status).toBe('failed');
    expect(replay.historical.failedEdgeId).toBe('e10');
    expect(replay.historical.results).toHaveLength(2);
    expect(replay.historical.results[0].status).toBe('done');
    expect(replay.historical.results[0].output).toEqual({name: 'Ada', age: 0});
    expect(replay.historical.results[1].status).toBe('failed');
    expect(replay.historical.results[1].error).toMatch(/tier service unavailable/);

    // New side succeeds on a different route; no final-json verdict is forced.
    expect(replay.current.status).toBe('succeeded');
    expect(replay.diff!.finalDocumentEqual).toBeNull();
    // step 2: historical failed, current done → status divergence named.
    expect(replay.diff!.pairs[1].diffs).toContain('status');
  });

  it('BLOCKS the new side when the current graph offers no applicable path, keeping the frozen ranking', async () => {
    const app = createApp();
    // Historical run tried the platinum-only edge with a standard-tier doc.
    const source = await createRun(
      app,
      [{edgeId: 'e8', from: 'v3', to: 'v4', funcId: 'rename-name', funcRevision: 1, cost: 5, reversible: false,
        condition: 'doc.tier === "platinum"'}],
      {name: 'Ada', age: 1, tier: 'standard'},
    );
    expect(source.status).toBe('failed');

    // Remove the normal v3->v4 edge so only the rejected condition remains.
    await deleteEdge(app, 'e5', 1);

    const created = await request(app)
      .post('/api/replays')
      .send({runId: source.id, start: 'v3', goal: 'v4', expectedRevision: 2})
      .expect(201);
    const replay = await waitForReplay(app, created.body.replay.id);
    expect(replay.status).toBe('blocked');
    expect(replay.current.status).toBe('blocked');
    expect(replay.current.runId).toBeUndefined();
    expect(replay.current.blockedReason).toMatch(/condition|path/i);
    expect(replay.current.ranking.some((c) => c.key === 'e8' && c.conditionStatus === 'rejected')).toBe(true);
    // The historical side is still fully present.
    expect(replay.historical.failedEdgeId).toBe('e8');
    expect(replay.diff!.finalDocumentEqual).toBeNull();
  });

  it('404s unknown runs and 409s when the source run is still active', async () => {
    const app = createApp();
    await request(app)
      .post('/api/replays')
      .send({runId: 'run-ghost', start: 'v1', goal: 'v3'})
      .expect(404);

    // Launch the 400ms slow run and replay before it finishes.
    const slow = await request(app)
      .post('/api/runs')
      .send({
        steps: [{edgeId: 'e3', from: 'v1', to: 'v3', funcId: 'slow-stamp', funcRevision: 1, cost: 8, reversible: false}],
        sample: SAMPLE,
      })
      .expect(201);
    await request(app)
      .post('/api/replays')
      .send({runId: slow.body.id, start: 'v1', goal: 'v3'})
      .expect(409);
  });

  it('PINNING: a function published while the new-side run is executing never changes its bound body', async () => {
    const store = new StudioStore();
    const app = createApp(store);

    // Historical run via the slow single-hop edge, r1 (must finish first so it
    // is replayable).
    const source = await createRun(
      app,
      [{edgeId: 'e3', from: 'v1', to: 'v3', funcId: 'slow-stamp', funcRevision: 1, cost: 8, reversible: false}],
      SAMPLE,
    );
    expect(source.results[0].output).toEqual({name: 'Ada', age: 0, tier: 'standard'});

    // Leave e3 as the only simple v1->v3 path.
    let rev = 1;
    rev = await deleteEdge(app, 'e4', rev);
    rev = await deleteEdge(app, 'e10', rev);
    rev = await deleteEdge(app, 'e1', rev);

    const created = await request(app)
      .post('/api/replays')
      .send({runId: source.id, start: 'v1', goal: 'v3', expectedRevision: rev})
      .expect(201);
    // Publish a poisoned r2 while the pinned 400ms run is in flight.
    await publish(app, 'slow-stamp', '(doc) => ({...doc, poisoned: true})', rev);

    const replay = await waitForReplay(app, created.body.replay.id);
    expect(replay.status).toBe('completed');
    expect(replay.current.selectedKey).toBe('e3');
    expect(replay.current.results[0].funcRevision).toBe(1); // pinned at bind
    expect(replay.current.results[0].output).toEqual({name: 'Ada', age: 0, tier: 'standard'});
    expect(replay.current.graphRevision).toBe(rev); // frozen, not the post-publish revision
  });
});
