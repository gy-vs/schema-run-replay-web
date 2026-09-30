// Domain types shared by server and client.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | {[key: string]: JsonValue};
export type JsonObject = {[key: string]: JsonValue};

// A field in a revision schema. `optional` fields may be absent; records may
// carry extra fields unless `additional` is false.
export type FieldSpec = {name: string; type: 'string' | 'number' | 'boolean'; optional?: boolean};
export type Schema = {fields: FieldSpec[]; additional?: boolean};

export type Node = {id: string; label: string; schema: Schema};

export type FuncRevision = {
  /** body expression, e.g. "(doc, ctx) => ({...doc})" */
  source: string;
  /** optional predicate body; edge is applicable only when it returns truthy */
  condition?: string;
  note: string;
  createdAt: string;
};

export type Func = {
  id: string;
  name: string;
  revision: number; // latest revision number, 1-based
  revisions: FuncRevision[]; // index = revision - 1
};

export type Edge = {
  id: string;
  from: string;
  to: string;
  funcId: string;
  cost: number;
  reversible: boolean;
  /** condition carried by the edge itself (latest function condition used when absent) */
  condition?: string;
};

export type BackEdge = {edgeId: string; from: string; to: string};
export type Cycle = {nodeIds: string[]; edgeIds: string[]};
export type GraphDiagnostics = {
  backEdges: BackEdge[];
  cycles: Cycle[];
  /** edges whose endpoint or function references do not resolve */
  dangling: {edgeId: string; reason: string}[];
};

export type Graph = {
  nodes: Node[];
  funcs: Func[];
  edges: Edge[];
  diagnostics: GraphDiagnostics;
};

export type PathStep = {
  edgeId: string;
  from: string;
  to: string;
  funcId: string;
  /** revision the step is / will be bound to */
  funcRevision: number;
  cost: number;
  reversible: boolean;
  condition?: string;
};

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export type StepResult = {
  edgeId: string;
  from: string;
  to: string;
  funcId: string;
  funcRevision: number;
  cost: number;
  status: StepStatus;
  output?: JsonObject;
  /** error message when status === 'failed' */
  error?: string;
  /** false when the condition predicate rejected the input */
  conditionMet?: boolean;
  startedAt?: string;
  finishedAt?: string;
};

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type Run = {
  id: string;
  experimentId?: string;
  pathKey: string;
  steps: PathStep[];
  sample: JsonObject;
  status: RunStatus;
  totalCost: number;
  /** per-edge intermediate outputs; earlier results are kept after a failure */
  results: StepResult[];
  /** precise edge that stopped the run, if any */
  failedEdgeId?: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
};

export type SchemaIssue =
  | {kind: 'unknown_node'; edgeId: string; endpoint: 'from' | 'to'; nodeId: string}
  | {kind: 'unknown_func'; edgeId: string; funcId: string}
  | {kind: 'input_mismatch'; edgeId: string; detail: string}
  | {kind: 'output_mismatch'; edgeId: string; detail: string};

export type ConditionVerdict =
  | {met: true; projected: JsonObject}
  | {met: false; projected: JsonObject; reason: string}
  | {met: 'unknown'; reason: string};

export type CandidatePath = {
  key: string;
  steps: PathStep[];
  edgeIds: string[];
  totalCost: number;
  reversibleOnly: boolean;
  valid: boolean;
  schemaIssues: SchemaIssue[];
  /** first condition (edgeId) that rejects, when conditionStatus === 'rejected' */
  rejectedAtEdge?: string;
  rejectedReason?: string;
  conditionStatus: 'satisfied' | 'rejected' | 'unknown';
  /** final projected document from preview, when all conditions could be evaluated */
  projected?: JsonObject;
};

export type ApiError = {error: string; details?: unknown};
