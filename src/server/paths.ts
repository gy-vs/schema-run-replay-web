import type {CandidatePath, Graph, JsonObject, PathStep} from '../common/types';
import {buildAdjacency, buildEdgeIndex, findSimplePaths} from '../common/graph';
import {rankCandidates, validatePath, type PreviewRuntime} from '../common/validate';
import {MigrationRuntime} from './runtime';

const MAX_PATHS = 24;

/** Preview runtime backed by the VM sandbox: sleeps resolve instantly. */
class SandboxPreview implements PreviewRuntime {
  constructor(private readonly runtime: MigrationRuntime, private readonly graph: Graph) {}

  async apply(step: PathStep, doc: JsonObject): Promise<JsonObject> {
    const func = this.graph.funcs.find((f) => f.id === step.funcId);
    if (!func) throw new Error(`unknown function "${step.funcId}"`);
    const source = func.revisions[step.funcRevision - 1].source;
    return this.runtime.invoke(step, doc, source, {preview: true});
  }

  check(condition: string | undefined, _step: PathStep, doc: JsonObject): boolean {
    return this.runtime.evaluate(condition, doc);
  }
}

export type QueryOptions = {
  start: string;
  goal: string;
  sample: JsonObject;
  reversibleOnly?: boolean;
};

/**
 * Enumerate every simple path start -> goal, validate composition edge by
 * edge (schemas, function applicability, projected conditions) and rank by
 * real total cost — never by hop count.
 */
export async function queryPaths(
  graph: Graph,
  runtime: MigrationRuntime,
  options: QueryOptions,
): Promise<CandidatePath[]> {
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  if (!nodeMap.has(options.start) || !nodeMap.has(options.goal)) {
    throw Object.assign(new Error('unknown start or goal node'), {statusCode: 400});
  }

  const edgeIndex = buildEdgeIndex(graph.edges);
  const funcMap = new Map(graph.funcs.map((f) => [f.id, f]));
  const adj = buildAdjacency(graph.edges);
  const rawPaths = findSimplePaths(adj, options.start, options.goal, MAX_PATHS);
  const preview = new SandboxPreview(runtime, graph);

  const candidates: CandidatePath[] = [];
  for (const edgeIds of rawPaths) {
    const candidate = await validatePath(edgeIds, options.sample, {
      nodes: nodeMap,
      edges: edgeIndex,
      funcs: funcMap,
    }, preview);
    if (options.reversibleOnly && !candidate.reversibleOnly) continue;
    candidates.push(candidate);
  }
  return rankCandidates(candidates);
}
