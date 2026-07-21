export interface WatchBenchConfig {
  readonly enabled: true;
  readonly operations: number;
  readonly seedFiles: number;
  readonly debounceMs: number;
  readonly timeoutMs: number;
  readonly pauseMs: number;
  readonly maxPaintP95Ms: number;
  readonly maxReactP95Ms: number;
  readonly maxFrameIntervalMs: number;
  readonly exitOnComplete: boolean;
  readonly reportPath: string;
  readonly workspaceRoot: string;
}

export interface WatchBenchPresentExpectation {
  readonly name: string;
  readonly kind?: number;
  readonly size?: number;
}

export interface WatchBenchExpectation {
  readonly present: readonly WatchBenchPresentExpectation[];
  readonly absent: readonly string[];
}

export interface WatchBenchOperation {
  readonly id: number;
  readonly kind: string;
  readonly label: string;
  readonly expectation: WatchBenchExpectation;
}

export interface WatchBenchObservation {
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

export interface WatchBenchSummary {
  readonly count: number;
  readonly failed: number;
  readonly durationMs: number;
  readonly operationsPerSecond: number;
  readonly mirror: WatchBenchLatencySummary;
  readonly commit: WatchBenchLatencySummary;
  readonly reactDuration: WatchBenchLatencySummary;
  readonly paint: WatchBenchLatencySummary;
  readonly commitToPaint: WatchBenchLatencySummary;
  readonly frameInterval: WatchBenchLatencySummary;
  readonly qualityGate: {
    readonly passed: boolean;
    readonly violations: readonly string[];
  };
}

export interface WatchBenchLatencySummary {
  readonly min: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export type WatchBenchEvent =
  | {
      readonly type: 'issued';
      readonly operation: WatchBenchOperation;
      readonly completedAt: number;
      readonly warmup?: boolean;
    }
  | {
      readonly type: 'timeout';
      readonly operation: WatchBenchOperation;
      readonly timeoutMs: number;
    }
  | {
      readonly type: 'complete';
      readonly summary: WatchBenchSummary;
      readonly reportPath: string;
    }
  | { readonly type: 'fatal'; readonly message: string };
