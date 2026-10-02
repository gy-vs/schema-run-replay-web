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

// ---- historical replay comparison -----------------------------------------

export type ReplayStatus = 'preparing' | 'running' | 'completed' | 'cancelled';

/** The NEW side: everything is re-confirmed against one pinned graph state. */
export type FreshSide = {
  start: string;
  goal: string;
  /**
   * Candidate paths re-enumerated and re-ranked on the graph pinned at replay
   * creation — current costs and current function revisions, never the old
   * run's ranking. Frozen on the record so later edits cannot rewrite it.
   */
  candidates: CandidatePath[];
  /** key of the candidate chosen for the fresh execution */
  chosenKey?: string;
  runId?: string;
  /** set when no current candidate could be executed (no path / all rejected) */
  notExecutedReason?: string;
};

/** The OLD side: a frozen statement of what actually happened back then. */
export type HistoricalSide = {
  runId: string;
  /** graph revision the historical run was created against */
  graphRevision: number;
  /** frozen copy of the historical run — never re-bound to newer revisions */
  run: Run;
};

export type StepChange =
  | 'edge_changed'
  | 'revision_changed'
  | 'condition_changed'
  | 'cost_changed'
  | 'status_changed'
  | 'output_changed'
  | 'only_in_history'
  | 'only_in_fresh';

export type StepDiff = {
  index: number;
  oldStep?: PathStep;
  freshStep?: PathStep;
  oldResult?: StepResult;
  freshResult?: StepResult;
  changes: StepChange[];
  /** false exactly when the two sides have different outputs at this index */
  outputEqual: boolean;
};

export type HistoricalVerdict =
  | 'applicable'
  | 'schema_issue'
  | 'condition_rejected'
  | 'unverifiable'
  | 'absent';

export type DivergenceReport = {
  steps: StepDiff[];
  /** first index where anything (edge, revision, condition, cost, output…) differs */
  firstDifferentIndex: number | null;
  /** first index where the intermediate OUTPUT document differs */
  firstOutputDifferenceIndex: number | null;
  /** final-to-final equality; null when at least one side has no final document */
  finalEqual: boolean | null;
  finalOld?: JsonObject;
  finalFresh?: JsonObject;
  samePath: boolean;
  /** 1-based rank of the historical path key in the current ranking; null = gone */
  historicalRank: number | null;
  historicalVerdict: HistoricalVerdict;
  notes: string[];
};

export type ReplayComparison = {
  id: string;
  status: ReplayStatus;
  createdAt: string;
  finishedAt?: string;
  /** graph revision the NEW side was pinned to at creation */
  boundGraphRevision: number;
  /** baseRevision the page claimed to see when requesting, if supplied */
  requestedBaseRevision?: number;
  /** true when the page view was already behind the pinned graph at creation */
  staleViewAtCreate: boolean;
  historical: HistoricalSide;
  fresh: FreshSide;
  divergence?: DivergenceReport;
  /** setup-level error, if the comparison itself could not be prepared */
  error?: string;
  /**
   * Present only on live (polling) responses while the fresh run is in
   * flight: its partial results. Never persisted — the stored comparison is
   * closed by the server finalizer only.
   */
  liveFreshRun?: Run;
};

export type ReplaySummary = {
  id: string;
  status: ReplayStatus;
  historicalRunId: string;
  freshRunId?: string;
  boundGraphRevision: number;
  start: string;
  goal: string;
  createdAt: string;
  finishedAt?: string;
};
