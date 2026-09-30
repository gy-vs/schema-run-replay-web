import {afterEach, describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {MigrationRuntime} from '../src/server/runtime';
import {StudioStore} from '../src/server/store';
import type {Run} from '../src/common/types';

async function waitForRun(app: ReturnType<typeof createApp>, id: string, timeoutMs = 3000): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app).get(`/api/runs/${id}`).expect(200);
    const run = res.body as Run;
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run ${id} stuck in ${run.status}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('migration service', () => {
  const sample = {name: 'Ada'};

  it('returns multiple ranked paths; cheapest multi-hop beats the one-hop path', async () => {
    const app = createApp();
    const res = await request(app).post('/api/paths').send({start: 'v1', goal: 'v3', sample}).expect(200);
    const keys = res.body.candidates.map((c: {key: string}) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['e4>e2', 'e1>e2', 'e3', 'e1>e10']));
    expect(res.body.candidates[0].key).not.toBe('e3'); // fewest hops but highest cost
    const costs = res.body.candidates.map((c: {totalCost: number}) => c.totalCost);
    expect(costs).toEqual([...costs].sort((a: number, b: number) => a - b));
  });

  it('rejects an unsatisfied condition at the precise edge and keeps the path visible', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/paths')
      .send({start: 'v3', goal: 'v4', sample: {name: 'Ada', age: 1, tier: 'standard'}})
      .expect(200);
    const e8 = res.body.candidates.find((c: {key: string}) => c.key === 'e8');
    expect(e8.conditionStatus).toBe('rejected');
    expect(e8.rejectedAtEdge).toBe('e8');
  });

  it('succeeds on a multi-step path and records every intermediate output', async () => {
    const app = createApp();
    const create = await request(app)
      .post('/api/runs')
      .send({
        steps: [
          {edgeId: 'e1', from: 'v1', to: 'v2', funcId: 'add-age', funcRevision: 1, cost: 3, reversible: true},
          {edgeId: 'e2', from: 'v2', to: 'v3', funcId: 'add-tier', funcRevision: 1, cost: 2, reversible: true},
        ],
        sample,
      })
      .expect(201);
    const run = await waitForRun(app, create.body.id);
    expect(run.status).toBe('succeeded');
    expect(run.results).toHaveLength(2);
    expect(run.results[0].output).toEqual({name: 'Ada', age: 0});
    expect(run.results[1].output).toEqual({name: 'Ada', age: 0, tier: 'standard'});
  });

  it('PARTIAL FAILURE keeps earlier intermediate results and names the precise edge', async () => {
    const app = createApp();
    const create = await request(app)
      .post('/api/runs')
      .send({
        steps: [
          {edgeId: 'e1', from: 'v1', to: 'v2', funcId: 'add-age', funcRevision: 1, cost: 3, reversible: true},
          {edgeId: 'e10', from: 'v2', to: 'v3', funcId: 'broken-tier', funcRevision: 1, cost: 1, reversible: false},
        ],
        sample,
      })
      .expect(201);
    const run = await waitForRun(app, create.body.id);
    expect(run.status).toBe('failed');
    expect(run.failedEdgeId).toBe('e10');
    expect(run.error).toMatch(/tier service unavailable/);
    // Intermediate result from the step BEFORE the failure is retained.
    expect(run.results).toHaveLength(2);
    expect(run.results[0].status).toBe('done');
    expect(run.results[0].output).toEqual({name: 'Ada', age: 0});
    expect(run.results[1].status).toBe('failed');
    expect(run.results[1].output).toBeUndefined();
  });

  it('fails the run when a condition rejects the document at execution time', async () => {
    const app = createApp();
    const create = await request(app)
      .post('/api/runs')
      .send({
        steps: [
          {edgeId: 'e8', from: 'v3', to: 'v4', funcId: 'rename-name', funcRevision: 1, cost: 5, reversible: false,
            condition: 'doc.tier === "platinum"'},
        ],
        sample: {name: 'Ada', age: 1, tier: 'standard'},
      })
      .expect(201);
    const run = await waitForRun(app, create.body.id);
    expect(run.status).toBe('failed');
    expect(run.failedEdgeId).toBe('e8');
    expect(run.results[0].conditionMet).toBe(false);
  });

  it('executes the rollback path through back edges v3 -> v1', async () => {
    const app = createApp();
    const compare = await request(app)
      .post('/api/compare')
      .send({start: 'v3', goal: 'v1', sample: {name: 'Ada', age: 9, tier: 'gold'}})
      .expect(201);
    const rollback = compare.body.runs.find((r: {key: string}) => r.key === 'e7>e6');
    expect(rollback.runId).toBeTruthy();
    const run = await waitForRun(app, rollback.runId);
    expect(run.status).toBe('succeeded');
    expect(run.results.at(-1)!.output).toEqual({name: 'Ada'});
  });

  it('CANCELLATION stops a run mid-flight and preserves completed steps', async () => {
    const app = createApp();
    const create = await request(app)
      .post('/api/runs')
      .send({
        steps: [
          {edgeId: 'e3', from: 'v1', to: 'v3', funcId: 'slow-stamp', funcRevision: 1, cost: 8, reversible: false},
        ],
        sample,
      })
      .expect(201);
    // Cancel while the 400ms audit sleep is in progress.
    await new Promise((r) => setTimeout(r, 60));
    await request(app).post(`/api/runs/${create.body.id}/cancel`).expect(200);
    const run = await waitForRun(app, create.body.id);
    expect(run.status).toBe('cancelled');
    expect(run.error).toMatch(/cancel/i);
    // Cancelling a finished run is rejected.
    await request(app).post(`/api/runs/${create.body.id}/cancel`).expect(409);
  });

  it('publishing a FUNCTION UPDATE never changes a running/old run (revision binding)', async () => {
    const store = new StudioStore();
    const app = createApp(store);
    // Start the slow run bound to slow-stamp r1.
    const create = await request(app)
      .post('/api/runs')
      .send({
        steps: [{edgeId: 'e3', from: 'v1', to: 'v3', funcId: 'slow-stamp', funcRevision: 1, cost: 8, reversible: false}],
        sample,
      })
      .expect(201);
    await new Promise((r) => setTimeout(r, 30));
    // Publish r2 while the run is sleeping.
    const publish = await request(app)
      .put('/api/funcs/slow-stamp/revisions')
      .send({source: '(doc) => ({...doc, age: 1, tier: "mutated", poisoned: true})', note: 'r2', baseRevision: 1})
      .expect(200);
    expect(publish.body.func.revision).toBe(2);
    const run = await waitForRun(app, create.body.id);
    // The old run finished on r1 — no r2 field leaked in.
    expect(run.status).toBe('succeeded');
    expect(run.results[0].funcRevision).toBe(1);
    expect(run.results[0].output).toEqual({name: 'Ada', age: 0, tier: 'standard'});
    // A NEW run binds r2 and sees the updated behaviour.
    const second = await request(app)
      .post('/api/runs')
      .send({
        steps: [{edgeId: 'e3', from: 'v1', to: 'v3', funcId: 'slow-stamp', funcRevision: 2, cost: 8, reversible: false}],
        sample,
      })
      .expect(201);
    const run2 = await waitForRun(app, second.body.id);
    expect(run2.results[0].funcRevision).toBe(2);
    expect(run2.results[0].output).toMatchObject({poisoned: true});
  });

  it('CONCURRENT EDITS: stale baseRevision loses with 409; winner proceeds', async () => {
    const app = createApp();
    const first = await request(app)
      .put('/api/edges/e1')
      .send({from: 'v1', to: 'v2', funcId: 'add-age', cost: 11, reversible: true, baseRevision: 1})
      .expect(200);
    expect(first.body.revision).toBe(2);
    const stale = await request(app)
      .put('/api/edges/e2')
      .send({from: 'v2', to: 'v3', funcId: 'add-tier', cost: 22, reversible: true, baseRevision: 1})
      .expect(409);
    expect(stale.body.error).toBe('revision_conflict');
    expect(stale.body.current).toBe(2);
    // Retrying with the fresh revision works.
    await request(app)
      .put('/api/edges/e2')
      .send({from: 'v2', to: 'v3', funcId: 'add-tier', cost: 22, reversible: true, baseRevision: 2})
      .expect(200);
  });

  it('detects cycles in the graph while still permitting back edges', async () => {
    const app = createApp();
    const res = await request(app).get('/api/graph').expect(200);
    const backIds = res.body.graph.diagnostics.backEdges.map((b: {edgeId: string}) => b.edgeId);
    expect(backIds).toEqual(expect.arrayContaining(['e6', 'e7', 'e9']));
    expect(res.body.graph.diagnostics.cycles.length).toBeGreaterThanOrEqual(3);
    // The back edges remain present and usable.
    expect(res.body.graph.edges.map((e: {id: string}) => e.id)).toEqual(expect.arrayContaining(['e6', 'e7']));
  });

  it('compare fans out one run per applicable path and tags rejected ones', async () => {
    const app = createApp();
    const res = await request(app).post('/api/compare').send({start: 'v1', goal: 'v3', sample}).expect(201);
    expect(res.body.experimentId).toMatch(/^exp-/);
    const executed = res.body.runs.filter((r: {runId?: string}) => r.runId);
    const rejected = res.body.runs.filter((r: {status: string}) => r.status === 'rejected');
    expect(executed.length).toBeGreaterThanOrEqual(2);
    // The always-failing broken-tier path is launched (failure is a runtime result).
    expect(rejected.length + executed.length).toBe(res.body.candidates.length);
  });

  it('fails precisely at an edge whose live output violates the destination schema', async () => {
    const app = createApp();
    await request(app)
      .put('/api/funcs/add-age/revisions')
      .send({source: '(doc) => ({...doc})', note: 'r2 forgets age', baseRevision: 1})
      .expect(200);
    const create = await request(app)
      .post('/api/runs')
      .send({
        steps: [{edgeId: 'e1', from: 'v1', to: 'v2', funcId: 'add-age', funcRevision: 2, cost: 3, reversible: true}],
        sample,
      })
      .expect(201);
    const run = await waitForRun(app, create.body.id);
    expect(run.status).toBe('failed');
    expect(run.failedEdgeId).toBe('e1');
    expect(run.error).toMatch(/output schema mismatch/);
    // The offending output is still recorded on the precise failed edge.
    expect(run.results[0].status).toBe('failed');
    expect(run.results[0].output).toEqual({name: 'Ada'});
  });

  it('rejects invalid function source with a compile error instead of crashing', async () => {
    const runtime = new MigrationRuntime();
    await expect(
      runtime.invoke({edgeId: 'x', from: 'v1', to: 'v2', funcId: 'f', funcRevision: 1, cost: 1, reversible: false},
        {name: 'Ada'}, 'this is not => valid js'),
    ).rejects.toMatchObject({code: 'compile'});
  });
});

afterEach(() => undefined);
