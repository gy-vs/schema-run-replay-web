import type {JsonObject, Run, StepResult} from '../common/types';
import {checkSchema} from '../common/schema';
import {MigrationError, MigrationRuntime} from './runtime';
import type {StudioStore} from './store';

/**
 * Execute a run edge by edge.
 *
 * Guarantees:
 *  - every edge's applicability condition is evaluated on the current
 *    intermediate document;
 *  - a failing edge stops the run, but every earlier intermediate output and
 *    the precise edge id are retained on the run record;
 *  - cancellation is observed between and during (ctx.sleep) steps;
 *  - bound function revisions never change mid-run even if the graph is
 *    concurrently edited (the bound snapshot is captured at creation).
 */
export class RunExecutor {
  constructor(
    private readonly store: StudioStore,
    private readonly runtime: MigrationRuntime,
  ) {}

  async start(runId: string): Promise<Run> {
    const run = this.store.getLiveRun(runId);
    const bound = this.store.getBound(runId);
    const abort = this.store.getAbortController(runId);
    if (!run || !bound || !abort) throw new Error(`unknown run ${runId}`);

    run.status = 'running';
    let current: JsonObject = structuredClone(run.sample);
    const results: StepResult[] = [];

    for (const item of bound) {
      const {step, source} = item;
      if (abort.signal.aborted) {
        this.finishCancelled(run, results, step.edgeId);
        return this.store.getRun(runId)!;
      }
      const base: StepResult = {
        edgeId: step.edgeId,
        from: step.from,
        to: step.to,
        funcId: step.funcId,
        funcRevision: step.funcRevision,
        cost: step.cost,
        status: 'running',
        startedAt: new Date().toISOString(),
      };
      results.push(base);

      // 0. composition guard: the current intermediate document must conform
      // to this edge's input revision schema before binding its function.
      const inputSchema = this.store.getNodeSchema(step.from);
      if (inputSchema) {
        const mismatch = checkSchema(inputSchema, current);
        if (mismatch) {
          this.failAt(run, results, base, step.edgeId, `input schema mismatch: ${mismatch}`);
          return this.store.getRun(runId)!;
        }
      }

      // 1. applicability gate — condition on the current intermediate document
      let conditionMet: boolean;
      try {
        conditionMet = this.runtime.evaluate(step.condition, current);
      } catch (error) {
        this.failAt(run, results, base, step.edgeId, `condition error: ${(error as Error).message}`);
        return this.store.getRun(runId)!;
      }
      if (!conditionMet) {
        this.failAt(run, results, {...base, conditionMet: false}, step.edgeId,
          'condition predicate returned false for the current document');
        return this.store.getRun(runId)!;
      }
      base.conditionMet = true;

      // 2. invoke the pinned function revision
      try {
        const output = await this.runtime.invoke(step, current, source, {signal: abort.signal});
        const outputSchema = this.store.getNodeSchema(step.to);
        if (outputSchema) {
          const mismatch = checkSchema(outputSchema, output);
          if (mismatch) {
            results[results.length - 1] = {
              ...base,
              status: 'failed',
              output,
              error: `output schema mismatch: ${mismatch}`,
              finishedAt: new Date().toISOString(),
            };
            run.results = results;
            run.status = 'failed';
            run.failedEdgeId = step.edgeId;
            run.error = `output schema mismatch: ${mismatch}`;
            run.finishedAt = new Date().toISOString();
            return this.store.getRun(runId)!;
          }
        }
        results[results.length - 1] = {
          ...base,
          status: 'done',
          output,
          finishedAt: new Date().toISOString(),
        };
        current = output;
      } catch (error) {
        if (error instanceof MigrationError && error.code === 'cancelled') {
          this.finishCancelled(run, results, step.edgeId);
          return this.store.getRun(runId)!;
        }
        if (abort.signal.aborted) {
          this.finishCancelled(run, results, step.edgeId);
          return this.store.getRun(runId)!;
        }
        this.failAt(run, results, base, step.edgeId,
          error instanceof MigrationError ? error.message : `function threw: ${(error as Error).message}`);
        return this.store.getRun(runId)!;
      }
    }

    run.results = results;
    run.status = 'succeeded';
    run.finishedAt = new Date().toISOString();
    return this.store.getRun(runId)!;
  }

  cancel(runId: string): boolean {
    const abort = this.store.getAbortController(runId);
    if (!abort) return false;
    const run = this.store.getLiveRun(runId)!;
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') return false;
    abort.abort();
    return true;
  }

  /** Record a precise failure: earlier intermediate results stay intact. */
  private failAt(run: Run, results: StepResult[], base: StepResult, edgeId: string, message: string): void {
    results[results.length - 1] = {
      ...base,
      status: 'failed',
      error: message,
      finishedAt: new Date().toISOString(),
    };
    run.results = results;
    run.status = 'failed';
    run.failedEdgeId = edgeId;
    run.error = message;
    run.finishedAt = new Date().toISOString();
  }

  private finishCancelled(run: Run, results: StepResult[], atEdgeId: string): void {
    const last = results[results.length - 1];
    if (last && last.edgeId === atEdgeId && last.status === 'running') {
      results[results.length - 1] = {...last, status: 'skipped', finishedAt: new Date().toISOString()};
    }
    run.results = results;
    run.status = 'cancelled';
    run.error = 'cancelled by user';
    run.finishedAt = new Date().toISOString();
  }
}
