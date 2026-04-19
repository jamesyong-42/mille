// Typed FileExplorer wrapper — Phase 6 commit 6.5.
//
// Wraps the raw napi-rs `FileExplorer` class (from fx-binding) with the
// typed surface declared in ../api.d.ts. The goals:
//
//  1. Every async native call routes through `wrap()` so rejections
//     arrive as typed `FileSystemError` (code + path + message).
//  2. The eight channel-specific `onChange / onChangeTree /
//     onChangeDecorations / onEvent / onBatch / onWarning / onError /
//     onReady` methods on the native collapse into a single
//     `on(event, listener): Disposable` that matches api.d.ts.
//  3. `readFileStream` turns the native `class-with-.next()` into a
//     real `AsyncIterable<Uint8Array>` via `Symbol.asyncIterator`.
//  4. `MirrorSnapshot` is wrapped so callers can pick between the
//     struct-marshaled `visibleRows` (small viewports) and the
//     bincode-bulk `visibleRowsBulk` (decoded via `decodeBulkRows`).
//
// api.d.ts is the package's public type surface; this module mirrors
// only the subset it needs without importing from api.d.ts at runtime
// — keeping the declaration file decoupled from the implementation.
// The public `.d.ts` consumers see is the generated one from this
// file plus api.d.ts at the package root.
//
// AbortSignal on async I/O: accepted in the signature to stay API-
// compatible with api.d.ts, but currently ignored (napi-rs 3.x !Send
// issue on async fns with references — tracked in PLAN 13.x).

import { native } from './native.js';
import { wrap } from './errors.js';
import { decodeBulkRows, type VisibleRow as DecodedRow } from './decode.js';
import type { ChangeSet } from './delta.js';
import { DecorationStore, type DecorationProvider } from './decorations.js';

// ─── Local type mirrors (subset of api.d.ts) ──────────────────────────
//
// Kept intentionally minimal — just what client.ts references. Consumers
// importing from '@mille/file-explorer' get the rich surface through
// api.d.ts; this file stays decoupled.

export type EntryId = number;

export interface Entry {
  readonly id: EntryId;
  readonly parentId: EntryId | null;
  readonly name: string;
  readonly kind: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly symlinkTargetIsDir?: boolean;
  readonly pathSegments?: readonly string[];
  readonly isIgnored: boolean;
  readonly isReadonly: boolean;
  readonly isHidden: boolean;
}

export interface VisibleRow extends Entry {
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly isExpanded: boolean;
  readonly pending?: true;
}

export interface VisibleRowsOptions {
  readonly expanded: ReadonlySet<EntryId>;
  readonly offset: number;
  readonly limit: number;
  readonly includeIgnored?: boolean;
}

export interface VisibleRowCount {
  readonly known: number;
  readonly pendingExpansions: ReadonlySet<EntryId>;
}

export interface Decoration {
  readonly badge?: string;
  readonly color?: string;
  readonly tooltip?: string;
  readonly propagate?: boolean;
}

export interface SearchOptions {
  readonly limit?: number;
  readonly includeIgnored?: boolean;
  readonly caseSensitive?: boolean;
}

export interface SearchHit {
  readonly entry: Entry;
  readonly score: number;
  readonly matchedIndices: readonly number[];
}

export interface Disposable {
  dispose(): void;
}

export interface Uri {
  readonly scheme: string;
  readonly authority?: string;
  readonly path: string;
  readonly query?: string;
  readonly fragment?: string;
}

export interface ExplorerOptions {
  readonly roots: readonly (Uri | string)[];
  readonly respectIgnore?: boolean;
  readonly followSymlinks?: boolean | 'smart';
  readonly walkerConcurrency?: number;
  readonly watchDebounceMs?: number;
  readonly compactFolders?: boolean;
  readonly excludeGlobs?: readonly string[];
  readonly snapshotPath?: string;
  readonly maxCachedEntries?: number;
}

export type EventName =
  | 'change'
  | 'change:tree'
  | 'change:decorations'
  | 'event'
  | 'batch'
  | 'warning'
  | 'error'
  | 'ready';

// napi `onChange*` returns bigint subscription ids; off() expects Number.
type NativeFx = {
  readonly capabilities: number;
  getTreeVersion(): number;
  getSnapshot(): NativeSnapshot;
  takePendingChanges(): NativeChangeSet;
  populateFromRoots(): Promise<number>;
  create(parentId: number, name: string, kind: number): Promise<Entry>;
  rename(id: number, newName: string): Promise<Entry>;
  move(id: number, newParentId: number, newName?: string): Promise<Entry>;
  delete(id: number, options?: { trash?: boolean; recursive?: boolean }): Promise<void>;
  copy(id: number, newParentId: number, newName?: string): Promise<Entry>;
  readFile(id: number): Promise<Buffer>;
  readText(id: number, encoding?: string): Promise<string>;
  writeFile(id: number, data: Buffer, options?: { atomic?: boolean }): Promise<void>;
  readFileStream(id: number): NativeReadStream;
  onChange(listener: (n: unknown) => void): bigint;
  onChangeTree(listener: (n: unknown) => void): bigint;
  onChangeDecorations(listener: (n: unknown) => void): bigint;
  onEvent(listener: (n: unknown) => void): bigint;
  onBatch(listener: (n: unknown) => void): bigint;
  onWarning(listener: (n: unknown) => void): bigint;
  onError(listener: (n: unknown) => void): bigint;
  onReady(listener: () => void): bigint;
  off(subscriptionId: number): boolean;
  emitReadyForTests(): void;
  search(
    query: string,
    options?: { limit?: number; includeIgnored?: boolean; caseSensitive?: boolean },
  ): Array<{ entry: Entry; score: number; matchedIndices: number[] }>;
  dispose(): Promise<void>;
};

type NativeReadStream = {
  next(): Promise<Buffer | null>;
  cancel(): void;
};

// napi-rs `#[napi(object)]` emits camelCase field names on the JS side;
// the Rust source is snake_case. Keep this mirror aligned with
// crates/fx-binding/src/types.rs::ChangeSetJs.
type NativeChangeSet = {
  changedIds: number[];
  subtreeRootsChanged: number[];
  childSetChanged: number[];
  reparentedIds: Array<{
    id: number;
    oldParentId: number | null;
    newParentId: number | null;
  }>;
  fromVersion: number;
  toVersion: number;
};

type NativeSnapshot = {
  readonly treeVersion: number;
  readonly decorationVersion: number;
  roots(): Entry[];
  getById(id: number): Entry | null;
  directChildCount(id: number): number | null;
  hasChildren(id: number): boolean;
  childrenOf(id: number): number[];
  visibleRows(options: {
    expanded: number[];
    offset: number;
    limit: number;
    includeIgnored?: boolean;
  }): VisibleRow[];
  visibleRowsBin(options: {
    expanded: number[];
    offset: number;
    limit: number;
    includeIgnored?: boolean;
  }): Buffer;
  visibleRowCount(
    expanded: number[],
    includeIgnored?: boolean,
  ): { known: number; pendingExpansions: number[] };
};

// Map the public event names to the native method names.
const ON_METHOD: Record<EventName, keyof NativeFx> = {
  change: 'onChange',
  'change:tree': 'onChangeTree',
  'change:decorations': 'onChangeDecorations',
  event: 'onEvent',
  batch: 'onBatch',
  warning: 'onWarning',
  error: 'onError',
  ready: 'onReady',
};

function resolveRoot(u: Uri | string): string {
  if (typeof u === 'string') return u;
  return u.path;
}

function encodeFollowSymlinks(v: ExplorerOptions['followSymlinks']): string | undefined {
  if (v === undefined) return undefined;
  if (v === true) return 'true';
  if (v === false) return 'false';
  return 'smart';
}

/**
 * Typed `FileExplorer` wrapping the native binding. All async methods
 * funnel through `wrap()` so rejected napi errors surface as
 * `FileSystemError`. The public event API is a single `on()`; the
 * channel routing happens inside.
 */
export class FileExplorer {
  /** @internal — exposed so tests can reach `emitReadyForTests` etc. */
  private readonly nativeFx: NativeFx;
  /** @internal — host-side decoration merge store (Phase 9). */
  private readonly decorations = new DecorationStore();
  /** JS-side listeners for the decoration-scoped channels (Phase 9.3). */
  private readonly decorationListeners = new Set<(ids: readonly number[]) => void>();
  /** JS-side listeners for 'change' (fires on either dimension). */
  private readonly changeAnyListeners = new Set<(ids: readonly number[]) => void>();
  /** @internal — unsubscribe from the store's onChange when disposed. */
  private readonly decorationStoreSub: { dispose(): void };

  constructor(options: ExplorerOptions) {
    const Ctor = (native as unknown as { FileExplorer: new (opts: unknown) => NativeFx })
      .FileExplorer;
    const nativeOpts: Record<string, unknown> = {
      roots: options.roots.map(resolveRoot),
    };
    if (options.respectIgnore !== undefined) nativeOpts.respectIgnore = options.respectIgnore;
    const follow = encodeFollowSymlinks(options.followSymlinks);
    if (follow !== undefined) nativeOpts.followSymlinks = follow;
    if (options.walkerConcurrency !== undefined)
      nativeOpts.walkerConcurrency = options.walkerConcurrency;
    if (options.watchDebounceMs !== undefined)
      nativeOpts.watchDebounceMs = options.watchDebounceMs;
    if (options.compactFolders !== undefined) nativeOpts.compactFolders = options.compactFolders;
    if (options.excludeGlobs !== undefined) nativeOpts.excludeGlobs = [...options.excludeGlobs];
    if (options.snapshotPath !== undefined) nativeOpts.snapshotPath = options.snapshotPath;
    if (options.maxCachedEntries !== undefined)
      nativeOpts.maxCachedEntries = options.maxCachedEntries;

    this.nativeFx = new Ctor(nativeOpts);

    // Route DecorationStore bumps to the JS-only 'change:decorations'
    // channel and to 'change' (the dimension-agnostic aggregate).
    // 'change:tree' deliberately does NOT fire here — that's the core
    // promise of SPEC §4.9.11: decoration churn doesn't invalidate
    // tree-keyed caches. Tree bumps still arrive on 'change:tree' via
    // the native binding.
    this.decorationStoreSub = this.decorations.onChange((ids) => {
      for (const l of this.decorationListeners) l(ids);
      for (const l of this.changeAnyListeners) l(ids);
    });
  }

  get capabilities(): number {
    return this.nativeFx.capabilities;
  }

  getTreeVersion(): number {
    return this.nativeFx.getTreeVersion();
  }

  /** Decoration versions bump independently of the tree (Phase 9). */
  getDecorationVersion(): number {
    return this.decorations.version;
  }

  getSnapshot(): MirrorSnapshot {
    return new MirrorSnapshot(this.nativeFx.getSnapshot(), this.decorations);
  }

  /**
   * Register a decoration provider. The provider's `onDidChange`
   * fires with a set of affected entry ids; for each we call
   * `provide()` and update the DecorationStore, then bump the
   * decoration version once at the end of the batch.
   *
   * Provider errors during `provide()` are swallowed — a buggy
   * provider shouldn't crash the explorer. Real deployments should
   * log somewhere; Phase 9 keeps this minimal.
   *
   * Disposing the returned Disposable removes all the provider's
   * decorations and bumps the version one more time so consumers
   * drop the stale overlays.
   */
  registerDecorationProvider(provider: DecorationProvider): Disposable {
    const sub = provider.onDidChange(async (changedIds) => {
      const changed: number[] = [];
      for (const id of changedIds) {
        try {
          const d = await provider.provide({ id });
          if (this.decorations.setForProvider(provider.id, id, d ?? null)) {
            changed.push(id);
          }
        } catch {
          // Swallow — see method doc.
        }
      }
      this.decorations.bump(changed);
    });

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        sub.dispose();
        const affected = this.decorations.removeProvider(provider.id);
        this.decorations.bump(affected);
      },
    };
  }

  /**
   * Walk every configured root and seed the EntryStore with the
   * discovered entries. Returns the total entry count.
   *
   * Phase 5 intentionally keeps `new FileExplorer(...)` cheap — the
   * constructor does not walk the filesystem. Callers (and tests) that
   * need a populated tree invoke this method explicitly.
   */
  populateFromRoots(): Promise<number> {
    return wrap(this.nativeFx.populateFromRoots());
  }

  /**
   * Drain the native store's pending ChangeSet. The host's 16ms tick
   * loop (commit 7.6) calls this once per tick and fans the result out
   * to each attached session via `computeSessionDelta`.
   *
   * Returning a plain JS object (not a class) keeps this a zero-copy
   * NAPI struct marshal — a cleared `ChangeSet` is only six empty vecs
   * and two u32s so the allocation cost on quiet ticks is negligible.
   */
  takePendingChanges(): ChangeSet {
    const cs = this.nativeFx.takePendingChanges();
    // napi-rs already rewrites fields to camelCase, so the shape matches
    // ChangeSet as-is. The spread normalizes the prototype and strips any
    // non-own properties the binding might add in future versions.
    return {
      changedIds: cs.changedIds,
      subtreeRootsChanged: cs.subtreeRootsChanged,
      childSetChanged: cs.childSetChanged,
      reparentedIds: cs.reparentedIds.map((r) => ({
        id: r.id,
        oldParentId: r.oldParentId,
        newParentId: r.newParentId,
      })),
      fromVersion: cs.fromVersion,
      toVersion: cs.toVersion,
    };
  }

  /**
   * Local-mode expansion is a consumer-side concern — the snapshot
   * serves every subtree unconditionally. Kept on the surface for
   * API parity with PortFileExplorer so consumers can swap back-ends
   * without editing call sites.
   */
  setExpanded(_diff: { add?: readonly EntryId[]; remove?: readonly EntryId[] }): void {
    /* no-op: local MirrorSnapshot is direct. */
  }

  /** Local-mode viewport is likewise a consumer concern. */
  setViewport(_window: { offset: number; limit: number; overscan?: number }): void {
    /* no-op */
  }

  // ─── Mutations ──────────────────────────────────────────────────────

  create(parentId: EntryId, name: string, kind: number): Promise<Entry> {
    return wrap(this.nativeFx.create(parentId, name, kind));
  }

  rename(id: EntryId, newName: string): Promise<Entry> {
    return wrap(this.nativeFx.rename(id, newName));
  }

  move(id: EntryId, newParentId: EntryId, newName?: string): Promise<Entry> {
    return wrap(this.nativeFx.move(id, newParentId, newName));
  }

  delete(
    id: EntryId,
    options?: { trash?: boolean; recursive?: boolean },
  ): Promise<void> {
    return wrap(this.nativeFx.delete(id, options));
  }

  copy(id: EntryId, newParentId: EntryId, newName?: string): Promise<Entry> {
    return wrap(this.nativeFx.copy(id, newParentId, newName));
  }

  // ─── I/O ────────────────────────────────────────────────────────────

  async readFile(id: EntryId, _signal?: AbortSignal): Promise<Uint8Array> {
    // TODO(PLAN 13.x): pass signal once napi-rs !Send constraint is
    // resolved and read_file restructures onto AsyncTask.
    const buf = await wrap(this.nativeFx.readFile(id));
    // Zero-copy Uint8Array view over the Node Buffer.
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  readText(id: EntryId, encoding?: string, _signal?: AbortSignal): Promise<string> {
    return wrap(this.nativeFx.readText(id, encoding));
  }

  writeFile(
    id: EntryId,
    data: Uint8Array,
    options?: { atomic?: boolean },
  ): Promise<void> {
    return wrap(this.nativeFx.writeFile(id, Buffer.from(data), options));
  }

  /**
   * Async-iterable wrapper over the native `FileReadStream`. Callers
   * stop iteration with `break` or by exhausting; either path routes
   * through `finally` so the stream's `cancel()` always runs.
   */
  readFileStream(id: EntryId, _signal?: AbortSignal): AsyncIterable<Uint8Array> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const stream = this.nativeFx.readFileStream(id);
    return {
      [Symbol.asyncIterator]: async function* () {
        try {
          while (true) {
            const chunk = await wrap(stream.next());
            if (chunk === null) return;
            yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          }
        } finally {
          stream.cancel();
        }
      },
    };
  }

  // ─── Search ─────────────────────────────────────────────────────────

  /**
   * Filename fuzzy search (Phase 10). Matches `query` against every
   * entry's `name` in the current snapshot via the nucleo matcher.
   * Returns hits sorted by score descending (ties broken by entry id).
   *
   * Local-mode only: runs synchronously on the main thread. The
   * `AbortSignal` field on api.d.ts `SearchOptions` is accepted but
   * ignored here — nothing to abort in a sub-millisecond sync call.
   * The client-port path would front this with a 'call' message over
   * the wire; not wired in this commit.
   */
  search(query: string, options?: SearchOptions): readonly SearchHit[] {
    const nativeOpts: {
      limit?: number;
      includeIgnored?: boolean;
      caseSensitive?: boolean;
    } = {};
    if (options?.limit !== undefined) nativeOpts.limit = options.limit;
    if (options?.includeIgnored !== undefined) nativeOpts.includeIgnored = options.includeIgnored;
    if (options?.caseSensitive !== undefined) nativeOpts.caseSensitive = options.caseSensitive;
    const hits = this.nativeFx.search(query, nativeOpts);
    // napi-rs already rewrites to camelCase + plain arrays; just pass through.
    return hits;
  }

  // ─── Events ─────────────────────────────────────────────────────────

  /**
   * Subscribe to one of the eight event channels. Returns a Disposable
   * whose `dispose()` detaches the listener (idempotent on the native).
   *
   * Decoration channels (Phase 9.3):
   *   - 'change:decorations' is JS-only. Native never fires it; the
   *     DecorationStore does, via an internal bridge.
   *   - 'change' is a union: fires on BOTH the native's onChange
   *     (tree bumps) AND on decoration bumps.
   *   - 'change:tree' routes to the native onChangeTree as before —
   *     decoration-only bumps deliberately do not fan out here.
   */
  on(event: EventName, listener: (...args: unknown[]) => void): Disposable {
    if (event === 'change:decorations') {
      // JS-only channel; no native wiring.
      const wrapped = (ids: readonly number[]) => {
        (listener as (ids: readonly number[]) => void)(ids);
      };
      this.decorationListeners.add(wrapped);
      let active = true;
      return {
        dispose: () => {
          if (!active) return;
          active = false;
          this.decorationListeners.delete(wrapped);
        },
      };
    }

    if (event === 'change') {
      // 'change' fires on either dimension. Wire both the native
      // aggregate (tree bumps) and the JS-only decoration bridge.
      const wrapped = (ids: readonly number[]) => {
        (listener as (ids: readonly number[]) => void)(ids);
      };
      this.changeAnyListeners.add(wrapped);
      const nativeSubId = this.nativeFx.onChange(listener);
      let active = true;
      return {
        dispose: () => {
          if (!active) return;
          active = false;
          this.changeAnyListeners.delete(wrapped);
          this.nativeFx.off(Number(nativeSubId));
        },
      };
    }

    const method = ON_METHOD[event];
    if (!method) {
      throw new Error(`unknown event channel: ${String(event)}`);
    }
    // The native onX methods all take a single-arg listener; the shape
    // of that arg depends on the channel. Public typings in api.d.ts
    // enforce the right signature at call sites.
    const register = this.nativeFx[method] as (fn: (...args: unknown[]) => void) => bigint;
    const subId = register.call(this.nativeFx, listener);
    let active = true;
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        this.nativeFx.off(Number(subId));
      },
    };
  }

  dispose(): Promise<void> {
    this.decorationStoreSub.dispose();
    this.decorationListeners.clear();
    this.changeAnyListeners.clear();
    return wrap(this.nativeFx.dispose());
  }
}

/**
 * Typed, immutable view of the tree at a specific tree- and
 * decoration-version. Identity-stable between deltas so it can be
 * diffed with `===` and cached in refs.
 */
export class MirrorSnapshot {
  /** @internal */
  private readonly inner: NativeSnapshot;
  /** @internal — optional so Phase 9's wiring is backward-compatible. */
  private readonly decorations: DecorationStore | undefined;

  constructor(inner: NativeSnapshot, decorations?: DecorationStore) {
    this.inner = inner;
    this.decorations = decorations;
  }

  get treeVersion(): number {
    return this.inner.treeVersion;
  }

  get decorationVersion(): number {
    // Host-side decorations (Phase 9) live in DecorationStore; fall
    // back to the native decorationVersion (always 0 pre-Phase 9).
    return this.decorations?.version ?? this.inner.decorationVersion;
  }

  roots(): readonly Entry[] {
    return this.inner.roots();
  }

  getById(id: EntryId): Entry | null {
    return this.inner.getById(id) ?? null;
  }

  directChildCount(id: EntryId): number | null {
    const v = this.inner.directChildCount(id);
    return v ?? null;
  }

  hasChildren(id: EntryId): boolean {
    return this.inner.hasChildren(id);
  }

  /**
   * Immediate children of `id` in wire order. Used by the IPC host to
   * walk the tree for snapshot serialization (Phase 8 commit 8.6) —
   * consumers at the public surface normally route through
   * `visibleRows` instead.
   */
  childrenOf(id: EntryId): readonly EntryId[] {
    return this.inner.childrenOf(id);
  }

  /**
   * Struct-marshaled path. Preferred for small viewports (< ~100 rows
   * per SPEC §4.8). Per-row object marshaling, one NAPI call per row.
   */
  visibleRows(options: VisibleRowsOptions): readonly VisibleRow[] {
    const nativeOpts: {
      expanded: number[];
      offset: number;
      limit: number;
      includeIgnored?: boolean;
    } = {
      expanded: [...options.expanded],
      offset: options.offset,
      limit: options.limit,
    };
    if (options.includeIgnored !== undefined) {
      nativeOpts.includeIgnored = options.includeIgnored;
    }
    return this.inner.visibleRows(nativeOpts);
  }

  /**
   * Bincode bulk path. One Buffer hop, decoded in TS. Preferred above
   * the struct-marshaling threshold (SPEC §4.8: 100 rows).
   */
  visibleRowsBulk(options: VisibleRowsOptions): readonly DecodedRow[] {
    const nativeOpts: {
      expanded: number[];
      offset: number;
      limit: number;
      includeIgnored?: boolean;
    } = {
      expanded: [...options.expanded],
      offset: options.offset,
      limit: options.limit,
    };
    if (options.includeIgnored !== undefined) {
      nativeOpts.includeIgnored = options.includeIgnored;
    }
    const buf = this.inner.visibleRowsBin(nativeOpts);
    return decodeBulkRows(buf);
  }

  visibleRowCount(
    expanded: ReadonlySet<EntryId>,
    includeIgnored?: boolean,
  ): VisibleRowCount {
    const result = this.inner.visibleRowCount([...expanded], includeIgnored);
    return {
      known: result.known,
      pendingExpansions: new Set(result.pendingExpansions),
    };
  }

  /**
   * Merged decorations for `id` across all registered providers on
   * the owning FileExplorer. Returns `[]` when no decorations apply,
   * and also `[]` when no DecorationStore is wired — e.g. the
   * client-port MirrorSnapshot (shipping decoration deltas over the
   * wire is a Phase 10+ consideration).
   */
  getDecorations(id: EntryId): readonly Decoration[] {
    if (!this.decorations) return [];
    return this.decorations.getMerged(id) as readonly Decoration[];
  }
}
