export interface TreeCommitMetric {
  readonly phase: 'mount' | 'update' | 'nested-update';
  readonly treeVersion: number;
  readonly actualDurationMs: number;
  readonly baseDurationMs: number;
  readonly startAt: number;
  readonly commitAt: number;
}

export interface RenderObservation {
  readonly id: number;
  readonly kind: string;
  readonly treeVersion: number;
  readonly mirrorLatencyMs: number;
  readonly commitLatencyMs: number;
  readonly reactDurationMs: number;
  readonly reactBaseDurationMs: number;
  readonly paintLatencyMs: number;
  readonly commitToPaintMs: number;
  readonly frameIntervalMs: number;
  readonly observedAt: number;
}

export function createTreeCommit(
  sample: {
    readonly phase: TreeCommitMetric['phase'];
    readonly treeVersion: number;
    readonly actualDurationMs: number;
    readonly baseDurationMs: number;
    readonly startTimeMs: number;
    readonly commitTimeMs: number;
  },
  timeOriginMs: number,
): TreeCommitMetric;
export function publishTreeCommit(commit: TreeCommitMetric): void;
export function subscribeTreeCommits(listener: (commit: TreeCommitMetric) => void): () => void;
export function latestTreeCommit(): TreeCommitMetric | null;
export function isCommitEligible(
  commit: TreeCommitMetric | null,
  operationCompletedAt: number,
  minimumTreeVersion: number,
): commit is TreeCommitMetric;
export function createRenderObservation(input: {
  readonly id: number;
  readonly kind: string;
  readonly operationCompletedAt: number;
  readonly mirrorAt: number;
  readonly mirrorTreeVersion: number;
  readonly commit: TreeCommitMetric;
  readonly firstFrameAt: number;
  readonly secondFrameAt: number;
}): RenderObservation;
export function evaluateRenderQuality(
  summary: {
    readonly failed: number;
    readonly paint: { readonly p95: number };
    readonly reactDuration: { readonly p95: number };
    readonly frameInterval: { readonly max: number };
  },
  budgets: {
    readonly maxPaintP95Ms: number;
    readonly maxReactP95Ms: number;
    readonly maxFrameIntervalMs: number;
  },
): { readonly passed: boolean; readonly violations: readonly string[] };
export function benchmarkExitCode(event: {
  readonly type?: string;
  readonly summary?: { readonly qualityGate?: { readonly passed?: boolean } };
}): 0 | 1 | null;
