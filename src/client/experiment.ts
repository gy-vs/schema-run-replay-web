import type {CandidatePath, Run, RunStatus} from '../common/types';

export type RunSlot =
  | {kind: 'run'; key: string; runId: string; status: RunStatus; run?: Run; cancelRequested?: boolean}
  | {kind: 'rejected'; key: string; status: 'rejected'; rejected: string};

export type ExperimentState = {
  experimentId: string | null;
  graphRevision: number;
  start: string;
  goal: string;
  candidates: CandidatePath[];
  slots: Record<string, RunSlot>;
  /** monotonically increasing; older generations must never mutate state */
  generation: number;
};

export type ExperimentAction =
  | {
      type: 'experiment_started';
      experimentId: string;
      graphRevision: number;
      start: string;
      goal: string;
      candidates: CandidatePath[];
      runs: {key: string; runId?: string; rejected?: string; status: string}[];
    }
  | {type: 'run_progress'; experimentId: string; run: Run}
  | {type: 'cancel_requested'; experimentId: string; runId: string}
  | {type: 'reset'};

export const initialExperiment: ExperimentState = {
  experimentId: null,
  graphRevision: 0,
  start: '',
  goal: '',
  candidates: [],
  slots: {},
  generation: 0,
};

/**
 * The stale-write guard. Completions arriving for a previous experiment — for
 * example a run bound to an OLD function revision that finishes after the user
 * has started a new experiment — must never touch the new experiment's state.
 * Guarded twice: by experiment id (server binds it at run creation) and by the
 * local generation counter (covers resets even if ids are reused by a mock).
 */
export function experimentReducer(state: ExperimentState, action: ExperimentAction): ExperimentState {
  switch (action.type) {
    case 'reset':
      return {...initialExperiment, generation: state.generation + 1};

    case 'experiment_started':
      return {
        experimentId: action.experimentId,
        graphRevision: action.graphRevision,
        start: action.start,
        goal: action.goal,
        candidates: action.candidates,
        generation: state.generation + 1,
        slots: Object.fromEntries(
          action.runs.map((entry) => [
            entry.key,
            entry.runId
              ? ({kind: 'run', key: entry.key, runId: entry.runId, status: entry.status as RunStatus} satisfies RunSlot)
              : {kind: 'rejected', key: entry.key, status: 'rejected', rejected: entry.rejected ?? 'not applicable'},
          ]),
        ),
      };

    case 'run_progress': {
      if (!state.experimentId || action.experimentId !== state.experimentId) {
        return state; // stale completion from an older experiment / function binding
      }
      const slot = state.slots[action.run.pathKey];
      if (!slot || slot.kind !== 'run' || slot.runId !== action.run.id) return state;
      if (isTerminal(slot.status) && slot.status !== action.run.status) return state;
      return {
        ...state,
        slots: {...state.slots, [action.run.pathKey]: {...slot, status: action.run.status, run: action.run}},
      };
    }

    case 'cancel_requested': {
      if (action.experimentId !== state.experimentId) return state;
      const next = {...state.slots};
      for (const [key, slot] of Object.entries(next)) {
        if (slot.kind === 'run' && slot.runId === action.runId && !isTerminal(slot.status)) {
          next[key] = {...slot, cancelRequested: true};
        }
      }
      return {...state, slots: next};
    }
  }
}

export function isTerminal(status: RunStatus | string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/** Latest function revision available for a step — used to flag stale bindings. */
export function boundIsStale(run: Run, latestRevisionOf: (funcId: string) => number): boolean {
  return run.steps.some((step) => latestRevisionOf(step.funcId) > step.funcRevision);
}
