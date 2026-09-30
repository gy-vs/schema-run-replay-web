import {useCallback, useEffect, useReducer, useRef, useState} from 'react';
import {
  ArrowLeftRight,
  Ban,
  FlaskConical,
  GitBranch,
  ListTree,
  Play,
  Plus,
  RotateCcw,
  Save,
  TriangleAlert,
  X,
} from 'lucide-react';
import type {CandidatePath, Edge, Func, Graph, JsonObject, Run} from '../common/types';
import {DEFAULT_SAMPLE} from '../common/seed';
import {api} from './api';
import {experimentReducer, initialExperiment, isTerminal, type ExperimentState} from './experiment';

type Notice = {kind: 'info' | 'error' | 'conflict'; text: string};

export default function App() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [revision, setRevision] = useState(0);
  const [start, setStart] = useState('v1');
  const [goal, setGoal] = useState('v3');
  const [sampleText, setSampleText] = useState(JSON.stringify(DEFAULT_SAMPLE, null, 2));
  const [sample, setSample] = useState<JsonObject>({...DEFAULT_SAMPLE});
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [reversibleOnly, setReversibleOnly] = useState(false);
  const [candidates, setCandidates] = useState<CandidatePath[] | null>(null);
  const [exp, dispatch] = useReducer(experimentReducer, initialExperiment);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [tab, setTab] = useState<'functions' | 'edges'>('functions');
  const [editingFunc, setEditingFunc] = useState<string | null>(null);
  const [editingEdge, setEditingEdge] = useState<string | null>(null);
  const [showNewFunc, setShowNewFunc] = useState(false);
  const [showNewEdge, setShowNewEdge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedRunKey, setSelectedRunKey] = useState<string | null>(null);

  const expRef = useRef(exp);
  expRef.current = exp;
  const pollRef = useRef<Map<string, number>>(new Map());

  const applyGraphPayload = useCallback((payload: {revision: number; graph: Graph}) => {
    setRevision(payload.revision);
    setGraph(payload.graph);
  }, []);

  useEffect(() => {
    api.bootstrap().catch(() => undefined);
    api.graph().then(applyGraphPayload).catch((e) => setNotice({kind: 'error', text: e.message}));
  }, [applyGraphPayload]);

  // ---- polling ------------------------------------------------------------

  const stopPolling = useCallback((runId: string) => {
    const handle = pollRef.current.get(runId);
    if (handle) {
      clearTimeout(handle);
      pollRef.current.delete(runId);
    }
  }, []);

  const pollRun = useCallback(
    (experimentId: string, runId: string) => {
      let cancelled = false;
      const tick = async () => {
        if (cancelled) return;
        try {
          const run = await api.runStatus(runId);
          // Stale guard: a run bound to an older experiment (e.g. its function
          // revision was replaced) must never write into the current one.
          if (expRef.current.experimentId !== experimentId) {
            stopPolling(runId);
            return;
          }
          dispatch({type: 'run_progress', experimentId, run});
          if (isTerminal(run.status)) stopPolling(runId);
          else schedule();
        } catch (error) {
          schedule();
        }
      };
      const schedule = () => {
        pollRef.current.set(runId, window.setTimeout(tick, 120));
      };
      schedule();
      return () => {
        cancelled = true;
        stopPolling(runId);
      };
    },
    [stopPolling],
  );

  useEffect(() => () => pollRef.current.forEach((h) => clearTimeout(h)), []);

  // Drop all polling when the experiment is replaced.
  useEffect(() => {
    if (!exp.experimentId) {
      pollRef.current.forEach((h) => clearTimeout(h));
      pollRef.current.clear();
    }
  }, [exp.experimentId]);

  // ---- actions ------------------------------------------------------------

  async function findPaths() {
    if (!parseSample()) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.paths({start, goal, sample, reversibleOnly});
      setRevision(result.revision);
      setCandidates(result.candidates);
    } catch (error) {
      setNotice({kind: 'error', text: (error as Error).message});
    } finally {
      setBusy(false);
    }
  }

  function parseSample(): boolean {
    try {
      const parsed = JSON.parse(sampleText) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('must be an object');
      setSample(parsed as JsonObject);
      setSampleError(null);
      return true;
    } catch (error) {
      setSampleError((error as Error).message);
      return false;
    }
  }

  async function compare() {
    if (!parseSample()) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.compare({start, goal, sample, reversibleOnly});
      applyGraphPayload({revision: result.graphRevision, graph: graph!});
      setCandidates(result.candidates);
      dispatch({
        type: 'experiment_started',
        experimentId: result.experimentId,
        graphRevision: result.graphRevision,
        start,
        goal,
        candidates: result.candidates,
        runs: result.runs,
      });
      setSelectedRunKey(result.runs.find((r) => r.runId)?.key ?? null);
      for (const entry of result.runs) {
        if (entry.runId) pollRun(result.experimentId, entry.runId);
      }
    } catch (error) {
      setNotice({kind: 'error', text: (error as Error).message});
    } finally {
      setBusy(false);
    }
  }

  async function cancelRun(slot: Extract<ExperimentState['slots'][string], {kind: 'run'}>) {
    dispatch({type: 'cancel_requested', experimentId: exp.experimentId!, runId: slot.runId});
    try {
      await api.cancel(slot.runId);
    } catch (error) {
      setNotice({kind: 'error', text: (error as Error).message});
    }
  }

  function cancelAll() {
    for (const slot of Object.values(exp.slots)) {
      if (slot.kind === 'run' && !isTerminal(slot.status)) void cancelRun(slot);
    }
  }

  if (!graph) return <main className="shell"><p style={{padding: 24}}>Loading graph…</p></main>;

  const nodeIds = graph.nodes.map((n) => n.id);
  const slotOrder = exp.candidates.map((c) => c.key);

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Schema Evolution Studio</strong>
        <small>directed migration graph · revision {revision}</small>
        <span className="spacer" />
        {graph.diagnostics.backEdges.length > 0 && (
          <span className="warn-pill" title="Cycles are allowed; rollback edges are part of the graph">
            <GitBranch size={13} /> {graph.diagnostics.backEdges.length} back edge(s) / {graph.diagnostics.cycles.length} cycle(s)
          </span>
        )}
      </header>

      <section className="workspace">
        {/* ---- left: experiment ------------------------------------------ */}
        <section className="pane">
          <h2><ListTree size={15} /> Experiment</h2>

          <div className="field-row">
            <label>From
              <select value={start} onChange={(e) => setStart(e.target.value)}>
                {nodeIds.map((id) => <option key={id}>{id}</option>)}
              </select>
            </label>
            <label>To
              <select value={goal} onChange={(e) => setGoal(e.target.value)}>
                {nodeIds.map((id) => <option key={id}>{id}</option>)}
              </select>
            </label>
          </div>

          <label className="check">
            <input type="checkbox" checked={reversibleOnly} onChange={(e) => setReversibleOnly(e.target.checked)} />
            <ArrowLeftRight size={13} /> rollback-safe edges only
          </label>

          <label className="block">Fixed sample
            <textarea
              aria-label="Sample document"
              className="sample"
              value={sampleText}
              onChange={(e) => setSampleText(e.target.value)}
              spellCheck={false}
            />
          </label>
          {sampleError && <p className="error-text">{sampleError}</p>}

          <div className="toolbar">
            <button onClick={findPaths} disabled={busy}><Play size={15} />Find paths</button>
            <button className="primary" onClick={compare} disabled={busy}>
              <FlaskConical size={15} />Compare on sample
            </button>
            {exp.experimentId && <button onClick={cancelAll}><Ban size={15} />Cancel all</button>}
            {exp.experimentId && (
              <button onClick={() => dispatch({type: 'reset'})} title="Discard this experiment">
                <RotateCcw size={15} />
              </button>
            )}
          </div>

          {notice && (
            <p className={notice.kind === 'error' ? 'error-banner' : 'info-banner'}>
              {notice.kind === 'conflict' && <TriangleAlert size={14} />} {notice.text}
            </p>
          )}

          {exp.experimentId && (
            <p className="exp-id">experiment <code>{exp.experimentId}</code> · graph r{exp.graphRevision}{exp.graphRevision !== revision && ' · graph edited since'}</p>
          )}

          <CandidateList
            candidates={candidates ?? exp.candidates}
            exp={exp}
            slotOrder={slotOrder}
            selectedRunKey={selectedRunKey}
            onSelectRun={setSelectedRunKey}
            onCancel={cancelRun}
            latestRevision={(id) => graph.funcs.find((f) => f.id === id)?.revision ?? 0}
          />
        </section>

        {/* ---- middle: details / run trace -------------------------------- */}
        <section className="pane">
          <RunTrace exp={exp} runKey={selectedRunKey} />
        </section>

        {/* ---- right: graph editor ---------------------------------------- */}
        <aside className="pane editor">
          <div className="tabs">
            <button className={tab === 'functions' ? 'active' : ''} onClick={() => setTab('functions')}>Functions</button>
            <button className={tab === 'edges' ? 'active' : ''} onClick={() => setTab('edges')}>Edges</button>
          </div>

          {tab === 'functions' && (
            <div className="list">
              <div className="list-head">
                <h2>Functions</h2>
                <button className="mini" onClick={() => setShowNewFunc((v) => !v)}><Plus size={13} />New</button>
              </div>
              {showNewFunc && (
                <FunctionEditor
                  graph={graph}
                  revision={revision}
                  onSaved={(payload) => {applyGraphPayload(payload); setShowNewFunc(false); setEditingFunc(payload.func.id);}}
                  onConflict={(e) => setNotice({kind: 'conflict', text: e.message})}
                  onCancel={() => setShowNewFunc(false)}
                />
              )}
              {graph.funcs.map((func) =>
                editingFunc === func.id ? (
                  <FunctionEditor
                    key={func.id}
                    func={func}
                    graph={graph}
                    revision={revision}
                    onSaved={(payload) => {applyGraphPayload(payload); setEditingFunc(null);}}
                    onConflict={(e) => setNotice({kind: 'conflict', text: e.message})}
                    onCancel={() => setEditingFunc(null)}
                  />
                ) : (
                  <button key={func.id} onClick={() => setEditingFunc(func.id)}>
                    <strong>{func.name}</strong> <code>{func.id}</code>
                    <br /><small>r{func.revision}{func.revisions[func.revision - 1]?.condition ? ' · conditional' : ''}</small>
                  </button>
                ),
              )}
            </div>
          )}

          {tab === 'edges' && (
            <div className="list">
              <div className="list-head">
                <h2>Edges</h2>
                <button className="mini" onClick={() => setShowNewEdge((v) => !v)}><Plus size={13} />New</button>
              </div>
              {showNewEdge && (
                <EdgeEditor
                  graph={graph}
                  revision={revision}
                  onSaved={(payload) => {applyGraphPayload(payload); setShowNewEdge(false); setEditingEdge(payload.edge.id);}}
                  onConflict={(e) => setNotice({kind: 'conflict', text: e.message})}
                  onCancel={() => setShowNewEdge(false)}
                />
              )}
              {graph.edges.map((edge) =>
                editingEdge === edge.id ? (
                  <EdgeEditor
                    key={edge.id}
                    edge={edge}
                    graph={graph}
                    revision={revision}
                    onSaved={(payload) => {applyGraphPayload(payload); setEditingEdge(null);}}
                    onConflict={(e) => setNotice({kind: 'conflict', text: e.message})}
                    onCancel={() => setEditingEdge(null)}
                  />
                ) : (
                  <EdgeCard
                    key={edge.id}
                    edge={edge}
                    isBack={graph.diagnostics.backEdges.some((b) => b.edgeId === edge.id)}
                    onEdit={() => setEditingEdge(edge.id)}
                  />
                ),
              )}
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------

function CandidateList({
  candidates,
  exp,
  slotOrder,
  selectedRunKey,
  onSelectRun,
  onCancel,
  latestRevision,
}: {
  candidates: CandidatePath[];
  exp: ExperimentState;
  slotOrder: string[];
  selectedRunKey: string | null;
  onSelectRun: (key: string) => void;
  onCancel: (slot: Extract<ExperimentState['slots'][string], {kind: 'run'}>) => void;
  latestRevision: (funcId: string) => number;
}) {
  if (candidates.length === 0) return <p className="muted">No paths — choose revisions and press Find paths.</p>;
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  return (
    <ol className="candidates">
      {slotOrder.length > 0
        ? slotOrder.map((key) => byKey.get(key) && (
            <CandidateRow key={key} candidate={byKey.get(key)!} slot={exp.slots[key]} selected={selectedRunKey === key}
              onSelect={() => onSelectRun(key)} onCancel={onCancel} latestRevision={latestRevision} />
          ))
        : candidates.map((candidate) => <CandidateRow key={candidate.key} candidate={candidate} latestRevision={latestRevision} />)}
    </ol>
  );
}

function verdictOf(candidate: CandidatePath): {label: string; cls: string} {
  if (!candidate.valid) return {label: 'schema issue', cls: 'bad'};
  if (candidate.conditionStatus === 'rejected') return {label: 'condition not met', cls: 'warn'};
  if (candidate.conditionStatus === 'unknown') return {label: 'unverifiable', cls: 'warn'};
  return {label: 'valid', cls: 'ok'};
}

function CandidateRow({
  candidate,
  slot,
  selected,
  onSelect,
  onCancel,
  latestRevision,
}: {
  candidate: CandidatePath;
  slot?: ExperimentState['slots'][string];
  selected?: boolean;
  onSelect?: () => void;
  onCancel?: (slot: Extract<ExperimentState['slots'][string], {kind: 'run'}>) => void;
  latestRevision: (funcId: string) => number;
}) {
  const verdict = verdictOf(candidate);
  const stale =
    slot?.kind === 'run' && slot.run ? slot.run.steps.some((s) => latestRevision(s.funcId) > s.funcRevision) : false;
  return (
    <li className={`candidate ${slot?.kind === 'run' ? slot.status : ''} ${selected ? 'selected' : ''}`}
        onClick={slot?.kind === 'run' ? onSelect : undefined}>
      <div className="candidate-head">
        <span className="path-text">{candidate.edgeIds.join(' → ')}</span>
        <span className={`verdict ${verdict.cls}`}>{verdict.label}</span>
      </div>
      <div className="candidate-meta">
        cost <strong>{candidate.totalCost}</strong>
        <span className="muted"> · {candidate.steps.length} hop{candidate.steps.length === 1 ? '' : 's'}</span>
        {candidate.reversibleOnly && <span className="tag ok">reversible</span>}
        {stale && <span className="tag warn" title="Bound to an older function revision">stale binding</span>}
      </div>
      {candidate.schemaIssues.length > 0 && (
        <ul className="issues">{candidate.schemaIssues.map((issue, i) => <li key={i}>{issue.kind} @ {issue.edgeId}: {'detail' in issue ? issue.detail : ''}</li>)}</ul>
      )}
      {candidate.conditionStatus !== 'satisfied' && candidate.rejectedReason && (
        <p className="issues">{candidate.rejectedAtEdge ? `blocked at ${candidate.rejectedAtEdge}: ` : ''}{candidate.rejectedReason}</p>
      )}
      {slot?.kind === 'run' && (
        <div className="run-line">
          <span className={`status-dot ${slot.status}`} />
          <span>{slot.status}</span>
          {!isTerminal(slot.status) && (
            <button className="mini" disabled={slot.cancelRequested} onClick={() => onCancel?.(slot)}>
              {slot.cancelRequested ? 'cancelling…' : <><X size={12} />cancel</>}
            </button>
          )}
          {slot.run?.failedEdgeId && <small className="fail-text">failed at {slot.run.failedEdgeId}</small>}
        </div>
      )}
      {slot?.kind === 'rejected' && <p className="muted">not executed — {slot.rejected}</p>}
    </li>
  );
}

function RunTrace({exp, runKey}: {exp: ExperimentState; runKey: string | null}) {
  const slot = runKey ? exp.slots[runKey] : undefined;
  const selected = slot?.kind === 'run' ? slot.run ?? null : null;
  if (!exp.experimentId) {
    return <>
      <h2>Run trace</h2>
      <p className="muted">Start a comparison to inspect per-edge intermediate results. Failures keep every earlier output and name the precise edge.</p>
    </>;
  }
  if (!selected) {
    return <>
      <h2>Run trace</h2>
      <p className="muted">Select an executed candidate on the left.</p>
    </>;
  }
  return (
    <>
      <h2>Run trace <code className="small-code">{selected.id}</code></h2>
      <p className={`run-summary ${selected.status}`}>
        <span className={`status-dot ${selected.status}`} /> {selected.status} · total cost {selected.totalCost}
        {selected.failedEdgeId && <> · stopped at <code>{selected.failedEdgeId}</code></>}
      </p>
      {selected.error && <p className="error-text">{selected.error}</p>}
      <ol className="trace">
        <li className="trace-step seed">
          <div className="trace-head"><span className="pill">sample</span></div>
          <pre>{JSON.stringify(selected.sample, null, 2)}</pre>
        </li>
        {selected.results.length === 0 && selected.steps.map((step) => (
          <li className="trace-step pending" key={step.edgeId}>
            <div className="trace-head"><span className="pill pending">{step.edgeId}</span><small>{step.funcId} r{step.funcRevision}</small></div>
          </li>
        ))}
        {selected.results.map((result, index) => (
          <li className={`trace-step ${result.status}`} key={result.edgeId}>
            <div className="trace-head">
              <span className={`pill ${result.status}`}>{result.edgeId}</span>
              <small>{result.funcId} r{result.funcRevision} · cost {result.cost} · {result.from}→{result.to}</small>
              <span className={`status-dot ${result.status}`} />
            </div>
            {result.conditionMet === false && <p className="fail-text">condition rejected the document</p>}
            {result.error && <p className="fail-text">{result.error}</p>}
            {result.output !== undefined && <pre>{JSON.stringify(result.output, null, 2)}</pre>}
            {result.status === 'skipped' && <p className="muted">step never started (run cancelled before {selected.steps[index + 1]?.edgeId ?? 'end'})</p>}
          </li>
        ))}
      </ol>
    </>
  );
}

// ---------------------------------------------------------------------------

function FunctionEditor({
  func,
  graph,
  revision,
  onSaved,
  onConflict,
  onCancel,
}: {
  func?: Func;
  graph: Graph;
  revision: number;
  onSaved: (payload: {func: Func; revision: number; graph: Graph}) => void;
  onConflict: (error: Error) => void;
  onCancel: () => void;
}) {
  const latest = func?.revisions[func.revision - 1];
  const [name, setName] = useState(func?.name ?? 'New function');
  const [id, setId] = useState(func?.id ?? '');
  const [source, setSource] = useState(latest?.source ?? '(doc) => ({...doc})');
  const [condition, setCondition] = useState(latest?.condition ?? '');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const payload = func
        ? await api.publishRevision(func.id, {source, condition: condition || undefined, note, baseRevision: revision})
        : await api.createFunction({id: id || undefined, name, source, condition: condition || undefined, note, baseRevision: revision});
      onSaved(payload);
    } catch (error) {
      onConflict(error as Error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="editor-card">
      {!func && (
        <>
          <input placeholder="function id (blank = generated)" value={id} onChange={(e) => setId(e.target.value)} />
          <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
        </>
      )}
      {func && <small className="muted">publishes revision r{func.revision + 1} — running experiments stay bound to r{func.revision}</small>}
      <textarea className="code" spellCheck={false} value={source} onChange={(e) => setSource(e.target.value)} rows={5} />
      <input placeholder="condition on doc, e.g. doc.tier === 'gold'" value={condition} onChange={(e) => setCondition(e.target.value)} />
      <input placeholder="revision note" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="toolbar">
        <button className="mini primary" onClick={save} disabled={saving}><Save size={12} />{func ? 'Publish revision' : 'Create'}</button>
        <button className="mini" onClick={onCancel}>Cancel</button>
      </div>
      {func && graph && (
        <details>
          <summary>history ({func.revisions.length})</summary>
          {func.revisions.map((rev, i) => (
            <div key={i} className="history-row"><code>r{i + 1}</code> <small>{rev.note}</small></div>
          ))}
        </details>
      )}
    </div>
  );
}

function EdgeEditor({
  edge,
  graph,
  revision,
  onSaved,
  onConflict,
  onCancel,
}: {
  edge?: Edge;
  graph: Graph;
  revision: number;
  onSaved: (payload: {edge: Edge; revision: number; graph: Graph}) => void;
  onConflict: (error: Error) => void;
  onCancel: () => void;
}) {
  const [from, setFrom] = useState(edge?.from ?? graph.nodes[0]?.id ?? '');
  const [to, setTo] = useState(edge?.to ?? graph.nodes[1]?.id ?? '');
  const [funcId, setFuncId] = useState(edge?.funcId ?? graph.funcs[0]?.id ?? '');
  const [cost, setCost] = useState(edge?.cost ?? 1);
  const [reversible, setReversible] = useState(edge?.reversible ?? false);
  const [condition, setCondition] = useState(edge?.condition ?? '');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const payload = await api.upsertEdge({
        id: edge?.id, from, to, funcId, cost: Number(cost), reversible,
        condition: condition || undefined, baseRevision: revision,
      });
      onSaved(payload);
    } catch (error) {
      onConflict(error as Error);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!edge) return;
    try {
      const payload = await api.deleteEdge(edge.id, revision);
      onCancel();
      onSaved({edge, ...payload});
    } catch (error) {
      onConflict(error as Error);
    }
  }

  return (
    <div className="editor-card">
      <div className="field-row">
        <label>from<select value={from} onChange={(e) => setFrom(e.target.value)}>{graph.nodes.map((n) => <option key={n.id}>{n.id}</option>)}</select></label>
        <label>to<select value={to} onChange={(e) => setTo(e.target.value)}>{graph.nodes.map((n) => <option key={n.id}>{n.id}</option>)}</select></label>
      </div>
      <label className="block">function
        <select value={funcId} onChange={(e) => setFuncId(e.target.value)}>{graph.funcs.map((f) => <option key={f.id} value={f.id}>{f.id} (r{f.revision})</option>)}</select>
      </label>
      <div className="field-row">
        <label>cost<input type="number" min={0} value={cost} onChange={(e) => setCost(Number(e.target.value))} /></label>
        <label className="check"><input type="checkbox" checked={reversible} onChange={(e) => setReversible(e.target.checked)} />reversible</label>
      </div>
      <input placeholder="edge condition (overrides function)" value={condition} onChange={(e) => setCondition(e.target.value)} />
      <div className="toolbar">
        <button className="mini primary" onClick={save} disabled={saving}><Save size={12} />{edge ? 'Save edge' : 'Add edge'}</button>
        <button className="mini" onClick={onCancel}>Cancel</button>
        {edge && <button className="mini danger" onClick={remove}>Delete</button>}
      </div>
      {edge && <small className="muted">Back edges are allowed; saving r{revision + 1}. Edges mid-run stay bound.</small>}
    </div>
  );
}

function EdgeCard({edge, isBack, onEdit}: {edge: Edge; isBack: boolean; onEdit: () => void}) {
  return (
    <button onClick={onEdit} className="edge-card">
      <span className="path-text">{edge.from} → {edge.to}</span>
      <br /><small><code>{edge.funcId}</code> · cost {edge.cost}{edge.reversible ? ' · reversible' : ''}</small>
      {isBack && <span className="tag warn">back edge</span>}
      {edge.condition && <span className="tag">conditional</span>}
    </button>
  );
}
