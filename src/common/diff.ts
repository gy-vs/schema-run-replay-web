import type {
  CandidatePath,
  DivergenceReport,
  HistoricalVerdict,
  JsonObject,
  JsonValue,
  PathStep,
  ReplayComparison,
  Run,
  StepDiff,
  StepResult,
} from './types';

/** Structural JSON equality (Object.is on leaves; NaN equals NaN). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i] as JsonValue));
  }
  const ra = a as Record<string, JsonValue>;
  const rb = b as Record<string, JsonValue>;
  const keysA = Object.keys(ra);
  const keysB = Object.keys(rb);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => Object.prototype.hasOwnProperty.call(rb, k) && jsonEqual(ra[k], rb[k]));
}

/** Last retained intermediate output — a failed or cancelled run has none. */
export function finalOutputOf(run: Run | undefined): JsonObject | undefined {
  if (!run) return undefined;
  for (let i = run.results.length - 1; i >= 0; i--) {
    const result = run.results[i]!;
    if (result.status === 'done' && result.output !== undefined) {
      // Only a run that reached its last step actually produced a final doc.
      if (run.status === 'succeeded' || i === run.steps.length - 1) return result.output;
    }
  }
  return undefined;
}

function stepDiff(index: number, oldStep: PathStep | undefined, freshStep: PathStep | undefined,
  oldResult: StepResult | undefined, freshResult: StepResult | undefined): StepDiff {
  const changes: StepDiff['changes'] = [];
  if (oldStep && !freshStep) changes.push('only_in_history');
  if (!oldStep && freshStep) changes.push('only_in_fresh');
  if (oldStep && freshStep) {
    if (oldStep.edgeId !== freshStep.edgeId) changes.push('edge_changed');
    if (oldStep.funcRevision !== freshStep.funcRevision) changes.push('revision_changed');
    if ((oldStep.condition ?? '') !== (freshStep.condition ?? '')) changes.push('condition_changed');
    if (oldStep.cost !== freshStep.cost) changes.push('cost_changed');
    if (oldResult && freshResult && oldResult.status !== freshResult.status) changes.push('status_changed');
  }
  let outputEqual = true;
  if (oldResult?.output !== undefined || freshResult?.output !== undefined) {
    outputEqual = jsonEqual(oldResult?.output, freshResult?.output);
    if (!outputEqual) changes.push('output_changed');
  }
  return {index, oldStep, freshStep, oldResult, freshResult, changes, outputEqual};
}

function verdictOf(candidate: CandidatePath | undefined): HistoricalVerdict {
  if (!candidate) return 'absent';
  if (candidate.conditionStatus === 'rejected') return 'condition_rejected';
  if (candidate.conditionStatus === 'unknown') return 'unverifiable';
  if (!candidate.valid) return 'schema_issue';
  return 'applicable';
}

/**
 * Build the sourced, step-aligned divergence report.
 *
 * Results are aligned BY INDEX in execution order, not by edge id: when the
 * paths differ, the same index still pairs the two sides, and the very first
 * index where edge / revision / condition / cost / output differs is named
 * explicitly — identical final JSON does not hide an earlier fork.
 */
export function buildDivergence(input: {
  oldRun: Run;
  freshRun?: Run;
  candidates: CandidatePath[];
}): DivergenceReport {
  const {oldRun, freshRun, candidates} = input;
  const length = Math.max(oldRun.steps.length, freshRun?.steps.length ?? 0);
  const steps: StepDiff[] = [];
  for (let i = 0; i < length; i++) {
    steps.push(stepDiff(
      i,
      oldRun.steps[i],
      freshRun?.steps[i],
      oldRun.results[i],
      freshRun?.results[i],
    ));
  }

  const firstDifferentIndex = steps.find((s) => s.changes.length > 0)?.index ?? null;
  const firstOutputDifferenceIndex = steps.find((s) => !s.outputEqual)?.index ?? null;

  const oldKey = oldRun.pathKey;
  const historicalIndex = candidates.findIndex((c) => c.key === oldKey);
  const historicalRank = historicalIndex >= 0 ? historicalIndex + 1 : null;
  const historicalCandidate = historicalIndex >= 0 ? candidates[historicalIndex] : undefined;
  const historicalVerdict = verdictOf(historicalCandidate);
  const freshKey = freshRun?.pathKey;
  const samePath = Boolean(freshKey && freshKey === oldKey);

  const finalOld = finalOutputOf(oldRun);
  const finalFresh = finalOutputOf(freshRun);
  let finalEqual: boolean | null = null;
  if (finalOld !== undefined && finalFresh !== undefined) finalEqual = jsonEqual(finalOld, finalFresh);

  const notes: string[] = [];
  if (!samePath) {
    notes.push(historicalRank === null
      ? `historical path ${oldKey} no longer exists in the current graph`
      : `historical path ${oldKey} is rank #${historicalRank} of ${candidates.length} under current costs`);
  }
  if (!samePath && freshKey) notes.push(`fresh execution chose ${freshKey}`);
  if (historicalVerdict !== 'applicable' && historicalVerdict !== 'absent') {
    notes.push(`historical path would be "${historicalVerdict}" if selected now${
      historicalCandidate?.rejectedReason ? `: ${historicalCandidate.rejectedReason}` : ''}`);
  }
  if (firstOutputDifferenceIndex !== null && finalEqual === true) {
    notes.push('final documents match, but the intermediate documents already differed — see the first output difference');
  } else if (firstOutputDifferenceIndex === null && finalEqual === true && firstDifferentIndex !== null) {
    notes.push('final documents match, but the routes already differed (edge, revision, condition or cost) before the end');
  }
  if (oldRun.status === 'failed') {
    notes.push(`historical run failed at ${oldRun.failedEdgeId ?? '?'}: ${oldRun.error ?? 'no error recorded'}`);
  } else if (oldRun.status === 'cancelled') {
    notes.push('historical run was cancelled — only the completed intermediate outputs above are facts');
  }

  return {
    steps,
    firstDifferentIndex,
    firstOutputDifferenceIndex,
    finalEqual,
    finalOld,
    finalFresh,
    samePath,
    historicalRank,
    historicalVerdict,
    notes,
  };
}

/** Convenience accessor for completed replay records stored on the server. */
export function freshRunOf(replay: ReplayComparison, runs: Map<string, Run>): Run | undefined {
  return replay.fresh.runId ? runs.get(replay.fresh.runId) : undefined;
}
