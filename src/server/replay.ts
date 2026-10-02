import {randomUUID} from 'node:crypto';
import type {CandidatePath, ReplayComparison} from '../common/types';
import {buildDivergence} from '../common/diff';
import {queryPaths} from './paths';
import {MigrationRuntime} from './runtime';
import {RunExecutor} from './executor';
import {StudioStore, ValidationError} from './store';

/** A candidate the comparison endpoint would actually execute as a fresh run. */
export function isExecutableCandidate(candidate: CandidatePath): boolean {
  return candidate.valid && candidate.conditionStatus !== 'rejected';
}

/**
 * Default new-side route: prefer a candidate whose preview projects cleanly
 * end to end ('satisfied'); fall back to an executable-but-unverifiable one
 * only when nothing previewed cleanly. Unlike /api/compare (which launches
 * every executable path), the replay chooses one representative route — it
 * should not default to a path the preview already knows throws.
 */
export function pickDefaultCandidate(candidates: CandidatePath[]): CandidatePath | undefined {
  const executable = candidates.filter(isExecutableCandidate);
  return executable.find((c) => c.conditionStatus === 'satisfied') ?? executable[0];
}

function explainNotExecuted(candidates: CandidatePath[]): string {
  if (candidates.length === 0) return 'no simple path exists between the chosen revisions in the current graph';
  return candidates
    .map((c) => {
      if (!c.valid) return `${c.key}: schema issue (${c.schemaIssues.map((i) => i.kind).join(', ') || '?'})`;
      if (c.conditionStatus === 'rejected') return `${c.key}: condition rejected at ${c.rejectedAtEdge ?? '?'}`;
      return `${c.key}: ${c.rejectedReason ?? 'not executable'}`;
    })
    .join('; ');
}

/**
 * Historical replay comparison orchestration.
 *
 * Sourcing discipline:
 *  - the OLD side is a frozen clone of the historical run as it actually
 *    finished — steps, bound revisions, sample, intermediate outputs. It is
 *    never re-executed and never re-bound to newer function bodies;
 *  - the NEW side enumerates and ranks candidates on the graph snapshot
 *    captured when the request starts, records that revision number on the
 *    comparison, and executes one chosen path with that snapshot's bindings.
 *    Once created the record (including its candidate list) is frozen: later
 *    graph edits bump the store revision but cannot rewrite this comparison.
 */
export class ReplayService {
  constructor(
    private readonly store: StudioStore,
    private readonly runtime: MigrationRuntime,
    private readonly executor: RunExecutor,
  ) {}

  async create(input: {
    historicalRunId: string;
    start?: string;
    goal?: string;
    pathKey?: string;
    baseRevision?: number;
  }): Promise<ReplayComparison> {
    const historicalLive = this.store.getRun(input.historicalRunId);
    if (!historicalLive) throw new ValidationError(`unknown run "${input.historicalRunId}"`);
    if (historicalLive.status === 'queued' || historicalLive.status === 'running') {
      throw new ValidationError(`historical run "${input.historicalRunId}" is still ${historicalLive.status}; replay only finished runs`);
    }

    // Pin the graph state for the NEW side BEFORE touching anything else, so
    // the record states exactly which graph this comparison was made against.
    const boundGraphRevision = this.store.getRevision();
    const graph = this.store.snapshot();
    const start = input.start?.trim() || historicalLive.steps[0]?.from;
    const goal = input.goal?.trim() || historicalLive.steps[historicalLive.steps.length - 1]?.to;
    if (!start || !goal) throw new ValidationError('start and goal could not be resolved');
    if (!graph.nodes.some((n) => n.id === start) || !graph.nodes.some((n) => n.id === goal)) {
      throw new ValidationError(`unknown start or goal node (${start} -> ${goal}) in the pinned graph`);
    }

    const id = `replay-${randomUUID().slice(0, 8)}`;
    const createdAt = new Date().toISOString();
    const staleViewAtCreate =
      typeof input.baseRevision === 'number' && Number.isInteger(input.baseRevision) && input.baseRevision < boundGraphRevision;

    // Save immediately in 'preparing' so the record exists even if enumeration
    // or execution setup throws before the fresh run is launched.
    let replay: ReplayComparison = {
      id,
      status: 'preparing',
      createdAt,
      boundGraphRevision,
      requestedBaseRevision: typeof input.baseRevision === 'number' ? input.baseRevision : undefined,
      staleViewAtCreate,
      historical: {
        runId: historicalLive.id,
        graphRevision: this.store.getRunGraphRevision(historicalLive.id) ?? boundGraphRevision,
        run: historicalLive,
      },
      fresh: {start, goal, candidates: []},
    };
    this.store.saveReplay(replay);

    // Re-confirm applicable paths with the CURRENT graph: current edges,
    // conditions, costs and latest revisions — ranked by current cost.
    const candidates = await queryPaths(graph, this.runtime, {start, goal, sample: historicalLive.sample});

    let chosen: CandidatePath | undefined;
    if (input.pathKey !== undefined) {
      chosen = candidates.find((c) => c.key === input.pathKey);
      if (!chosen) throw new ValidationError(`path "${input.pathKey}" does not exist in the current graph`);
      if (!isExecutableCandidate(chosen)) {
        throw new ValidationError(`path "${input.pathKey}" is not executable on the current graph`);
      }
    } else {
      chosen = pickDefaultCandidate(candidates);
    }

    replay = {
      ...replay,
      fresh: {...replay.fresh, candidates, chosenKey: chosen?.key},
    };

    if (!chosen) {
      // No run possible — the comparison still stands: the old facts are
      // compared against a current graph that offers nothing executable.
      replay = {
        ...replay,
        status: 'completed',
        finishedAt: new Date().toISOString(),
        fresh: {...replay.fresh, notExecutedReason: explainNotExecuted(candidates)},
        divergence: buildDivergence({oldRun: historicalLive, candidates}),
      };
      this.store.saveReplay(replay);
      return this.store.getReplay(id)!;
    }

    // Bind the fresh run to the SAME pinned graph snapshot this comparison
    // announced, not whatever revision the store may reach later.
    const {run: freshRun} = this.store.createRun({
      experimentId: id,
      steps: chosen.steps,
      sample: historicalLive.sample,
      graphRevision: boundGraphRevision,
    });
    replay = {...replay, fresh: {...replay.fresh, runId: freshRun.id}, status: 'running'};
    this.store.saveReplay(replay);

    // Execute detached; the finalizer is the only writer that closes the
    // comparison, so later graph edits cannot touch its result.
    void this.executor
      .start(freshRun.id)
      .then((finishedRun) => this.finalize(id, finishedRun.id))
      .catch(() => undefined);

    return this.store.getReplay(id)!;
  }

  /** Attach the latest fresh run state and recompute the divergence report. */
  private finalize(replayId: string, freshRunId: string): ReplayComparison | undefined {
    const current = this.store.getReplay(replayId);
    if (!current) return undefined;
    if (current.status === 'completed' || current.status === 'cancelled') return current; // idempotent
    const freshRun = this.store.getRun(freshRunId);
    if (!freshRun) return current;
    if (freshRun.status === 'queued' || freshRun.status === 'running') return current;

    const divergence = buildDivergence({
      oldRun: current.historical.run,
      freshRun,
      candidates: current.fresh.candidates,
    });
    const status: ReplayComparison['status'] = freshRun.status === 'cancelled' ? 'cancelled' : 'completed';
    return this.store.updateReplay(replayId, {
      status,
      finishedAt: new Date().toISOString(),
      divergence,
    });
  }

  /** Cancel the fresh execution. The historical side is never touched. */
  cancel(replayId: string): ReplayComparison | undefined {
    const current = this.store.getReplay(replayId);
    if (!current) return undefined;
    if (current.status !== 'preparing' && current.status !== 'running') return current;
    if (current.fresh.runId) this.executor.cancel(current.fresh.runId);
    return this.store.getReplay(replayId);
  }

  /**
   * Live view for polling: merge the still-running fresh run's partial
   * results without persisting them. The stored record is only closed by
   * finalize(), so concurrent edits after completion can never rewrite it.
   */
  getLive(replayId: string): ReplayComparison | undefined {
    const stored = this.store.getReplay(replayId);
    if (!stored) return undefined;
    if (stored.status !== 'running' || !stored.fresh.runId) return stored;
    const freshRun = this.store.getRun(stored.fresh.runId);
    if (!freshRun) return stored;
    return {
      ...stored,
      liveFreshRun: freshRun,
      divergence: buildDivergence({oldRun: stored.historical.run, freshRun, candidates: stored.fresh.candidates}),
    };
  }
}
