import {describe, expect, it} from 'vitest';
import {buildDivergence, finalOutputOf, jsonEqual} from '../src/common/diff';
import type {CandidatePath, PathStep, Run, StepResult} from '../src/common/types';

function step(partial: Partial<PathStep> & Pick<PathStep, 'edgeId' | 'from' | 'to' | 'funcId'>): PathStep {
  return {funcRevision: 1, cost: 1, reversible: true, ...partial};
}

function result(partial: Partial<StepResult> & Pick<StepResult, 'edgeId' | 'from' | 'to' | 'funcId' | 'funcRevision' | 'cost' | 'status'>): StepResult {
  return partial;
}

function run(partial: Partial<Run> & Pick<Run, 'id' | 'pathKey' | 'steps' | 'sample' | 'status' | 'totalCost'>): Run {
  return {results: [], createdAt: '', ...partial};
}

function candidate(key: string, overrides: Partial<CandidatePath> = {}): CandidatePath {
  return {
    key,
    steps: [],
    edgeIds: key.split('>'),
    totalCost: 1,
    reversibleOnly: true,
    valid: true,
    schemaIssues: [],
    conditionStatus: 'satisfied',
    ...overrides,
  };
}

const oldSteps = [
  step({edgeId: 'e1', from: 'v1', to: 'v2', funcId: 'add-age', cost: 3}),
  step({edgeId: 'e2', from: 'v2', to: 'v3', funcId: 'add-tier', cost: 2}),
];

const oldRun = run({
  id: 'run-old',
  pathKey: 'e1>e2',
  status: 'succeeded',
  totalCost: 5,
  sample: {name: 'Ada'},
  steps: oldSteps,
  results: [
    result({edgeId: 'e1', from: 'v1', to: 'v2', funcId: 'add-age', funcRevision: 1, cost: 3, status: 'done', output: {name: 'Ada', age: 0}}),
    result({edgeId: 'e2', from: 'v2', to: 'v3', funcId: 'add-tier', funcRevision: 1, cost: 2, status: 'done', output: {name: 'Ada', age: 0, tier: 'standard'}}),
  ],
});

describe('buildDivergence', () => {
  it('reports identical routes step by step', () => {
    const freshRun = run({
      id: 'run-new', pathKey: 'e1>e2', status: 'succeeded', totalCost: 5,
      sample: {name: 'Ada'}, steps: oldSteps.map((s) => ({...s})),
      results: structuredClone(oldRun.results),
    });
    const report = buildDivergence({oldRun, freshRun, candidates: [candidate('e1>e2')]});
    expect(report.samePath).toBe(true);
    expect(report.firstDifferentIndex).toBeNull();
    expect(report.firstOutputDifferenceIndex).toBeNull();
    expect(report.finalEqual).toBe(true);
    expect(report.historicalRank).toBe(1);
  });

  it('names the FIRST step where outputs differ even when the final JSON later reconverges', () => {
    // New route: the one-hop slow stamp reaches the same final document, but
    // step 1 is a different edge with a different intermediate document.
    const freshSteps = [step({edgeId: 'e3', from: 'v1', to: 'v3', funcId: 'slow-stamp', cost: 8, reversible: false})];
    const freshRun = run({
      id: 'run-new', pathKey: 'e3', status: 'succeeded', totalCost: 8,
      sample: {name: 'Ada'}, steps: freshSteps,
      results: [
        result({edgeId: 'e3', from: 'v1', to: 'v3', funcId: 'slow-stamp', funcRevision: 1, cost: 8,
          status: 'done', output: {name: 'Ada', age: 0, tier: 'standard'}}),
      ],
    });
    const report = buildDivergence({oldRun, freshRun, candidates: [candidate('e3', {totalCost: 8}), candidate('e1>e2', {totalCost: 5})]});
    expect(report.finalEqual).toBe(true);
    expect(report.samePath).toBe(false);
    expect(report.firstDifferentIndex).toBe(0);
    expect(report.firstOutputDifferenceIndex).toBe(0);
    // Historical path is now the SECOND candidate under current costs — not
    // allowed to claim the fresh ranking.
    expect(report.historicalRank).toBe(2);
    expect(report.notes.join(' ')).toMatch(/final documents match/);
  });

  it('detects a revision bump with unchanged JSON as a route difference, not an output difference', () => {
    const freshSteps = [
      step({edgeId: 'e1', from: 'v1', to: 'v2', funcId: 'add-age', funcRevision: 2, cost: 3}),
      step({edgeId: 'e2', from: 'v2', to: 'v3', funcId: 'add-tier', cost: 2}),
    ];
    const freshRun = run({
      id: 'run-new', pathKey: 'e1>e2', status: 'succeeded', totalCost: 5,
      sample: {name: 'Ada'}, steps: freshSteps,
      results: [
        result({edgeId: 'e1', from: 'v1', to: 'v2', funcId: 'add-age', funcRevision: 2, cost: 3, status: 'done', output: {name: 'Ada', age: 0}}),
        result({edgeId: 'e2', from: 'v2', to: 'v3', funcId: 'add-tier', funcRevision: 1, cost: 2, status: 'done', output: {name: 'Ada', age: 0, tier: 'standard'}}),
      ],
    });
    const report = buildDivergence({oldRun, freshRun, candidates: [candidate('e1>e2')]});
    expect(report.firstDifferentIndex).toBe(0);
    expect(report.steps[0]!.changes).toContain('revision_changed');
    expect(report.firstOutputDifferenceIndex).toBeNull();
    expect(report.finalEqual).toBe(true);
  });

  it('marks extra / missing steps when the fresh path has a different length', () => {
    const freshRun = run({
      id: 'run-new', pathKey: 'e3', status: 'succeeded', totalCost: 8,
      sample: {name: 'Ada'}, steps: [step({edgeId: 'e3', from: 'v1', to: 'v3', funcId: 'slow-stamp', cost: 8, reversible: false})],
      results: [],
    });
    const report = buildDivergence({oldRun, freshRun, candidates: [candidate('e3')]});
    expect(report.steps[1]!.changes).toContain('only_in_history');
  });

  it('historical path gone from the graph: rank null, verdict absent', () => {
    const report = buildDivergence({oldRun, candidates: [candidate('e3')]});
    expect(report.historicalRank).toBeNull();
    expect(report.historicalVerdict).toBe('absent');
    expect(report.notes.join(' ')).toMatch(/no longer exists/);
  });

  it('verdict reflects a condition rejection of the historical route today', () => {
    const report = buildDivergence({
      oldRun,
      candidates: [candidate('e1>e2', {
        valid: true,
        conditionStatus: 'rejected',
        rejectedAtEdge: 'e2',
        rejectedReason: 'condition predicate returned false for the current document',
      })],
    });
    expect(report.historicalVerdict).toBe('condition_rejected');
    expect(report.historicalRank).toBe(1);
  });

  it('a FAILED historical run keeps its partial outputs and records the failure position', () => {
    const failedOld = run({
      id: 'run-failed', pathKey: 'e1>e10', status: 'failed', totalCost: 4, failedEdgeId: 'e10',
      error: 'tier service unavailable',
      sample: {name: 'Ada'},
      steps: [
        step({edgeId: 'e1', from: 'v1', to: 'v2', funcId: 'add-age', cost: 3}),
        step({edgeId: 'e10', from: 'v2', to: 'v3', funcId: 'broken-tier', cost: 1, reversible: false}),
      ],
      results: [
        result({edgeId: 'e1', from: 'v1', to: 'v2', funcId: 'add-age', funcRevision: 1, cost: 3, status: 'done', output: {name: 'Ada', age: 0}}),
        result({edgeId: 'e10', from: 'v2', to: 'v3', funcId: 'broken-tier', funcRevision: 1, cost: 1, status: 'failed', error: 'tier service unavailable'}),
      ],
    });
    const freshRun = run({
      id: 'run-new', pathKey: 'e1>e2', status: 'succeeded', totalCost: 5,
      sample: {name: 'Ada'}, steps: oldSteps.map((s) => ({...s})),
      results: structuredClone(oldRun.results),
    });
    const report = buildDivergence({oldRun: failedOld, freshRun, candidates: [candidate('e1>e2'), candidate('e1>e10', {totalCost: 4})]});
    // Failure does not discard the comparison: earlier intermediate stays aligned.
    expect(report.steps[0]!.oldResult?.output).toEqual({name: 'Ada', age: 0});
    expect(report.steps[1]!.changes).toContain('edge_changed');
    // No final document from the failed side.
    expect(report.finalEqual).toBeNull();
    expect(report.finalOld).toBeUndefined();
    expect(report.finalFresh).toBeDefined();
    expect(report.notes.join(' ')).toMatch(/failed at e10/);
  });

  it('a cancelled fresh run contributes no final document', () => {
    const freshRun = run({
      id: 'run-c', pathKey: 'e1>e2', status: 'cancelled', totalCost: 5,
      error: 'cancelled by user',
      sample: {name: 'Ada'}, steps: oldSteps.map((s) => ({...s})),
      results: [
        result({edgeId: 'e1', from: 'v1', to: 'v2', funcId: 'add-age', funcRevision: 1, cost: 3, status: 'done', output: {name: 'Ada', age: 0}}),
        result({edgeId: 'e2', from: 'v2', to: 'v3', funcId: 'add-tier', funcRevision: 1, cost: 2, status: 'skipped'}),
      ],
    });
    const report = buildDivergence({oldRun, freshRun, candidates: [candidate('e1>e2')]});
    expect(report.finalEqual).toBeNull();
    expect(report.steps[1]!.freshResult?.status).toBe('skipped');
  });

  it('jsonEqual handles nested objects, arrays and nulls', () => {
    expect(jsonEqual({a: 1, b: [1, {c: null}]}, {a: 1, b: [1, {c: null}]})).toBe(true);
    expect(jsonEqual({a: 1}, {a: 1, b: 2})).toBe(false);
    expect(jsonEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(jsonEqual(null, null)).toBe(true);
    expect(jsonEqual(null, {})).toBe(false);
  });

  it('finalOutputOf requires a successful terminal step', () => {
    expect(finalOutputOf(oldRun)).toEqual({name: 'Ada', age: 0, tier: 'standard'});
    const cancelled = run({
      id: 'x', pathKey: 'e1>e2', status: 'cancelled', totalCost: 5, sample: {},
      steps: oldSteps,
      results: [result({edgeId: 'e1', from: 'v1', to: 'v2', funcId: 'add-age', funcRevision: 1, cost: 3, status: 'done', output: {name: 'Ada', age: 0}})],
    });
    // Completed intermediate exists, but no run-level final document.
    expect(finalOutputOf(cancelled)).toBeUndefined();
  });
});
