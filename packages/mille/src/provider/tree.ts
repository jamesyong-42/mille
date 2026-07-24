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
//
// Watcher-driven walks are scoped: an event invalidates the directory whose
// listing it changed, and the walk re-reads only those directories, returning
// every subtree with no dirty descendant by reference. An event deep in one
// directory therefore costs `depth` listings, not one per directory in the
// workspace. `refresh()` stays a full rebuild — it is the recovery path for a
// missed event — as does the first walk, or any burst touching more than
// MAX_SCOPED_DIRS directories.

import type {
  FileSystemProvider,
  ProviderEntry,
  ProviderOperation,
  Uri,
} from './types.js';
import { createUri, dirnameUriPath, normalizeUriPath } from './uri.js';
import {
  describeUnsupported,
  isCaseSensitiveProvider,
  providerSupportsOperation,
} from './capabilities.js';

/**
 * `full` re-reads every directory; `dirty` re-reads only the directories a
 * watcher invalidated and reuses the rest of the previous tree by reference.
 */
type WalkScope = 'full' | 'dirty';

/**
 * Above this many invalidated directories, re-reading the tree in one pass
 * beats descending to each of them separately.
 */
const MAX_SCOPED_DIRS = 64;

/** True when `path` is `ancestor` or sits under it. */
function pathIsUnder(path: string, ancestor: string): boolean {
  const p = normalizeUriPath(path);
  const a = normalizeUriPath(ancestor);
  if (p === a) return true;
  return a === '/' ? p.startsWith('/') : p.startsWith(`${a}/`);
}

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
  /**
   * Maximum provider calls in flight across the whole walk. Default 8.
   *
   * A walk costs one `stat` + one `readDirectory` per directory. Issuing
   * those serially makes a remote provider's walk cost
   * `directories × round-trip`; the cap keeps the walk parallel without
   * opening an unbounded number of connections on a deep tree.
   */
  readonly concurrency?: number;
}

export interface ProviderTreeSession {
  readonly provider: FileSystemProvider;
  readonly rootUri: Uri;
  /**
   * Rebuild the whole tree from the provider (stat + recursive
   * readDirectory), bypassing watcher-scoped invalidation — this is the
   * recovery path when events may have been missed. The resolved snapshot
   * always reflects provider state at or after this call, even when a
   * walk is already running.
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
  const concurrency = Math.max(1, options.concurrency ?? 8);

  // Shared walk semaphore: bounds provider calls in flight for the whole
  // walk, not per directory level (which would allow limit^depth).
  let activeCalls = 0;
  const callWaiters: (() => void)[] = [];
  function acquire(): Promise<void> | void {
    if (activeCalls < concurrency) {
      activeCalls += 1;
      return;
    }
    return new Promise<void>((resolve) => callWaiters.push(resolve));
  }
  function release(): void {
    const next = callWaiters.shift();
    // Hand the token over directly rather than decrementing and racing.
    if (next) next();
    else activeCalls -= 1;
  }
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
  let queuedScope: WalkScope = 'dirty';
  let pendingAfterFlight = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Directories whose listing a watcher event invalidated, as normalized
  // paths. A walk consumes and clears this; events arriving mid-walk
  // repopulate it and are picked up by the trailing walk.
  const dirtyDirs = new Set<string>();
  const caseSensitive = isCaseSensitiveProvider(provider.capabilities);

  /** Dirty-set key. Case-folded when the provider is case-insensitive. */
  function dirtyKey(path: string): string {
    const p = normalizeUriPath(path);
    return caseSensitive ? p : p.toLowerCase();
  }

  /**
   * Mark the directory whose listing an event changed. Creates, deletes and
   * renames change the *parent's* listing; a content change refreshes the
   * same listing's entry metadata, so the parent covers every event type
   * with one rule.
   */
  function markDirty(uri: Uri): void {
    const path = normalizeUriPath(uri.path);
    if (!pathIsUnder(path, normalizeUriPath(root.path))) return;
    dirtyDirs.add(dirtyKey(dirnameUriPath(path)));
  }

  if (
    typeof provider.watch === 'function' &&
    providerSupportsOperation(provider, 'watch')
  ) {
    try {
      const w = provider.watch(root, { recursive: true });
      const sub = w.onDidChange((event) => {
        markDirty(event.uri);
        if (event.oldUri) markDirty(event.oldUri);
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
    void startWalk('dirty').catch(() => {
      /* watcher-driven walk failures are non-fatal */
    });
  }

  /**
   * Run `fn` holding one of `concurrency` tokens. A task never holds a token
   * while waiting on another task, so sibling walks cannot deadlock here.
   */
  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  function childUriOf(parent: Uri, name: string): Uri {
    const parentPath = normalizeUriPath(parent.path);
    const childPath = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
    return createUri(parent.scheme, childPath, {
      ...(parent.authority !== undefined
        ? { authority: parent.authority }
        : {}),
    });
  }

  async function loadNode(uri: Uri): Promise<ProviderTreeNode> {
    const entry = await guarded(() => provider.stat(uri));
    if (entry.kind !== 1 /* Directory */) {
      return { entry, uri, children: [] };
    }
    const kids = await guarded(() => provider.readDirectory(uri));
    const children = await Promise.all(
      kids.map((k) => loadNode(childUriOf(uri, k.name))),
    );
    return { entry, uri, children };
  }

  /**
   * Re-read one directory's listing and rebuild only what it says changed.
   *
   * `readDirectory` already returns full entries, so file children need no
   * extra `stat`. An unchanged child directory keeps its previous `children`
   * array by reference — it costs nothing and lets consumers compare subtrees
   * by identity — while still taking the fresh entry from this listing.
   */
  async function refreshDirectory(
    uri: Uri,
    prev: ProviderTreeNode | null,
    dirty: ReadonlySet<string>,
  ): Promise<ProviderTreeNode> {
    const entry = await guarded(() => provider.stat(uri));
    if (entry.kind !== 1 /* Directory */) {
      return { entry, uri, children: [] };
    }
    const kids = await guarded(() => provider.readDirectory(uri));
    const prevByName = new Map(
      (prev?.children ?? []).map((c) => [c.entry.name, c] as const),
    );
    const children = await Promise.all(
      kids.map(async (k) => {
        const childUri = childUriOf(uri, k.name);
        const prevChild = prevByName.get(k.name);
        if (k.kind !== 1 /* not a directory */) {
          return { entry: k, uri: childUri, children: [] };
        }
        if (prevChild === undefined || prevChild.entry.kind !== 1) {
          // Newly appeared directory (or replaced a file) — walk it fully.
          return loadNode(childUri);
        }
        return applyDirty(prevChild, childUri, dirty);
      }),
    );
    return { entry, uri, children };
  }

  /**
   * Walk the previous tree, re-reading dirty directories and returning every
   * other node untouched. A subtree with no dirty descendant is returned by
   * reference, so an event deep in one directory costs `depth` listings
   * rather than one per directory in the workspace.
   */
  async function applyDirty(
    node: ProviderTreeNode,
    uri: Uri,
    dirty: ReadonlySet<string>,
  ): Promise<ProviderTreeNode> {
    const path = normalizeUriPath(uri.path);
    if (dirty.has(dirtyKey(path))) {
      return refreshDirectory(uri, node, dirty);
    }
    let containsDirty = false;
    for (const d of dirty) {
      if (pathIsUnder(d, caseSensitive ? path : path.toLowerCase())) {
        containsDirty = true;
        break;
      }
    }
    if (!containsDirty) return node;
    const children = await Promise.all(
      node.children.map((c) =>
        c.entry.kind === 1
          ? applyDirty(c, childUriOf(uri, c.entry.name), dirty)
          : Promise.resolve(c),
      ),
    );
    return { entry: node.entry, uri: node.uri, children };
  }

  /**
   * A walk guaranteed to **start after this call**, so the caller observes
   * mutations it made before calling. Joining `inFlight` instead would let
   * `refresh()` resolve with a tree that was read before the caller's write.
   */
  function enqueueWalk(scope: WalkScope): Promise<ProviderTreeSnapshot> {
    // A queued walk has not started yet, so it satisfies this caller too —
    // but a caller that needs a full rebuild upgrades the queued scope.
    if (queued !== null) {
      if (scope === 'full') queuedScope = 'full';
      return queued;
    }
    const prior = inFlight;
    if (prior === null) return startWalk(scope);
    queuedScope = scope;
    // Run after the current walk, whether it settles or fails.
    const next = prior.then(runQueued, runQueued);
    queued = next;
    return next;
  }

  function runQueued(): Promise<ProviderTreeSnapshot> {
    queued = null;
    const scope = queuedScope;
    queuedScope = 'dirty';
    if (disposed) {
      return Promise.reject(new Error('ProviderTreeSession disposed'));
    }
    return startWalk(scope);
  }

  /** Run one walk now. Callers must ensure no other walk is in flight. */
  function startWalk(scope: WalkScope): Promise<ProviderTreeSnapshot> {
    const myGen = ++generation;
    // Consume the invalidation set now. Events that arrive while this walk
    // runs repopulate it and are covered by the trailing walk.
    const dirty = new Set(dirtyDirs);
    dirtyDirs.clear();
    const prevRoot = snapshot?.root ?? null;
    const scoped =
      scope === 'dirty' &&
      prevRoot !== null &&
      dirty.size > 0 &&
      dirty.size <= MAX_SCOPED_DIRS;
    const work = (async (): Promise<ProviderTreeSnapshot> => {
      try {
        const treeRoot =
          scoped && prevRoot !== null
            ? await applyDirty(prevRoot, root, dirty)
            : await loadNode(root);
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
          void enqueueWalk('dirty').catch(() => {
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
    // Explicit refresh is the recovery path: rebuild everything, so a caller
    // can use it to recover from a missed or dropped watcher event.
    return enqueueWalk('full');
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
      queuedScope = 'dirty';
      pendingAfterFlight = false;
      dirtyDirs.clear();
    },
  };
}
