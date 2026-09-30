import {describe, expect, it} from 'vitest';
import {experimentReducer, initialExperiment, isTerminal} from '../src/client/experiment';
import type {CandidatePath, Run} from '../src/common/types';

function candidate(key: string): CandidatePath {
  return {
    key,
    steps: [],
    edgeIds: key.split('>'),
    totalCost: 1,
    reversibleOnly: true,
    valid: true,
    schemaIssues: [],
    conditionStatus: 'satisfied',
    projected: {},
  };
}

function run(experimentId: string, key: string, id: string, status: Run['status']): Run {
  return {
    id,
    experimentId,
    pathKey: key,
    steps: [],
    sample: {},
    status,
    totalCost: 1,
    results: [],
    createdAt: '',
  };
}

describe('experiment reducer — stale completion guard', () => {
  it('an OLD experiment run completing after a new experiment starts must NOT write into the new one', () => {
    let state = initialExperiment;
    state = experimentReducer(state, {
      type: 'experiment_started',
      experimentId: 'exp-old',
      graphRevision: 1,
      start: 'v1',
      goal: 'v3',
      candidates: [candidate('e1>e2'), candidate('e3')],
      runs: [
        {key: 'e1>e2', runId: 'run-old-1', status: 'running'},
        {key: 'e3', runId: 'run-old-2', status: 'running'},
      ],
    });
    // Old run finishes...
    state = experimentReducer(state, {type: 'run_progress', experimentId: 'exp-old', run: run('exp-old', 'e1>e2', 'run-old-1', 'succeeded')});
    expect(state.slots['e1>e2'].kind).toBe('run');
    if (state.slots['e1>e2'].kind === 'run') expect(state.slots['e1>e2'].status).toBe('succeeded');

    // ...but the user starts a NEW experiment (new graph revision / functions).
    state = experimentReducer(state, {
      type: 'experiment_started',
      experimentId: 'exp-new',
      graphRevision: 2,
      start: 'v1',
      goal: 'v3',
      candidates: [candidate('e1>e2')],
      runs: [{key: 'e1>e2', runId: 'run-new-1', status: 'queued'}],
    });
    expect(state.experimentId).toBe('exp-new');

    // Late completion of the OTHER old run (bound to an old function revision):
    // it carries the stale experiment id and must be ignored.
    const before = JSON.stringify(state);
    state = experimentReducer(state, {type: 'run_progress', experimentId: 'exp-old', run: run('exp-old', 'e3', 'run-old-2', 'succeeded')});
    expect(JSON.stringify(state)).toBe(before);
    // Also a misrouted payload that reuses a path key but with the OLD run id is ignored.
    state = experimentReducer(state, {type: 'run_progress', experimentId: 'exp-new', run: run('exp-new', 'e1>e2', 'run-old-2', 'succeeded')});
    if (state.slots['e1>e2'].kind === 'run') {
      expect(state.slots['e1>e2'].runId).toBe('run-new-1');
      expect(state.slots['e1>e2'].status).toBe('queued');
    }

    // The genuinely new run's progress is applied.
    state = experimentReducer(state, {type: 'run_progress', experimentId: 'exp-new', run: run('exp-new', 'e1>e2', 'run-new-1', 'succeeded')});
    if (state.slots['e1>e2'].kind === 'run') expect(state.slots['e1>e2'].status).toBe('succeeded');
  });

  it('marks cancel-requested only on live runs and resets clear slots', () => {
    let state = experimentReducer(initialExperiment, {
      type: 'experiment_started',
      experimentId: 'exp-x', graphRevision: 1, start: 'v1', goal: 'v3',
      candidates: [candidate('e3')], runs: [{key: 'e3', runId: 'r1', status: 'running'}],
    });
    state = experimentReducer(state, {type: 'cancel_requested', experimentId: 'exp-x', runId: 'r1'});
    if (state.slots['e3'].kind === 'run') expect(state.slots['e3'].cancelRequested).toBe(true);
    state = experimentReducer(state, {type: 'reset'});
    expect(state.experimentId).toBeNull();
    expect(Object.keys(state.slots)).toHaveLength(0);
    expect(isTerminal('succeeded')).toBe(true);
    expect(isTerminal('running')).toBe(false);
  });
});
