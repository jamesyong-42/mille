// Phase 5.1 — test status decoration types.
//
// Hosts push results from their test runner (Jest, Vitest, cargo test, …);
// the companion never runs tests itself.

/**
 * Outcome of a single test file / suite path.
 *
 * Severity order for folder roll-up and badge color:
 *   failed > errored > running > skipped > passed
 */
export type TestStatus =
  | 'passed'
  | 'failed'
  | 'errored'
  | 'skipped'
  | 'running';

/**
 * Numeric rank for severity comparisons. Higher = more severe / more
 * attention-grabbing in the explorer.
 */
export const TEST_STATUS_RANK: Readonly<Record<TestStatus, number>> =
  Object.freeze({
    failed: 4,
    errored: 3,
    running: 2,
    skipped: 1,
    passed: 0,
  });

/**
 * One test result keyed by workspace-relative path (POSIX separators).
 * Path is typically a test file; hosts may also key suite folders.
 */
export interface TestResult {
  readonly path: string;
  readonly status: TestStatus;
  /** Failure message or suite summary (tooltip). */
  readonly message?: string;
  readonly durationMs?: number;
  /**
   * Optional nested counts when the path is a suite that already
   * aggregates children. When set, ancestor roll-up prefers these
   * numbers over treating the path as a single leaf.
   */
  readonly counts?: TestStatusCounts;
}

/**
 * Per-status counts for folder aggregates and suite summaries.
 */
export interface TestStatusCounts {
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  readonly skipped: number;
  readonly running: number;
}

export const ZERO_TEST_COUNTS: TestStatusCounts = Object.freeze({
  passed: 0,
  failed: 0,
  errored: 0,
  skipped: 0,
  running: 0,
});

/**
 * Minimal contract the UI needs from a host-supplied test client.
 *
 * `getResults(root)` returns a map of workspace-relative path → result.
 * `onChange` fires when a run starts, progresses, or finishes.
 */
export interface TestStatusClient {
  getResults(
    root: string,
  ): Promise<ReadonlyMap<string, TestResult>> | ReadonlyMap<string, TestResult>;
  onChange(cb: () => void): () => void;
}

export function maxTestStatus(
  a: TestStatus | null,
  b: TestStatus | null,
): TestStatus | null {
  if (a === null) return b;
  if (b === null) return a;
  return TEST_STATUS_RANK[a] >= TEST_STATUS_RANK[b] ? a : b;
}

export function maxStatusFromCounts(
  counts: TestStatusCounts,
): TestStatus | null {
  if (counts.failed > 0) return 'failed';
  if (counts.errored > 0) return 'errored';
  if (counts.running > 0) return 'running';
  if (counts.skipped > 0) return 'skipped';
  if (counts.passed > 0) return 'passed';
  return null;
}

export function totalTestCount(counts: TestStatusCounts): number {
  return (
    counts.passed +
    counts.failed +
    counts.errored +
    counts.skipped +
    counts.running
  );
}

export function countsFromStatus(status: TestStatus): TestStatusCounts {
  return {
    passed: status === 'passed' ? 1 : 0,
    failed: status === 'failed' ? 1 : 0,
    errored: status === 'errored' ? 1 : 0,
    skipped: status === 'skipped' ? 1 : 0,
    running: status === 'running' ? 1 : 0,
  };
}

export function countsFromResult(result: TestResult): TestStatusCounts {
  if (result.counts !== undefined) return result.counts;
  return countsFromStatus(result.status);
}

export function addTestCounts(
  a: TestStatusCounts,
  b: TestStatusCounts,
): TestStatusCounts {
  return {
    passed: a.passed + b.passed,
    failed: a.failed + b.failed,
    errored: a.errored + b.errored,
    skipped: a.skipped + b.skipped,
    running: a.running + b.running,
  };
}
