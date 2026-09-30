import type {
  CandidatePath,
  Edge,
  Func,
  JsonObject,
  Node,
  PathStep,
  SchemaIssue,
} from './types';
import {checkSchema} from './schema';
import {pathKey, totalCost} from './graph';

/**
 * A sandboxed way to apply a bound function / evaluate a condition without
 * performing real (slow or side-effecting) work. Methods may be sync or async;
 * the server's VM preview resolves sleeps instantly, tests can supply fakes.
 */
export interface PreviewRuntime {
  apply(step: PathStep, doc: JsonObject): Promise<JsonObject> | JsonObject;
  check(condition: string | undefined, step: PathStep, doc: JsonObject): Promise<boolean> | boolean;
}

type Resolved = {
  edge: Edge;
  from?: Node;
  to?: Node;
  func?: Func;
};

function resolveEdge(
  edgeId: string,
  index: Map<string, Edge>,
  nodes: Map<string, Node>,
  funcs: Map<string, Func>,
): Resolved | null {
  const edge = index.get(edgeId);
  if (!edge) return null;
  return {
    edge,
    from: nodes.get(edge.from),
    to: nodes.get(edge.to),
    func: funcs.get(edge.funcId),
  };
}

/**
 * Validate one candidate path:
 *  - every edge / endpoint / function must resolve;
 *  - each edge's input/output schema must match the connecting revisions
 *    (composition is checked edge by edge against the projected document);
 *  - conditions are evaluated against a doc projected by running each bound
 *    function through the preview runtime.
 *
 * A rejected condition or a throw during preview never removes the path: it
 * stays in the result list with an explicit verdict so the UI can show why.
 */
export async function validatePath(
  edgeIds: string[],
  sample: JsonObject,
  ctx: {nodes: Map<string, Node>; edges: Map<string, Edge>; funcs: Map<string, Func>},
  runtime: PreviewRuntime,
): Promise<CandidatePath> {
  const steps: PathStep[] = [];
  const issues: SchemaIssue[] = [];
  let valid = true;
  let reversibleOnly = true;
  let projected: JsonObject = sample;
  let conditionStatus: CandidatePath['conditionStatus'] = 'satisfied';
  let rejectedAtEdge: string | undefined;
  let rejectedReason: string | undefined;

  for (const edgeId of edgeIds) {
    const resolved = resolveEdge(edgeId, ctx.edges, ctx.nodes, ctx.funcs);
    if (!resolved) {
      issues.push({kind: 'unknown_node', edgeId, endpoint: 'from', nodeId: edgeId});
      valid = false;
      reversibleOnly = false;
      continue;
    }
    const {edge, from, to, func} = resolved;
    if (!from) {
      issues.push({kind: 'unknown_node', edgeId, endpoint: 'from', nodeId: edge.from});
      valid = false;
    }
    if (!to) {
      issues.push({kind: 'unknown_node', edgeId, endpoint: 'to', nodeId: edge.to});
      valid = false;
    }
    if (!func) {
      issues.push({kind: 'unknown_func', edgeId, funcId: edge.funcId});
      valid = false;
    }
    if (!edge.reversible) reversibleOnly = false;

    const step: PathStep = {
      edgeId: edge.id,
      from: edge.from,
      to: edge.to,
      funcId: edge.funcId,
      funcRevision: func ? func.revision : 0,
      cost: edge.cost,
      reversible: edge.reversible,
      condition: edge.condition ?? func?.revisions[func.revision - 1]?.condition,
    };
    steps.push(step);

    if (from && func) {
      const inputError = checkSchema(from.schema, projected);
      if (inputError) {
        issues.push({kind: 'input_mismatch', edgeId, detail: inputError});
        valid = false;
      }
    }

    // Once a condition rejects or projection fails we cannot evaluate the
    // remainder: keep collecting metadata but mark the verdict precisely.
    if (from && to && func && conditionStatus === 'satisfied') {
      let met = true;
      try {
        met = await runtime.check(step.condition, step, projected);
      } catch (error) {
        conditionStatus = 'unknown';
        rejectedReason = `condition failed: ${(error as Error).message}`;
      }
      if (conditionStatus === 'satisfied' && !met) {
        conditionStatus = 'rejected';
        rejectedAtEdge = edgeId;
        rejectedReason = 'condition predicate returned false for the current document';
      }

      if (conditionStatus === 'satisfied') {
        try {
          projected = await runtime.apply(step, projected);
        } catch (error) {
          conditionStatus = 'unknown';
          rejectedReason = `function "${func.id}" r${func.revision} failed during preview: ${(error as Error).message}`;
        }
      }
    }

    if (to && func && conditionStatus === 'satisfied') {
      const outputError = checkSchema(to.schema, projected);
      if (outputError) {
        issues.push({kind: 'output_mismatch', edgeId, detail: outputError});
        valid = false;
      }
    }
  }

  return {
    key: pathKey(edgeIds),
    steps,
    edgeIds: [...edgeIds],
    totalCost: totalCost(steps),
    reversibleOnly,
    valid,
    schemaIssues: issues,
    rejectedAtEdge,
    rejectedReason,
    conditionStatus,
    projected: conditionStatus === 'satisfied' ? projected : undefined,
  };
}

/**
 * Rank candidates: cost first (never hop count), then stable key as
 * tie-breaker so the UI order is deterministic under concurrent edits.
 */
export function rankCandidates(candidates: CandidatePath[]): CandidatePath[] {
  return [...candidates].sort((a, b) => a.totalCost - b.totalCost || a.key.localeCompare(b.key));
}

export function describeIssue(issue: SchemaIssue): string {
  switch (issue.kind) {
    case 'unknown_node':
      return `${issue.edgeId}: unknown ${issue.endpoint} node "${issue.nodeId}"`;
    case 'unknown_func':
      return `${issue.edgeId}: unknown function "${issue.funcId}"`;
    case 'input_mismatch':
      return `${issue.edgeId}: input schema mismatch — ${issue.detail}`;
    case 'output_mismatch':
      return `${issue.edgeId}: output schema mismatch — ${issue.detail}`;
  }
}
