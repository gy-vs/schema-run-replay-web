import type {BackEdge, Cycle, Edge, Func, GraphDiagnostics, Node, PathStep} from './types';

export type EdgeIndex = Map<string, Edge>;
export type Adjacency = Map<string, Edge[]>;

export function buildEdgeIndex(edges: Edge[]): EdgeIndex {
  return new Map(edges.map((e) => [e.id, e]));
}

export function buildAdjacency(edges: Edge[]): Adjacency {
  const adj: Adjacency = new Map();
  for (const edge of edges) {
    const list = adj.get(edge.from) ?? [];
    list.push(edge);
    adj.set(edge.from, list);
  }
  return adj;
}

/**
 * Enumerate simple paths (no repeated node) between two revisions.
 *
 * Cycles are allowed in the graph — back edges are normal edges here — but a
 * candidate path never revisits a node, because looping would make migration
 * costs unbounded. Results are returned in DFS order; ranking by cost happens
 * later (fewest edges must NOT be treated as best).
 */
export function findSimplePaths(
  adj: Adjacency,
  start: string,
  goal: string,
  limit: number,
): string[][] {
  const paths: string[][] = [];
  const stack: {node: string; edgeIds: string[]; seen: Set<string>}[] = [
    {node: start, edgeIds: [], seen: new Set([start])},
  ];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.node === goal) {
      paths.push(frame.edgeIds);
      if (paths.length >= limit) return paths;
      continue;
    }
    const outgoing = adj.get(frame.node) ?? [];
    // Push in reverse so ascending-id edges are explored first (stable output).
    for (let i = outgoing.length - 1; i >= 0; i--) {
      const edge = outgoing[i];
      if (frame.seen.has(edge.to)) continue;
      const seen = new Set(frame.seen);
      seen.add(edge.to);
      stack.push({node: edge.to, edgeIds: [...frame.edgeIds, edge.id], seen});
    }
  }
  return paths;
}

export function pathKey(edgeIds: string[]): string {
  return edgeIds.join('>');
}

export function materializeSteps(
  edgeIds: string[],
  index: EdgeIndex,
  funcs: Func[],
): {steps: PathStep[]; missing: string[]} {
  const funcById = new Map(funcs.map((f) => [f.id, f]));
  const steps: PathStep[] = [];
  const missing: string[] = [];
  for (const edgeId of edgeIds) {
    const edge = index.get(edgeId);
    if (!edge) {
      missing.push(edgeId);
      continue;
    }
    const func = funcById.get(edge.funcId);
    steps.push({
      edgeId: edge.id,
      from: edge.from,
      to: edge.to,
      funcId: edge.funcId,
      funcRevision: func ? func.revision : 0,
      cost: edge.cost,
      reversible: edge.reversible,
      condition: edge.condition ?? func?.revisions[func.revision - 1]?.condition,
    });
  }
  return {steps, missing};
}

/**
 * Detect back edges with a DFS colouring (white/gray/black): an edge to a gray
 * ancestor closes a cycle. Also reports strongly-connected components with
 * more than one node, plus self loops, as explicit cycles.
 */
export function detectCycles(nodes: Node[], edges: Edge[]): {backEdges: BackEdge[]; cycles: Cycle[]} {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const adj = buildAdjacency(edges);
  const colour = new Map<string, 0 | 1 | 2>();
  for (const id of nodeIds) colour.set(id, 0);
  const backEdges: BackEdge[] = [];

  // Parent tracking so we can reconstruct the node cycle each back edge closes.
  const parentEdge = new Map<string, string>();
  const cycles: Cycle[] = [];

  function walk(node: string): void {
    colour.set(node, 1);
    for (const edge of adj.get(node) ?? []) {
      if (!nodeIds.has(edge.to)) continue;
      if (edge.from === edge.to) {
        backEdges.push({edgeId: edge.id, from: edge.from, to: edge.to});
        cycles.push({nodeIds: [edge.from], edgeIds: [edge.id]});
        continue;
      }
      const targetColour = colour.get(edge.to) ?? 0;
      if (targetColour === 0) {
        parentEdge.set(edge.to, edge.id);
        walk(edge.to);
      } else if (targetColour === 1) {
        backEdges.push({edgeId: edge.id, from: edge.from, to: edge.to});
        // Reconstruct: edge.from ... edge.to via parent chain, then the back edge.
        const chainNodes: string[] = [edge.to];
        const chainEdges: string[] = [];
        let cursor = edge.from;
        while (cursor !== edge.to) {
          chainNodes.push(cursor);
          const pe = parentEdge.get(cursor);
          if (!pe) break;
          chainEdges.push(pe);
          cursor = (index.get(pe)!).from;
        }
        chainEdges.reverse();
        chainEdges.push(edge.id);
        cycles.push({nodeIds: chainNodes, edgeIds: chainEdges});
      }
    }
    colour.set(node, 2);
  }

  const index = buildEdgeIndex(edges);
  for (const id of [...nodeIds].sort()) {
    if ((colour.get(id) ?? 0) === 0) walk(id);
  }
  // Stable ordering.
  backEdges.sort((a, b) => a.edgeId.localeCompare(b.edgeId));
  cycles.sort((a, b) => a.edgeIds.join(',').localeCompare(b.edgeIds.join(',')));
  return {backEdges, cycles};
}

export function buildDiagnostics(nodes: Node[], funcs: Func[], edges: Edge[]): GraphDiagnostics {
  const {backEdges, cycles} = detectCycles(nodes, edges);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const funcIds = new Set(funcs.map((f) => f.id));
  const dangling: GraphDiagnostics['dangling'] = [];
  for (const edge of edges) {
    if (!nodeIds.has(edge.from)) dangling.push({edgeId: edge.id, reason: `unknown node "${edge.from}"`});
    else if (!nodeIds.has(edge.to)) dangling.push({edgeId: edge.id, reason: `unknown node "${edge.to}"`});
    else if (!funcIds.has(edge.funcId)) dangling.push({edgeId: edge.id, reason: `unknown function "${edge.funcId}"`});
  }
  return {backEdges, cycles, dangling};
}

/** Total cost — the real ranking key, unlike the edge count. */
export function totalCost(steps: Pick<PathStep, 'cost'>[]): number {
  return steps.reduce((sum, step) => sum + step.cost, 0);
}
