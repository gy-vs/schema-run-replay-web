import {describe, expect, it} from 'vitest';
import {initialReplay, replayReducer} from '../src/client/replay';
import type {ReplayComparison} from '../src/common/types';

function replay(id: string, sourceRunId: string, status: ReplayComparison['status']): ReplayComparison {
  return {
    id,
    status,
    createdAt: '',
    sourceRunId,
    sample: {},
    historical: {
      sourceRunId,
      graphRevision: 1,
      status: 'succeeded',
      start: 'v1',
      goal: 'v3',
      pathKey: 'e1>e2',
      steps: [],
      results: [],
      totalCost: 5,
      createdAt: '',
    },
    current: {
      graphRevision: 2,
      liveRevisionAtBind: 2,
      start: 'v1',
      goal: 'v3',
      reversibleOnly: false,
      ranking: [],
      selectedKey: 'e1>e2',
      runId: `${id}-run`,
      steps: [],
      results: [],
      status: status === 'blocked' ? 'blocked' : 'running',
    },
    drift: {
      historicalRevision: 1,
      pinnedRevision: 2,
      changedFromView: false,
      changedDuringPreparation: false,
    },
  };
}

describe('replay reducer — slow previous comparison must not overwrite a new selection', () => {
  it('drops late attach/progress carrying an older seq or a different id', () => {
    let state = initialReplay;

    // User starts comparison A.
    state = replayReducer(state, {type: 'request_started', seq: 1});
    state = replayReducer(state, {type: 'replay_attached', seq: 1, replay: replay('replay-A', 'run-1', 'running')});
    expect(state.selectedReplayId).toBe('replay-A');

    // While A polls, the user selects another historical run and starts B.
    state = replayReducer(state, {type: 'request_started', seq: 2});
    expect(state.busy).toBe(true);

    // A's slow response / poll comes back now — it carries seq 1 and must be
    // dropped even though the id exists server-side.
    state = replayReducer(state, {type: 'replay_progress', seq: 1, replay: replay('replay-A', 'run-1', 'completed')});
    expect(state.selectedReplayId).toBe('replay-A'); // selection unchanged
    expect(state.replay?.status).toBe('running'); // A's terminal update ignored

    // B attaches.
    state = replayReducer(state, {type: 'replay_attached', seq: 2, replay: replay('replay-B', 'run-2', 'completed')});
    expect(state.selectedReplayId).toBe('replay-B');
    expect(state.replay?.id).toBe('replay-B');
    expect(state.busy).toBe(false);

    // Same seq but an unexpected id (misrouted poll) is also dropped.
    const before = JSON.stringify(state);
    state = replayReducer(state, {type: 'replay_progress', seq: 2, replay: replay('replay-A', 'run-1', 'completed')});
    expect(JSON.stringify(state)).toBe(before);
  });

  it('an error from an older request never clears the current comparison', () => {
    let state = initialReplay;
    state = replayReducer(state, {type: 'request_started', seq: 1});
    state = replayReducer(state, {type: 'request_started', seq: 2});
    state = replayReducer(state, {type: 'replay_attached', seq: 2, replay: replay('replay-B', 'run-2', 'completed')});
    state = replayReducer(state, {type: 'request_failed', seq: 1, error: 'boom'});
    expect(state.error).toBeNull();
    expect(state.replay?.id).toBe('replay-B');
  });
});
