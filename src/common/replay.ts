import type {
  JsonObject,
  PathStep,
  ReplayCurrentSide,
  ReplayDiff,
  ReplayHistoricalSide,
  StepPair,
  StepResult,
} from './types';

/**
 * Sourced replay diff — PURE LOGIC, no IO.
 *
 * The historical side is a fact copied from the stored run (bound revisions,
 * retained intermediates, failure position). The current side is a fresh
 * execution on a pinned graph. Neither side is "replayed" by substituting the
 * other's function bodies; this module only describes where they diverge.
 */

/** Minimal view of one side needed for step-level comparison. */
export type SideTrace = {
  steps: PathStep[];
  results: StepResult[];
  status: string;
  totalCost?: number;
};

function jsonEqual(a: unknown, b: unknown): boolean {
  // Order-insensitive object comparison: {a:1,b:2} and {b:2,a:1} are the same
  // JSON document. Arrays keep order.
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

export function deepJsonEqual(a: unknown, b: unknown): boolean {
  return jsonEqual(a, b);
}

/**
 * Pair steps (and their recorded results) by POSITION. Position alignment is
 * deliberate: even when edge ids diverge, pairing by index shows exactly where
 * the two executions first stopped agreeing. Each pair carries every concrete
 * difference kind independently — a revision change and an output change on
 * the same hop are both reported.
 */
export function pairSides(historical: SideTrace, current: SideTrace): StepPair[] {
  const length = Math.max(historical.steps.length, current.steps.length);
  const hResults = historical.results;
  const cResults = current.results;
  const pairs: StepPair[] = [];

  for (let i = 0; i < length; i++) {
    const hs = historical.steps[i];
    const cs = current.steps[i];
    const hr = hResults[i];
    const cr = cResults[i];
    const diffs: StepPair['diffs'] = [];

    const pathEnded = !hs || !cs;
    if (pathEnded) diffs.push('path');
    else if (hs.edgeId !== cs.edgeId) diffs.push('path');

    // Binding comparisons only make sense while both sides still have a step.
    if (hs && cs) {
      if (hs.funcRevision !== cs.funcRevision) diffs.push('revision');
      if ((hs.condition ?? '') !== (cs.condition ?? '')) diffs.push('condition');
      if (hs.cost !== cs.cost) diffs.push('cost');
    }

    // Status / output comparison from the retained execution records.
    if (hr || cr) {
      if (!hr || !cr) {
        diffs.push('missing');
      } else {
        if (hr.status !== cr.status) diffs.push('status');
        if (hr.status === 'done' && cr.status === 'done') {
          if (!jsonEqual(hr.output, cr.output)) diffs.push('output');
        }
      }
    }

    pairs.push({
      index: i,
      historicalStep: hs,
      currentStep: cs,
      historicalResult: hr,
      currentResult: cr,
      diffs,
    });
  }
  return pairs;
}

/** Last successfully produced intermediate output (the surviving document). */
export function lastDoneOutput(results: StepResult[]): JsonObject | undefined {
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i].status === 'done') return results[i].output;
  }
  return undefined;
}

function terminalOf(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'blocked';
}

export type SideCounts = {done: number; failed: number; skipped: number; other: number};

function countStatuses(results: StepResult[]): SideCounts {
  const counts: SideCounts = {done: 0, failed: 0, skipped: 0, other: 0};
  for (const r of results) {
    if (r.status === 'done') counts.done += 1;
    else if (r.status === 'failed') counts.failed += 1;
    else if (r.status === 'skipped') counts.skipped += 1;
    else counts.other += 1;
  }
  return counts;
}

/**
 * Build the full sourced diff once the current side has reached a terminal
 * state. While the current run is still in flight callers must NOT freeze a
 * diff (the pinned run's outputs are not facts yet).
 */
export function diffSides(
  historical: ReplayHistoricalSide,
  current: ReplayCurrentSide,
): ReplayDiff {
  const pairs = pairSides(historical, current);
  const firstIndex = pairs.find((p) => p.diffs.length > 0)?.index ?? null;

  const notes: string[] = [];
  const finalDocumentEqual = finalVerdict(historical, current, notes);

  if (historical.pathKey !== current.selectedKey) {
    notes.unshift(
      `historical path ${historical.pathKey || '(empty)'} vs current selection ${current.selectedKey ?? '(none)'}`,
    );
  }

  return {
    pairs,
    firstDifferenceIndex: firstIndex,
    firstDifferenceEdge: describeFirstEdge(pairs, firstIndex),
    historicalCounts: countStatuses(historical.results),
    currentCounts: countStatuses(current.results),
    finalDocumentEqual,
    notes,
  };
}

function describeFirstEdge(pairs: StepPair[], index: number | null):
  {historical?: string; current?: string} | undefined {
  if (index === null) return undefined;
  const pair = pairs[index];
  return {historical: pair.historicalStep?.edgeId, current: pair.currentStep?.edgeId};
}

function finalVerdict(
  historical: ReplayHistoricalSide,
  current: ReplayCurrentSide,
  notes: string[],
): boolean | null {
  if (!terminalOf(current.status)) return null;
  if (current.status === 'blocked') {
    notes.push(`current side blocked: ${current.blockedReason ?? 'no applicable path on the current graph'}`);
    return null;
  }

  const h = lastDoneOutput(historical.results);
  const c = lastDoneOutput(current.results);

  if (historical.status !== 'succeeded') {
    notes.push(`historical run ended ${historical.status}${historical.failedEdgeId ? ` at ${historical.failedEdgeId}` : ''} — it has no final document`);
  }
  if (current.status !== 'succeeded') {
    notes.push(`current run ended ${current.status}${current.failedEdgeId ? ` at ${current.failedEdgeId}` : ''} — it has no final document`);
  }
  if (historical.status !== 'succeeded' || current.status !== 'succeeded') return null;
  if (h === undefined || c === undefined) return null;
  return jsonEqual(h, c);
}
