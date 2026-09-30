import type {Edge, Func, Graph, Node} from './types';
import {buildDiagnostics} from './graph';

export function seedNodes(): Node[] {
  return [
    {
      id: 'v1',
      label: 'Customer r1',
      schema: {fields: [{name: 'name', type: 'string'}]},
    },
    {
      id: 'v2',
      label: 'Customer r2 (+age)',
      schema: {fields: [{name: 'name', type: 'string'}, {name: 'age', type: 'number'}]},
    },
    {
      id: 'v3',
      label: 'Customer r3 (+tier)',
      schema: {
        fields: [
          {name: 'name', type: 'string'},
          {name: 'age', type: 'number'},
          {name: 'tier', type: 'string'},
        ],
      },
    },
    {
      id: 'v4',
      label: 'Customer r4 (renamed)',
      schema: {
        fields: [
          {name: 'fullName', type: 'string'},
          {name: 'age', type: 'number'},
          {name: 'tier', type: 'string'},
        ],
      },
    },
  ];
}

export function seedFuncs(): Func[] {
  return [
    {
      id: 'add-age',
      name: 'Add default age',
      revision: 1,
      revisions: [
        {
          source: '(doc) => ({...doc, age: typeof doc.age === "number" ? doc.age : 0})',
          note: 'r1: default age zero',
          createdAt: new Date(0).toISOString(),
        },
      ],
    },
    {
      id: 'drop-age',
      name: 'Drop age (rollback)',
      revision: 1,
      revisions: [
        {
          source: '(doc) => {const {age, ...rest} = doc; return rest;}',
          note: 'inverse of add-age',
          createdAt: new Date(0).toISOString(),
        },
      ],
    },
    {
      id: 'add-tier',
      name: 'Add default tier',
      revision: 1,
      revisions: [
        {
          source: '(doc) => ({...doc, tier: typeof doc.tier === "string" ? doc.tier : "standard"})',
          note: 'r1: standard tier',
          createdAt: new Date(0).toISOString(),
        },
      ],
    },
    {
      id: 'drop-tier',
      name: 'Drop tier (rollback)',
      revision: 1,
      revisions: [
        {
          source: '(doc) => {const {tier, ...rest} = doc; return rest;}',
          note: 'inverse of add-tier',
          createdAt: new Date(0).toISOString(),
        },
      ],
    },
    {
      id: 'rename-name',
      name: 'Rename name -> fullName',
      revision: 1,
      revisions: [
        {
          source:
            '(doc) => {const {name, ...rest} = doc; return {...rest, fullName: doc.name};}',
          note: 'only for reviewed customers',
          condition: 'doc.tier === "gold" || doc.tier === "standard"',
          createdAt: new Date(0).toISOString(),
        },
      ],
    },
    {
      id: 'strict-add-age',
      name: 'Add age with validation',
      revision: 1,
      revisions: [
        {
          source:
            '(doc, ctx) => { if (typeof doc.name !== "string" || !doc.name.trim()) ctx.fail("name required before adding age"); return {...doc, age: typeof doc.age === "number" ? doc.age : 0}; }',
          note: 'rejects documents without a name',
          createdAt: new Date(0).toISOString(),
        },
      ],
    },
    {
      id: 'slow-stamp',
      name: 'Stamp age and tier with audit wait',
      revision: 1,
      revisions: [
        {
          // Artificially slow so cancellation and mid-run updates can be exercised.
          source:
            'async (doc, ctx) => { await ctx.sleep(400); return {...doc, age: typeof doc.age === "number" ? doc.age : 0, tier: typeof doc.tier === "string" ? doc.tier : "standard"}; }',
          note: 'r1: 400ms audit wait (edit to publish r2 while a run is in flight)',
          createdAt: new Date(0).toISOString(),
        },
      ],
    },
    {
      id: 'broken-tier',
      name: 'Tier writer (failing)',
      revision: 1,
      revisions: [
        {
          source:
            'async (doc, ctx) => { await ctx.sleep(20); ctx.fail("tier service unavailable"); }',
          note: 'always fails — used to demonstrate partial failure after step 1',
          createdAt: new Date(0).toISOString(),
        },
      ],
    },
    {
      id: 'unrename',
      name: 'Backtrack v4 -> v3',
      revision: 1,
      revisions: [
        {
          source:
            '(doc) => { const {fullName, ...rest} = doc; return {...rest, name: doc.fullName}; }',
          note: 'reverses rename-name for the detour back edge',
          createdAt: new Date(0).toISOString(),
        },
      ],
    },
  ];
}

export function seedEdges(): Edge[] {
  return [
    {id: 'e1', from: 'v1', to: 'v2', funcId: 'add-age', cost: 3, reversible: true},
    {id: 'e2', from: 'v2', to: 'v3', funcId: 'add-tier', cost: 2, reversible: true},
    // Equivalent to e1+e2 at the document level but more expensive and not
    // reversible — single hop, highest cost, so hop-count ranking would lose.
    {id: 'e3', from: 'v1', to: 'v3', funcId: 'slow-stamp', cost: 8, reversible: false},
    // Strict cheap alternative v1 -> v2. Fails on documents without a name.
    {id: 'e4', from: 'v1', to: 'v2', funcId: 'strict-add-age', cost: 1, reversible: false},
    // Fails at runtime — a path through it keeps the intermediate result from e1.
    {id: 'e10', from: 'v2', to: 'v3', funcId: 'broken-tier', cost: 1, reversible: false},
    {id: 'e5', from: 'v3', to: 'v4', funcId: 'rename-name', cost: 2, reversible: false},
    // Rollback / back edges — cycles are permitted in the graph.
    {id: 'e6', from: 'v2', to: 'v1', funcId: 'drop-age', cost: 3, reversible: true},
    {id: 'e7', from: 'v3', to: 'v2', funcId: 'drop-tier', cost: 2, reversible: true},
    {id: 'e9', from: 'v4', to: 'v3', funcId: 'unrename', cost: 4, reversible: false},
    // Conditional edge whose predicate fails for the default sample.
    {
      id: 'e8',
      from: 'v3',
      to: 'v4',
      funcId: 'rename-name',
      cost: 5,
      reversible: false,
      condition: 'doc.tier === "platinum"',
    },
  ];
}

export function seedGraph(): Graph {
  const nodes = seedNodes();
  const funcs = seedFuncs();
  const edges = seedEdges();
  return {nodes, funcs, edges, diagnostics: buildDiagnostics(nodes, funcs, edges)};
}

export const DEFAULT_SAMPLE = {name: 'Ada'} as const;
