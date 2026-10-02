import {useCallback, useEffect, useReducer, useRef, useState} from 'react';
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  GitCompareArrows,
  History,
  ListOrdered,
  RotateCw,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import type {CandidatePath, ReplayComparison, ReplaySummary, Run, StepResult} from '../common/types';
import {api} from './api';
import {initialReplay, replayReducer, replayIsTerminal} from './replay';

type Notice = {kind: 'info' | 'error' | 'conflict'; text: string};

export function ReplayPanel({
  seedRunId,
  liveRevision,
  onBack,
  onNotice,
}: {
  seedRunId?: string | null;
  liveRevision: number;
  onBack: () => void;
  onNotice: (notice: Notice) => void;
}) {
  const [state, dispatch] = useReducer(replayReducer, initialReplay);
  const [formRunId, setFormRunId] = useState(seedRunId ?? '');
  const [start, setStart] = useState('');
  const [goal, setGoal] = useState('');
  const [recallId, setRecallId] = useState('');
  const [history, setHistory] = useState<ReplaySummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const genRef = useRef(state.generation);
  genRef.current = state.generation;
  const pollRef = useRef<number | null>(null);

  // Seed from a run selected in the trace pane (mount happens once per open).
  useEffect(() => {
    if (seedRunId) {
      setFormRunId(seedRunId);
      dispatch({type: 'select', replayId: null, runId: seedRunId});
    }
    return () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      window.clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const loadReplay = useCallback((id: string, generation: number) => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const replay = await api.replayStatus(id);
        if (cancelled) return;
        // Stale guard: the user switched to another comparison meanwhile.
        if (genRef.current !== generation) return stopPolling();
        dispatch({type: 'loaded', generation, replay});
        if (replayIsTerminal(replay.status)) {
          stopPolling();
        } else {
          pollRef.current = window.setTimeout(tick, 120);
        }
      } catch {
        if (!cancelled) pollRef.current = window.setTimeout(tick, 300);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [stopPolling]);

  async function refreshList() {
    try {
      const result = await api.replays();
      setHistory(result.replays);
    } catch (error) {
      onNotice({kind: 'error', text: (error as Error).message});
    }
  }

  useEffect(() => {
    void refreshList();
    return () => undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.replay?.status]);

  async function createReplay(pathKey?: string) {
    const runId = formRunId.trim();
    if (!runId) {
      onNotice({kind: 'error', text: 'historical run id is required'});
      return;
    }
    setBusy(true);
    // One selection bump arms the stale guard against any comparison still
    // returning from a previous selection.
    const generation = genRef.current + 1;
    stopPolling();
    dispatch({type: 'select', replayId: null, runId});
    dispatch({type: 'loading', generation, selectedId: null, value: true});
    try {
      const replay = await api.replay({
        historicalRunId: runId,
        start: start.trim() || undefined,
        goal: goal.trim() || undefined,
        pathKey,
        baseRevision: liveRevision,
      });
      // Slow response for a run the user already switched away from: drop it.
      if (genRef.current !== generation) return;
      dispatch({type: 'loaded', generation, replay, replayId: replay.id});
      if (!replayIsTerminal(replay.status)) loadReplay(replay.id, generation);
      void refreshList();
    } catch (error) {
      if (genRef.current === generation) {
        dispatch({type: 'loading', generation, selectedId: null, value: false});
      }
      onNotice({kind: 'error', text: (error as Error).message});
    } finally {
      setBusy(false);
    }
  }

  async function recall(id: string) {
    const trimmed = id.trim();
    if (!trimmed) return;
    const generation = genRef.current + 1;
    stopPolling();
    dispatch({type: 'select', replayId: trimmed, runId: null});
    dispatch({type: 'loading', generation, selectedId: trimmed, value: true});
    try {
      const replay = await api.replayStatus(trimmed);
      if (genRef.current !== generation) return;
      dispatch({type: 'loaded', generation, replay});
      setFormRunId(replay.historical.runId);
      if (!replayIsTerminal(replay.status)) loadReplay(trimmed, generation);
    } catch (error) {
      if (genRef.current === generation) {
        dispatch({type: 'loading', generation, selectedId: trimmed, value: false});
      }
      onNotice({kind: 'error', text: (error as Error).message});
    }
  }

  async function cancel() {
    const replay = state.replay;
    if (!replay) return;
    const generation = genRef.current;
    dispatch({type: 'cancel_requested'});
    try {
      const updated = await api.cancelReplay(replay.id);
      if (genRef.current !== generation) return;
      dispatch({type: 'loaded', generation, replay: updated});
      if (!replayIsTerminal(updated.status)) loadReplay(updated.id, generation);
    } catch (error) {
      onNotice({kind: 'error', text: (error as Error).message});
    }
  }

  const replay = state.replay;

  return (
    <>
      <h2>
        <GitCompareArrows size={15} /> Historical replay
        <button className="mini" onClick={onBack} title="Back to run trace"><ArrowLeft size={13} />trace</button>
      </h2>

      <div className="replay-form">
        <label className="block">Historical run id (the OLD side — frozen facts)
          <input value={formRunId} onChange={(e) => setFormRunId(e.target.value)} placeholder="run-…" spellCheck={false} />
        </label>
        <div className="field-row">
          <label className="block">New side from
            <input value={start} onChange={(e) => setStart(e.target.value)} placeholder="default: old run's start" spellCheck={false} />
          </label>
          <label className="block">to
            <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="default: old run's goal" spellCheck={false} />
          </label>
        </div>
        <div className="toolbar">
          <button className="primary" disabled={busy || state.loading} onClick={() => void createReplay()}>
            <RotateCw size={13} />Replay against current graph
          </button>
          <small className="muted">new side pins graph r{liveRevision}</small>
        </div>
      </div>

      <div className="recall-row">
        <input value={recallId} onChange={(e) => setRecallId(e.target.value)} placeholder="replay-… recall from server" spellCheck={false} />
        <button className="mini" onClick={() => void recall(recallId)}><History size={12} />Recall</button>
      </div>

      <details>
        <summary className="muted"><ListOrdered size={11} /> stored comparisons ({history?.length ?? 0})</summary>
        {history === null ? (
          <p className="muted">loading…</p>
        ) : history.length === 0 ? (
          <p className="muted">none yet</p>
        ) : (
          <ol className="replay-index">
            {history.map((entry) => (
              <li key={entry.id}>
                <button className="mini" onClick={() => void recall(entry.id)} title="recall this comparison">
                  <code>{entry.id}</code>
                </button>
                <small className="muted">
                  <span className={`status-dot ${entry.status === 'completed' ? 'succeeded' : entry.status === 'cancelled' ? 'cancelled' : 'running'}`} />
                  {' '}{entry.status} · old {entry.historicalRunId} · pinned r{entry.boundGraphRevision} · {entry.start}→{entry.goal}
                </small>
              </li>
            ))}
          </ol>
        )}
      </details>

      {state.loading && <p className="muted">preparing comparison…</p>}

      {replay && (
        <ReplayView
          replay={replay}
          liveRevision={liveRevision}
          cancelRequested={state.cancelRequested}
          onCancel={() => void cancel()}
          onChoosePath={(key) => void createReplay(key)}
          choosing={busy}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function ReplayView({
  replay,
  liveRevision,
  cancelRequested,
  onCancel,
  onChoosePath,
  choosing,
}: {
  replay: ReplayComparison;
  liveRevision: number;
  cancelRequested: boolean;
  onCancel: () => void;
  onChoosePath: (key: string) => void;
  choosing: boolean;
}) {
  const oldRun = replay.historical.run;
  const freshRun = replay.liveFreshRun;
  const divergence = replay.divergence;
  const running = !replayIsTerminal(replay.status);

  return (
    <div className="replay-view">
      <div className={`replay-banner ${replay.status}`}>
        <span className={`status-dot ${replay.status === 'completed' ? 'succeeded' : replay.status === 'cancelled' ? 'cancelled' : 'running'}`} />
        <strong>replay {replay.status}</strong>
        <code className="small-code">{replay.id}</code>
        {running && (
          <button className="mini danger" disabled={cancelRequested} onClick={onCancel}>
            {cancelRequested ? 'cancelling…' : <><Ban size={12} />cancel fresh side</>}
          </button>
        )}
      </div>

      <p className="muted replay-provenance">
        old side: historical run <code>{replay.historical.runId}</code> ({oldRun.status}, graph r{replay.historical.graphRevision}) —
        steps, revisions and intermediate outputs are the frozen record, never re-executed
        <br />
        new side: re-confirmed on <strong>pinned graph r{replay.boundGraphRevision}</strong>
        {replay.staleViewAtCreate && replay.requestedBaseRevision !== undefined && (
          <span className="stale-warn">
            <TriangleAlert size={12} /> page showed r{replay.requestedBaseRevision}; the graph had already advanced — comparison binds r{replay.boundGraphRevision}
          </span>
        )}
        {liveRevision > replay.boundGraphRevision && (
          <span className="stale-warn">
            <TriangleAlert size={12} /> live graph is now r{liveRevision}; this comparison stays frozen at r{replay.boundGraphRevision}
          </span>
        )}
      </p>

      {divergence && <DivergenceSummary divergence={divergence} replayStatus={replay.status} />}

      {replay.fresh.notExecutedReason && (
        <p className="error-banner"><XCircle size={14} />new side not executed: {replay.fresh.notExecutedReason}</p>
      )}

      {divergence && divergence.historicalRank === null && (
        <p className="error-banner"><TriangleAlert size={14} />the historical path {oldRun.pathKey} no longer exists in the current graph</p>
      )}

      <FreshCandidates replay={replay} choosing={choosing} onChoosePath={onChoosePath} />

      <div className="sides">
        <section className="side old">
          <h3>OLD — historical fact</h3>
          <p className={`run-summary ${oldRun.status}`}>
            <span className={`status-dot ${oldRun.status}`} /> {oldRun.status} · cost {oldRun.totalCost}
            {oldRun.failedEdgeId && <> · stopped at <code>{oldRun.failedEdgeId}</code></>}
          </p>
          <RunSteps run={oldRun} highlightIndex={divergence?.firstOutputDifferenceIndex ?? null} />
        </section>
        <section className="side fresh">
          <h3>NEW — this execution on pinned r{replay.boundGraphRevision}</h3>
          {freshRun ? (
            <>
              <p className={`run-summary ${freshRun.status}`}>
                <span className={`status-dot ${freshRun.status}`} /> {freshRun.status} · cost {freshRun.totalCost}
                {freshRun.failedEdgeId && <> · stopped at <code>{freshRun.failedEdgeId}</code></>}
              </p>
              <RunSteps run={freshRun} highlightIndex={divergence?.firstOutputDifferenceIndex ?? null} />
            </>
          ) : replay.fresh.notExecutedReason ? (
            <p className="muted">no fresh execution — the current graph offered no executable candidate, yet the historical intermediate outputs are still shown on the left</p>
          ) : (
            <p className="muted">fresh run not started</p>
          )}
        </section>
      </div>
    </div>
  );
}

function DivergenceSummary({divergence, replayStatus}: {
  divergence: NonNullable<ReplayComparison['divergence']>;
  replayStatus: ReplayComparison['status'];
}) {
  const outcome = divergence.finalEqual === null
    ? {cls: 'warn', text: replayStatus === 'cancelled'
        ? 'comparison cut short by cancellation — only completed steps are compared'
        : 'no comparable final document on at least one side (failure or abort)'}
    : divergence.finalEqual
      ? {cls: 'ok', text: 'final JSON is identical'}
      : {cls: 'bad', text: 'final JSON differs'};
  return (
    <div className={`divergence-summary ${outcome.cls}`}>
      {divergence.finalEqual === true ? <CheckCircle2 size={14} /> : <TriangleAlert size={14} />}
      <span>{outcome.text}</span>
      <ul className="divergence-facts">
        <li>first route/step difference: {divergence.firstDifferentIndex === null
          ? 'none — same steps, bindings, costs and outputs'
          : `step #${divergence.firstDifferentIndex + 1}`}</li>
        <li>first intermediate OUTPUT difference: {divergence.firstOutputDifferenceIndex === null
          ? 'none'
          : `step #${divergence.firstOutputDifferenceIndex + 1}`}</li>
        <li>same path: {divergence.samePath ? 'yes' : 'no'} · historical path rank now: {divergence.historicalRank ?? 'gone'}</li>
        {divergence.notes.map((note, i) => <li key={i} className="muted">{note}</li>)}
      </ul>
    </div>
  );
}

function FreshCandidates({replay, choosing, onChoosePath}: {
  replay: ReplayComparison;
  choosing: boolean;
  onChoosePath: (key: string) => void;
}) {
  const candidates = replay.fresh.candidates;
  if (candidates.length === 0) return null;
  return (
    <details>
      <summary className="muted">current candidates re-ranked by present cost ({candidates.length}) — costs and order are the NEW graph's</summary>
      <ol className="fresh-candidates">
        {candidates.map((candidate, i) => (
          <FreshCandidateRow
            key={candidate.key}
            candidate={candidate}
            rank={i + 1}
            isHistorical={candidate.key === replay.historical.run.pathKey}
            isChosen={candidate.key === replay.fresh.chosenKey}
            disabled={choosing || replay.status === 'running'}
            onChoose={() => onChoosePath(candidate.key)}
          />
        ))}
      </ol>
    </details>
  );
}

function FreshCandidateRow({candidate, rank, isHistorical, isChosen, disabled, onChoose}: {
  candidate: CandidatePath;
  rank: number;
  isHistorical: boolean;
  isChosen: boolean;
  disabled: boolean;
  onChoose: () => void;
}) {
  const executable = candidate.valid && candidate.conditionStatus !== 'rejected';
  return (
    <li className={`fresh-candidate ${isChosen ? 'chosen' : ''}`}>
      <button className="mini" disabled={!executable || disabled} onClick={onChoose}
        title={executable ? 'execute this current candidate as the new side' : 'not executable on the current graph'}>
        run
      </button>
      <span className="path-text">#{rank} {candidate.edgeIds.join(' → ')} · cost {candidate.totalCost}</span>
      {isHistorical && <span className="tag warn" title="This is the route the historical run took">historical path</span>}
      {isChosen && <span className="tag ok">new side</span>}
      {!candidate.valid && <span className="tag bad-tag">schema issue</span>}
      {candidate.conditionStatus === 'rejected' && <span className="tag bad-tag">rejected @ {candidate.rejectedAtEdge}</span>}
      {candidate.conditionStatus === 'unknown' && <span className="tag">unverifiable</span>}
    </li>
  );
}

/** Compact per-step trace: sample, every retained intermediate output, and a
 * precise failure position even when the run never produced a final doc. */
function RunSteps({run, highlightIndex}: {run: Run; highlightIndex: number | null}) {
  return (
    <ol className="trace compact">
      <li className="trace-step seed">
        <div className="trace-head"><span className="pill">sample</span></div>
        <pre>{JSON.stringify(run.sample, null, 2)}</pre>
      </li>
      {run.steps.map((step, i) => {
        const result: StepResult | undefined = run.results[i];
        const status = result?.status ?? 'pending';
        return (
          <li className={`trace-step ${status} ${i === highlightIndex ? 'first-diff' : ''}`} key={`${step.edgeId}-${i}`}>
            <div className="trace-head">
              <span className={`pill ${status}`}>#{i + 1} {step.edgeId}</span>
              <small>{step.funcId} r{step.funcRevision} · cost {step.cost}</small>
              <span className={`status-dot ${status}`} />
            </div>
            {result?.conditionMet === false && <p className="fail-text">condition rejected the document</p>}
            {result?.error && <p className="fail-text">{result.error}</p>}
            {result?.output !== undefined && <pre>{JSON.stringify(result.output, null, 2)}</pre>}
            {!result && <p className="muted">never started</p>}
            {result?.status === 'skipped' && <p className="muted">skipped — run cancelled before this step</p>}
          </li>
        );
      })}
    </ol>
  );
}
