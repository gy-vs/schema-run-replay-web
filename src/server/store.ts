import {randomUUID} from 'node:crypto';
import type {
  Edge,
  Func,
  FuncRevision,
  Graph,
  JsonObject,
  Node,
  PathStep,
  Run,
} from '../common/types';
import {buildDiagnostics} from '../common/graph';
import {seedGraph} from '../common/seed';

export class RevisionConflictError extends Error {
  constructor(readonly current: number) {
    super(`revision conflict: expected ${current}`);
    this.name = 'RevisionConflictError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

type PendingRun = {
  run: Run;
  abort: AbortController;
  /** graph revision the run was created from (for staleness diagnostics) */
  graphRevision: number;
  /** immutable per-step binding (function revision body) captured at creation */
  bound: BoundStep[];
};

/**
 * In-memory, single-process store.
 *
 * Concurrency model:
 *  - graph edits require the caller's `baseRevision`; a stale write loses with
 *    a RevisionConflictError (HTTP 409) instead of silently overwriting;
 *  - function edits append a new revision — existing edges keep working and
 *    runs already started stay bound to the revision snapshot they began with;
 *  - runs embed a full snapshot of their steps (source included) at creation.
 */
export class StudioStore {
  private graph: Graph;
  private revision = 1;
  private readonly runs = new Map<string, PendingRun>();

  constructor(graph?: Graph) {
    this.graph = graph ?? seedGraph();
    this.graph.diagnostics = buildDiagnostics(this.graph.nodes, this.graph.funcs, this.graph.edges);
  }

  getRevision(): number {
    return this.revision;
  }

  snapshot(): Graph {
    return structuredClone(this.graph);
  }

  private bump(): void {
    this.revision += 1;
    this.graph.diagnostics = buildDiagnostics(this.graph.nodes, this.graph.funcs, this.graph.edges);
  }

  private guard(baseRevision: number): void {
    if (!Number.isInteger(baseRevision) || baseRevision !== this.revision) {
      throw new RevisionConflictError(this.revision);
    }
  }

  private findNode(id: string): Node {
    const node = this.graph.nodes.find((n) => n.id === id);
    if (!node) throw new ValidationError(`unknown node "${id}"`);
    return node;
  }

  private findFunc(id: string): Func {
    const func = this.graph.funcs.find((f) => f.id === id);
    if (!func) throw new ValidationError(`unknown function "${id}"`);
    return func;
  }

  // ---- function revisions -------------------------------------------------

  /** Append a new revision to an existing function. */
  addFuncRevision(funcId: string, revision: FuncRevision, baseRevision: number): Func {
    this.guard(baseRevision);
    const func = this.findFunc(funcId);
    func.revisions.push(revision);
    func.revision = func.revisions.length;
    this.bump();
    return structuredClone(func);
  }

  /** Create a brand-new function at revision 1. */
  createFunc(input: {id?: string; name: string; revision: FuncRevision}, baseRevision: number): Func {
    this.guard(baseRevision);
    const id = input.id?.trim() || `func-${randomUUID().slice(0, 8)}`;
    if (this.graph.funcs.some((f) => f.id === id)) throw new ValidationError(`function "${id}" already exists`);
    const func: Func = {id, name: input.name, revision: 1, revisions: [input.revision]};
    this.graph.funcs.push(func);
    this.bump();
    return structuredClone(func);
  }

  // ---- graph edits --------------------------------------------------------

  upsertNode(node: Node, baseRevision: number): Node {
    this.guard(baseRevision);
    const existing = this.graph.nodes.find((n) => n.id === node.id);
    if (existing) Object.assign(existing, node);
    else this.graph.nodes.push(node);
    this.bump();
    return structuredClone(node);
  }

  upsertEdge(input: Omit<Edge, 'id'> & {id?: string}, baseRevision: number): Edge {
    this.guard(baseRevision);
    this.findNode(input.from);
    this.findNode(input.to);
    this.findFunc(input.funcId);
    if (!Number.isFinite(input.cost) || input.cost < 0) throw new ValidationError('cost must be a non-negative number');
    const id = input.id?.trim() || `edge-${randomUUID().slice(0, 8)}`;
    const edge: Edge = {
      id,
      from: input.from,
      to: input.to,
      funcId: input.funcId,
      cost: input.cost,
      reversible: Boolean(input.reversible),
      condition: input.condition,
    };
    const existing = this.graph.edges.findIndex((e) => e.id === id);
    if (existing >= 0) this.graph.edges[existing] = edge;
    else this.graph.edges.push(edge);
    this.bump();
    // Cycles are allowed — diagnostics simply report the back edge.
    return structuredClone(edge);
  }

  deleteEdge(id: string, baseRevision: number): void {
    this.guard(baseRevision);
    const before = this.graph.edges.length;
    this.graph.edges = this.graph.edges.filter((e) => e.id !== id);
    if (this.graph.edges.length === before) throw new ValidationError(`unknown edge "${id}"`);
    this.bump();
  }

  // ---- runs ---------------------------------------------------------------

  /**
   * Freeze a run: every step is copied and the function source is bound to the
   * revision current at creation time. Later edits — even a publish that
   * happens a millisecond later — cannot change what this run executes.
   */
  createRun(input: {
    experimentId?: string;
    steps: PathStep[];
    sample: JsonObject;
  }): {run: Run; abort: AbortController} {
    const bound: BoundStep[] = [];
    for (const step of input.steps) {
      const edge = this.graph.edges.find((e) => e.id === step.edgeId);
      if (!edge) throw new ValidationError(`unknown edge "${step.edgeId}"`);
      const func = this.graph.funcs.find((f) => f.id === step.funcId);
      if (!func) throw new ValidationError(`unknown function "${step.funcId}"`);
      const revisionNumber = step.funcRevision > 0 ? Math.min(step.funcRevision, func.revision) : func.revision;
      const rev = func.revisions[revisionNumber - 1];
      if (!rev) throw new ValidationError(`function "${func.id}" has no revision ${revisionNumber}`);
      bound.push({
        step: {...step, funcRevision: revisionNumber, condition: edge.condition ?? rev.condition},
        source: rev.source,
      });
    }
    const run: Run = {
      id: `run-${randomUUID().slice(0, 8)}`,
      experimentId: input.experimentId,
      pathKey: input.steps.map((s) => s.edgeId).join('>'),
      steps: bound.map((b) => b.step),
      sample: structuredClone(input.sample),
      status: 'queued',
      totalCost: bound.reduce((sum, b) => sum + b.step.cost, 0),
      results: [],
      createdAt: new Date().toISOString(),
    };
    this.runs.set(run.id, {run, abort: new AbortController(), graphRevision: this.revision, bound});
    return {run, abort: this.runs.get(run.id)!.abort};
  }

  getRun(id: string): Run | undefined {
    const pending = this.runs.get(id);
    return pending ? structuredClone(pending.run) : undefined;
  }

  /** Mutable live record — only the executor uses this. */
  getLiveRun(id: string): Run | undefined {
    return this.runs.get(id)?.run;
  }

  getBound(id: string): BoundStep[] | undefined {
    return this.runs.get(id)?.bound;
  }

  getAbortController(id: string): AbortController | undefined {
    return this.runs.get(id)?.abort;
  }

  getRunGraphRevision(id: string): number | undefined {
    return this.runs.get(id)?.graphRevision;
  }

  getNodeSchema(id: string) {
    return this.graph.nodes.find((n) => n.id === id)?.schema;
  }
}

export type BoundStep = {step: PathStep; source: string};
