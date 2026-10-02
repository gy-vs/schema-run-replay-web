import type {ReplayComparison} from '../common/types';

export type ReplayState = {
  /** id of the comparison the user is currently looking at; null = none */
  selectedId: string | null;
  /** historical run id the form is seeded with (may not yet have a comparison) */
  pendingRunId: string | null;
  replay: ReplayComparison | null;
  loading: boolean;
  cancelRequested: boolean;
  /**
   * Monotonic selection generation. Switching to another historical run bumps
   * it; a slow response from the PREVIOUS comparison carries an older
   * generation and must never overwrite the freshly selected one.
   */
  generation: number;
};

export type ReplayAction =
  | {type: 'select'; replayId: string | null; runId?: string | null}
  | {type: 'loading'; generation: number; selectedId: string | null; value: boolean}
  | {type: 'loaded'; generation: number; replay: ReplayComparison; replayId?: string}
  | {type: 'cancel_requested'};

export const initialReplay: ReplayState = {
  selectedId: null,
  pendingRunId: null,
  replay: null,
  loading: false,
  cancelRequested: false,
  generation: 0,
};

/**
 * Stale-response guard for replay comparisons. Every selection (create,
 * recall, switch to another historical run) takes a new generation. Responses
 * that arrive late — the comparison the user has already navigated away from
 * — carry the old generation and are dropped, exactly like the experiment
 * reducer drops runs of an older experiment.
 */
export function replayReducer(state: ReplayState, action: ReplayAction): ReplayState {
  switch (action.type) {
    case 'select':
      return {
        ...initialReplay,
        selectedId: action.replayId,
        pendingRunId: action.runId !== undefined ? action.runId : state.pendingRunId,
        generation: state.generation + 1,
      };

    case 'loading':
      // Only the latest selection may show the spinner.
      if (action.generation !== state.generation || action.selectedId !== state.selectedId) return state;
      return {...state, loading: action.value};

    case 'loaded': {
      if (action.generation !== state.generation) return state; // slow older comparison
      // `replayId` marks the completion of a create whose selection started
      // with a null id; adopt it then. For recalls, state.selectedId was set
      // up-front and must match. In both cases the generation is the guard.
      const expected = action.replayId ?? state.selectedId;
      if (expected !== null && action.replay.id !== expected) return state;
      return {
        ...state,
        selectedId: action.replay.id,
        replay: action.replay,
        loading: false,
        cancelRequested: action.replay.status === 'cancelled' ? state.cancelRequested : false,
      };
    }

    case 'cancel_requested':
      return {...state, cancelRequested: true};
  }
}

export function replayIsTerminal(status: ReplayComparison['status']): boolean {
  return status === 'completed' || status === 'cancelled';
}
