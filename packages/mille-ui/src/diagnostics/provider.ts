// Phase 5.1 — registerDiagnosticsDecorations factory.
//
// Wires a host-supplied `DiagnosticsClient` into the engine's decoration
// pipeline. Pattern mirrors `git/provider.ts`:
//
//   1. Fetches an initial diagnostics snapshot.
//   2. Resolves workspace-relative paths → `EntryId` via `fx.getByUri`.
//   3. Builds leaf decorations (badge = problem count, color = max
//      severity) and optional ancestor aggregates (sum of descendant
//      counts, color = max severity among descendants).
//   4. Registers a `DecorationProvider` whose `provide(entry)` is an
//      O(1) map lookup.
//   5. Subscribes to `client.onChange`; each firing re-fetches via the
//      batcher and publishes `onDidChange(ids)`.
//
// Merge precedence with other providers (SCM, agent-rules, …) follows
// the engine / UI "later providers win on overlapping fields" rule
// (see `mergeDecorations`). Hosts that want diagnostic badges to win
// over SCM letters should register diagnostics *after* SCM.

import type {
  Decoration,
  Entry,
  EntryId,
  FileExplorer,
  Uri,
} from '@vibecook/mille';
import type { PortFileExplorer } from '@vibecook/mille/port';

import { createBatcher, type BatchOptions } from '../git/batch.js';
import type {
  Diagnostic,
  DiagnosticCounts,
  DiagnosticSeverity,
  DiagnosticsClient,
} from './types.js';
import {
  ZERO_COUNTS,
  addCounts,
  countDiagnostics,
  maxSeverityFromCounts,
  totalDiagnosticCount,
} from './types.js';

// ─── Minimal fx surface ───────────────────────────────────────────────

interface SnapshotLike {
  getById(id: EntryId): Entry | null;
}

/**
 * Subset of `FileExplorer` the companion actually touches. Narrow so
 * tests can hand in a scripted fake without stubbing the full engine.
 */
export interface FileExplorerLike {
  getSnapshot(): SnapshotLike;
  getByUri?(uri: Uri): Promise<Entry | null> | Entry | null;
  registerDecorationProvider(
    provider: EngineDecorationProvider,
  ): { dispose(): void };
}

/**
 * Engine-level `DecorationProvider` shape. Re-declared locally so the
 * companion doesn't force a runtime dependency direction.
 */
export interface EngineDecorationProvider {
  readonly id: string;
  onDidChange(
    listener: (ids: readonly EntryId[]) => void,
  ): { dispose(): void };
  provide(entry: Entry): Decoration | null;
}

// ─── Options & handle ─────────────────────────────────────────────────

export interface RegisterDiagnosticsDecorationsOptions {
  /**
   * Accepts either the real in-process `FileExplorer`, a port-backed
   * `PortFileExplorer`, or a scripted `FileExplorerLike` fake.
   */
  readonly fx: FileExplorer | PortFileExplorer | FileExplorerLike;
  readonly client: DiagnosticsClient;
  /**
   * Absolute workspace root. Passed through to `client.getDiagnostics`
   * and used as the base for `fx.getByUri` lookups.
   */
  readonly rootPath: string;
  /** Provider id. Default: `'diagnostics'`. */
  readonly providerId?: string;
  /**
   * When `true` (default), each leaf with diagnostics propagates
   * aggregate counts up its ancestor chain so folders surface problem
   * totals.
   */
  readonly propagateToParent?: boolean;
  /** URI scheme passed to `fx.getByUri`. Default: `'file'`. */
  readonly uriScheme?: string;
  /** Forwarded to the batcher; exposed for tests. */
  readonly batchOptions?: BatchOptions;
  /**
   * Cap for the badge numeral. Counts above this render as
   * `"${badgeCap}+"`. Default: `99`.
   */
  readonly badgeCap?: number;
  /**
   * Override the default color per severity. Returning `undefined`
   * falls through to the built-in palette.
   */
  colorFor?(severity: DiagnosticSeverity, aggregated: boolean): string | undefined;
  /**
   * Override the badge text. Default is the formatted problem count
   * (`"3"`, `"99+"`). Returning `undefined` falls through to the default.
   */
  badgeFor?(
    counts: DiagnosticCounts,
    severity: DiagnosticSeverity,
    aggregated: boolean,
  ): string | undefined;
  /**
   * Override the tooltip. Default is a human summary like
   * `"2 errors, 1 warning"`.
   */
  tooltipFor?(
    counts: DiagnosticCounts,
    severity: DiagnosticSeverity,
    aggregated: boolean,
    leafDiagnostics: readonly Diagnostic[] | null,
  ): string | undefined;
  /**
   * When the provider should register somewhere other than
   * `fx.registerDecorationProvider` (e.g. `FileExplorerHost` exposes
   * its own decoration store), supply a custom registrar.
   */
  readonly registrar?: (provider: EngineDecorationProvider) => Disposable;
}

interface Disposable {
  dispose(): void;
}

export interface DiagnosticsDecorationsHandle {
  /** Tear down subscriptions and unregister from the engine. */
  dispose(): void;
  /** Force an immediate diagnostics fetch + publish. */
  refresh(): Promise<void>;
}

// ─── Defaults ─────────────────────────────────────────────────────────

/**
 * VS Code-ish problems palette. Exported so consumers can compose with
 * their own `colorFor` override.
 */
export const DEFAULT_DIAGNOSTIC_COLORS: Readonly<
  Record<DiagnosticSeverity, string>
> = Object.freeze({
  error: 'var(--mille-decoration-error, #f85149)',
  warning: 'var(--mille-decoration-warning, #d29922)',
  info: 'var(--mille-decoration-info, #58a6ff)',
  hint: 'var(--mille-decoration-hint, #8b949e)',
});

/**
 * Muted palette for ancestor aggregate badges so folders read as
 * "problems below" rather than "I am the problem".
 */
export const MUTED_DIAGNOSTIC_COLORS: Readonly<
  Record<DiagnosticSeverity, string>
> = Object.freeze({
  error: 'var(--mille-decoration-error-muted, #b53a34)',
  warning: 'var(--mille-decoration-warning-muted, #a68b64)',
  info: 'var(--mille-decoration-info-muted, #3d6fa3)',
  hint: 'var(--mille-decoration-hint-muted, #6c6c6c)',
});

// ─── Pure helpers (exported for tests) ────────────────────────────────

/**
 * Format a problem count for the badge glyph. Caps at `badgeCap` with a
 * trailing `+` (VS Code Problems explorer convention).
 */
export function formatDiagnosticBadge(
  total: number,
  badgeCap = 99,
): string {
  if (total <= 0) return '';
  if (total > badgeCap) return `${badgeCap}+`;
  return String(total);
}

/**
 * Build a human-readable tooltip from per-severity counts.
 * Example: `"2 errors, 1 warning"`.
 */
export function formatDiagnosticTooltip(counts: DiagnosticCounts): string {
  const parts: string[] = [];
  if (counts.error > 0) {
    parts.push(counts.error === 1 ? '1 error' : `${counts.error} errors`);
  }
  if (counts.warning > 0) {
    parts.push(
      counts.warning === 1 ? '1 warning' : `${counts.warning} warnings`,
    );
  }
  if (counts.info > 0) {
    parts.push(counts.info === 1 ? '1 info' : `${counts.info} infos`);
  }
  if (counts.hint > 0) {
    parts.push(counts.hint === 1 ? '1 hint' : `${counts.hint} hints`);
  }
  return parts.join(', ');
}

// ─── Implementation ───────────────────────────────────────────────────

/**
 * Register a diagnostics decoration provider on the given engine.
 * Returns a handle with `dispose()` and `refresh()`.
 */
export function registerDiagnosticsDecorations(
  options: RegisterDiagnosticsDecorationsOptions,
): DiagnosticsDecorationsHandle {
  const {
    fx,
    client,
    rootPath,
    providerId = 'diagnostics',
    propagateToParent = true,
    uriScheme = 'file',
    batchOptions,
    badgeCap = 99,
    colorFor,
    badgeFor,
    tooltipFor,
  } = options;

  let decorations = new Map<EntryId, Decoration>();
  const listeners = new Set<(ids: readonly EntryId[]) => void>();
  let disposed = false;
  let decoratedIds = new Set<EntryId>();

  function resolveColor(
    severity: DiagnosticSeverity,
    aggregated: boolean,
  ): string | undefined {
    if (colorFor) {
      const override = colorFor(severity, aggregated);
      if (override !== undefined) return override;
    }
    return aggregated
      ? MUTED_DIAGNOSTIC_COLORS[severity]
      : DEFAULT_DIAGNOSTIC_COLORS[severity];
  }

  function resolveBadge(
    counts: DiagnosticCounts,
    severity: DiagnosticSeverity,
    aggregated: boolean,
  ): string {
    if (badgeFor) {
      const override = badgeFor(counts, severity, aggregated);
      if (override !== undefined) return override;
    }
    return formatDiagnosticBadge(totalDiagnosticCount(counts), badgeCap);
  }

  function resolveTooltip(
    counts: DiagnosticCounts,
    severity: DiagnosticSeverity,
    aggregated: boolean,
    leafDiagnostics: readonly Diagnostic[] | null,
  ): string {
    if (tooltipFor) {
      const override = tooltipFor(
        counts,
        severity,
        aggregated,
        leafDiagnostics,
      );
      if (override !== undefined) return override;
    }
    const summary = formatDiagnosticTooltip(counts);
    // For leaves with a single diagnostic and a message, append it so
    // hover is actionable without opening Problems.
    if (
      !aggregated &&
      leafDiagnostics !== null &&
      leafDiagnostics.length === 1
    ) {
      const only = leafDiagnostics[0];
      if (only !== undefined && only.message !== undefined && only.message.length > 0) {
        const prefix =
          only.source !== undefined ? `${only.source}: ` : '';
        return summary.length > 0
          ? `${summary}\n${prefix}${only.message}`
          : `${prefix}${only.message}`;
      }
    }
    return summary;
  }

  function buildDecoration(
    counts: DiagnosticCounts,
    aggregated: boolean,
    leafDiagnostics: readonly Diagnostic[] | null,
  ): Decoration | null {
    const severity = maxSeverityFromCounts(counts);
    if (severity === null) return null;
    const total = totalDiagnosticCount(counts);
    if (total <= 0) return null;

    const badge = resolveBadge(counts, severity, aggregated);
    if (badge.length === 0) return null;

    const color = resolveColor(severity, aggregated);
    const tooltip = resolveTooltip(
      counts,
      severity,
      aggregated,
      leafDiagnostics,
    );

    // Leaves advertise propagate so hosts/engine that honor the flag
    // can bubble; we still do our own ancestor aggregation for count
    // accuracy (engine propagate would only copy a single badge).
    return {
      badge,
      ...(color !== undefined ? { color } : {}),
      ...(tooltip.length > 0 ? { tooltip } : {}),
      propagate: !aggregated && propagateToParent,
    };
  }

  function makeUri(workspaceRelative: string): Uri {
    const trimmedRoot = rootPath.replace(/\/+$/, '');
    const trimmedRel = workspaceRelative.replace(/^\/+/, '');
    const joined =
      trimmedRel.length === 0
        ? trimmedRoot
        : `${trimmedRoot}/${trimmedRel}`;
    return { scheme: uriScheme, path: joined };
  }

  async function resolvePathToEntry(
    workspaceRelative: string,
  ): Promise<Entry | null> {
    const uri = makeUri(workspaceRelative);
    const handle = fx as FileExplorerLike;
    if (typeof handle.getByUri !== 'function') {
      return null;
    }
    try {
      const maybe = handle.getByUri(uri);
      const entry = isPromise(maybe) ? await maybe : maybe;
      return entry ?? null;
    } catch {
      return null;
    }
  }

  async function recompute(): Promise<void> {
    if (disposed) return;
    const statusMap = await client.getDiagnostics(rootPath);
    if (disposed) return;

    const next = new Map<EntryId, Decoration>();
    // Track leaf counts for ancestor roll-up.
    const leafCounts: Array<{ id: EntryId; counts: DiagnosticCounts }> = [];

    for (const [path, diags] of statusMap) {
      if (diags.length === 0) continue;
      const resolved = await resolvePathToEntry(path);
      if (resolved === null) continue;
      const counts = countDiagnostics(diags);
      const decoration = buildDecoration(counts, false, diags);
      if (decoration === null) continue;
      next.set(resolved.id, decoration);
      leafCounts.push({ id: resolved.id, counts });
    }

    // Ancestor aggregation: sum descendant counts. Multiple leaves under
    // the same folder accumulate. A folder that is itself a leaf with
    // diagnostics keeps its own leaf decoration (do not clobber).
    if (propagateToParent && leafCounts.length > 0) {
      const snapshot = fx.getSnapshot();
      const ancestorCounts = new Map<EntryId, DiagnosticCounts>();

      for (const leaf of leafCounts) {
        let cursor = snapshot.getById(leaf.id);
        if (cursor === null) continue;
        // napi-rs maps Rust Option::None to JS undefined; loose == null.
        let parentId = cursor.parentId;
        while (parentId != null) {
          const existing = ancestorCounts.get(parentId) ?? ZERO_COUNTS;
          ancestorCounts.set(parentId, addCounts(existing, leaf.counts));
          const parent = snapshot.getById(parentId);
          if (parent === null) break;
          parentId = parent.parentId;
        }
      }

      for (const [id, counts] of ancestorCounts) {
        // Do not clobber a real leaf decoration with an aggregate.
        if (next.has(id)) continue;
        const decoration = buildDecoration(counts, true, null);
        if (decoration !== null) next.set(id, decoration);
      }
    }

    // Diff: every id that was in the previous set OR the new set may
    // have changed.
    const changed = new Set<EntryId>();
    for (const id of decoratedIds) changed.add(id);
    for (const id of next.keys()) changed.add(id);

    decorations = next;
    decoratedIds = new Set(next.keys());

    if (changed.size > 0 && listeners.size > 0) {
      const ids = Array.from(changed);
      for (const l of [...listeners]) l(ids);
    }
  }

  // Batcher coalesces client.onChange storms. A single sentinel id is
  // enqueued per notification so any burst produces exactly one recompute.
  const SENTINEL: EntryId = -1;
  const batcher = createBatcher(
    () => {
      void recompute();
    },
    batchOptions,
  );

  const provider: EngineDecorationProvider = {
    id: providerId,
    onDidChange(listener) {
      listeners.add(listener);
      let active = true;
      return {
        dispose() {
          if (!active) return;
          active = false;
          listeners.delete(listener);
        },
      };
    },
    provide(entry: Entry): Decoration | null {
      return decorations.get(entry.id) ?? null;
    },
  };

  const registration = options.registrar
    ? options.registrar(provider)
    : fx.registerDecorationProvider(provider);

  const unsubscribe = client.onChange(() => {
    if (disposed) return;
    batcher.enqueue(SENTINEL);
  });

  // Kick off initial fetch. Fire-and-forget; `refresh()` returns a
  // promise for callers that need to await readiness.
  void recompute();

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
      batcher.dispose();
      listeners.clear();
      try {
        registration.dispose();
      } catch {
        /* ignore */
      }
      decorations = new Map<EntryId, Decoration>();
      decoratedIds = new Set<EntryId>();
    },
    async refresh(): Promise<void> {
      if (disposed) return;
      batcher.cancel();
      await recompute();
    },
  };
}

function isPromise<T>(v: unknown): v is Promise<T> {
  return (
    v !== null &&
    typeof v === 'object' &&
    typeof (v as { then?: unknown }).then === 'function'
  );
}
