import {useCallback, useEffect, useReducer, useRef, useState} from 'react';
import {
  ArrowLeftRight,
  CheckCheck,
  History,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react';
import type {ReplayComparison, Run, RunSummary, StepPair} from '../common/types';
import {api} from './api';
import {initialReplay, replayReducer, replayIsTerminal} from './replay';

/**
 * Sourced replay workbench.
 *
 * Left pane (ReplayPanel): pick a finished historical run, choose the current
 * start/goal, create a comparison; also reopen comparisons the server stored.
 * Middle pane (ReplayTrace): historical fact vs. fresh current-side execution,
 * step pairs, and the precise first divergence.
 *
 * State lives in one reducer at App level (so both panes share it); the hook
 * below owns loading and polling.
 */

export function useReplayWorkbench(opts: {active: boolean}) {
  const [state, dispatch] = useReducer(replayReducer, initialReplay);
  const seqRef = useRef(0);
  const pollRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const refreshLists = useCallback(async () => {
    try {
      const [runs, replays] = await Promise.all([api.listRuns(), api.listReplays()]);
      dispatch({type: 'runs_loaded', runs: runs.runs});
      dispatch({type: 'replays_loaded', replays: replays.replays});
    } catch {
      // lists are non-critical; the next refresh retries
    }
  }, []);

  const pollReplay = useCallback(
    (seq: number, id: string) => {
      let cancelled = false;
      const tick = async () => {
        if (cancelled) return;
        try {
          const {replay} = await api.replay(id);
          if (cancelled) return;
          dispatch({type: 'replay_progress', seq, replay});
          if (replayIsTerminal(replay)) {
            stopPolling();
            void refreshLists();
            return;
          }
        } catch {
          // transient — fall through and repoll
        }
        pollRef.current = window.setTimeout(tick, 150);
      };
      pollRef.current = window.setTimeout(tick, 150);
      return () => {
        cancelled = true;
        stopPolling();
      };
    },
    [refreshLists, stopPolling],
  );

  // Load the picker lists when the workbench becomes active.
  useEffect(() => {
    if (!opts.active) return;
    void refreshLists();
  }, [opts.active, refreshLists]);

  // Stop background polling as soon as the user leaves the replay tab.
  useEffect(() => {
    if (!opts.active) stopPolling();
  }, [opts.active, stopPolling]);

  useEffect(() => stopPolling, [stopPolling]);

  const startRequest = useCallback(() => {
    seqRef.current += 1;
    stopPolling();
    dispatch({type: 'request_started', seq: seqRef.current});
    return seqRef.current;
  }, [stopPolling]);

  /** Reopen a comparison already stored on the server. */
  const openReplay = useCallback(
    async (id: string) => {
      const seq = startRequest();
      try {
        const {replay} = await api.replay(id);
        dispatch({type: 'replay_attached', seq, replay});
        if (!replayIsTerminal(replay)) pollReplay(seq, replay.id);
      } catch (error) {
        dispatch({type: 'request_failed', seq, error: (error as Error).message});
      }
    },
    [pollReplay, startRequest],
  );

  const createReplay = useCallback(
    async (input: {
      runId: string;
      start: string;
      goal: string;
      reversibleOnly: boolean;
      expectedRevision: number;
    }) => {
      const seq = startRequest();
      try {
        const {replay} = await api.createReplay(input);
        dispatch({type: 'replay_attached', seq, replay});
        if (!replayIsTerminal(replay)) pollReplay(seq, replay.id);
        void refreshLists();
      } catch (error) {
        dispatch({type: 'request_failed', seq, error: (error as Error).message});
      }
    },
    [pollReplay, refreshLists, startRequest],
  );

  return {state, openReplay, createReplay, refreshLists};
}

export type ReplayWorkbench = ReturnType<typeof useReplayWorkbench>;

// ---------------------------------------------------------------------------

export function ReplayPanel({
  workbench,
  nodeIds,
  graphRevision,
}: {
  workbench: ReplayWorkbench;
  nodeIds: string[];
  graphRevision: number;
}) {
  const {state, createReplay, refreshLists} = workbench;
  const [runId, setRunId] = useState('');
  const [start, setStart] = useState(nodeIds[0] ?? '');
  const [goal, setGoal] = useState(nodeIds[nodeIds.length - 1] ?? '');
  const [reversibleOnly, setReversibleOnly] = useState(false);

  const nodeKey = nodeIds.join(',');
  useEffect(() => {
    setStart((v) => (nodeIds.includes(v) ? v : nodeIds[0] ?? ''));
    setGoal((v) => (nodeIds.includes(v) ? v : nodeIds[nodeIds.length - 1] ?? ''));
    // node identity is stable per graph revision; react to the id set only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeKey]);

  return (
    <>
      <h2><History size={15} /> Replay comparison</h2>
      <p className="muted">
        Re-run a stored migration against the CURRENT graph. The historical side
        is its original record — bound revisions and retained outputs are facts,
        never re-executed.
      </p>

      <label className="block">Historical run
        <select value={runId} onChange={(e) => setRunId(e.target.value)}>
          <option value="" disabled>select a finished run…</option>
          {state.runs.map((r: RunSummary) => (
            <option key={r.id} value={r.id}>
              {r.id} · {r.status} · {r.pathKey || '(empty)'} · graph r{r.graphRevision}
            </option>
          ))}
        </select>
      </label>

      <div className="field-row">
        <label>From (current)
          <select value={start} onChange={(e) => setStart(e.target.value)}>
            {nodeIds.map((id) => <option key={id}>{id}</option>)}
          </select>
        </label>
        <label>To (current)
          <select value={goal} onChange={(e) => setGoal(e.target.value)}>
            {nodeIds.map((id) => <option key={id}>{id}</option>)}
          </select>
        </label>
      </div>

      <label className="check">
        <input type="checkbox" checked={reversibleOnly} onChange={(e) => setReversibleOnly(e.target.checked)} />
        <ArrowLeftRight size={13} /> rollback-safe edges only (new side)
      </label>

      <div className="toolbar">
        <button
          className="primary"
          disabled={state.busy || !runId}
          onClick={() => {
            void createReplay({runId, start, goal, reversibleOnly, expectedRevision: graphRevision});
          }}
        >
          {state.busy ? <Loader2 size={15} className="spin" /> : <Play size={15} />}
          Replay against current graph
        </button>
        <button onClick={() => void refreshLists()} title="Refresh lists"><RefreshCw size={14} /></button>
      </div>

      {state.error && (
        <p className="error-banner"><TriangleAlert size={14} /> {state.error}</p>
      )}

      {state.runs.length === 0 && <p className="muted">No stored runs yet — execute a path or a comparison first.</p>}

      <div className="replay-saved">
        <div className="list-head">
          <h3 className="mini-h">Stored comparisons</h3>
          <button className="mini" onClick={() => void refreshLists()}><Search size={12} />reload</button>
        </div>
        {state.replays.length === 0 && (
          <p className="muted">Nothing stored yet. Comparisons persist server-side and can be reopened later.</p>
        )}
        {state.replays.map((r) => (
          <button
            key={r.id}
            className={`replay-item ${state.selectedReplayId === r.id ? 'selected' : ''}`}
            onClick={() => void workbench.openReplay(r.id)}
          >
            <span className="path-text">{r.id}</span>
            <span className={`status-dot ${r.status === 'completed' ? 'succeeded' : r.status === 'blocked' ? 'failed' : 'running'}`} />
            <small className="muted">
              src {r.sourceRunId} · graph r{r.historicalRevision}→r{r.pinnedRevision} · {r.currentStatus ?? r.status}
            </small>
          </button>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

export function ReplayTrace({replay, busy}: {replay: ReplayComparison | null; busy: boolean}) {
  if (!replay) {
    return (
      <>
        <h2><History size={15} /> Replay trace</h2>
        <p className="muted">
          Choose a finished run on the left and replay it against the current
          graph. You will see which migration step first diverged — equal final
          JSON does not mean the journeys matched.
        </p>
      </>
    );
  }

  const {historical, current, drift, diff} = replay;

  return (
    <>
      <h2><History size={15} /> Replay trace <code className="small-code">{replay.id}</code></h2>

      <div className="replay-banner">
        <span className="tag" title="Copied verbatim from the stored run; never re-executed">
          historical: r{historical.graphRevision} · {historical.status}
        </span>
        <Lock size={12} />
        <span className="tag" title="Candidate ranking and execution are pinned to this graph revision">
          current bound: r{current.graphRevision} · {current.status}
        </span>
        {replay.status === 'running' && <small className="muted"><Loader2 size={12} className="spin" /> new side executing…</small>}
        {busy && replay.status !== 'running' && <small className="muted">preparing…</small>}
      </div>

      {drift.changedFromView && (
        <p className="warn-banner-inline">
          <TriangleAlert size={13} /> the graph changed before this replay started — your page showed r
          {drift.expectedRevision ?? '?'}, the new side is bound to r{drift.pinnedRevision}.
        </p>
      )}
      {drift.changedDuringPreparation && (
        <p className="warn-banner-inline">
          <TriangleAlert size={13} /> the graph was edited while candidates were being enumerated;
          ranking and the run were both pinned to r{current.graphRevision}.
        </p>
      )}
      {!drift.changedFromView && !drift.changedDuringPreparation && (
        <p className="muted"><Lock size={11} /> bound at request time; later edits cannot rewrite this comparison.</p>
      )}

      {diff && <DiffSummary replay={replay} />}

      <div className="replay-columns">
        <div className="replay-col">
          <h3 className="mini-h">Historical fact <small className="muted">not re-executed</small></h3>
          <SideTraceCard
            pathKey={historical.pathKey}
            status={historical.status}
            totalCost={historical.totalCost}
            failedEdgeId={historical.failedEdgeId}
            error={historical.error}
            sample={replay.sample}
            steps={historical.steps}
            results={historical.results}
            pairs={diff?.pairs}
          />
        </div>
        <div className="replay-col">
          <h3 className="mini-h">Fresh execution on current graph</h3>
          {current.status === 'blocked' ? (
            <div className="trace-step failed">
              <strong>No applicable path</strong>
              <p className="fail-text">{current.blockedReason}</p>
              <FrozenRanking replay={replay} />
            </div>
          ) : (
            <SideTraceCard
              pathKey={current.selectedKey ?? ''}
              status={current.status}
              totalCost={current.totalCost}
              failedEdgeId={current.failedEdgeId}
              error={current.error}
              sample={replay.sample}
              steps={current.steps}
              results={current.results}
              pairs={diff?.pairs}
            />
          )}
          {current.status !== 'blocked' && <FrozenRanking replay={replay} />}
        </div>
      </div>
    </>
  );
}

function DiffSummary({replay}: {replay: ReplayComparison}) {
  const diff = replay.diff!;
  const first = diff.firstDifferenceIndex;
  return (
    <div className={`diff-summary ${first === null ? 'equal' : 'different'}`}>
      {first === null ? (
        <span><CheckCheck size={14} /> identical step-for-step: same edges, revisions, conditions, statuses and outputs</span>
      ) : (
        <span>
          <TriangleAlert size={14} /> first divergence at step {first + 1}
          {diff.firstDifferenceEdge && (
            <> — historical <code>{diff.firstDifferenceEdge.historical ?? '∅'}</code>
            {' '}vs current <code>{diff.firstDifferenceEdge.current ?? '∅'}</code></>
          )}
          <span className="diff-kinds">
            {diff.pairs[first]?.diffs.map((d) => <span key={d} className="tag warn">{d}</span>)}
          </span>
        </span>
      )}
      <span className="diff-final">
        {diff.finalDocumentEqual === true && 'final JSON equal (inspect the steps above)'}
        {diff.finalDocumentEqual === false && 'final JSON differs'}
        {diff.finalDocumentEqual === null && 'no comparable final document (a side failed, was blocked or cancelled)'}
      </span>
      {diff.notes.map((n, i) => <small key={i} className="muted diff-note">{n}</small>)}
    </div>
  );
}

function FrozenRanking({replay}: {replay: ReplayComparison}) {
  const {ranking, selectedKey} = replay.current;
  return (
    <details className="frozen-ranking">
      <summary>frozen candidate ranking @ r{replay.current.graphRevision} ({ranking.length})</summary>
      <ol className="ranking-list">
        {ranking.map((c, i) => (
          <li key={c.key} className={c.key === selectedKey ? 'selected' : ''}>
            <span className="muted">{i + 1}.</span> <code>{c.key}</code>
            <span className="muted"> cost {c.totalCost}</span>
            {c.key === selectedKey && <span className="tag ok">selected</span>}
            {!c.valid && <span className="tag warn">schema issue</span>}
            {c.conditionStatus === 'rejected' && (
              <span className="tag warn">condition rejected @ {c.rejectedAtEdge}</span>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

function SideTraceCard({
  pathKey,
  status,
  totalCost,
  failedEdgeId,
  error,
  sample,
  steps,
  results,
  pairs,
}: {
  pathKey: string;
  status: string;
  totalCost?: number;
  failedEdgeId?: string;
  error?: string;
  sample: Run['sample'];
  steps: Run['steps'];
  results: Run['results'];
  pairs?: StepPair[];
}) {
  const dotClass =
    status === 'succeeded' ? 'succeeded'
      : status === 'failed' ? 'failed'
        : status === 'cancelled' ? 'cancelled'
          : 'running';
  return (
    <div>
      <p className={`run-summary ${status === 'failed' ? 'failed' : ''}`}>
        <span className={`status-dot ${dotClass}`} />
        {status} · cost {totalCost ?? '—'}
        {failedEdgeId && <> · stopped at <code>{failedEdgeId}</code></>}
      </p>
      {error && <p className="fail-text">{error}</p>}
      <p className="path-text">{pathKey || '(no path)'}</p>
      <ol className="trace">
        <li className="trace-step seed">
          <div className="trace-head"><span className="pill">sample</span></div>
          <pre>{JSON.stringify(sample, null, 2)}</pre>
        </li>
        {steps.map((step, index) => {
          const result = results[index];
          const pair = pairs?.[index];
          const isFirst = pair ? pairs!.findIndex((p) => p.diffs.length > 0) === index : false;
          // 'cost' alone still marks the pair, but the prominent tags focus on
          // behaviour-changing differences.
          const tags = pair?.diffs.filter((d) => d !== 'cost') ?? [];
          return (
            <li
              key={`${step.edgeId}-${index}`}
              className={`trace-step ${result?.status ?? 'pending'} ${isFirst ? 'first-divergence' : ''}`}
            >
              <div className="trace-head">
                <span className={`pill ${result?.status ?? 'pending'}`}>{step.edgeId}</span>
                <small>{step.funcId} r{step.funcRevision} · {step.cost} · {step.from}→{step.to}</small>
                {isFirst && (
                  <span className="tag warn" title="First step where the two sides diverge">
                    <X size={11} />first diff
                  </span>
                )}
                {tags.map((d) => <span key={d} className="tag diff-tag">{d}</span>)}
              </div>
              {step.condition && <small className="muted">cond: {step.condition}</small>}
              {result?.conditionMet === false && <p className="fail-text">condition rejected the document</p>}
              {result?.error && <p className="fail-text">{result.error}</p>}
              {result?.output !== undefined && <pre>{JSON.stringify(result.output, null, 2)}</pre>}
              {!result && status === 'failed' && <p className="muted">not reached before failure</p>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
