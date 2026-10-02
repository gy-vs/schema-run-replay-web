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

// ---- replay comparison (historical run vs. the current graph) -------------

export type RunSummary = {
  id: string;
  experimentId?: string;
  status: RunStatus;
  pathKey: string;
  start?: string;
  goal?: string;
  totalCost: number;
  /** graph revision the run was bound to when created */
  graphRevision: number;
  failedEdgeId?: string;
  createdAt: string;
  finishedAt?: string;
};

/**
 * A frozen view of one candidate as it ranked at replay-bind time. Costs and
 * ordering belong to the pinned NEW graph — the historical run's costs are
 * never mixed into this ranking.
 */
export type FrozenCandidate = {
  key: string;
  edgeIds: string[];
  totalCost: number;
  valid: boolean;
  reversibleOnly: boolean;
  conditionStatus: CandidatePath['conditionStatus'];
  rejectedAtEdge?: string;
  rejectedReason?: string;
  schemaIssues: SchemaIssue[];
};

/** Historical fact: copied verbatim from the source run, never re-executed. */
export type ReplayHistoricalSide = {
  sourceRunId: string;
  graphRevision: number;
  status: RunStatus;
  start: string;
  goal: string;
  pathKey: string;
  steps: PathStep[];
  results: StepResult[];
  totalCost: number;
  failedEdgeId?: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
};

/** Fresh execution bound to a pinned current-graph revision. */
export type ReplayCurrentSide = {
  /** graph revision the candidate query and the run were bound to */
  graphRevision: number;
  /** live store revision observed immediately after candidate enumeration */
  liveRevisionAtBind: number;
  start: string;
  goal: string;
  reversibleOnly: boolean;
  /** candidate ranking frozen at bind time */
  ranking: FrozenCandidate[];
  selectedKey?: string;
  selectionNote?: string;
  runId?: string;
  steps: PathStep[];
  results: StepResult[];
  totalCost?: number;
  status: RunStatus | 'blocked';
  failedEdgeId?: string;
  error?: string;
  /** why no current-side run could be started, when status === 'blocked' */
  blockedReason?: string;
};

export type ReplayStatus = 'running' | 'completed' | 'blocked';

export type ReplayComparison = {
  id: string;
  status: ReplayStatus;
  createdAt: string;
  finishedAt?: string;
  sourceRunId: string;
  /** original sample, copied from the historical run */
  sample: JsonObject;
  historical: ReplayHistoricalSide;
  current: ReplayCurrentSide;
  diff?: ReplayDiff;
  drift: {
    expectedRevision?: number;
    historicalRevision: number;
    pinnedRevision: number;
    /** the graph the page was viewing had already moved when the replay was requested */
    changedFromView: boolean;
    /** the graph was edited while candidates were being enumerated */
    changedDuringPreparation: boolean;
  };
};

export type ReplaySummary = {
  id: string;
  status: ReplayStatus;
  sourceRunId: string;
  historicalRevision: number;
  pinnedRevision: number;
  currentStatus?: RunStatus | 'blocked';
  createdAt: string;
  finishedAt?: string;
};

export type StepDiffKind = 'path' | 'revision' | 'condition' | 'cost' | 'status' | 'output' | 'missing';

export type StepPair = {
  index: number;
  historicalStep?: PathStep;
  currentStep?: PathStep;
  historicalResult?: StepResult;
  currentResult?: StepResult;
  diffs: StepDiffKind[];
};

export type StepCounts = {done: number; failed: number; skipped: number; other: number};

export type ReplayDiff = {
  pairs: StepPair[];
  /** first paired position where anything differs; null when fully identical */
  firstDifferenceIndex: number | null;
  firstDifferenceEdge?: {historical?: string; current?: string};
  historicalCounts: StepCounts;
  currentCounts: StepCounts;
  /**
   * Whether the terminal documents are order-insensitively equal. Null when
   * either side lacks a final document (blocked / failed / cancelled) — equal
   * true never implies the intermediate traces matched.
   */
  finalDocumentEqual: boolean | null;
  notes: string[];
};
