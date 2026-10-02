import {randomUUID} from 'node:crypto';
import type {
  CandidatePath,
  FrozenCandidate,
  ReplayComparison,
  ReplayCurrentSide,
  ReplayHistoricalSide,
  ReplayStatus,
  Run,
  RunStatus,
} from '../common/types';
import {diffSides} from '../common/replay';
import {queryPaths} from './paths';
import {MigrationRuntime} from './runtime';
import {HttpError, StudioStore} from './store';

function isTerminal(status: RunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function freezeCandidate(candidate: CandidatePath): FrozenCandidate {
  return {
    key: candidate.key,
    edgeIds: [...candidate.edgeIds],
    totalCost: candidate.totalCost,
    valid: candidate.valid,
    reversibleOnly: candidate.reversibleOnly,
    conditionStatus: candidate.conditionStatus,
    rejectedAtEdge: candidate.rejectedAtEdge,
    rejectedReason: candidate.rejectedReason,
    schemaIssues: candidate.schemaIssues,
  };
}

function describeBlocked(candidates: FrozenCandidate[]): string {
  if (candidates.length === 0) return 'no simple path exists between those revisions on the current graph';
  const rejected = candidates.filter((c) => c.conditionStatus === 'rejected');
  if (rejected.length === candidates.length) {
    return `every path is blocked by an edge condition (first: ${rejected[0].rejectedAtEdge ?? '?'})`;
  }
  return 'no compositionally valid, applicable path exists on the current graph';
}

/**
 * Build the historical side by COPYING the source run as fact. It is never
 * re-executed: bound revisions, the original sample, retained intermediate
 * outputs, the failure position and even cancelled/skipped steps survive.
 */
function buildHistorical(source: Run, graphRevision: number): ReplayHistoricalSide {
  return {
    sourceRunId: source.id,
    graphRevision,
    status: source.status,
    start: source.steps[0]?.from ?? '',
    goal: source.steps[source.steps.length - 1]?.to ?? '',
    pathKey: source.pathKey,
    steps: source.steps.map((s) => ({...s})),
    results: source.results.map((r) => ({...r})),
    totalCost: source.totalCost,
    failedEdgeId: source.failedEdgeId,
    error: source.error,
    createdAt: source.createdAt,
    finishedAt: source.finishedAt,
  };
}

export type CreateReplayInput = {
  runId: string;
  start: string;
  goal: string;
  reversibleOnly?: boolean;
  /** graph revision the page was viewing when the user requested the replay */
  expectedRevision?: number;
};

/**
 * Create a sourced replay comparison.
 *
 * Snapshot semantics:
 *  - the CURRENT graph is snapshotted once; candidate enumeration AND the new
 *    run bind to that same frozen graph (revision + function bodies + node
 *    schemas + edge costs/conditions), so later edits cannot silently rewrite
 *    either the ranking or the execution;
 *  - `drift` records whether the graph had already moved relative to the page
 *    (expectedRevision) and relative to the historical run.
 */
export async function createReplayComparison(
  store: StudioStore,
  runtime: MigrationRuntime,
  input: CreateReplayInput,
): Promise<ReplayComparison> {
  const source = store.getRun(input.runId);
  if (!source) throw new HttpError(404, `unknown run "${input.runId}"`);
  if (!isTerminal(source.status)) {
    throw new HttpError(409, `source run "${input.runId}" is ${source.status}; wait for it to finish before replaying`);
  }
  const historicalRevision = store.getRunGraphRevision(input.runId) ?? 0;

  // ONE snapshot drives the whole new side.
  const pinnedGraph = store.snapshot();
  const pinnedRevision = store.getRevision();
  const expectedRevision = Number.isInteger(input.expectedRevision) ? input.expectedRevision : undefined;

  const candidates = await queryPaths(pinnedGraph, runtime, {
    start: input.start,
    goal: input.goal,
    sample: source.sample,
    reversibleOnly: Boolean(input.reversibleOnly),
  });
  const liveRevisionAtBind = store.getRevision();

  const ranking = candidates.map(freezeCandidate);
  const historical = buildHistorical(source, historicalRevision);

  // The NEW side's own selection rule: cheapest compositionally valid path
  // whose conditions are satisfied. Historical costs never enter this ranking.
  const chosen = candidates.find((c) => c.valid && c.conditionStatus === 'satisfied');

  const base: ReplayCurrentSide = {
    graphRevision: pinnedRevision,
    liveRevisionAtBind,
    start: input.start,
    goal: input.goal,
    reversibleOnly: Boolean(input.reversibleOnly),
    ranking,
    steps: [],
    results: [],
    status: 'blocked',
  };

  let current: ReplayCurrentSide;
  let status: ReplayStatus;
  let diff: ReplayComparison['diff'];

  if (!chosen) {
    current = {...base, blockedReason: describeBlocked(ranking)};
    status = 'blocked';
    // Even with nothing executed on the new side, pair the historical trace
    // against the empty current one: every historical step shows as a fact
    // the current graph cannot reproduce.
    diff = diffSides(historical, current);
  } else {
    // Bind the run to the SAME pinned graph — a publish/edge edit arriving
    // after this point cannot touch it.
    const {run} = store.createRun({
      experimentId: `replay-${input.runId}`,
      steps: chosen.steps,
      sample: source.sample,
      pinnedGraph,
      pinnedRevision,
    });
    current = {
      ...base,
      selectedKey: chosen.key,
      runId: run.id,
      steps: run.steps.map((s) => ({...s})),
      results: [],
      totalCost: run.totalCost,
      status: run.status as RunStatus,
    };
    status = 'running';
  }

  const replay: ReplayComparison = {
    id: `replay-${randomUUID().slice(0, 8)}`,
    status,
    createdAt: new Date().toISOString(),
    finishedAt: status === 'blocked' ? new Date().toISOString() : undefined,
    sourceRunId: input.runId,
    sample: structuredClone(source.sample),
    historical,
    current,
    diff,
    drift: {
      expectedRevision,
      historicalRevision,
      pinnedRevision,
      changedFromView: expectedRevision !== undefined && expectedRevision !== pinnedRevision,
      changedDuringPreparation: pinnedRevision !== liveRevisionAtBind,
    },
  };
  store.saveReplay(replay);
  return store.getReplay(replay.id)!;
}

/**
 * Refresh a replay from its (possibly still executing) current-side run. Once
 * the run is terminal the diff is frozen onto the stored comparison; later
 * graph/function edits have no effect on that stored result.
 */
export function refreshReplayComparison(store: StudioStore, replay: ReplayComparison): ReplayComparison {
  const runId = replay.current.runId;
  if (!runId || replay.status === 'completed' || replay.status === 'blocked') {
    return replay;
  }
  const run = store.getRun(runId);
  if (!run) {
    return replay;
  }
  replay.current.status = run.status;
  replay.current.steps = run.steps.map((s) => ({...s}));
  replay.current.results = run.results.map((r) => ({...r}));
  replay.current.totalCost = run.totalCost;
  replay.current.failedEdgeId = run.failedEdgeId;
  replay.current.error = run.error;

  if (isTerminal(run.status)) {
    replay.status = 'completed';
    replay.finishedAt = run.finishedAt ?? new Date().toISOString();
    replay.diff = diffSides(replay.historical, replay.current);
  }
  store.saveReplay(replay);
  return store.getReplay(replay.id)!;
}
