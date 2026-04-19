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
  }

  get capabilities(): number {
    return this.nativeFx.capabilities;
  }

  getTreeVersion(): number {
    return this.nativeFx.getTreeVersion();
  }

  /** Decoration versions bump independently of the tree (Phase 9). */
  getDecorationVersion(): number {
    return this.nativeFx.getSnapshot().decorationVersion;
  }

  getSnapshot(): MirrorSnapshot {
    return new MirrorSnapshot(this.nativeFx.getSnapshot());
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

  // ─── Events ─────────────────────────────────────────────────────────

  /**
   * Subscribe to one of the eight event channels. Returns a Disposable
   * whose `dispose()` detaches the listener (idempotent on the native).
   */
  on(event: EventName, listener: (...args: unknown[]) => void): Disposable {
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

  constructor(inner: NativeSnapshot) {
    this.inner = inner;
  }

  get treeVersion(): number {
    return this.inner.treeVersion;
  }

  get decorationVersion(): number {
    return this.inner.decorationVersion;
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

  /** Decorations land in Phase 9; return empty until then. */
  getDecorations(_id: EntryId): readonly Decoration[] {
    return [];
  }
}
