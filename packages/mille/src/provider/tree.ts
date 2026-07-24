// ProviderTreeSession — materialize a provider into a flat tree model.
//
// Watcher-driven refresh is single-flight: coalesced, generation-guarded,
// disposal-safe, and rejection-handled. Bursts of N events produce one
// refresh (plus at most one trailing refresh if more events arrived mid-flight).
//
// Explicit `refresh()` is serialized rather than coalesced: it resolves with a
// walk that started after the call, so a host can `await provider.writeFile()`
// then `await refresh()` and see its own write. Joining the in-flight walk
// would resolve with a tree read before that write.

import type {
  FileSystemProvider,
  ProviderEntry,
  ProviderOperation,
  Uri,
} from './types.js';
import { createUri, normalizeUriPath } from './uri.js';
import {
  describeUnsupported,
  providerSupportsOperation,
} from './capabilities.js';

export interface ProviderTreeNode {
  readonly entry: ProviderEntry;
  readonly uri: Uri;
  readonly children: readonly ProviderTreeNode[];
}

export interface ProviderTreeSnapshot {
  readonly version: number;
  readonly root: ProviderTreeNode;
  /**
   * Flat list for virtualization (depth-first).
   * The root row is always included; root children are shown when the root
   * id is in `expanded` **or** when `expanded` is empty (default navigation
   * starts with the root open).
   */
  flatten(expanded: ReadonlySet<number>): readonly ProviderTreeFlatRow[];
  getById(id: number): ProviderEntry | null;
}

export interface ProviderTreeFlatRow {
  readonly entry: ProviderEntry;
  readonly uri: Uri;
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly isExpanded: boolean;
}

export interface ProviderTreeSessionOptions {
  /**
   * Debounce window for watcher-driven refreshes (ms). Default 16.
   * Explicit `refresh()` calls bypass the debounce and run ASAP (still
   * single-flight).
   */
  readonly debounceMs?: number;
}

export interface ProviderTreeSession {
  readonly provider: FileSystemProvider;
  readonly rootUri: Uri;
  /**
   * Rebuild the tree from the provider (stat + recursive readDirectory).
   * The resolved snapshot always reflects provider state at or after this
   * call, even when a watcher-driven walk is already running.
   */
  refresh(): Promise<ProviderTreeSnapshot>;
  getSnapshot(): ProviderTreeSnapshot | null;
  /**
   * Whether a mutation is supported by advertised capabilities + methods.
   * UI should disable unsupported commands and show `unsupportedReason`.
   */
  can(operation: ProviderOperation): boolean;
  unsupportedReason(operation: ProviderOperation): string | null;
  onDidChange(listener: () => void): () => void;
  dispose(): void;
}

/**
 * Map flattened provider rows into a MirrorSnapshot-like visible-row list
 * for hosts that bridge into FileTree / createFakeEngine.
 */
export function providerRowsToVisibleRows(
  rows: readonly ProviderTreeFlatRow[],
): readonly {
  id: number;
  parentId: number | null;
  name: string;
  kind: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  isIgnored: false;
  isReadonly: boolean;
  isHidden: false;
}[] {
  return rows.map((r) => ({
    id: r.entry.id,
    parentId: r.entry.parentId,
    name: r.entry.name,
    kind: r.entry.kind,
    size: r.entry.size,
    mtimeMs: r.entry.mtimeMs,
    ctimeMs: r.entry.ctimeMs,
    depth: r.depth,
    hasChildren: r.hasChildren,
    isExpanded: r.isExpanded,
    isIgnored: false as const,
    isReadonly: Boolean(r.entry.isReadonly),
    isHidden: false as const,
  }));
}

/**
 * Walk a provider from `rootUri` and keep a renderable snapshot.
 * Does not require the native FileExplorer — suitable for memfs demos.
 */
export function createProviderTreeSession(
  provider: FileSystemProvider,
  rootUri?: Uri,
  options: ProviderTreeSessionOptions = {},
): ProviderTreeSession {
  const root = rootUri ?? createUri(provider.scheme, '/');
  const debounceMs = options.debounceMs ?? 16;
  let snapshot: ProviderTreeSnapshot | null = null;
  let version = 0;
  let generation = 0;
  let disposed = false;
  const listeners = new Set<() => void>();
  let watcherDispose: (() => void) | null = null;

  // Walk serialization. At most one walk runs at a time, with at most one
  // walk queued behind it. Watcher events coalesce onto whichever walk will
  // observe them; explicit `refresh()` always gets a walk that *starts after*
  // its call, so a caller can observe its own mutations.
  let inFlight: Promise<ProviderTreeSnapshot> | null = null;
  let queued: Promise<ProviderTreeSnapshot> | null = null;
  let pendingAfterFlight = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  if (
    typeof provider.watch === 'function' &&
    providerSupportsOperation(provider, 'watch')
  ) {
    try {
      const w = provider.watch(root, { recursive: true });
      const sub = w.onDidChange(() => {
        scheduleRefresh();
      });
      watcherDispose = () => {
        sub.dispose();
        w.dispose();
      };
    } catch {
      /* watch optional */
    }
  }

  function notify(): void {
    if (disposed) return;
    for (const l of [...listeners]) {
      try {
        l();
      } catch {
        /* ignore */
      }
    }
  }

  function scheduleRefresh(): void {
    if (disposed) return;
    if (debounceTimer !== null) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      watcherRefresh();
    }, debounceMs);
  }

  /**
   * Watcher-driven refresh. Coalescing is the point: a queued walk has not
   * started yet, so it will observe this event on its own. A walk already
   * in flight may have read past the changed directory, so it needs one
   * trailing walk behind it.
   */
  function watcherRefresh(): void {
    if (disposed) return;
    if (queued !== null) return;
    if (inFlight !== null) {
      pendingAfterFlight = true;
      return;
    }
    void startWalk().catch(() => {
      /* watcher-driven walk failures are non-fatal */
    });
  }

  async function loadNode(uri: Uri): Promise<ProviderTreeNode> {
    const entry = await provider.stat(uri);
    if (entry.kind !== 1 /* Directory */) {
      return { entry, uri, children: [] };
    }
    const kids = await provider.readDirectory(uri);
    const children: ProviderTreeNode[] = [];
    for (const k of kids) {
      const childPath =
        normalizeUriPath(uri.path) === '/'
          ? `/${k.name}`
          : `${normalizeUriPath(uri.path)}/${k.name}`;
      const childUri = createUri(uri.scheme, childPath, {
        ...(uri.authority !== undefined ? { authority: uri.authority } : {}),
      });
      children.push(await loadNode(childUri));
    }
    return { entry, uri, children };
  }

  /**
   * A walk guaranteed to **start after this call**, so the caller observes
   * mutations it made before calling. Joining `inFlight` instead would let
   * `refresh()` resolve with a tree that was read before the caller's write.
   */
  function enqueueWalk(): Promise<ProviderTreeSnapshot> {
    // A queued walk has not started yet, so it satisfies this caller too.
    if (queued !== null) return queued;
    const prior = inFlight;
    if (prior === null) return startWalk();
    // Run after the current walk, whether it settles or fails.
    const next = prior.then(runQueued, runQueued);
    queued = next;
    return next;
  }

  function runQueued(): Promise<ProviderTreeSnapshot> {
    queued = null;
    if (disposed) {
      return Promise.reject(new Error('ProviderTreeSession disposed'));
    }
    return startWalk();
  }

  /** Run one walk now. Callers must ensure no other walk is in flight. */
  function startWalk(): Promise<ProviderTreeSnapshot> {
    const myGen = ++generation;
    const work = (async (): Promise<ProviderTreeSnapshot> => {
      try {
        const treeRoot = await loadNode(root);
        if (disposed) {
          if (snapshot) return snapshot;
          throw new Error('ProviderTreeSession disposed');
        }
        // Only publish if we are still the latest generation.
        if (myGen !== generation) {
          return snapshot ?? buildSnap(treeRoot, version);
        }
        version += 1;
        const snap = buildSnap(treeRoot, version);
        snapshot = snap;
        notify();
        return snap;
      } finally {
        inFlight = null;
        if (!disposed && pendingAfterFlight) {
          pendingAfterFlight = false;
          // Trailing walk for events that arrived mid-flight. Reuses an
          // already-queued walk when one exists.
          void enqueueWalk().catch(() => {
            /* watcher trailing refresh failures are non-fatal */
          });
        }
      }
    })();

    inFlight = work;
    return work;
  }

  function buildSnap(
    treeRoot: ProviderTreeNode,
    ver: number,
  ): ProviderTreeSnapshot {
    const byId = new Map<number, ProviderEntry>();
    function index(node: ProviderTreeNode): void {
      byId.set(node.entry.id, node.entry);
      for (const c of node.children) index(c);
    }
    index(treeRoot);

    return {
      version: ver,
      root: treeRoot,
      getById(id) {
        return byId.get(id) ?? null;
      },
      flatten(expanded) {
        const rows: ProviderTreeFlatRow[] = [];
        // Empty expanded set ⇒ treat root as expanded so children are visible
        // by default (navigation starts open). Explicit sets control expansion.
        const rootExpanded =
          expanded.size === 0 || expanded.has(treeRoot.entry.id);

        function walk(
          node: ProviderTreeNode,
          depth: number,
          parentExpanded: boolean,
        ): void {
          if (depth > 0 && !parentExpanded) return;
          const hasChildren = node.children.length > 0;
          const isExpanded =
            depth === 0
              ? rootExpanded
              : expanded.size === 0
                ? false
                : expanded.has(node.entry.id);
          rows.push({
            entry: node.entry,
            uri: node.uri,
            depth,
            hasChildren,
            isExpanded,
          });
          if (hasChildren && isExpanded) {
            for (const c of node.children) walk(c, depth + 1, true);
          }
        }
        walk(treeRoot, 0, true);
        return rows;
      },
    };
  }

  async function refresh(): Promise<ProviderTreeSnapshot> {
    if (disposed) {
      throw new Error('ProviderTreeSession disposed');
    }
    if (debounceTimer !== null) {
      // Drop the pending watcher walk: the walk we queue below starts later,
      // so it already observes whatever that event changed.
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    return enqueueWalk();
  }

  return {
    provider,
    rootUri: root,
    refresh,
    getSnapshot() {
      return snapshot;
    },
    can(operation) {
      return providerSupportsOperation(provider, operation);
    },
    unsupportedReason(operation) {
      if (providerSupportsOperation(provider, operation)) return null;
      return describeUnsupported(
        provider.capabilities,
        operation,
        provider,
      ).message;
    },
    onDidChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      generation += 1; // invalidate in-flight
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      watcherDispose?.();
      watcherDispose = null;
      listeners.clear();
      // Keep last snapshot readable until GC; clear after dispose call.
      snapshot = null;
      inFlight = null;
      queued = null;
      pendingAfterFlight = false;
    },
  };
}
