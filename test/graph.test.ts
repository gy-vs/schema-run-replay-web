import {describe, expect, it} from 'vitest';
import {detectCycles, findSimplePaths, buildAdjacency, totalCost, materializeSteps, buildEdgeIndex} from '../src/common/graph';
import {rankCandidates, validatePath, type PreviewRuntime} from '../src/common/validate';
import {checkSchema} from '../src/common/schema';
import {seedGraph} from '../src/common/seed';
import type {CandidatePath, JsonObject, PathStep} from '../src/common/types';

const graph = seedGraph();
const adj = buildAdjacency(graph.edges);
const edgeIndex = buildEdgeIndex(graph.edges);
const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
const funcMap = new Map(graph.funcs.map((f) => [f.id, f]));

/** Deterministic local runtime mirroring the seed functions for unit tests. */
function localRuntime(): PreviewRuntime {
  return {
    apply(step, doc) {
      const fn: Record<string, (d: JsonObject) => JsonObject> = {
        'add-age': (d) => ({...d, age: typeof d.age === 'number' ? d.age : 0}),
        'strict-add-age': (d) => {
          if (typeof d.name !== 'string' || !d.name.trim()) throw new Error('name required');
          return {...d, age: typeof d.age === 'number' ? d.age : 0};
        },
        'add-tier': (d) => ({...d, tier: typeof d.tier === 'string' ? d.tier : 'standard'}),
        'broken-tier': () => {
          throw new Error('tier service unavailable');
        },
        'slow-stamp': (d) => ({
          ...d,
          age: typeof d.age === 'number' ? d.age : 0,
          tier: typeof d.tier === 'string' ? d.tier : 'standard',
        }),
        'rename-name': (d) => {
          const {name, ...rest} = d;
          return {...rest, fullName: String(name)};
        },
        'drop-age': (d) => {
          const {age, ...rest} = d;
          return rest;
        },
        'drop-tier': (d) => {
          const {tier, ...rest} = d;
          return rest;
        },
        unrename: (d) => {
          const {fullName, ...rest} = d;
          return {...rest, name: String(fullName)};
        },
      };
      return fn[step.funcId](doc);
    },
    check(condition, _step, doc) {
      if (!condition) return true;
      if (condition.includes('platinum')) return (doc as {tier?: string}).tier === 'platinum';
      if (condition.includes('gold') || condition.includes('standard')) {
        return (doc as {tier?: string}).tier === 'gold' || (doc as {tier?: string}).tier === 'standard';
      }
      return false;
    },
  };
}

async function allPaths(start: string, goal: string, sample: JsonObject): Promise<CandidatePath[]> {
  const edgeIdPaths = findSimplePaths(adj, start, goal, 24);
  const candidates = [];
  for (const ids of edgeIdPaths) {
    candidates.push(await validatePath(ids, sample, {nodes: nodeMap, edges: edgeIndex, funcs: funcMap}, localRuntime()));
  }
  return rankCandidates(candidates);
}

describe('path enumeration', () => {
  it('finds multiple EQUIVALENT paths v1 -> v3 and ranks by COST, never hop count', async () => {
    const candidates = await allPaths('v1', 'v3', {name: 'Ada'});
    // e4+e2 (cost 3, strict-add-age + add-tier), e1+e2 (cost 5), e1+e10(cost 4, fails),
    // e1+e2+e7+e2 would repeat v2? No — v3->v2 then v2->v3 repeats node v3.
    // Also long detour v1->v2->v3->v4->v3 repeats v3 — excluded (simple paths).
    const keys = candidates.map((c) => c.key);
    expect(keys).toContain('e1>e2');
    expect(keys).toContain('e3');
    expect(keys).toContain('e4>e2');
    expect(keys).toContain('e1>e10');

    // The single-hop path e3 must NOT be first: it costs 8 vs multi-hop cheap ones.
    expect(candidates[0].totalCost).toBeLessThan(candidates.find((c) => c.key === 'e3')!.totalCost);
    // Costs are non-decreasing after ranking.
    const costs = candidates.map((c) => c.totalCost);
    expect(costs).toEqual([...costs].sort((a, b) => a - b));
  });

  it('rollback/back-edge path v3 -> v1 is offered through drop edges', async () => {
    const candidates = await allPaths('v3', 'v1', {name: 'Ada', age: 30, tier: 'gold'});
    expect(candidates.map((c) => c.key)).toContain('e7>e6');
    const back = candidates.find((c) => c.key === 'e7>e6')!;
    expect(back.reversibleOnly).toBe(true);
    expect(back.valid).toBe(true);
  });
});

describe('condition applicability', () => {
  it('marks a path rejected when an edge condition is not satisfied, without dropping it', async () => {
    const candidates = await allPaths('v3', 'v4', {name: 'Ada', age: 30, tier: 'standard'});
    const platinum = candidates.find((c) => c.key === 'e8');
    expect(platinum).toBeTruthy();
    expect(platinum!.conditionStatus).toBe('rejected');
    expect(platinum!.rejectedAtEdge).toBe('e8');
    // The satisfiable edge stays available.
    const normal = candidates.find((c) => c.key === 'e5')!;
    expect(normal.conditionStatus).toBe('satisfied');
  });

  it('evaluates conditions against the PROJECTED document, not the seed', async () => {
    // Seed has no tier; e5's inherited function condition needs tier standard,
    // which is only added mid-path. v1->v3 via slow-stamp then e5 must pass.
    const candidates = await allPaths('v1', 'v4', {name: 'Ada'});
    const viaStamp = candidates.find((c) => c.key === 'e3>e5');
    expect(viaStamp?.conditionStatus).toBe('satisfied');
  });
});

describe('composition schema checks', () => {
  it('flags output schema mismatches edge by edge', async () => {
    checkSchema; // import sanity
    const badStep: PathStep = {edgeId: 'x', from: 'v1', to: 'v2', funcId: 'add-age', funcRevision: 1, cost: 1, reversible: true};
    const fakeRuntime: PreviewRuntime = {
      apply: async () => ({name: 'Ada'}), // missing required age
      check: () => true,
    };
    const candidate = await validatePath(['x'], {name: 'Ada'}, {
      nodes: nodeMap,
      edges: new Map([['x', {id: 'x', from: 'v1', to: 'v2', funcId: 'add-age', cost: 1, reversible: true}]]),
      funcs: funcMap,
    }, fakeRuntime);
    expect(candidate.valid).toBe(false);
    expect(candidate.schemaIssues[0]?.kind).toBe('output_mismatch');
    expect(badStep.edgeId).toBe('x');
  });

  it('flags dangling edges and unknown functions', async () => {
    const candidate = await validatePath(['ghost'], {}, {nodes: nodeMap, edges: edgeIndex, funcs: funcMap}, localRuntime());
    expect(candidate.valid).toBe(false);
    expect(candidate.schemaIssues[0]?.kind).toBe('unknown_node');
  });
});

describe('cycle detection with allowed back edges', () => {
  it('detects back edges and cycles but keeps them usable', () => {
    const {backEdges, cycles} = detectCycles(graph.nodes, graph.edges);
    const ids = backEdges.map((b) => b.edgeId).sort();
    // v2->v1 (e6), v3->v2 (e7), v4->v3 (e9) all close cycles.
    expect(ids).toEqual(expect.arrayContaining(['e6', 'e7', 'e9']));
    expect(cycles.length).toBeGreaterThanOrEqual(3);
    // Graph diagnostics are attached and nothing is removed.
    expect(graph.edges.map((e) => e.id).sort()).toContain('e6');
  });

  it('never enumerates a candidate that revisits a node', () => {
    const paths = findSimplePaths(adj, 'v1', 'v3', 50);
    for (const ids of paths) {
      const {steps} = materializeSteps(ids, edgeIndex, graph.funcs);
      const nodes = steps.flatMap((s, i) => (i === 0 ? [s.from, s.to] : [s.to]));
      expect(new Set(nodes).size).toBe(nodes.length);
    }
  });
});

describe('costs', () => {
  it('sums edge costs', () => {
    const {steps} = materializeSteps(['e1', 'e2'], edgeIndex, graph.funcs);
    expect(totalCost(steps)).toBe(5);
  });
});
