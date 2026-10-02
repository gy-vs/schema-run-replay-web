import express, {type NextFunction, type Request, type Response} from 'express';
import {fileURLToPath} from 'node:url';
import type {FuncRevision, JsonObject, PathStep} from '../common/types';
import {DEFAULT_SAMPLE} from '../common/seed';
import {queryPaths} from './paths';
import {MigrationRuntime} from './runtime';
import {RevisionConflictError, StudioStore, ValidationError} from './store';
import {RunExecutor} from './executor';
import {ReplayService} from './replay';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;
const wrap =
  (handler: AsyncHandler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };

export type ExperimentResponse = {
  experimentId: string;
  sample: JsonObject;
  graphRevision: number;
  candidates: Awaited<ReturnType<typeof queryPaths>>;
  runs: {key: string; runId?: string; rejected?: string; status: string}[];
};

export function createApp(store = new StudioStore()) {
  const app = express();
  app.use(express.json({limit: '1mb'}));
  const runtime = new MigrationRuntime();
  const executor = new RunExecutor(store, runtime);
  const replays = new ReplayService(store, runtime, executor);

  function graphPayload() {
    return {revision: store.getRevision(), graph: store.snapshot()};
  }

  app.get('/api/bootstrap', (_req, res) => {
    const {graph, revision} = {graph: store.snapshot(), revision: store.getRevision()};
    res.json({
      family: 'schema-evolution',
      revision,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      funcCount: graph.funcs.length,
      defaultSample: DEFAULT_SAMPLE,
    });
  });

  app.get('/api/graph', (_req, res) => {
    res.set('ETag', String(store.getRevision()));
    res.json(graphPayload());
  });

  // ---- function revisions -------------------------------------------------

  app.get('/api/funcs/:id', (req, res) => {
    const func = store.snapshot().funcs.find((f) => f.id === req.params.id as string);
    if (!func) return res.status(404).json({error: 'not_found'});
    res.json(func);
  });

  app.post('/api/funcs', wrap(async (req, res) => {
    const body = req.body ?? {};
    const revision = parseRevision(body);
    const func = store.createFunc(
      {id: body.id, name: String(body.name ?? 'New function'), revision},
      integer(body.baseRevision),
    );
    res.status(201).json({func, ...graphPayload()});
  }));

  // Publish a NEW revision of a function. Existing edges and running
  // executions keep binding to the revision they started with.
  app.put('/api/funcs/:id/revisions', wrap(async (req, res) => {
    const revision = parseRevision(req.body);
    const func = store.addFuncRevision(req.params.id as string, revision, integer(req.body.baseRevision));
    res.json({func, ...graphPayload()});
  }));

  // ---- graph edits (optimistic concurrency via baseRevision) --------------

  app.put('/api/edges/:id', wrap(async (req, res) => {
    const edge = store.upsertEdge({...req.body, id: req.params.id as string}, integer(req.body.baseRevision));
    res.json({edge, ...graphPayload()});
  }));

  app.post('/api/edges', wrap(async (req, res) => {
    const edge = store.upsertEdge(req.body ?? {}, integer(req.body.baseRevision));
    res.status(201).json({edge, ...graphPayload()});
  }));

  app.delete('/api/edges/:id', wrap(async (req, res) => {
    store.deleteEdge(req.params.id as string, integer(String(req.query.baseRevision)));
    res.json(graphPayload());
  }));

  app.put('/api/nodes/:id', wrap(async (req, res) => {
    const node = store.upsertNode({...req.body, id: req.params.id as string}, integer(req.body.baseRevision));
    res.json({node, ...graphPayload()});
  }));

  // ---- path queries -------------------------------------------------------

  app.post('/api/paths', wrap(async (req, res) => {
    const {start, goal, sample, reversibleOnly} = readQuery(req.body);
    const candidates = await queryPaths(store.snapshot(), runtime, {start, goal, sample, reversibleOnly});
    res.json({revision: store.getRevision(), start, goal, sample, candidates});
  }));

  // ---- runs ---------------------------------------------------------------

  app.post('/api/runs', wrap(async (req, res) => {
    const steps = readSteps(req.body?.steps);
    const sample = asObject(req.body?.sample);
    const {run} = store.createRun({experimentId: asString(req.body?.experimentId), steps, sample});
    // Execute detached; clients poll (or the compare endpoint fans out).
    void executor.start(run.id).catch(() => undefined);
    res.status(201).json(run);
  }));

  app.get('/api/runs/:id', (req, res) => {
    const run = store.getRun(req.params.id as string);
    if (!run) return res.status(404).json({error: 'not_found'});
    res.json(run);
  });

  app.post('/api/runs/:id/cancel', (req, res) => {
    const ok = executor.cancel(req.params.id as string);
    if (!ok) return res.status(409).json({error: 'not_cancellable'});
    const run = store.getRun(req.params.id as string);
    res.json(run);
  });

  // ---- experiment: compare multiple paths on one fixed sample -------------

  app.post('/api/compare', wrap(async (req, res) => {
    const {start, goal, sample, reversibleOnly} = readQuery(req.body);
    const candidates = await queryPaths(store.snapshot(), runtime, {start, goal, sample, reversibleOnly});
    const experimentId = `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const runs: ExperimentResponse['runs'] = [];
    for (const candidate of candidates) {
      // Skip only paths composition cannot accept. A function that throws in
      // preview still gets executed: runtime failure is itself a comparison
      // result (with prior intermediate outputs retained).
      if (!candidate.valid || candidate.conditionStatus === 'rejected') {
        runs.push({
          key: candidate.key,
          status: 'rejected',
          rejected:
            candidate.conditionStatus === 'rejected'
              ? `condition not met at ${candidate.rejectedAtEdge ?? ''}: ${candidate.rejectedReason ?? ''}`
              : candidate.rejectedReason ??
                candidate.schemaIssues.map((i) => `${i.kind}:${i.edgeId}`).join('; '),
        });
        continue;
      }
      const {run} = store.createRun({experimentId, steps: candidate.steps, sample});
      void executor.start(run.id).catch(() => undefined);
      runs.push({key: candidate.key, runId: run.id, status: run.status});
    }
    const response: ExperimentResponse = {
      experimentId,
      sample,
      graphRevision: store.getRevision(),
      candidates,
      runs,
    };
    res.status(201).json(response);
  }));

  // ---- historical replay: old finished run vs. the current graph ----------

  app.post('/api/replays', wrap(async (req, res) => {
    const body = req.body ?? {};
    const historicalRunId = asString(body.historicalRunId);
    if (!historicalRunId) throw new ValidationError('historicalRunId is required');
    const replay = await replays.create({
      historicalRunId,
      start: asString(body.start),
      goal: asString(body.goal),
      pathKey: asString(body.pathKey),
      baseRevision: body.baseRevision === undefined ? undefined : integer(body.baseRevision),
    });
    // Return the LIVE view: if the fresh run is already in flight the client
    // can poll this same URL for its partial intermediate outputs.
    res.status(201).json(replays.getLive(replay.id) ?? replay);
  }));

  app.get('/api/replays', (_req, res) => {
    res.json({revision: store.getRevision(), replays: store.listReplays()});
  });

  app.get('/api/replays/:id', (req, res) => {
    const replay = replays.getLive(req.params.id as string);
    if (!replay) return res.status(404).json({error: 'not_found'});
    res.json(replay);
  });

  // Cancel only the NEW side of a comparison; the historical record is fact.
  app.post('/api/replays/:id/cancel', (req, res) => {
    const replay = replays.cancel(req.params.id as string);
    if (!replay) return res.status(404).json({error: 'not_found'});
    if (replay.status === 'completed' || replay.status === 'cancelled') {
      return res.status(409).json({error: 'not_cancellable'});
    }
    res.json(replays.getLive(replay.id) ?? replay);
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof RevisionConflictError) {
      return res.status(409).json({error: 'revision_conflict', current: error.current, ...graphPayload()});
    }
    if (error instanceof ValidationError) {
      return res.status(422).json({error: 'validation_error', details: error.message});
    }
    const status = (error as {statusCode?: number})?.statusCode ?? 500;
    res.status(status).json({error: 'internal_error', details: (error as Error).message});
  });

  return app;
}

// ---- request parsing helpers ---------------------------------------------

function integer(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new ValidationError('baseRevision must be an integer');
  return n;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asObject(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('sample must be a JSON object');
  }
  return value as JsonObject;
}

function parseRevision(body: any): FuncRevision {
  const source = String(body?.source ?? '').trim();
  if (!source) throw new ValidationError('source is required');
  const condition = typeof body.condition === 'string' && body.condition.trim() ? body.condition : undefined;
  return {source, condition, note: String(body.note ?? ''), createdAt: new Date().toISOString()};
}

function readQuery(body: any) {
  const start = asString(body?.start);
  const goal = asString(body?.goal);
  if (!start || !goal) throw new ValidationError('start and goal are required');
  const sample = asObject(body?.sample ?? DEFAULT_SAMPLE);
  return {start, goal, sample, reversibleOnly: Boolean(body?.reversibleOnly)};
}

function readSteps(value: unknown): PathStep[] {
  if (!Array.isArray(value) || value.length === 0) throw new ValidationError('steps must be a non-empty array');
  return value.map((raw) => ({
    edgeId: String(raw.edgeId),
    from: String(raw.from),
    to: String(raw.to),
    funcId: String(raw.funcId),
    funcRevision: Number(raw.funcRevision ?? 0),
    cost: Number(raw.cost ?? 0),
    reversible: Boolean(raw.reversible),
    condition: typeof raw.condition === 'string' ? raw.condition : undefined,
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
