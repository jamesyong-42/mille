/**
 * @vibecook/mille — public API draft
 *
 * Design principles (from research):
 *  - Tree state lives in Rust; JS owns view state (expansion, selection, scroll)
 *  - Flat-array output over NAPI boundary; no nested objects
 *  - Stable EntryId across renames (inode+device on Unix, FileID on Windows)
 *  - Expected errors as tagged-union Result; exceptions only for bugs
 *  - Capability flags + scheme dispatch (VS Code IFileSystemProvider pattern)
 *  - Sum-tree snapshot so visible-row queries are O(log n) for virtualization
 */

// ─── Core identifiers ──────────────────────────────────────────────────────

/**
 * Monotonic id assigned in Rust. Stable across renames/moves within a session.
 * Uses JS `number` capped at 2^53-1 in Rust (Number.MAX_SAFE_INTEGER) for
 * ergonomic React keys, JSON, Set/Map usage. Session-scoped — reassigned on boot.
 */
export type EntryId = number;

/** URI for scheme-based provider dispatch. Mirrors VS Code's Uri shape. */
export interface Uri {
  readonly scheme: string; // 'file' | 'memfs' | 'ssh' | 'zip' | ...
  readonly authority?: string; // e.g. remote host
  readonly path: string; // always POSIX-style
  readonly query?: string;
  readonly fragment?: string;
}

// ─── Tagged-union errors ───────────────────────────────────────────────────

export type ErrorCode =
  | 'EACCES'
  | 'ENOENT'
  | 'EEXIST'
  | 'EISDIR'
  | 'ENOTDIR'
  | 'ELOOP'
  | 'ENOSPC'
  | 'EROFS'
  | 'EBUSY'
  | 'EINVAL'
  | 'ECANCELED'
  | 'EUNSUPPORTED'
  | 'EUNKNOWN';

/**
 * Typed error for expected filesystem failures. Methods throw this rather
 * than returning a Result-style tagged union, so natural try/catch works
 * and stack traces are preserved. Mirrors VS Code's `FileSystemError`.
 *
 * Example:
 *   try {
 *     await fx.rename(id, 'new-name');
 *   } catch (e) {
 *     if (isFileSystemError(e) && e.code === 'EEXIST') {
 *       // handle collision
 *     } else throw e;
 *   }
 */
export declare class FileSystemError extends Error {
  readonly code: ErrorCode;
  readonly path?: string;
  constructor(code: ErrorCode, message: string, path?: string);
}

export declare function isFileSystemError(e: unknown): e is FileSystemError;

/** Exact package/native implementation loaded by the current process. */
export interface BuildIdentity {
  readonly packageVersion: string;
  readonly nativeVersion: string;
  readonly nativeProfile: string;
  readonly nativeTarget: string;
  readonly protocolVersion: number;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly source: 'local' | 'platform-package';
  readonly resolvedPath: string;
}

/** Record this in benchmark reports and native bug reports. */
export declare function buildIdentity(): BuildIdentity;

// ─── Capability flags ──────────────────────────────────────────────────────

/** Bitmask. Providers advertise which methods they implement. */
export const enum Capability {
  None = 0,
  ReadWrite = 1 << 0,
  CaseSensitive = 1 << 1,
  Readonly = 1 << 2,
  Trash = 1 << 3,
  AtomicWrite = 1 << 4,
  Watch = 1 << 5,
  Stream = 1 << 6,
  Clone = 1 << 7,
  Realpath = 1 << 8,
  FileLock = 1 << 9,
}

// ─── Entry record ──────────────────────────────────────────────────────────

export const enum EntryKind {
  File = 0,
  Directory = 1,
  Symlink = 2,
  Unknown = 3,
}

/** One row in the flat-array model. Produced in Rust, shipped as bincode Buffer. */
export interface Entry {
  readonly id: EntryId;
  readonly parentId: EntryId | null; // null only for roots
  readonly name: string;
  readonly kind: EntryKind;
  readonly size: number; // bytes; 0 for dirs. JS number is fine up to 8 PB.
  readonly mtimeMs: number; // unix ms; JS `number` precision is fine for mtimes
  readonly ctimeMs: number;
  /** True if the symlink target is a directory (for UI rendering). */
  readonly symlinkTargetIsDir?: boolean;
  /** Set when compact-folders collapsed `a/b/c` into a single row. */
  readonly pathSegments?: readonly string[];
  readonly isIgnored: boolean;
  readonly isReadonly: boolean;
  readonly isHidden: boolean; // dotfile or platform-hidden
}

// ─── Explorer construction ─────────────────────────────────────────────────

export interface ExplorerOptions {
  /**
   * Workspace roots in display order. Duplicate filesystem basenames are
   * supported and retain distinct path identities.
   */
  readonly roots: readonly Uri[];

  /** Parse .gitignore/.ignore/.rgignore and flag matching entries. Default: true. */
  readonly respectIgnore?: boolean;

  /**
   * Symlink traversal policy. Default: `'smart'`.
   *   - `false` — never descend into symlinked directories
   *   - `true`  — always descend (may cycle; not recommended)
   *   - `'smart'` — descend but canonicalize & dedupe: already-seen targets
   *     render as non-expandable "link" rows, ancestor cycles are blocked,
   *     outside-workspace targets are allowed (covers pnpm/npm link)
   */
  readonly followSymlinks?: boolean | 'smart';

  /** Parallel walker thread count. Default: num_cpus. */
  readonly walkerConcurrency?: number;

  /** Debounce window before emitting batched events. Default: 75ms. */
  readonly watchDebounceMs?: number;

  /** Collapse single-child folder chains into one row. Default: true. */
  readonly compactFolders?: boolean;

  /** Extra exclude globs layered on top of .gitignore. */
  readonly excludeGlobs?: readonly string[];

  /** Resume from a prior snapshot if present; emit `changedSinceSnapshot` events on boot. */
  readonly snapshotPath?: string;

  /** Max in-memory entries. Further children are lazy-loaded. Default: 500_000. */
  readonly maxCachedEntries?: number;

  /**
   * Phase B2 — initial walk policy. Consumed by `createFileExplorerHost`
   * (see host.ts); the raw `FileExplorer` class ignores it (construction
   * stays cheap — no implicit filesystem work).
   *
   *   - `'full'` (default, v0.1 behaviour): the host does not walk;
   *     the consumer calls `host.local.populateFromRoots()` explicitly.
   *   - `'roots-only'`: the host walks each configured root at depth 0
   *     so root Entry records appear in the store before handshake.
   *     Children stream in on-demand via `setExpanded` (which now fires
   *     a per-folder walk when the child list isn't in the store).
   *   - `'none'`: the host does not walk at all; the consumer drives
   *     `prefetch` / `list` / `populateFromRoots` by hand.
   *
   * The SPEC §4.3 walker section describes the tradeoffs in detail.
   */
  readonly initialWalk?: 'full' | 'roots-only' | 'none';
  /** Resolved Phase 3 settings applied at the native snapshot boundary. */
  readonly settings?: ResolvedExplorerSettings;
}

export type ExplorerSortBy = 'name' | 'type' | 'modified';

export interface ResolvedExplorerSettings {
  readonly sortBy: ExplorerSortBy;
  readonly caseSensitive: boolean;
  readonly locale: string | null;
  readonly foldersOnTop: boolean;
  readonly showHiddenFiles: boolean;
  readonly showIgnoredFiles: boolean;
  /** Whether single-directory chains are projected as compact rows. */
  readonly compactFolders: boolean;
  readonly compactFolders: boolean;
  readonly excludeGlobs: readonly string[];
  /**
   * Parent pattern → exact companion-name templates. Parent patterns accept
   * zero or one `*`; child templates may substitute `${capture}`.
   */
  readonly fileNestingPatterns: Readonly<Record<string, readonly string[]>>;
}

export type ExplorerProjectionSettings = Pick<
  ResolvedExplorerSettings,
  | 'sortBy'
  | 'caseSensitive'
  | 'locale'
  | 'foldersOnTop'
  | 'showHiddenFiles'
  | 'showIgnoredFiles'
  | 'compactFolders'
  | 'excludeGlobs'
  | 'fileNestingPatterns'
>;

export type ExplorerSettingsOverride = Partial<ResolvedExplorerSettings>;

export interface ExplorerWorkspaceSettings {
  readonly settings?: ExplorerSettingsOverride;
  readonly roots?: Readonly<Record<string, ExplorerSettingsOverride>>;
}

export interface ExplorerSettingsDocument {
  readonly version: 1;
  readonly global?: ExplorerSettingsOverride;
  readonly workspaces?: Readonly<Record<string, ExplorerWorkspaceSettings>>;
}

export declare const EXPLORER_SETTINGS_VERSION: 1;
export declare const DEFAULT_EXPLORER_SETTINGS: ResolvedExplorerSettings;
export declare function parseExplorerSettings(
  input: string | unknown,
): ExplorerSettingsDocument | null;
export declare function serializeExplorerSettings(settings: ExplorerSettingsDocument): string;
export declare function resolveExplorerSettings(
  document: ExplorerSettingsDocument | null | undefined,
  workspaceKey?: string,
  rootKey?: string,
): ResolvedExplorerSettings;

// ─── Listing & pagination ──────────────────────────────────────────────────

export interface ListOptions {
  readonly includeIgnored?: boolean;
  /** Depth below `parentId`; 1 = direct children only. Default: 1. */
  readonly depth?: number;
  readonly offset?: number;
  readonly limit?: number;
  readonly sort?: 'name' | 'mtime' | 'size' | 'kindThenName';
  readonly sortDir?: 'asc' | 'desc';
  readonly signal?: AbortSignal;
}

export interface ListPage {
  readonly entries: readonly Entry[];
  readonly total: number;
  readonly hasMore: boolean;
}

// ─── Virtualized row query ─────────────────────────────────────────────────
//
// Reads go through an immutable `MirrorSnapshot` so React 19 concurrent
// rendering sees a consistent view. Get one via `fx.getSnapshot()`; it stays
// valid (same identity, same data) until the next delta. Pair with
// `useSyncExternalStore(subscribe, getSnapshot)` — the snapshot *is* the
// external store value.

export interface VisibleRowsOptions {
  readonly expanded: ReadonlySet<EntryId>;
  readonly offset: number;
  readonly limit: number;
  readonly includeIgnored?: boolean;
  readonly sort?: ListOptions['sort'];
  readonly sortDir?: ListOptions['sortDir'];
}

export interface VisibleRow extends Entry {
  /** 0 = root level. Lets the renderer indent without walking parents. */
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly isExpanded: boolean;
  /** Placeholder row — real data still in flight. Renderer shows a skeleton. */
  readonly pending?: true;
}

export interface VisibleRowCount {
  /** Rows the snapshot can render right now. */
  readonly known: number;
  /**
   * Ids of expanded folders whose children haven't arrived yet. Empty set ⇒
   * `known` is the exact total. Non-empty ⇒ `known` is a lower bound; more
   * rows will appear when their child deltas land.
   */
  readonly pendingExpansions: ReadonlySet<EntryId>;
}

/**
 * Immutable view of the tree at a specific tree-version + decoration-version.
 * Safe to read during React render; safe to cache in refs; safe to diff via
 * `===` identity. Produced by `FileExplorer.getSnapshot()`; never mutated in
 * place. A new snapshot is published on any change to either dimension.
 */
export interface MirrorSnapshot {
  readonly treeVersion: TreeVersion;
  /** Advances when viewport rows hydrate without an authoritative tree change. */
  readonly projectionVersion: number;
  readonly decorationVersion: DecorationVersion;
  /** Resolved projection policy for dotfiles and other hidden entries. */
  readonly showHiddenFiles: boolean;
  /** Resolved projection policy for ignored/excluded entries. */
  readonly showIgnoredFiles: boolean;

  /** Workspace roots in display order. */
  roots(): readonly Entry[];

  /** O(log n) in the sum-tree; O(1) from the mirror in typical cases. */
  visibleRows(options: VisibleRowsOptions): readonly VisibleRow[];
  /** Visible ids for selection-only consumers, without complete row payloads. */
  visibleRowIds(options: VisibleRowsOptions): readonly EntryId[];
  visibleRowCount(expanded: ReadonlySet<EntryId>, includeIgnored?: boolean): VisibleRowCount;
  /** Exact index in the flattened visible order via one DFS, or `null` when not visible. */
  visibleRowIndex(
    id: EntryId,
    expanded: ReadonlySet<EntryId>,
    includeIgnored?: boolean,
  ): number | null;
  getById(id: EntryId): Entry | null;

  /** Cached immediate-child count for a folder. `null` if not yet known. */
  directChildCount(id: EntryId): number | null;

  /** True if the snapshot holds this folder's full child list (safe to call `visibleRows` crossing it). */
  hasChildren(id: EntryId): boolean;

  /** Merged decorations for an entry across all registered providers. Fast path — precomputed per snapshot. */
  getDecorations(id: EntryId): readonly Decoration[];
}

// ─── Events & invalidation (hybrid model) ──────────────────────────────────
//
// Primary model: "version + pull". On any tree mutation, treeVersion bumps and
// `'change'` fires with the version + a compact set of touched ids. UI stores
// version via useSyncExternalStore and re-pulls only the rows it needs.
//
// Raw events ('event' / 'batch') are still exposed for consumers with
// imperative semantics (SCM decorators, audit logs, external indexers).

/** Monotonically increasing version of the tree snapshot. */
export type TreeVersion = number;

/** Monotonically increasing version of decoration state (git/lint/problems). Bumps independently of tree structure. */
export type DecorationVersion = number;

export interface ChangeNotice {
  readonly treeVersion: TreeVersion;
  readonly decorationVersion: DecorationVersion;
  /** Which dimensions actually changed. A decoration-only change has `tree: false, decorations: true`. */
  readonly changed: { readonly tree: boolean; readonly decorations: boolean };
  /** Ids whose entry record (or visibility) may have changed. Empty for decoration-only bumps. */
  readonly changedIds: readonly EntryId[];
  /** Parents whose child set may have changed. Empty for decoration-only bumps. */
  readonly childSetChanged: readonly EntryId[];
  /** Ids whose decorations changed. Non-empty only when `changed.decorations === true`. */
  readonly decorationChangedIds: readonly EntryId[];
  /** Subtree roots flagged as coarse (watcher overflow); scoped, never global. */
  readonly coarseSubtrees: readonly EntryId[];
}

export type WarningCode =
  | 'INOTIFY_LIMIT' // Linux inotify watch count near ceiling
  | 'FSEVENTS_LIMIT' // macOS FSEvents path limit hit
  | 'ENTRY_CAP_REACHED' // maxCachedEntries exceeded; tail is lazy-only
  | 'SYMLINK_CYCLE' // cycle detected; link not descended
  | 'SNAPSHOT_STALE'; // resume snapshot too old; cold-walking

export type FileSystemEvent =
  | {
      readonly kind: 'created';
      readonly id: EntryId;
      readonly parentId: EntryId | null;
      readonly entry: Entry;
    }
  | { readonly kind: 'changed'; readonly id: EntryId; readonly entry: Entry }
  | {
      readonly kind: 'deleted';
      readonly id: EntryId;
      readonly parentId: EntryId | null;
      readonly path: string;
    }
  | {
      readonly kind: 'renamed';
      readonly id: EntryId;
      readonly oldParentId: EntryId | null;
      readonly newParentId: EntryId | null;
      readonly oldName: string;
      readonly newName: string;
    }
  | {
      readonly kind: 'error';
      readonly path: string;
      readonly code: ErrorCode;
      readonly message: string;
    }
  | { readonly kind: 'warning'; readonly code: WarningCode; readonly detail?: string }
  /** Watcher backlog exceeded; consumer should treat tree as dirty and re-list. */
  | { readonly kind: 'overflow' };

export type EventListener<E> = (event: E) => void;

export interface Disposable {
  dispose(): void;
}

// ─── Decorations (git/lint/problems overlay) ───────────────────────────────

export interface Decoration {
  readonly badge?: string; // 1–2 chars, e.g. 'M', '!'
  readonly color?: string; // theme token
  readonly tooltip?: string;
  /** Roll up to ancestor folders (e.g. dirty-folder indicator). */
  readonly propagate?: boolean;
}

export interface DecorationProvider {
  readonly id: string;
  /** Fired by the provider when specific entries' decorations change. */
  onDidChange(listener: EventListener<readonly EntryId[]>): Disposable;
  provide(entry: Entry): Decoration | null | Promise<Decoration | null>;
}

// ─── Filename fuzzy search ─────────────────────────────────────────────────
//
// Scoped to filenames/paths over the in-memory entry list (nucleo matcher in
// Rust). Content search lives in a separate package that consumes this one.

export interface SearchOptions {
  readonly limit?: number; // default 100
  readonly includeIgnored?: boolean;
  readonly kinds?: readonly EntryKind[];
  readonly signal?: AbortSignal;
}

export interface SearchHit {
  readonly entry: Entry;
  readonly score: number;
  /** Indices into `entry.name` (or full path) for highlighting. */
  readonly matchedIndices: readonly number[];
}

// ─── External provider API (v2 hook, defined now for stability) ────────────

export interface FileSystemProvider {
  readonly scheme: string;
  readonly capabilities: number; // bitmask of Capability
  stat(uri: Uri): Promise<Entry>;
  readDirectory(uri: Uri): Promise<readonly Entry[]>;
  readFile(uri: Uri): Promise<Uint8Array>;
  writeFile(uri: Uri, data: Uint8Array, options?: { atomic?: boolean }): Promise<void>;
  createDirectory(uri: Uri): Promise<void>;
  delete(uri: Uri, options?: { recursive?: boolean; trash?: boolean }): Promise<void>;
  rename(oldUri: Uri, newUri: Uri): Promise<void>;
  copy?(source: Uri, destination: Uri): Promise<void>;
  watch?(uri: Uri, options?: WatchOptions): Watcher;
  readFileStream?(uri: Uri, signal?: AbortSignal): AsyncIterable<Uint8Array>;
}

export interface WatchOptions {
  readonly recursive?: boolean;
  readonly excludes?: readonly string[];
  readonly includes?: readonly string[];
}

export interface Watcher extends Disposable {
  onDidChange(listener: EventListener<FileSystemEvent>): Disposable;
}

// ─── The main class ────────────────────────────────────────────────────────

export declare class FileExplorer implements Disposable {
  constructor(options: ExplorerOptions);

  /** Bitmask of local provider capabilities. */
  readonly capabilities: number;

  /**
   * Returns the current immutable snapshot. Identity-stable until the next
   * `'change'` event. All sync reads (roots, visibleRows, getById, ...)
   * live on the snapshot, not on the explorer, so React concurrent rendering
   * sees a consistent view:
   *
   *     const snap = useSyncExternalStore(
   *       (cb) => fx.on('change', cb).dispose,
   *       () => fx.getSnapshot(),
   *     );
   *     const rows = snap.visibleRows({ expanded, offset, limit });
   */
  getSnapshot(): MirrorSnapshot;

  /**
   * Atomically replace display settings without rebuilding or walking.
   * Indexed entries are immediately reclassified for exclude-glob changes.
   * Local explorers return the new version synchronously; port explorers
   * resolve after every attached mirror has received the new projection.
   */
  updateProjectionSettings(
    settings: ExplorerProjectionSettings,
  ): TreeVersion | Promise<TreeVersion>;

  /**
   * Atomically reorder the current workspace roots by stable identity.
   * `ids` must contain every current root exactly once. Local explorers
   * return synchronously; port explorers resolve after every attached
   * mirror has received the ordered root list.
   */
  reorderRoots(ids: readonly EntryId[]): TreeVersion | Promise<TreeVersion>;

  /**
   * Atomically replace workspace roots in display order. New roots are seeded
   * as lazy directory entries; removed roots lose their known subtrees.
   * Duplicate, overlapping, missing, and non-directory roots reject without
   * publishing. The asynchronous result is a mirror synchronization point.
   */
  updateWorkspaceRoots(roots: readonly (Uri | string)[]): Promise<TreeVersion>;

  /** Async URI → entry. May return null if the URI isn't under a known root. */
  getByUri(uri: Uri): Promise<Entry | null>;
  /**
   * Resolve an absolute or workspace-relative path through the engine index.
   * Lazy stores hydrate only the target's ancestor chain.
   */
  resolvePath(path: string): Promise<EntryId | null>;
  /** Find the next visible prefix match without returning row payloads. */
  findVisiblePrefix(
    prefix: string,
    fromId: EntryId | null,
    skipCurrent: boolean,
    expanded: ReadonlySet<EntryId>,
  ): Promise<EntryId | null>;

  // Children (one level, paginated) — async form. Prefer `getSnapshot()`
  // for already-loaded data; use `list` for uncached / paginated reads.
  list(parentId: EntryId, options?: ListOptions): Promise<ListPage>;

  // Prefetch children for a folder about to be expanded. Doesn't add to the
  // session's expansion set — just warms the mirror.
  prefetch(id: EntryId, options?: { depth?: number; signal?: AbortSignal }): Promise<void>;

  // Session state lives with the client; call these to move expansion + viewport.
  setExpanded(diff: {
    readonly add?: readonly EntryId[];
    readonly remove?: readonly EntryId[];
  }): void;
  setViewport(options: {
    readonly offset: number;
    readonly limit: number;
    readonly overscan?: number;
  }): void;

  // Mutations
  create(parentId: EntryId, name: string, kind: EntryKind): Promise<Entry>;
  rename(id: EntryId, newName: string): Promise<Entry>;
  move(id: EntryId, newParentId: EntryId, newName?: string): Promise<Entry>;
  delete(id: EntryId, options?: { trash?: boolean; recursive?: boolean }): Promise<void>;
  copy(id: EntryId, newParentId: EntryId, newName?: string): Promise<Entry>;

  // I/O
  readFile(id: EntryId, signal?: AbortSignal): Promise<Uint8Array>;
  readText(id: EntryId, encoding?: string, signal?: AbortSignal): Promise<string>;
  writeFile(id: EntryId, data: Uint8Array, options?: { atomic?: boolean }): Promise<void>;
  readFileStream(id: EntryId, signal?: AbortSignal): AsyncIterable<Uint8Array>;

  // Fuzzy search over the in-memory tree
  search(query: string, options?: SearchOptions): Promise<readonly SearchHit[]>;

  // Ad-hoc watching outside the loaded roots
  watch(uri: Uri, options?: WatchOptions): Watcher;

  // Primary pull model — pair with useSyncExternalStore
  getTreeVersion(): TreeVersion;
  getDecorationVersion(): DecorationVersion;

  /**
   * Subscribe to snapshot bumps. Three variants:
   *   - `'change'` fires on either tree or decoration bump (typical UI use)
   *   - `'change:tree'` fires only on tree bumps (indexers, scanners)
   *   - `'change:decorations'` fires only on decoration bumps (SCM overlays)
   *
   * The snapshot returned by `getSnapshot()` advances identity on whichever
   * dimension bumped; consumers subscribing to the scoped variants get a
   * narrower cadence but still read the latest snapshot.
   */
  on(event: 'change', listener: EventListener<ChangeNotice>): Disposable;
  on(event: 'change:tree', listener: EventListener<ChangeNotice>): Disposable;
  on(event: 'change:decorations', listener: EventListener<ChangeNotice>): Disposable;

  // Raw event bus — for imperative consumers (SCM, indexers, audit)
  on(event: 'event', listener: EventListener<FileSystemEvent>): Disposable;
  on(event: 'batch', listener: EventListener<readonly FileSystemEvent[]>): Disposable;
  on(event: 'warning', listener: EventListener<{ code: WarningCode; detail?: string }>): Disposable;
  on(event: 'error', listener: EventListener<Error>): Disposable;
  on(event: 'ready', listener: EventListener<void>): Disposable;

  // Decorations — reads live on `MirrorSnapshot.getDecorations(id)`.
  registerDecorationProvider(provider: DecorationProvider): Disposable;

  // Crash-resume (@parcel/watcher-style)
  writeSnapshot(path: string): Promise<void>;

  // Teardown — stops watcher threads, releases Rust resources
  dispose(): Promise<void>;
}

// ─── Module-level registration for custom schemes ──────────────────────────

/** Register a provider for a non-`file` scheme (ssh, zip, memfs, s3, ...). */
export declare function registerProvider(provider: FileSystemProvider): Disposable;

/** Introspect registered providers and their capabilities. */
export declare function listProviders(): readonly { scheme: string; capabilities: number }[];

// ─── UtilityProcess host/client split ──────────────────────────────────────
//
// Deployment model: the native `.node` module loads only in the Electron
// UtilityProcess. The renderer talks to the host over a MessagePort and sees
// a lightweight client that mirrors state for sync `visibleRows` reads.
//
// Both entry points produce objects that satisfy the `FileExplorer` shape;
// renderers don't need to know which side they're on.

/** Minimal `MessagePort`-like surface satisfied by `MessagePortMain`, `MessagePort`, and Node `MessagePort`. */
export interface MessagePortLike {
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  start?(): void;
  close?(): void;
}

/**
 * UtilityProcess-side factory. Loads the native module, owns the canonical
 * EntryStore, walker, and watcher. Accepts any number of client connections
 * over MessagePorts.
 */
export interface FileExplorerHost extends Disposable {
  /** Attach a renderer/client port. Each port gets its own session (expansion + viewport state). */
  attachPort(port: MessagePortLike): Disposable;
  /** Number of currently-attached client sessions. */
  readonly sessionCount: number;
  /** Direct access for the host process itself (e.g. SCM extension running alongside). */
  readonly local: FileExplorer;
  dispose(): Promise<void>;
}

export declare function createFileExplorerHost(options: ExplorerOptions): Promise<FileExplorerHost>;

/**
 * Renderer-side factory. Takes a MessagePort (typically received via
 * `ipcRenderer.on('port')` from Electron main), returns a `FileExplorer`
 * whose reads are served from a local ViewportMirror and whose writes
 * round-trip to the host.
 */
export interface ClientOptions {
  /** Initial viewport window for prefetching; tune to your virtualizer's overscan. Default: 200. */
  readonly prefetchRows?: number;
  /** Max mirror size in entries before the oldest cold expansions are evicted. Default: 20_000. */
  readonly mirrorCap?: number;
}

export declare function connectFileExplorer(
  port: MessagePortLike,
  options?: ClientOptions,
): Promise<FileExplorer>;
