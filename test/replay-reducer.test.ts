import {describe, expect, it} from 'vitest';
import {initialReplay, replayReducer, replayIsTerminal} from '../src/client/replay';
import type {ReplayComparison} from '../src/common/types';

function replay(id: string, status: ReplayComparison['status'], runId = 'run-old'): ReplayComparison {
  return {
    id,
    status,
    createdAt: '',
    boundGraphRevision: 3,
    staleViewAtCreate: false,
    historical: {runId, graphRevision: 1, run: {
      id: runId, pathKey: '', steps: [], sample: {}, status: 'succeeded', totalCost: 0, results: [], createdAt: '',
    }},
    fresh: {start: 'v1', goal: 'v3', candidates: []},
  };
}

describe('replay reducer — stale comparison guard', () => {
  it('a SLOW previous comparison must not overwrite the newly selected historical run', () => {
    // User opens historical run A.
    let state = replayReducer(initialReplay, {type: 'select', replayId: null, runId: 'run-A'});
    const genA = state.generation;
    state = replayReducer(state, {type: 'loading', generation: genA, selectedId: null, value: true});

    // While A's request is still in flight, user switches to run B.
    state = replayReducer(state, {type: 'select', replayId: null, runId: 'run-B'});
    const genB = state.generation;
    expect(genB).toBeGreaterThan(genA);
    state = replayReducer(state, {type: 'loading', generation: genB, selectedId: null, value: true});

    // A comes back late — dropped.
    const before = JSON.stringify(state);
    state = replayReducer(state, {type: 'loaded', generation: genA, replay: replay('replay-A', 'completed', 'run-A'), replayId: 'replay-A'});
    expect(JSON.stringify(state)).toBe(before);
    expect(state.replay).toBeNull();

    // B comes back — applied.
    state = replayReducer(state, {type: 'loaded', generation: genB, replay: replay('replay-B', 'completed', 'run-B'), replayId: 'replay-B'});
    expect(state.replay?.id).toBe('replay-B');
    expect(state.selectedId).toBe('replay-B');
  });

  it('recall by id only accepts a response matching the requested comparison', () => {
    let state = replayReducer(initialReplay, {type: 'select', replayId: 'replay-X', runId: null});
    const gen = state.generation;
    // Misrouted response (different id) — ignored.
    state = replayReducer(state, {type: 'loaded', generation: gen, replay: replay('replay-Y', 'completed')});
    expect(state.replay).toBeNull();
    state = replayReducer(state, {type: 'loaded', generation: gen, replay: replay('replay-X', 'completed')});
    expect(state.replay?.id).toBe('replay-X');
  });

  it('switching selections bumps generations and clears prior replay', () => {
    let state = replayReducer(initialReplay, {type: 'select', replayId: 'replay-X', runId: 'run-A'});
    const gen = state.generation;
    state = replayReducer(state, {type: 'loaded', generation: gen, replay: replay('replay-X', 'running')});
    expect(state.replay?.id).toBe('replay-X');
    state = replayReducer(state, {type: 'select', replayId: null, runId: 'run-B'});
    expect(state.replay).toBeNull();
    expect(state.pendingRunId).toBe('run-B');
    expect(replayIsTerminal('completed')).toBe(true);
    expect(replayIsTerminal('running')).toBe(false);
  });
});
