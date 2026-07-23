// Phase 5.1 — diagnostics decoration types.
//
// Host-supplied diagnostic source. The companion never ships a language
// server: TypeScript, ESLint, rust-analyzer, etc. are host-specific.
// Consumers inject whatever their platform supports (LSP client, in-process
// checker, or a test fake).

/**
 * Diagnostic severity ordered by precedence for badge color / merge.
 * Higher severity always wins when a file (or folder aggregate) has
 * mixed severities: error > warning > info > hint.
 */
export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

/**
 * Numeric rank for severity comparisons. Higher = more severe.
 * Exported so hosts / tests can sort without re-encoding the order.
 */
export const DIAGNOSTIC_SEVERITY_RANK: Readonly<
  Record<DiagnosticSeverity, number>
> = Object.freeze({
  error: 3,
  warning: 2,
  info: 1,
  hint: 0,
});

/**
 * One diagnostic on a workspace path. `path` is workspace-relative with
 * POSIX separators — same convention as `GitStatusEntry.path`.
 */
export interface Diagnostic {
  readonly path: string;
  readonly severity: DiagnosticSeverity;
  /** Human-readable message (surfaces in leaf tooltips). */
  readonly message?: string;
  /** Origin label, e.g. `"typescript"`, `"eslint"`. */
  readonly source?: string;
  readonly code?: string | number;
  /** Optional 1-based range. Used only for tooltip detail. */
  readonly range?: {
    readonly startLine: number;
    readonly startCol?: number;
    readonly endLine?: number;
    readonly endCol?: number;
  };
}

/**
 * Per-severity counts. Used for folder aggregates and tooltip text.
 */
export interface DiagnosticCounts {
  readonly error: number;
  readonly warning: number;
  readonly info: number;
  readonly hint: number;
}

/**
 * Minimal contract the UI needs from a host-supplied diagnostics client.
 *
 * `getDiagnostics(root)` returns a snapshot map. Keys are **workspace-
 * relative POSIX paths** (matching each `Diagnostic.path`). Values are
 * the diagnostics for that path. Empty map = clean tree.
 *
 * Implementations should return a fresh map (or treat it as immutable).
 *
 * `onChange(cb)` fires whenever diagnostics may have changed; the
 * companion coalesces storms via its own batcher.
 */
export interface DiagnosticsClient {
  getDiagnostics(
    root: string,
  ): Promise<ReadonlyMap<string, readonly Diagnostic[]>>;

  /**
   * Subscribe to changes. Returns a disposer that unsubscribes.
   * Must be safe to call multiple times.
   */
  onChange(cb: () => void): () => void;
}

/**
 * Pick the highest severity present in a counts record, or `null` when
 * every count is zero.
 */
export function maxSeverityFromCounts(
  counts: DiagnosticCounts,
): DiagnosticSeverity | null {
  if (counts.error > 0) return 'error';
  if (counts.warning > 0) return 'warning';
  if (counts.info > 0) return 'info';
  if (counts.hint > 0) return 'hint';
  return null;
}

/** Sum of all severity buckets. */
export function totalDiagnosticCount(counts: DiagnosticCounts): number {
  return counts.error + counts.warning + counts.info + counts.hint;
}

/**
 * Build counts from a list of diagnostics (one leaf).
 */
export function countDiagnostics(
  diagnostics: readonly Diagnostic[],
): DiagnosticCounts {
  let error = 0;
  let warning = 0;
  let info = 0;
  let hint = 0;
  for (const d of diagnostics) {
    switch (d.severity) {
      case 'error':
        error += 1;
        break;
      case 'warning':
        warning += 1;
        break;
      case 'info':
        info += 1;
        break;
      case 'hint':
        hint += 1;
        break;
      default:
        break;
    }
  }
  return { error, warning, info, hint };
}

/**
 * Add two count records (immutable).
 */
export function addCounts(
  a: DiagnosticCounts,
  b: DiagnosticCounts,
): DiagnosticCounts {
  return {
    error: a.error + b.error,
    warning: a.warning + b.warning,
    info: a.info + b.info,
    hint: a.hint + b.hint,
  };
}

export const ZERO_COUNTS: DiagnosticCounts = Object.freeze({
  error: 0,
  warning: 0,
  info: 0,
  hint: 0,
});
