// Phase 5.1 — registerTestStatusDecorations factory.
//
// Decorates test files / suites from a host-supplied TestStatusClient.
// Pattern mirrors hardened diagnostics / editor-state companions:
//   - getByUri or resolvePath resolution
//   - generation token, bounded concurrency, value-diff, onError
//   - workspace-relative path validation
//   - optional ancestor aggregate badges (failure counts)
//
// Glyph policy:
//   - failed  → "✗" (leaf) or failure count (folder)
//   - errored → "!"
//   - running → "…"
//   - skipped → "○"
//   - passed  → "✓" (off by default via showPassed: false — less noise)
//
// Severity for color / folder worst-status:
//   failed > errored > running > skipped > passed

import type {
  Decoration,
  Entry,
  EntryId,
  FileExplorer,
  Uri,
} from '@vibecook/mille';
import type { PortFileExplorer } from '@vibecook/mille/port';

import { createBatcher, type BatchOptions } from '../git/batch.js';
import {
  decorationEquals,
  isSafeWorkspaceRelativePath,
  mapPool,
} from '../diagnostics/provider.js';
import type {
  TestResult,
  TestStatus,
  TestStatusClient,
  TestStatusCounts,
} from './types.js';
import {
  ZERO_TEST_COUNTS,
  addTestCounts,
  countsFromResult,
  maxStatusFromCounts,
  totalTestCount,
} from './types.js';

// ─── Minimal fx surface ───────────────────────────────────────────────

interface SnapshotLike {
  getById(id: EntryId): Entry | null;
}

export interface FileExplorerLike {
  getSnapshot(): SnapshotLike;
  getByUri?(uri: Uri): Promise<Entry | null> | Entry | null;
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

export interface RegisterTestStatusDecorationsOptions {
  readonly fx: FileExplorer | PortFileExplorer | FileExplorerLike;
  readonly client: TestStatusClient;
  readonly rootPath: string;
  /** Default: `'test-status'`. */
  readonly providerId?: string;
  readonly uriScheme?: string;
  readonly batchOptions?: BatchOptions;
  /** Default: 16. */
  readonly resolveConcurrency?: number;
  /**
   * When true (default), folder ancestors receive aggregate badges from
   * descendant results (failure counts / worst status).
   */
  readonly propagateToParent?: boolean;
  /**
   * When true, leaf paths with `passed` still get a ✓ badge. Default
   * false — only non-pass outcomes are shown (less noise after a green run).
   */
  readonly showPassed?: boolean;
  /** Cap for numeric failure badges. Default 99. */
  readonly badgeCap?: number;
  onError?(error: unknown): void;
  colorFor?(status: TestStatus, aggregated: boolean): string | undefined;
  badgeFor?(
    status: TestStatus,
    counts: TestStatusCounts,
    aggregated: boolean,
  ): string | undefined;
  tooltipFor?(
    status: TestStatus,
    counts: TestStatusCounts,
    aggregated: boolean,
    leaf: TestResult | null,
  ): string | undefined;
  readonly registrar?: (provider: EngineDecorationProvider) => Disposable;
}

interface Disposable {
  dispose(): void;
}

export interface TestStatusDecorationsHandle {
  dispose(): void;
  refresh(): Promise<void>;
}

// ─── Defaults ─────────────────────────────────────────────────────────

export const DEFAULT_TEST_STATUS_COLORS: Readonly<Record<TestStatus, string>> =
  Object.freeze({
    failed: 'var(--mille-decoration-test-failed, #f85149)',
    errored: 'var(--mille-decoration-test-errored, #d29922)',
    running: 'var(--mille-decoration-test-running, #58a6ff)',
    skipped: 'var(--mille-decoration-test-skipped, #8b949e)',
    passed: 'var(--mille-decoration-test-passed, #3fb950)',
  });

export const MUTED_TEST_STATUS_COLORS: Readonly<Record<TestStatus, string>> =
  Object.freeze({
    failed: 'var(--mille-decoration-test-failed-muted, #b53a34)',
    errored: 'var(--mille-decoration-test-errored-muted, #a68b64)',
    running: 'var(--mille-decoration-test-running-muted, #3d6fa3)',
    skipped: 'var(--mille-decoration-test-skipped-muted, #6c6c6c)',
    passed: 'var(--mille-decoration-test-passed-muted, #2d6a3a)',
  });

const DEFAULT_RESOLVE_CONCURRENCY = 16;
const DEFAULT_LEAF_BADGE: Readonly<Record<TestStatus, string>> = Object.freeze({
  failed: '✗',
  errored: '!',
  running: '…',
  skipped: '○',
  passed: '✓',
});

export function formatTestStatusTooltip(
  status: TestStatus,
  counts: TestStatusCounts,
  aggregated: boolean,
): string {
  if (!aggregated) {
    switch (status) {
      case 'failed':
        return 'Test failed';
      case 'errored':
        return 'Test errored';
      case 'running':
        return 'Test running';
      case 'skipped':
        return 'Test skipped';
      case 'passed':
        return 'Test passed';
      default:
        return '';
    }
  }
  const parts: string[] = [];
  if (counts.failed > 0) {
    parts.push(
      counts.failed === 1 ? '1 failed' : `${counts.failed} failed`,
    );
  }
  if (counts.errored > 0) {
    parts.push(
      counts.errored === 1 ? '1 errored' : `${counts.errored} errored`,
    );
  }
  if (counts.running > 0) {
    parts.push(
      counts.running === 1 ? '1 running' : `${counts.running} running`,
    );
  }
  if (counts.skipped > 0) {
    parts.push(
      counts.skipped === 1 ? '1 skipped' : `${counts.skipped} skipped`,
    );
  }
  if (counts.passed > 0) {
    parts.push(
      counts.passed === 1 ? '1 passed' : `${counts.passed} passed`,
    );
  }
  return parts.join(', ');
}

export function formatTestStatusBadge(
  status: TestStatus,
  counts: TestStatusCounts,
  aggregated: boolean,
  badgeCap = 99,
): string {
  if (!aggregated) return DEFAULT_LEAF_BADGE[status];
  // Folders: prefer failure count when present; else worst-status glyph.
  const failures = counts.failed + counts.errored;
  if (failures > 0) {
    if (failures > badgeCap) return `${badgeCap}+`;
    return String(failures);
  }
  if (counts.running > 0) return DEFAULT_LEAF_BADGE.running;
  if (counts.skipped > 0 && counts.passed === 0) {
    return DEFAULT_LEAF_BADGE.skipped;
  }
  if (counts.passed > 0) return DEFAULT_LEAF_BADGE.passed;
  return '';
}

// ─── Implementation ───────────────────────────────────────────────────

export function registerTestStatusDecorations(
  options: RegisterTestStatusDecorationsOptions,
): TestStatusDecorationsHandle {
  const {
    fx,
    client,
    rootPath,
    providerId = 'test-status',
    uriScheme = 'file',
    batchOptions,
    resolveConcurrency = DEFAULT_RESOLVE_CONCURRENCY,
    propagateToParent = true,
    showPassed = false,
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
  let generation = 0;

  const reportError =
    onError ??
    ((error: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[mille-ui/test-status] recompute failed:', error);
    });

  function resolveColor(
    status: TestStatus,
    aggregated: boolean,
  ): string | undefined {
    if (colorFor) {
      const override = colorFor(status, aggregated);
      if (override !== undefined) return override;
    }
    return aggregated
      ? MUTED_TEST_STATUS_COLORS[status]
      : DEFAULT_TEST_STATUS_COLORS[status];
  }

  function buildDecoration(
    status: TestStatus,
    counts: TestStatusCounts,
    aggregated: boolean,
    leaf: TestResult | null,
  ): Decoration | null {
    if (!aggregated && status === 'passed' && !showPassed) {
      return null;
    }
    // Aggregates that are all-passed: hide unless showPassed.
    if (aggregated && !showPassed) {
      const failures = counts.failed + counts.errored + counts.running;
      if (failures === 0 && counts.skipped === 0) return null;
    }

    let badge =
      badgeFor !== undefined
        ? badgeFor(status, counts, aggregated)
        : formatTestStatusBadge(status, counts, aggregated, badgeCap);
    if (badge === undefined) {
      badge = formatTestStatusBadge(status, counts, aggregated, badgeCap);
    }
    if (badge.length === 0) return null;

    let tooltip =
      tooltipFor !== undefined
        ? (tooltipFor(status, counts, aggregated, leaf) ??
          formatTestStatusTooltip(status, counts, aggregated))
        : formatTestStatusTooltip(status, counts, aggregated);

    if (
      !aggregated &&
      leaf !== null &&
      leaf.message !== undefined &&
      leaf.message.length > 0
    ) {
      tooltip =
        tooltip.length > 0
          ? `${tooltip}\n${leaf.message}`
          : leaf.message;
    }

    const color = resolveColor(status, aggregated);
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
    if (!isSafeWorkspaceRelativePath(workspaceRelative)) return null;
    const handle = fx as FileExplorerLike;

    if (typeof handle.getByUri === 'function') {
      try {
        const maybe = handle.getByUri(makeUri(workspaceRelative));
        const entry = isPromise(maybe) ? await maybe : maybe;
        if (entry != null) return entry;
      } catch {
        /* fall through */
      }
    }

    if (typeof handle.resolvePath === 'function') {
      try {
        const maybe = handle.resolvePath(absolutePathFor(workspaceRelative));
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

    let results: ReadonlyMap<string, TestResult>;
    try {
      const raw = client.getResults(rootPath);
      results = isPromise(raw) ? await raw : raw;
    } catch (error) {
      if (disposed || myGen !== generation) return;
      throw error;
    }
    if (disposed || myGen !== generation) return;

    const entries = [...results.entries()].filter(
      ([path]) => isSafeWorkspaceRelativePath(path),
    );

    const resolved = await mapPool(
      entries,
      resolveConcurrency,
      async ([path, result]) => {
        if (disposed || myGen !== generation) return null;
        const entry = await resolvePathToEntry(path);
        if (entry === null) return null;
        const counts = countsFromResult(result);
        const status =
          maxStatusFromCounts(counts) ?? result.status;
        // Suite folders (directory entries) and results that already
        // carry aggregate `counts` use the aggregate presentation
        // (failure counts + summary tooltip), not the leaf ✗ glyph.
        const isDirEntry =
          entry.kind === 1 || entry.symlinkTargetIsDir === true;
        const aggregated =
          isDirEntry || result.counts !== undefined;
        const decoration = buildDecoration(
          status,
          counts,
          aggregated,
          aggregated ? null : result,
        );
        if (decoration === null) return null;
        return { id: entry.id, counts, decoration, aggregated };
      },
    );

    if (disposed || myGen !== generation) return;

    const next = new Map<EntryId, Decoration>();
    const leafCounts: Array<{ id: EntryId; counts: TestStatusCounts }> = [];
    for (const item of resolved) {
      if (item === null) continue;
      next.set(item.id, item.decoration);
      leafCounts.push({ id: item.id, counts: item.counts });
    }

    if (propagateToParent && leafCounts.length > 0) {
      const snapshot = fx.getSnapshot();
      const ancestorCounts = new Map<EntryId, TestStatusCounts>();

      for (const leaf of leafCounts) {
        let cursor = snapshot.getById(leaf.id);
        if (cursor === null) continue;
        let parentId = cursor.parentId;
        while (parentId != null) {
          const existing = ancestorCounts.get(parentId) ?? ZERO_TEST_COUNTS;
          ancestorCounts.set(parentId, addTestCounts(existing, leaf.counts));
          const parent = snapshot.getById(parentId);
          if (parent === null) break;
          parentId = parent.parentId;
        }
      }

      for (const [id, counts] of ancestorCounts) {
        if (next.has(id)) continue;
        if (totalTestCount(counts) === 0) continue;
        const status = maxStatusFromCounts(counts);
        if (status === null) continue;
        const decoration = buildDecoration(status, counts, true, null);
        if (decoration !== null) next.set(id, decoration);
      }
    }

    if (disposed || myGen !== generation) return;

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
        /* ignore */
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
      generation += 1;
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
      decorations = new Map();
      decoratedIds = new Set();
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
