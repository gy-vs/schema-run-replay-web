import type {CandidatePath, Edge, Func, Graph, JsonObject, Run} from '../common/types';

async function parse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & {error?: string; details?: unknown};
  if (!response.ok) {
    const error = new Error(body.error ?? `request failed (${response.status})`) as Error & {
      status: number;
      body: unknown;
    };
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export const api = {
  async bootstrap() {
    return parse<{revision: number; defaultSample: JsonObject; nodeCount: number; edgeCount: number; funcCount: number}>(
      await fetch('/api/bootstrap'),
    );
  },

  async graph(): Promise<{revision: number; graph: Graph}> {
    return parse(await fetch('/api/graph'));
  },

  async paths(input: {start: string; goal: string; sample: JsonObject; reversibleOnly?: boolean}) {
    return parse<{revision: number; candidates: CandidatePath[]}>(
      await fetch('/api/paths', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(input),
      }),
    );
  },

  async compare(input: {start: string; goal: string; sample: JsonObject; reversibleOnly?: boolean}) {
    return parse<{
      experimentId: string;
      graphRevision: number;
      candidates: CandidatePath[];
      runs: {key: string; runId?: string; rejected?: string; status: string}[];
    }>(
      await fetch('/api/compare', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(input),
      }),
    );
  },

  async run(input: {steps: Run['steps']; sample: JsonObject; experimentId?: string}) {
    return parse<Run>(
      await fetch('/api/runs', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(input),
      }),
    );
  },

  async runStatus(id: string) {
    return parse<Run>(await fetch(`/api/runs/${id}`));
  },

  async cancel(id: string) {
    return parse<Run>(
      await fetch(`/api/runs/${id}/cancel`, {method: 'POST', headers: {'content-type': 'application/json'}}),
    );
  },

  async publishRevision(funcId: string, input: {source: string; condition?: string; note: string; baseRevision: number}) {
    return parse<{func: Func; revision: number; graph: Graph}>(
      await fetch(`/api/funcs/${funcId}/revisions`, {
        method: 'PUT',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(input),
      }),
    );
  },

  async createFunction(input: {id?: string; name: string; source: string; condition?: string; note: string; baseRevision: number}) {
    return parse<{func: Func; revision: number; graph: Graph}>(
      await fetch('/api/funcs', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(input),
      }),
    );
  },

  async upsertEdge(input: Partial<Edge> & {from: string; to: string; funcId: string; cost: number; baseRevision: number}) {
    const id = input.id ? `/${input.id}` : '';
    const method = input.id ? 'PUT' : 'POST';
    return parse<{edge: Edge; revision: number; graph: Graph}>(
      await fetch(`/api/edges${id}`, {
        method,
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(input),
      }),
    );
  },

  async deleteEdge(id: string, baseRevision: number) {
    return parse<{revision: number; graph: Graph}>(
      await fetch(`/api/edges/${id}?baseRevision=${baseRevision}`, {method: 'DELETE'}),
    );
  },
};
