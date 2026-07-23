// Phase 5.1 — registerDiagnosticsDecorations factory.
//
// Wires a host-supplied `DiagnosticsClient` into the engine's decoration
// pipeline. Pattern mirrors `git/provider.ts`:
//
//   1. Fetches an initial diagnostics snapshot.
//   2. Resolves workspace-relative paths → Entry via getByUri, or
//      resolvePath + snapshot fallback (PortFileExplorer).
//   3. Builds leaf decorations (badge = problem count, color = max
//      severity) and optional ancestor aggregates.
//   4. Registers a DecorationProvider whose provide(entry) is O(1).
//   5. Subscribes to client.onChange; batcher + generation token prevent
//      stale fetches from overwriting newer state.
//
// Merge precedence with other providers follows later-wins on overlapping
// fields (see mergeDecorations). Register diagnostics after SCM when
// problem badges should win.

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
 * Subset of FileExplorer the companion touches.
 *
 * Path resolution order:
 *   1. `getByUri` when present (in-process engine)
 *   2. `resolvePath(absolutePath)` + snapshot.getById (PortFileExplorer)
 *
 * Advertising PortFileExplorer without either method is a type error at
 * the call site for scripted fakes; the factory also no-ops path
 * resolution rather than silently pretending badges work.
 */
export interface FileExplorerLike {
  getSnapshot(): SnapshotLike;
  getByUri?(uri: Uri): Promise<Entry | null> | Entry | null;
  /**
   * Absolute path → entry id. Port clients expose this even when
   * `getByUri` is absent.
   */
  resolvePath?(
    path: string,
  ): Promise<EntryId | number | null> | EntryId | number | null;
  registerDecorationProvider(
    provider: EngineDecorationProvider,
  ): { dispose(): void };
}

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
   * In-process `FileExplorer`, port-backed `PortFileExplorer` (uses
   * `resolvePath`), or a scripted `FileExplorerLike` fake.
   */
  readonly fx: FileExplorer | PortFileExplorer | FileExplorerLike;
  readonly client: DiagnosticsClient;
  /**
   * Absolute workspace root. Passed to `client.getDiagnostics` and used
   * as the base for path resolution.
   */
  readonly rootPath: string;
  /** Provider id. Default: `'diagnostics'`. */
  readonly providerId?: string;
  /**
   * When `true` (default), each leaf with diagnostics propagates
   * aggregate counts up its ancestor chain.
   */
  readonly propagateToParent?: boolean;
  /** URI scheme for `getByUri`. Default: `'file'`. */
  readonly uriScheme?: string;
  /** Forwarded to the batcher; exposed for tests. */
  readonly batchOptions?: BatchOptions;
  /**
   * Max concurrent path resolutions. Default: `16`. Sequential resolution
   * of hundreds of paths is too slow for port RPC; this bounds fan-out.
   */
  readonly resolveConcurrency?: number;
  /**
   * Cap for the badge numeral. Counts above this render as
   * `"${badgeCap}+"`. Default: `99`.
   */
  readonly badgeCap?: number;
  /**
   * Called when a background recompute fails (initial fetch or batched
   * onChange). Explicit `refresh()` still rejects to its caller.
   * Default: `console.warn`.
   */
  onError?(error: unknown): void;
  colorFor?(severity: DiagnosticSeverity, aggregated: boolean): string | undefined;
  badgeFor?(
    counts: DiagnosticCounts,
    severity: DiagnosticSeverity,
    aggregated: boolean,
  ): string | undefined;
  tooltipFor?(
    counts: DiagnosticCounts,
    severity: DiagnosticSeverity,
    aggregated: boolean,
    leafDiagnostics: readonly Diagnostic[] | null,
  ): string | undefined;
  readonly registrar?: (provider: EngineDecorationProvider) => Disposable;
}

interface Disposable {
  dispose(): void;
}

export interface DiagnosticsDecorationsHandle {
  dispose(): void;
  refresh(): Promise<void>;
}

// ─── Defaults ─────────────────────────────────────────────────────────

export const DEFAULT_DIAGNOSTIC_COLORS: Readonly<
  Record<DiagnosticSeverity, string>
> = Object.freeze({
  error: 'var(--mille-decoration-error, #f85149)',
  warning: 'var(--mille-decoration-warning, #d29922)',
  info: 'var(--mille-decoration-info, #58a6ff)',
  hint: 'var(--mille-decoration-hint, #8b949e)',
});

export const MUTED_DIAGNOSTIC_COLORS: Readonly<
  Record<DiagnosticSeverity, string>
> = Object.freeze({
  error: 'var(--mille-decoration-error-muted, #b53a34)',
  warning: 'var(--mille-decoration-warning-muted, #a68b64)',
  info: 'var(--mille-decoration-info-muted, #3d6fa3)',
  hint: 'var(--mille-decoration-hint-muted, #6c6c6c)',
});

const DEFAULT_RESOLVE_CONCURRENCY = 16;

// ─── Pure helpers (exported for tests) ────────────────────────────────

export function formatDiagnosticBadge(total: number, badgeCap = 99): string {
  if (total <= 0) return '';
  if (total > badgeCap) return `${badgeCap}+`;
  return String(total);
}

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

/**
 * Validate a workspace-relative diagnostic path before joining to root.
 * Rejects absolute paths, traversal (`..`), backslashes, NULs, and empty
 * segments so custom `FileExplorerLike` implementations cannot be tricked
 * into decorating outside the workspace.
 */
export function isSafeWorkspaceRelativePath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path.includes('\0')) return false;
  if (path.includes('\\')) return false;
  // Absolute POSIX or Windows drive.
  if (path.startsWith('/') || path.startsWith('~')) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

export function decorationEquals(
  a: Decoration | null | undefined,
  b: Decoration | null | undefined,
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return (
    a.badge === b.badge &&
    a.color === b.color &&
    a.tooltip === b.tooltip &&
    a.propagate === b.propagate
  );
}

/**
 * Map pool: run `worker` over `items` with at most `concurrency` in flight.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await worker(items[i] as T, i);
    }
  }
  const runners = Array.from({ length: limit }, () => run());
  await Promise.all(runners);
  return results;
}

// ─── Implementation ───────────────────────────────────────────────────

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
    resolveConcurrency = DEFAULT_RESOLVE_CONCURRENCY,
    badgeCap = 99,
    onError,
    colorFor,
    badgeFor,
    tooltipFor,
  } = options;

  let decorations = new Map<EntryId, Decoration>();
  const listeners = new Set<(ids: readonly EntryId[]) => void>();
  let disposed = false;
  let decoratedIds = new Set<EntryId>();
  /** Monotonic generation so overlapping recomputes discard stale results. */
  let generation = 0;

  const reportError =
    onError ??
    ((error: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[mille-ui/diagnostics] recompute failed:', error);
    });

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
    if (
      !aggregated &&
      leafDiagnostics !== null &&
      leafDiagnostics.length === 1
    ) {
      const only = leafDiagnostics[0];
      if (
        only !== undefined &&
        only.message !== undefined &&
        only.message.length > 0
      ) {
        const prefix = only.source !== undefined ? `${only.source}: ` : '';
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

    return {
      badge,
      ...(color !== undefined ? { color } : {}),
      ...(tooltip.length > 0 ? { tooltip } : {}),
      propagate: !aggregated && propagateToParent,
    };
  }

  function absolutePathFor(workspaceRelative: string): string {
    const trimmedRoot = rootPath.replace(/\/+$/, '');
    return `${trimmedRoot}/${workspaceRelative}`;
  }

  function makeUri(workspaceRelative: string): Uri {
    return { scheme: uriScheme, path: absolutePathFor(workspaceRelative) };
  }

  async function resolvePathToEntry(
    workspaceRelative: string,
  ): Promise<Entry | null> {
    if (!isSafeWorkspaceRelativePath(workspaceRelative)) {
      return null;
    }
    const handle = fx as FileExplorerLike;

    // Prefer getByUri (local engine).
    if (typeof handle.getByUri === 'function') {
      try {
        const maybe = handle.getByUri(makeUri(workspaceRelative));
        const entry = isPromise(maybe) ? await maybe : maybe;
        if (entry != null) return entry;
      } catch {
        // Fall through to resolvePath.
      }
    }

    // PortFileExplorer (and fakes) expose resolvePath(absolute).
    if (typeof handle.resolvePath === 'function') {
      try {
        const abs = absolutePathFor(workspaceRelative);
        const maybe = handle.resolvePath(abs);
        const id = isPromise(maybe) ? await maybe : maybe;
        if (id == null) return null;
        return handle.getSnapshot().getById(id as EntryId);
      } catch {
        return null;
      }
    }

    return null;
  }

  async function recompute(): Promise<void> {
    if (disposed) return;
    const myGen = ++generation;

    let statusMap: ReadonlyMap<string, readonly Diagnostic[]>;
    try {
      statusMap = await client.getDiagnostics(rootPath);
    } catch (error) {
      if (disposed || myGen !== generation) return;
      throw error;
    }
    if (disposed || myGen !== generation) return;

    const entries = [...statusMap.entries()].filter(
      ([path, diags]) =>
        diags.length > 0 && isSafeWorkspaceRelativePath(path),
    );

    const resolved = await mapPool(
      entries,
      resolveConcurrency,
      async ([path, diags]) => {
        if (disposed || myGen !== generation) {
          return null;
        }
        const entry = await resolvePathToEntry(path);
        if (entry === null) return null;
        const counts = countDiagnostics(diags);
        const decoration = buildDecoration(counts, false, diags);
        if (decoration === null) return null;
        return { id: entry.id, counts, decoration };
      },
    );

    if (disposed || myGen !== generation) return;

    const next = new Map<EntryId, Decoration>();
    const leafCounts: Array<{ id: EntryId; counts: DiagnosticCounts }> = [];
    for (const item of resolved) {
      if (item === null) continue;
      next.set(item.id, item.decoration);
      leafCounts.push({ id: item.id, counts: item.counts });
    }

    if (propagateToParent && leafCounts.length > 0) {
      const snapshot = fx.getSnapshot();
      const ancestorCounts = new Map<EntryId, DiagnosticCounts>();

      for (const leaf of leafCounts) {
        let cursor = snapshot.getById(leaf.id);
        if (cursor === null) continue;
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
        if (next.has(id)) continue;
        const decoration = buildDecoration(counts, true, null);
        if (decoration !== null) next.set(id, decoration);
      }
    }

    if (disposed || myGen !== generation) return;

    // Value-diff: only notify ids whose decoration actually changed.
    const changed: EntryId[] = [];
    for (const id of decoratedIds) {
      if (!decorationEquals(decorations.get(id), next.get(id) ?? null)) {
        changed.push(id);
      }
    }
    for (const [id, dec] of next) {
      if (!decoratedIds.has(id) || !decorationEquals(decorations.get(id), dec)) {
        if (!changed.includes(id)) changed.push(id);
      }
    }

    decorations = next;
    decoratedIds = new Set(next.keys());

    if (changed.length > 0 && listeners.size > 0) {
      for (const l of [...listeners]) l(changed);
    }
  }

  async function recomputeBackground(): Promise<void> {
    try {
      await recompute();
    } catch (error) {
      if (disposed) return;
      try {
        reportError(error);
      } catch {
        /* ignore error-handler failures */
      }
    }
  }

  const SENTINEL: EntryId = -1;
  const batcher = createBatcher(
    () => {
      void recomputeBackground();
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

  void recomputeBackground();

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation += 1; // invalidate in-flight
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
      // Explicit refresh surfaces errors to the caller.
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
