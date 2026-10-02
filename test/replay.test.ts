import {describe, expect, it} from 'vitest';
import {deepJsonEqual, diffSides, pairSides} from '../src/common/replay';
import type {
  PathStep,
  ReplayCurrentSide,
  ReplayHistoricalSide,
  StepResult,
} from '../src/common/types';

function step(edgeId: string, overrides: Partial<PathStep> = {}): PathStep {
  return {
    edgeId,
    from: 'v1',
    to: 'v2',
    funcId: `f-${edgeId}`,
    funcRevision: 1,
    cost: 1,
    reversible: true,
    ...overrides,
  };
}

function result(edgeId: string, overrides: Partial<StepResult> = {}): StepResult {
  return {
    edgeId,
    from: 'v1',
    to: 'v2',
    funcId: `f-${edgeId}`,
    funcRevision: 1,
    cost: 1,
    status: 'done',
    ...overrides,
  };
}

function historical(overrides: Partial<ReplayHistoricalSide> = {}): ReplayHistoricalSide {
  return {
    sourceRunId: 'run-old',
    graphRevision: 1,
    status: 'succeeded',
    start: 'v1',
    goal: 'v3',
    pathKey: 'e1>e2',
    steps: [step('e1', {funcId: 'add-age'}), step('e2', {from: 'v2', to: 'v3', funcId: 'add-tier', cost: 2})],
    results: [
      result('e1', {funcId: 'add-age', output: {name: 'Ada', age: 0}}),
      result('e2', {edgeId: 'e2', from: 'v2', to: 'v3', funcId: 'add-tier', cost: 2, output: {name: 'Ada', age: 0, tier: 'standard'}}),
    ],
    totalCost: 5,
    createdAt: '',
    ...overrides,
  };
}

function current(overrides: Partial<ReplayCurrentSide> = {}): ReplayCurrentSide {
  return {
    graphRevision: 3,
    liveRevisionAtBind: 3,
    start: 'v1',
    goal: 'v3',
    reversibleOnly: false,
    ranking: [],
    selectedKey: 'e1>e2',
    runId: 'run-new',
    steps: [step('e1', {funcId: 'add-age'}), step('e2', {from: 'v2', to: 'v3', funcId: 'add-tier', cost: 2})],
    results: [
      result('e1', {funcId: 'add-age', output: {name: 'Ada', age: 0}}),
      result('e2', {edgeId: 'e2', from: 'v2', to: 'v3', funcId: 'add-tier', cost: 2, output: {name: 'Ada', age: 0, tier: 'standard'}}),
    ],
    totalCost: 5,
    status: 'succeeded',
    ...overrides,
  };
}

describe('sourced replay diff', () => {
  it('treats identical traces as equal at every position', () => {
    const diff = diffSides(historical(), current());
    expect(diff.firstDifferenceIndex).toBeNull();
    expect(diff.finalDocumentEqual).toBe(true);
    expect(diff.pairs.every((p) => p.diffs.length === 0)).toBe(true);
  });

  it('flags the FIRST differing intermediate output even when final JSON is equal', () => {
    // New revision of add-age computes the same END result but produces a
    // different intermediate (extra audit field later removed).
    const h = historical();
    const c = current({
      steps: [
        step('e1', {funcId: 'add-age', funcRevision: 2}),
        step('e2', {from: 'v2', to: 'v3', funcId: 'add-tier', cost: 2}),
      ],
      results: [
        result('e1', {funcId: 'add-age', funcRevision: 2, output: {name: 'Ada', age: 0, audit: true}}),
        result('e2', {edgeId: 'e2', from: 'v2', to: 'v3', funcId: 'add-tier', cost: 2, output: {name: 'Ada', age: 0, tier: 'standard'}}),
      ],
    });
    const diff = diffSides(h, c);
    expect(diff.firstDifferenceIndex).toBe(0);
    expect(diff.firstDifferenceEdge).toEqual({historical: 'e1', current: 'e1'});
    expect(diff.pairs[0].diffs).toContain('revision');
    expect(diff.pairs[0].diffs).toContain('output');
    // Final documents are equal — but the divergence is still surfaced.
    expect(diff.finalDocumentEqual).toBe(true);
  });

  it('detects path divergence by position and reports where one side ended early', () => {
    const h = historical({
      pathKey: 'e1>e2',
      status: 'failed',
      failedEdgeId: 'e2',
      results: [
        result('e1', {funcId: 'add-age', output: {name: 'Ada', age: 0}}),
        result('e2', {edgeId: 'e2', from: 'v2', to: 'v3', funcId: 'add-tier', cost: 2, status: 'failed', error: 'boom'}),
      ],
    });
    // Current graph routes v1 -> v3 through a single direct edge.
    const c = current({
      selectedKey: 'e3',
      steps: [step('e3', {to: 'v3', funcId: 'slow-stamp', cost: 8, reversible: false})],
      results: [
        result('e3', {to: 'v3', funcId: 'slow-stamp', cost: 8,
          output: {name: 'Ada', age: 0, tier: 'standard'}}),
      ],
      totalCost: 8,
    });
    const diff = diffSides(h, c);
    expect(diff.firstDifferenceIndex).toBe(0);
    expect(diff.pairs[0].diffs).toContain('path');
    // Historical had a second step, current did not.
    expect(diff.pairs[1].diffs).toContain('path');
    expect(diff.pairs[1].currentStep).toBeUndefined();
    expect(diff.pairs[1].historicalResult?.status).toBe('failed');
  });

  it('detects bound revision, condition and cost changes on the same edge', () => {
    const h = historical({
      steps: [
        step('e1', {funcRevision: 1, cost: 3, condition: undefined}),
        step('e2', {from: 'v2', to: 'v3', funcId: 'add-tier', funcRevision: 1, cost: 2}),
      ],
    });
    const c = current({
      selectedKey: 'e1>e2',
      steps: [
        step('e1', {funcRevision: 3, cost: 9, condition: 'doc.tier === "gold"'}),
        step('e2', {from: 'v2', to: 'v3', funcId: 'add-tier', funcRevision: 1, cost: 2}),
      ],
    });
    const pairs = pairSides(h, c);
    expect(pairs[0].diffs).toEqual(expect.arrayContaining(['revision', 'cost', 'condition']));
  });

  it('reports status divergence (done vs failed) and missing results', () => {
    const h = historical({
      status: 'failed',
      failedEdgeId: 'e2',
      results: [
        result('e1', {funcId: 'add-age', output: {name: 'Ada', age: 0}}),
        result('e2', {edgeId: 'e2', from: 'v2', to: 'v3', funcId: 'add-tier', cost: 2, status: 'failed', error: 'x'}),
      ],
    });
    const c = current();
    const diff = diffSides(h, c);
    expect(diff.pairs[1].diffs).toContain('status');
    expect(diff.finalDocumentEqual).toBeNull();
    expect(diff.notes.join(' ')).toMatch(/historical run ended failed/);
  });

  it('a blocked current side has no final-document verdict', () => {
    const c = current({status: 'blocked', runId: undefined, selectedKey: undefined, blockedReason: 'blocked', steps: [], results: []});
    const diff = diffSides(historical(), c);
    expect(diff.finalDocumentEqual).toBeNull();
    expect(diff.notes.join(' ')).toMatch(/current side blocked/);
  });

  it('counts completed / failed steps per side', () => {
    const h = historical({
      results: [
        result('e1', {funcId: 'add-age', output: {name: 'Ada', age: 0}}),
        result('e2', {edgeId: 'e2', from: 'v2', to: 'v3', funcId: 'add-tier', cost: 2, status: 'failed'}),
      ],
      status: 'failed',
    });
    const c = current();
    const diff = diffSides(h, c);
    expect(diff.historicalCounts).toMatchObject({done: 1, failed: 1});
    expect(diff.currentCounts).toMatchObject({done: 2, failed: 0});
  });

  it('deepJsonEqual ignores object key order but respects arrays', () => {
    expect(deepJsonEqual({a: 1, b: 2}, {b: 2, a: 1})).toBe(true);
    expect(deepJsonEqual([1, 2], [2, 1])).toBe(false);
    expect(deepJsonEqual({a: [1, {x: 1}]}, {a: [1, {x: 1}]})).toBe(true);
  });
});
