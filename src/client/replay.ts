import type {ReplayComparison, ReplaySummary, RunSummary} from '../common/types';

/**
 * Client-side state for the sourced-replay workbench.
 *
 * The stale-response guard: every new request (create a comparison from
 * another historical run, or open a different stored comparison) bumps `seq`.
 * A slow response or a late poll from the PREVIOUS selection carries an older
 * seq (or an id that no longer matches) and is dropped — it can never
 * overwrite what the user is now looking at.
 */
export type ReplayPanelState = {
  /** historical runs available as replay sources, newest first */
  runs: RunSummary[];
  /** completed/ongoing comparisons fetched back from the server */
  replays: ReplaySummary[];
  replay: ReplayComparison | null;
  selectedReplayId: string | null;
  /** monotonic request token; stale responses are discarded */
  seq: number;
  busy: boolean;
  error: string | null;
};

export const initialReplay: ReplayPanelState = {
  runs: [],
  replays: [],
  replay: null,
  selectedReplayId: null,
  seq: 0,
  busy: false,
  error: null,
};

export type ReplayAction =
  | {type: 'runs_loaded'; runs: RunSummary[]}
  | {type: 'replays_loaded'; replays: ReplaySummary[]}
  | {type: 'request_started'; seq: number}
  | {type: 'replay_attached'; seq: number; replay: ReplayComparison}
  | {type: 'replay_progress'; seq: number; replay: ReplayComparison}
  | {type: 'request_failed'; seq: number; error: string};

export function replayReducer(state: ReplayPanelState, action: ReplayAction): ReplayPanelState {
  switch (action.type) {
    case 'runs_loaded':
      return {...state, runs: action.runs};

    case 'replays_loaded':
      return {...state, replays: action.replays};

    case 'request_started':
      // The previous selection is now superseded: the new seq invalidates any
      // response or poll still in flight for it. The previously shown
      // comparison stays visible (with the busy indicator) until the new one
      // attaches.
      return {...state, seq: action.seq, busy: true, error: null};

    case 'replay_attached': {
      if (action.seq !== state.seq) return state; // late response for an older choice
      return {
        ...state,
        busy: false,
        error: null,
        replay: action.replay,
        selectedReplayId: action.replay.id,
      };
    }

    case 'replay_progress': {
      // Both the request generation AND the comparison id must match.
      if (action.seq !== state.seq) return state;
      if (state.selectedReplayId !== action.replay.id) return state;
      return {...state, replay: action.replay};
    }

    case 'request_failed': {
      if (action.seq !== state.seq) return state;
      return {...state, busy: false, error: action.error};
    }
  }
}

export function replayIsTerminal(replay: ReplayComparison): boolean {
  return replay.status === 'completed' || replay.status === 'blocked';
}
