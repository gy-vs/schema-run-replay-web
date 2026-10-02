import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import type {ReplayComparison, Run} from '../src/common/types';

type App = ReturnType<typeof createApp>;

async function waitForRun(app: App, id: string, timeoutMs = 3000): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app).get(`/api/runs/${id}`).expect(200);
    const run = res.body as Run;
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run ${id} stuck in ${run.status}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function waitForReplay(app: App, id: string, timeoutMs = 3000): Promise<ReplayComparison> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app).get(`/api/replays/${id}`).expect(200);
    const replay = res.body as ReplayComparison;
    if (replay.status === 'completed' || replay.status === 'cancelled') return replay;
    if (Date.now() > deadline) throw new Error(`replay ${id} stuck in ${replay.status}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function createRun(app: App, steps: Run['steps'], sample: unknown): Promise<Run> {
  const res = await request(app).post('/api/runs').send({steps, sample}).expect(201);
  return waitForRun(app, res.body.id as string);
}

const e1 = {edgeId: 'e1', from: 'v1', to: 'v2', funcId: 'add-age', funcRevision: 1, cost: 3, reversible: true};
const e2 = {edgeId: 'e2', from: 'v2', to: 'v3', funcId: 'add-tier', funcRevision: 1, cost: 2, reversible: true};
const e3 = {edgeId: 'e3', from: 'v1', to: 'v3', funcId: 'slow-stamp', funcRevision: 1, cost: 8, reversible: false};
const e4 = {edgeId: 'e10', from: 'v2', to: 'v3', funcId: 'broken-tier', funcRevision: 1, cost: 1, reversible: false};
const sample = {name: 'Ada'};

async function createReplay(app: App, historicalRunId: string, extra: Record<string, unknown> = {}) {
  const res = await request(app).post('/api/replays').send({historicalRunId, ...extra}).expect(201);
  return res.body as ReplayComparison;
}

describe('historical replay API', () => {
  it('SOURCED COMPARISON: old run stays on its revisions, new side re-ranks by current cost and executes the cheapest path', async () => {
    const app = createApp();
    const old = await createRun(app, [e1, e2], sample);
    expect(old.results.map((r) => r.funcRevision)).toEqual([1, 1]);

    const created = await createReplay(app, old.id);
    // Pinned to the graph revision at creation time.
    expect(created.boundGraphRevision).toBe(1);
    expect(created.historical.run.id).toBe(old.id);
    // Historical facts are frozen: the old side embeds original intermediates.
    expect(created.historical.run.results[0]!.output).toEqual({name: 'Ada', age: 0});

    // Current candidates re-ranked: e4>e10 is nominally cheapest (2) but its
    // preview already shows broken-tier throwing, so the replay defaults to
    // the cheapest CLEAN candidate e4>e2 (3) — ahead of historical e1>e2 (5).
    const keys = created.fresh.candidates.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['e4>e2', 'e1>e2', 'e3', 'e1>e10']));
    expect(keys.indexOf('e4>e10')).toBeLessThan(keys.indexOf('e4>e2'));
    expect(created.fresh.chosenKey).toBe('e4>e2');

    const finished = await waitForReplay(app, created.id);
    expect(finished.status).toBe('completed');
    expect(finished.fresh.runId).toBeTruthy();
    const freshRun = await waitForRun(app, finished.fresh.runId!);
    // New execution binds CURRENT revisions and takes the cheaper route.
    expect(freshRun.pathKey).toBe('e4>e2');
    expect(freshRun.totalCost).toBe(3);

    const report = finished.divergence!;
    expect(report.samePath).toBe(false);
    expect(report.historicalRank).toBe(keys.indexOf('e1>e2') + 1);
    // The routes fork at the very first edge (strict-add-age e4 vs add-age e1)
    // and the costs differ there too...
    expect(report.firstDifferentIndex).toBe(0);
    expect(report.steps[0]!.changes).toContain('edge_changed');
    expect(report.steps[0]!.changes).toContain('cost_changed');
    // ...but on THIS sample every intermediate document happens to be the
    // same and so is the final JSON. Equal finals must not be reported as an
    // identical journey: the route difference is still named at step 1.
    expect(report.firstOutputDifferenceIndex).toBeNull();
    expect(report.finalEqual).toBe(true);
    expect(report.notes.join(' ')).toMatch(/final documents match/);
  });

  it('AFTER-THE-FACT EDITS cannot rewrite a completed comparison or its candidate ranking', async () => {
    const app = createApp();
    const old = await createRun(app, [e1, e2], sample);
    const created = await createReplay(app, old.id);
    const finished = await waitForReplay(app, created.id);
    expect(finished.fresh.chosenKey).toBe('e4>e2');
    const freshRunId = finished.fresh.runId!;

    // Someone now edits the graph: repoint the cheap edge and inflate costs.
    await request(app)
      .put('/api/edges/e4')
      .send({from: 'v1', to: 'v2', funcId: 'add-age', cost: 99, reversible: false, baseRevision: 1})
      .expect(200);

    // The stored comparison is byte-for-byte unchanged.
    const recalled = (await request(app).get(`/api/replays/${created.id}`).expect(200)).body as ReplayComparison;
    expect(recalled.boundGraphRevision).toBe(1);
    // The frozen candidate list, order and per-step costs survive the edit.
    expect(recalled.fresh.candidates.map((c) => c.key)).toEqual(finished.fresh.candidates.map((c) => c.key));
    expect(recalled.fresh.candidates.find((c) => c.key === 'e4>e2')!.steps[0]!.cost).toBe(1);
    expect(recalled.divergence!.historicalRank).toBe(finished.divergence!.historicalRank);
    expect(recalled.liveFreshRun).toBeUndefined();

    // The fresh run that already executed is also still on the pinned state.
    const freshRun = await request(app).get(`/api/runs/${freshRunId}`).expect(200);
    expect(freshRun.body.pathKey).toBe('e4>e2');
  });

  it('failed historical run still produces a comparison with its REAL partial outputs and failure edge', async () => {
    const app = createApp();
    const old = await createRun(app, [e1, e4], sample);
    expect(old.status).toBe('failed');
    expect(old.failedEdgeId).toBe('e10');

    const created = await createReplay(app, old.id);
    const finished = await waitForReplay(app, created.id);
    // Whole comparison is NOT discarded just because history failed.
    expect(finished.status).toBe('completed');
    const frozenOld = finished.historical.run;
    expect(frozenOld.status).toBe('failed');
    expect(frozenOld.failedEdgeId).toBe('e10');
    expect(frozenOld.results[0]!.status).toBe('done');
    expect(frozenOld.results[0]!.output).toEqual({name: 'Ada', age: 0});
    expect(frozenOld.results[1]!.status).toBe('failed');

    const report = finished.divergence!;
    expect(report.finalEqual).toBeNull();
    expect(report.notes.join(' ')).toMatch(/failed at e10/);
    // The new side independently succeeds on a valid current route.
    expect(finished.fresh.runId).toBeTruthy();
    const fresh = await waitForRun(app, finished.fresh.runId!);
    expect(fresh.status).toBe('succeeded');
  });

  it('cost and path edits between then and now move the historical path in the current ranking', async () => {
    const app = createApp();
    const old = await createRun(app, [e1, e2], sample);

    // Delete the cheapest route and rewire the broken edge into a cheap winner.
    await request(app)
      .delete('/api/edges/e4?baseRevision=1')
      .expect(200);
    await request(app)
      .put('/api/edges/e10')
      .send({from: 'v2', to: 'v3', funcId: 'add-tier', cost: 1, reversible: false, baseRevision: 2})
      .expect(200);

    const created = await createReplay(app, old.id);
    expect(created.boundGraphRevision).toBe(3);
    const finished = await waitForReplay(app, created.id);
    // e1>e10 is now the cheapest CLEAN route: the fresh side follows the
    // current graph's ranking, never the old run's ranking.
    expect(finished.fresh.chosenKey).toBe('e1>e10');
    expect(finished.divergence!.historicalRank).toBe(2);
    const fresh = await waitForRun(app, finished.fresh.runId!);
    expect(fresh.pathKey).toBe('e1>e10');
    expect(fresh.totalCost).toBe(4);
  });

  it('new function revision changes the document: first output difference is pinpointed', async () => {
    const app = createApp();
    const old = await createRun(app, [e1, e2], sample);
    await request(app)
      .put('/api/funcs/add-age/revisions')
      .send({source: '(doc) => ({...doc, age: 42})', note: 'r2 changes default age', baseRevision: 1})
      .expect(200);

    // Force the historical route; its first step now binds add-age r2.
    const created = await createReplay(app, old.id, {pathKey: 'e1>e2'});
    const finished = await waitForReplay(app, created.id);
    const fresh = await waitForRun(app, finished.fresh.runId!);
    expect(fresh.results[0]!.funcRevision).toBe(2);
    expect(fresh.results[0]!.output).toMatchObject({age: 42});

    const report = finished.divergence!;
    expect(report.samePath).toBe(true);
    expect(report.steps[0]!.changes).toContain('revision_changed');
    expect(report.firstOutputDifferenceIndex).toBe(0);
    expect(report.finalEqual).toBe(false);
  });

  it('explicit pathKey that is gone from the graph is rejected with 422', async () => {
    const app = createApp();
    const old = await createRun(app, [e1, e2], sample);
    const res = await request(app)
      .post('/api/replays')
      .send({historicalRunId: old.id, pathKey: 'ghost>path'})
      .expect(422);
    expect(res.body.error).toBe('validation_error');
  });

  it('cannot replay a still-running historical run (422)', async () => {
    const app = createApp();
    const started = await request(app).post('/api/runs').send({steps: [e3], sample}).expect(201);
    const res = await request(app).post('/api/replays').send({historicalRunId: started.body.id}).expect(422);
    expect(res.body.details).toMatch(/still running/);
    await waitForRun(app, started.body.id as string);
  });

  it('unknown historical run returns 422; unknown replay id returns 404', async () => {
    const app = createApp();
    await request(app).post('/api/replays').send({historicalRunId: 'run-nope'}).expect(422);
    await request(app).get('/api/replays/replay-nope').expect(404);
  });

  it('stale baseRevision is announced on the comparison without blocking it', async () => {
    const app = createApp();
    const old = await createRun(app, [e1, e2], sample);
    await request(app)
      .put('/api/funcs/add-age/revisions')
      .send({source: '(doc) => ({...doc, age: 7})', note: 'r2', baseRevision: 1})
      .expect(200);
    // Page still thinks it sees r1; the server pins r2.
    const created = await createReplay(app, old.id, {baseRevision: 1});
    expect(created.boundGraphRevision).toBe(2);
    expect(created.staleViewAtCreate).toBe(true);
    expect(created.requestedBaseRevision).toBe(1);
    await waitForReplay(app, created.id);
  });

  it('cancelling the fresh side finalizes the comparison and retains completed steps', async () => {
    const app = createApp();
    // Historical v1->v3 success via e1>e2.
    const old = await createRun(app, [e1, e2], sample);
    // Force the slow one-hop route so the fresh run can be cancelled mid-sleep.
    const created = await createReplay(app, old.id, {pathKey: 'e3'});
    expect(created.status).toBe('running');
    await new Promise((r) => setTimeout(r, 60));
    await request(app).post(`/api/replays/${created.id}/cancel`).expect(200);
    const finished = await waitForReplay(app, created.id);
    expect(finished.status).toBe('cancelled');
    const fresh = await waitForRun(app, finished.fresh.runId!);
    expect(fresh.status).toBe('cancelled');
    // Cancelling again / an already closed comparison is 409.
    await request(app).post(`/api/replays/${created.id}/cancel`).expect(409);
  });

  it('completed comparisons are listed and recalled from the server, not just the session', async () => {
    const app = createApp();
    const old = await createRun(app, [e1, e2], sample);
    const created = await waitForReplay(app, (await createReplay(app, old.id)).id);

    const list = (await request(app).get('/api/replays').expect(200)).body;
    expect(list.replays.some((r: {id: string}) => r.id === created.id)).toBe(true);
    const entry = list.replays.find((r: {id: string}) => r.id === created.id);
    expect(entry.historicalRunId).toBe(old.id);
    expect(entry.boundGraphRevision).toBe(1);

    const recalled = (await request(app).get(`/api/replays/${created.id}`).expect(200)).body as ReplayComparison;
    expect(recalled.historical.run.results).toHaveLength(2);
    expect(recalled.fresh.candidates.length).toBeGreaterThan(0);
    expect(recalled.divergence).toBeDefined();
  });

  it('when the current graph has no path, the comparison completes with new side NOT executed but old facts intact', async () => {
    const app = createApp();
    // v1 -> v4 historical success: e1>e2>e5.
    const old = await createRun(app, [
      e1,
      e2,
      {edgeId: 'e5', from: 'v3', to: 'v4', funcId: 'rename-name', funcRevision: 1, cost: 2, reversible: false},
    ], {name: 'Ada', age: 1, tier: 'gold'});
    expect(old.status).toBe('succeeded');

    // Remove every edge reaching v4 (e5 and the conditional e8).
    await request(app).delete('/api/edges/e5?baseRevision=1').expect(200);
    await request(app).delete('/api/edges/e8?baseRevision=2').expect(200);

    const created = await createReplay(app, old.id);
    expect(created.fresh.candidates).toHaveLength(0);
    const finished = await waitForReplay(app, created.id);
    expect(finished.fresh.runId).toBeUndefined();
    expect(finished.fresh.notExecutedReason).toMatch(/no simple path/);
    expect(finished.historical.run.results.at(-1)!.output).toMatchObject({fullName: 'Ada'});
    expect(finished.divergence!.historicalRank).toBeNull();
  });

  it('existing single-path query and run cancel behaviors are unchanged', async () => {
    const app = createApp();
    // Paths still ranked by cost.
    const paths = await request(app).post('/api/paths').send({start: 'v1', goal: 'v3', sample}).expect(200);
    expect(paths.body.candidates[0].key).not.toBe('e3');
    // Run cancel still works directly.
    const runRes = await request(app).post('/api/runs').send({steps: [e3], sample}).expect(201);
    await new Promise((r) => setTimeout(r, 40));
    await request(app).post(`/api/runs/${runRes.body.id}/cancel`).expect(200);
    const stopped = await waitForRun(app, runRes.body.id as string);
    expect(stopped.status).toBe('cancelled');
  });
});
