const listeners = new Set();
let latestCommit = null;

function finite(value, name) {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

export function createTreeCommit(
  { phase, treeVersion, actualDurationMs, baseDurationMs, startTimeMs, commitTimeMs },
  timeOriginMs,
) {
  return Object.freeze({
    phase,
    treeVersion: finite(treeVersion, 'treeVersion'),
    actualDurationMs: finite(actualDurationMs, 'actualDurationMs'),
    baseDurationMs: finite(baseDurationMs, 'baseDurationMs'),
    startAt: finite(timeOriginMs + startTimeMs, 'startAt'),
    commitAt: finite(timeOriginMs + commitTimeMs, 'commitAt'),
  });
}

export function publishTreeCommit(commit) {
  latestCommit = commit;
  for (const listener of listeners) listener(commit);
}

export function subscribeTreeCommits(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function latestTreeCommit() {
  return latestCommit;
}

export function isCommitEligible(commit, operationCompletedAt, minimumTreeVersion) {
  return (
    commit !== null &&
    commit.commitAt >= operationCompletedAt &&
    commit.treeVersion >= minimumTreeVersion
  );
}

export function createRenderObservation({
  id,
  kind,
  operationCompletedAt,
  mirrorAt,
  mirrorTreeVersion,
  commit,
  firstFrameAt,
  secondFrameAt,
}) {
  if (!isCommitEligible(commit, operationCompletedAt, mirrorTreeVersion)) {
    throw new Error('React commit predates the mirrored filesystem state');
  }
  return Object.freeze({
    id,
    kind,
    treeVersion: commit.treeVersion,
    mirrorLatencyMs: Math.max(0, mirrorAt - operationCompletedAt),
    commitLatencyMs: Math.max(0, commit.commitAt - operationCompletedAt),
    reactDurationMs: Math.max(0, commit.actualDurationMs),
    reactBaseDurationMs: Math.max(0, commit.baseDurationMs),
    paintLatencyMs: Math.max(0, secondFrameAt - operationCompletedAt),
    commitToPaintMs: Math.max(0, secondFrameAt - commit.commitAt),
    frameIntervalMs: Math.max(0, secondFrameAt - firstFrameAt),
    observedAt: secondFrameAt,
  });
}

export function evaluateRenderQuality(summary, budgets) {
  const violations = [];
  if (summary.failed > 0) violations.push(`${summary.failed} state convergence miss(es)`);
  if (summary.paint.p95 > budgets.maxPaintP95Ms) {
    violations.push(
      `paint p95 ${summary.paint.p95.toFixed(1)}ms > ${budgets.maxPaintP95Ms.toFixed(1)}ms`,
    );
  }
  if (summary.reactDuration.p95 > budgets.maxReactP95Ms) {
    violations.push(
      `React duration p95 ${summary.reactDuration.p95.toFixed(1)}ms > ` +
        `${budgets.maxReactP95Ms.toFixed(1)}ms`,
    );
  }
  if (summary.frameInterval.max > budgets.maxFrameIntervalMs) {
    violations.push(
      `frame interval max ${summary.frameInterval.max.toFixed(1)}ms > ` +
        `${budgets.maxFrameIntervalMs.toFixed(1)}ms`,
    );
  }
  return Object.freeze({ passed: violations.length === 0, violations });
}

export function benchmarkExitCode(event) {
  if (event?.type === 'fatal') return 1;
  if (event?.type === 'complete') return event.summary?.qualityGate?.passed === true ? 0 : 1;
  return null;
}

export function isReferenceTreeReady(rows, seedFiles, outstandingExpansions) {
  if (outstandingExpansions > 0) return false;
  if (seedFiles === 0) return true;
  let visibleReferenceFiles = 0;
  for (const row of rows) {
    if (row.kind === 0 && /^reference-\d{6}\.txt$/.test(row.name)) {
      visibleReferenceFiles += 1;
    }
  }
  return visibleReferenceFiles === seedFiles;
}
