// Port-backed FileExplorer client — Phase 7 commit 7.4 + Phase 8 wave 3.
//
// Companion to createFileExplorerHost. `connectFileExplorer(port)` attaches
// to a MessagePort-shaped transport (Node worker_threads, Electron
// MessageChannelMain, or DOM MessageChannel), completes the protocol
// handshake, and returns a PortFileExplorer whose surface mirrors the
// typed FileExplorer class — but every method tunnels through the wire.
//
// Phase 8 wiring (commit 8.6) replaces the minimal PortMirrorSnapshot
// stub with the real mirror:
//   - PortFileExplorer holds a MirrorWorking state
//   - snapshot/delta messages flow through the applySnapshot / applyDelta
//     reducer (src/mirror-reducer.ts)
//   - getSnapshot() returns a ClientMirrorSnapshot whose identity is
//     stable between deltas (useSyncExternalStore-friendly)
//   - setExpanded / setViewport route to the host; pendingExpansions on
//     the mirror tracks in-flight expansions until the delta reply lands
//
// SPEC §4.9.1: identity-stable snapshots. Reducer produces a fresh
// MirrorWorking on every apply; we wrap it in a new
// ClientMirrorSnapshot before publishing so `getSnapshot()` returns
// `===`-equal references between ticks that didn't change anything.

import type { Decoration, DecorationProvider } from './decorations.js';
import { FileSystemError, type ErrorCode } from './errors.js';
import {
  applyDelta,
  applySnapshot,
  DEFAULT_MIRROR_CAP,
  hydrateLookupEntries,
  type InboundDelta,
  type InboundSnapshot,
} from './mirror-reducer.js';
import { ClientMirrorSnapshot, clientEntryToEntry } from './mirror-snapshot.js';
import { cloneMirror, createMirror, type ClientEntry, type MirrorWorking } from './mirror.js';
import {
  frame,
  PROTOCOL_VERSION,
  validateFrameVersion,
  type DecorationOnWire,
} from './protocol.js';
import type { Disposable, MessagePortLike } from './types.js';
import type { ExplorerProjectionSettings } from './explorer-settings.js';
import type { ResyncOptions, TransferOptions, Uri } from './client.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export interface ClientOptions {
  readonly prefetchRows?: number;
  /** Max entries the mirror retains before LRU eviction (SPEC §4.9.7). Default 4096. */
  readonly mirrorCap?: number;
}

type ChangeListener = () => void;

/**
 * Normalize a Node `worker_threads::MessagePort` onto the common
 * MessagePortLike shape. Mirrors host.ts's adaptPort.
 */
function adaptPort(port: unknown): MessagePortLike {
  const p = port as {
    postMessage?: (m: unknown, t?: readonly unknown[]) => void;
    addEventListener?: MessagePortLike['addEventListener'];
    removeEventListener?: MessagePortLike['removeEventListener'];
    on?: (event: string, listener: (data: unknown) => void) => unknown;
    start?: () => void;
    close?: () => void;
  };
  if (typeof p.addEventListener === 'function') {
    return port as MessagePortLike;
  }
  if (typeof p.on === 'function') {
    return {
      postMessage: (m, t) => p.postMessage!(m, t),
      addEventListener: (_type, listener) => {
        p.on!('message', (data) => listener({ data }));
      },
      removeEventListener: () => {
        /* no-op on Node MessagePort — close() handles teardown */
      },
      start: () => p.start?.(),
      close: () => p.close?.(),
    };
  }
  throw new Error('port does not satisfy MessagePortLike (no addEventListener or on)');
}

/**
 * Back-compat alias: older consumers `import { PortMirrorSnapshot }`.
 * Phase 8 swaps the implementation to ClientMirrorSnapshot — the
 * public shape (treeVersion, roots, getById, visibleRows, …) is a
 * superset of the old stub.
 */
export { ClientMirrorSnapshot as PortMirrorSnapshot } from './mirror-snapshot.js';

/**
 * Renderer-side FileExplorer proxy. Every mutation routes through the
 * port; every reqId gets a pending promise that resolves on the matching
 * mutateResult/callResult frame or rejects with a typed FileSystemError.
 */
interface RegisteredDecorationProvider {
  readonly provider: DecorationProvider;
  /** Entry ids the provider has produced a decoration for at least once. */
  readonly knownIds: Set<number>;
  dispose: () => void;
}

export class PortFileExplorer {
  private readonly port: MessagePortLike;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly changeListeners = new Set<ChangeListener>();
  private nextReqId = 1;
  private working: MirrorWorking = createMirror();
  private publishedSnapshot: ClientMirrorSnapshot = new ClientMirrorSnapshot(this.working);
  private readonly mirrorCap: number;
  private readonly handshakeReady: Promise<void>;
  private handshakeResolve!: () => void;
  private handshakeReject!: (reason: unknown) => void;
  private disposed = false;
  /**
   * Phase A1 — decoration providers registered against this client.
   * Each entry retains a `knownIds` set so the client can push
   * incremental deltas when the provider's `onDidChange` fires.
   */
  private readonly decorationProviders = new Map<string, RegisteredDecorationProvider>();
  /**
   * Entry ids that are already in `working.byId` at the last delta
   * tick. The port client uses this to detect new ids that arrived in
   * a delta and push per-new-id decoration computations.
   */
  private lastKnownEntryIds: Set<number> = new Set();

  constructor(rawPort: MessagePortLike, options?: ClientOptions) {
    this.port = adaptPort(rawPort);
    this.mirrorCap = options?.mirrorCap ?? DEFAULT_MIRROR_CAP;
    this.handshakeReady = new Promise((resolve, reject) => {
      this.handshakeResolve = resolve;
      this.handshakeReject = reject;
    });
    this.port.addEventListener('message', (ev) => this.handleMessage(ev.data));
    this.port.start?.();
    this.port.postMessage(
      frame('handshake', {
        version: PROTOCOL_VERSION,
        clientId: `c-${Math.random().toString(36).slice(2, 10)}`,
        options: { ...options, packedChildLists: true },
      }),
    );
  }

  /** Resolves once the host has replied with its initial snapshot. */
  ready(): Promise<void> {
    return this.handshakeReady;
  }

  getTreeVersion(): number {
    return this.working.treeVersion;
  }

  /** Resolve a workspace-relative path on the authoritative host index. */
  async resolvePath(path: string): Promise<number | null> {
    const result = await this.call('resolvePath', [path]);
    // Older hosts returned the id directly. Keep accepting that shape while
    // newer hosts include the bounded ancestor chain needed by lazy mirrors.
    if (typeof result === 'number') return result;
    if (result === null || typeof result !== 'object') return null;
    const payload = result as { id?: unknown; version?: unknown; entries?: unknown };
    if (
      typeof payload.id !== 'number' ||
      typeof payload.version !== 'number' ||
      !Array.isArray(payload.entries)
    ) {
      return null;
    }
    this.working = hydrateLookupEntries(
      this.working,
      payload.entries as ClientEntry[],
      payload.version,
      this.mirrorCap,
    );
    this.publishSnapshot();
    return payload.id;
  }

  /** Run a payload-free typeahead fallback against the host's full snapshot. */
  async findVisiblePrefix(
    prefix: string,
    fromId: number | null,
    skipCurrent: boolean,
    expanded: ReadonlySet<number>,
  ): Promise<number | null> {
    const result = await this.call('findVisiblePrefix', [
      prefix,
      fromId,
      skipCurrent,
      [...expanded],
    ]);
    if (typeof result === 'number') return result;
    if (result === null || typeof result !== 'object') return null;
    const payload = result as { id?: unknown; version?: unknown; entries?: unknown };
    if (
      typeof payload.id !== 'number' ||
      typeof payload.version !== 'number' ||
      !Array.isArray(payload.entries)
    ) {
      return null;
    }
    this.working = hydrateLookupEntries(
      this.working,
      payload.entries as ClientEntry[],
      payload.version,
      this.mirrorCap,
    );
    this.publishSnapshot();
    return payload.id;
  }

  /**
   * Current client-mirror snapshot. Identity is stable across ticks
   * that didn't deliver a new delta, so useSyncExternalStore can gate
   * re-renders on `===`.
   */
  getSnapshot(): ClientMirrorSnapshot {
    return this.publishedSnapshot;
  }

  /**
   * Subscribe to change bumps. Fires on every published snapshot —
   * handshake, delta, and future channels (event/batch/warning/error/
   * ready arrive in wave 3+).
   */
  on(event: string, listener: (...args: unknown[]) => void): Disposable {
    if (event === 'change') {
      const wrapped: ChangeListener = () => listener();
      this.changeListeners.add(wrapped);
      return {
        dispose: () => {
          this.changeListeners.delete(wrapped);
        },
      };
    }
    return { dispose: () => undefined };
  }

  /**
   * Push a fresh expansion diff to the host and record pending
   * expansions locally so `visibleRowCount` can surface a loading
   * indicator before the child entries arrive (SPEC §4.9.2).
   */
  setExpanded(diff: { add?: readonly number[]; remove?: readonly number[] }): void {
    const add = diff.add ?? [];
    const remove = diff.remove ?? [];
    if (add.length === 0 && remove.length === 0) return;

    // Clone before mutating so an already-published snapshot keeps its
    // immutable working-state view.
    const next = cloneMirror(this.working);
    let touched = false;
    for (const id of add) {
      if (!next.expanded.has(id)) {
        next.expanded.add(id);
        touched = true;
      }
      if (!next.pendingExpansions.has(id)) {
        next.pendingExpansions.add(id);
        touched = true;
      }
    }
    for (const id of remove) {
      if (next.expanded.delete(id)) touched = true;
      if (next.pendingExpansions.delete(id)) touched = true;
    }
    if (touched) {
      this.working = next;
      this.publishSnapshot();
    }

    this.sendAfterReady(
      frame('setExpanded', {
        add: [...add],
        remove: [...remove],
      }),
    );
  }

  /** Fire-and-forget viewport update. */
  setViewport(window: { offset: number; limit: number; overscan?: number }): void {
    const body: { offset: number; limit: number; overscan?: number } = {
      offset: window.offset,
      limit: window.limit,
    };
    if (window.overscan !== undefined) body.overscan = window.overscan;
    this.sendAfterReady(frame('setViewport', body));
  }

  /** Atomically update the host's display projection for every attached client. */
  async updateProjectionSettings(settings: ExplorerProjectionSettings): Promise<number> {
    const result = await this.call('updateProjectionSettings', [settings]);
    if (typeof result !== 'number') {
      throw new FileSystemError('EUNKNOWN', 'invalid updateProjectionSettings response');
    }
    return result;
  }

  /**
   * Atomically reorder all workspace roots. Resolves only after the host has
   * published the ordered root list to every attached client mirror.
   */
  async reorderRoots(ids: readonly number[]): Promise<number> {
    const result = await this.call('reorderRoots', [[...ids]]);
    if (typeof result !== 'number') {
      throw new FileSystemError('EUNKNOWN', 'invalid reorderRoots response');
    }
    return result;
  }

  /**
   * Replace the host's configured roots. Resolves after every attached mirror
   * has received the new root list and removals.
   */
  async updateWorkspaceRoots(roots: readonly (Uri | string)[]): Promise<number> {
    const paths = roots.map((root) => (typeof root === 'string' ? root : root.path));
    const result = await this.call('updateWorkspaceRoots', [paths]);
    if (typeof result !== 'number') {
      throw new FileSystemError('EUNKNOWN', 'invalid updateWorkspaceRoots response');
    }
    return result;
  }

  /** Re-stat root availability and resolve after every mirror is current. */
  async refreshWorkspaceRoots(): Promise<number> {
    const result = await this.call('refreshWorkspaceRoots', []);
    if (typeof result !== 'number') {
      throw new FileSystemError('EUNKNOWN', 'invalid refreshWorkspaceRoots response');
    }
    return result;
  }

  /** Reconcile one entry and resolve after every attached mirror is current. */
  async resync(id: number, options?: ResyncOptions): Promise<number> {
    const result = await this.call('resync', [id, options?.recursive ?? false]);
    if (typeof result !== 'number') {
      throw new FileSystemError('EUNKNOWN', 'invalid resync response');
    }
    return result;
  }

  /** Reconcile every workspace root and resolve after every mirror is current. */
  async resyncWorkspace(): Promise<number> {
    const result = await this.call('resyncWorkspace', []);
    if (typeof result !== 'number') {
      throw new FileSystemError('EUNKNOWN', 'invalid resyncWorkspace response');
    }
    return result;
  }

  // ─── Mutations ────────────────────────────────────────────────────

  create(parentId: number, name: string, kind: number): Promise<unknown> {
    return this.mutate('create', { parentId, name, kind });
  }

  rename(id: number, newName: string): Promise<unknown> {
    return this.mutate('rename', { id, newName });
  }

  move(
    id: number,
    newParentId: number,
    newName?: string,
    options?: TransferOptions,
  ): Promise<unknown> {
    const args: Record<string, unknown> = { id, newParentId };
    if (newName !== undefined) args.newName = newName;
    if (options !== undefined) args.options = options;
    return this.mutate('move', args);
  }

  delete(id: number, options?: { trash?: boolean; recursive?: boolean }): Promise<unknown> {
    const args: Record<string, unknown> = { id };
    if (options !== undefined) args.options = options;
    return this.mutate('delete', args);
  }

  copy(
    id: number,
    newParentId: number,
    newName?: string,
    options?: TransferOptions,
  ): Promise<unknown> {
    const args: Record<string, unknown> = { id, newParentId };
    if (newName !== undefined) args.newName = newName;
    if (options !== undefined) args.options = options;
    return this.mutate('copy', args);
  }

  async readFile(id: number): Promise<Uint8Array> {
    const data = (await this.mutate('readFile', { id })) as number[];
    return Uint8Array.from(data);
  }

  readText(id: number, encoding?: string): Promise<unknown> {
    const args: Record<string, unknown> = { id };
    if (encoding !== undefined) args.encoding = encoding;
    return this.mutate('readText', args);
  }

  writeFile(id: number, data: Uint8Array, options?: { atomic?: boolean }): Promise<unknown> {
    const args: Record<string, unknown> = { id, data: Array.from(data) };
    if (options !== undefined) args.options = options;
    return this.mutate('writeFile', args);
  }

  private async mutate(op: string, args: Record<string, unknown>): Promise<unknown> {
    await this.handshakeReady;
    if (this.disposed) {
      throw new FileSystemError('ECANCELED', 'explorer disposed');
    }
    const reqId = this.nextReqId++;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      try {
        this.port.postMessage(frame('mutate', { reqId, op, args }));
      } catch (e) {
        this.pending.delete(reqId);
        reject(e);
      }
    });
  }

  /**
   * Phase A1 — register a decoration provider on the client. The
   * client walks `working.byId`, calls `provider.provide(entry)` for
   * each, and pushes a single `decorations` frame with
   * `replaceAll: true` (which the host applies as a clear-then-upsert
   * under this provider id). Subsequent `provider.onDidChange(ids)`
   * fires push incremental deltas; `onDidChange()` with no args
   * re-pushes the whole known set. New entries discovered via
   * incoming deltas also trigger per-id decoration computations so
   * newly-arrived rows get their decoration on the same tick.
   *
   * Disposing the returned `Disposable` unsubscribes from the provider
   * and pushes a clearing frame so the host drops every decoration
   * contributed by this provider id.
   */
  registerDecorationProvider(provider: DecorationProvider): Disposable {
    const record: RegisteredDecorationProvider = {
      provider,
      knownIds: new Set<number>(),
      dispose: () => {
        /* replaced below */
      },
    };

    // Initial push — seed with whatever the mirror holds right now.
    // Fire through `sendAfterReady` so the push happens after the
    // handshake even if the caller registers before connect resolves.
    const initial = this.computeDecorationsForEveryKnownId(provider, record);
    this.sendAfterReady(
      frame('decorations', {
        providerId: provider.id,
        entries: initial,
        replaceAll: true,
      }),
    );

    // Subscribe to onDidChange — the listener's signature in
    // decorations.ts accepts `(ids: readonly EntryId[]) => void`. An
    // empty `ids` array means "re-push everything known". The
    // companion-level `EngineDecorationProvider` doesn't support
    // zero-arg invocation; treat a zero-length list as the signal for
    // a full rebuild so both shapes converge.
    const sub = provider.onDidChange((ids) => {
      if (this.disposed) return;
      if (ids.length === 0) {
        const full = this.computeDecorationsForEveryKnownId(provider, record);
        this.sendAfterReady(
          frame('decorations', {
            providerId: provider.id,
            entries: full,
            replaceAll: true,
          }),
        );
        return;
      }
      void this.pushDecorationsForIds(provider, record, ids, false);
    });

    record.dispose = (): void => {
      try {
        sub.dispose();
      } catch {
        /* ignore */
      }
      // Clear all decorations under this provider id on the host.
      this.sendAfterReady(
        frame('decorations', {
          providerId: provider.id,
          entries: [],
          replaceAll: true,
        }),
      );
      this.decorationProviders.delete(provider.id);
    };

    this.decorationProviders.set(provider.id, record);

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        record.dispose();
      },
    };
  }

  /** Non-mutating RPC channel (e.g. getTreeVersion). */
  async call(method: string, args: unknown[] = []): Promise<unknown> {
    await this.handshakeReady;
    if (this.disposed) {
      throw new FileSystemError('ECANCELED', 'explorer disposed');
    }
    const reqId = this.nextReqId++;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      try {
        this.port.postMessage(frame('call', { reqId, method, args }));
      } catch (e) {
        this.pending.delete(reqId);
        reject(e);
      }
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Best-effort notify the host before tearing down. If the port is
    // already closed the send will throw and we swallow it.
    try {
      this.port.postMessage(frame('dispose', {}));
    } catch {
      /* ignore */
    }
    for (const [, p] of this.pending) {
      p.reject(new FileSystemError('ECANCELED', 'explorer disposed'));
    }
    this.pending.clear();
    this.port.close?.();
  }

  private sendAfterReady(msg: unknown): void {
    void this.handshakeReady.then(() => {
      if (this.disposed) return;
      try {
        this.port.postMessage(msg);
      } catch {
        /* port closed; ignore */
      }
    });
  }

  private handleMessage(data: unknown): void {
    const f = validateFrameVersion(data);
    if (!f) return;
    switch (f.type) {
      case 'snapshot':
        this.handleSnapshot(f.body as InboundSnapshot);
        return;
      case 'delta':
        this.handleDelta(f.body as InboundDelta);
        return;
      case 'mutateResult':
      case 'callResult':
        this.handleResult(
          f.body as {
            reqId: number;
            result: unknown;
            error?: { code: string; message: string; path?: string };
          },
        );
        return;
      case 'error':
        this.handleError(f.body as { code: string; message: string });
        return;
      // event / warning / batch / ready land in wave 3+
      default:
        return;
    }
  }

  private handleSnapshot(body: InboundSnapshot): void {
    this.working = applySnapshot(this.working, body, this.mirrorCap);
    this.publishSnapshot();
    this.handshakeResolve();
    // Mirror initial seed for the decoration-new-id diff. No providers
    // can be registered before handshake completes, but populate the
    // tracker so the first post-register delta sees a clean baseline.
    this.lastKnownEntryIds = new Set(this.working.byId.keys());
  }

  private handleDelta(body: InboundDelta): void {
    this.working = applyDelta(this.working, body, this.mirrorCap);
    this.publishSnapshot();
    // Phase A1 — after the mirror absorbs a delta, recompute
    // decorations for any ids that just arrived so the host sees
    // per-provider decorations for them on the next tick.
    this.recomputeDecorationsForNewIds();
  }

  /**
   * Freeze the current MirrorWorking into a new ClientMirrorSnapshot
   * and wake up change listeners. Identity advances every publish —
   * consumers relying on `===` semantics re-render automatically.
   */
  private publishSnapshot(): void {
    this.publishedSnapshot = new ClientMirrorSnapshot(this.working);
    this.fireChange();
  }

  /**
   * Walk every id in `working.byId`, call `provider.provide(entry)`,
   * and return the wire-shape entry tuples. Also synchronises
   * `record.knownIds` to match the set of ids the provider produced
   * a non-null decoration for — the next incremental push can then
   * clear ids whose decoration disappeared.
   */
  private computeDecorationsForEveryKnownId(
    provider: DecorationProvider,
    record: RegisteredDecorationProvider,
  ): Array<readonly [number, DecorationOnWire | null]> {
    const out: Array<readonly [number, DecorationOnWire | null]> = [];
    const freshKnown = new Set<number>();
    for (const [id, ce] of this.working.byId) {
      let decoration: Decoration | null = null;
      // Reconstruct a public Entry from the mirror's ClientEntry so
      // providers whose matchers inspect fields beyond `id` (e.g.
      // agent-rules' path matching via `entry.name` / duck-typed
      // `path`) see the full record.
      const entry = clientEntryToEntry(ce);
      try {
        const maybe = provider.provide(entry as unknown as { id: number });
        // provide() may return a promise; the port path only supports
        // sync results in the bulk walk. Async providers keep working
        // via `onDidChange` fires — the listener below awaits per id.
        if (maybe !== null && !isThenable(maybe)) {
          decoration = maybe;
        }
      } catch {
        decoration = null;
      }
      if (decoration !== null) {
        out.push([id, toWire(decoration)]);
        freshKnown.add(id);
      }
    }
    record.knownIds.clear();
    for (const id of freshKnown) record.knownIds.add(id);
    return out;
  }

  /**
   * Recompute decorations for a specific id list and push an
   * incremental `decorations` frame (replaceAll: false). Handles the
   * async `provide()` path: results are awaited one by one and the
   * single outbound frame is queued after the last resolves. A
   * provider returning `null` for a previously-known id emits an
   * explicit `[id, null]` tuple so the host clears that slot.
   */
  private async pushDecorationsForIds(
    provider: DecorationProvider,
    record: RegisteredDecorationProvider,
    ids: readonly number[],
    includeClears: boolean,
  ): Promise<void> {
    if (this.disposed) return;
    const entries: Array<readonly [number, DecorationOnWire | null]> = [];
    for (const id of ids) {
      let decoration: Decoration | null = null;
      const ce = this.working.byId.get(id);
      // For removed ids (no entry left in the mirror) fall back to
      // a bare `{id}` stub so the provider can still return null for
      // cleanup purposes. Most providers only inspect the id anyway.
      const entry = ce !== undefined ? clientEntryToEntry(ce) : null;
      try {
        const arg = entry ?? { id };
        const maybe = provider.provide(arg as unknown as { id: number });
        decoration = isThenable(maybe) ? await maybe : maybe;
      } catch {
        decoration = null;
      }
      if (decoration !== null) {
        entries.push([id, toWire(decoration)]);
        record.knownIds.add(id);
      } else if (record.knownIds.has(id) || includeClears) {
        // Clearing an id we previously decorated. Without this the
        // host keeps a stale entry under this provider.
        entries.push([id, null]);
        record.knownIds.delete(id);
      }
    }
    if (entries.length === 0) return;
    this.sendAfterReady(
      frame('decorations', {
        providerId: provider.id,
        entries,
        replaceAll: false,
      }),
    );
  }

  /**
   * After a delta lands: diff the mirror's byId against
   * `lastKnownEntryIds` to find fresh ids, then call every
   * registered provider once per fresh id so newly-arrived rows
   * get a decoration pushed upstream on the same tick. Removed ids
   * (present before, absent now) also trigger a per-provider push
   * of an explicit clearing tuple.
   */
  private recomputeDecorationsForNewIds(): void {
    if (this.decorationProviders.size === 0) {
      this.lastKnownEntryIds = new Set(this.working.byId.keys());
      return;
    }
    const currentIds = new Set(this.working.byId.keys());
    const addedIds: number[] = [];
    for (const id of currentIds) {
      if (!this.lastKnownEntryIds.has(id)) addedIds.push(id);
    }
    const removedIds: number[] = [];
    for (const id of this.lastKnownEntryIds) {
      if (!currentIds.has(id)) removedIds.push(id);
    }
    this.lastKnownEntryIds = currentIds;
    if (addedIds.length === 0 && removedIds.length === 0) return;
    for (const record of this.decorationProviders.values()) {
      if (addedIds.length > 0) {
        void this.pushDecorationsForIds(record.provider, record, addedIds, false);
      }
      if (removedIds.length > 0) {
        void this.pushDecorationsForIds(record.provider, record, removedIds, true);
      }
    }
  }

  private handleResult(body: {
    reqId: number;
    result: unknown;
    error?: { code: string; message: string; path?: string };
  }): void {
    const pending = this.pending.get(body.reqId);
    if (!pending) return;
    this.pending.delete(body.reqId);
    if (body.error) {
      pending.reject(
        new FileSystemError(body.error.code as ErrorCode, body.error.message, body.error.path),
      );
    } else {
      pending.resolve(body.result);
    }
  }

  private handleError(body: { code: string; message: string }): void {
    const err = new FileSystemError(body.code as ErrorCode, body.message);
    // Session-level failure. If we haven't handshaken yet, fail ready().
    // Either way, reject every pending request so callers bubble out
    // rather than hanging.
    this.handshakeReject(err);
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }

  private fireChange(): void {
    for (const l of this.changeListeners) {
      try {
        l();
      } catch {
        /* swallow listener errors so one bad subscriber can't block others */
      }
    }
  }
}

/**
 * Renderer-side factory. Takes a MessagePort and resolves once the
 * handshake completes and the initial snapshot has arrived. Mirrors
 * the api.d.ts signature.
 */
export async function connectFileExplorer(
  port: MessagePortLike,
  options?: ClientOptions,
): Promise<PortFileExplorer> {
  const fx = new PortFileExplorer(port, options);
  await fx.ready();
  return fx;
}

// ─── Phase A1 helpers ──────────────────────────────────────────────────

/**
 * Duck-typed promise check. `provider.provide` may be sync or async;
 * the bulk-seed path only accepts sync results (async values flow via
 * the per-id `onDidChange` push which awaits one id at a time).
 */
function isThenable<T>(v: T | Promise<T>): v is Promise<T> {
  return (
    v !== null && typeof v === 'object' && typeof (v as { then?: unknown }).then === 'function'
  );
}

/**
 * Project a public `Decoration` into its wire shape. The two interfaces
 * share the same key set; spread-only-when-defined satisfies
 * `exactOptionalPropertyTypes`.
 */
function toWire(d: Decoration): DecorationOnWire {
  const out: { -readonly [K in keyof DecorationOnWire]: DecorationOnWire[K] } = {};
  if (d.badge !== undefined) out.badge = d.badge;
  if (d.color !== undefined) out.color = d.color;
  if (d.tooltip !== undefined) out.tooltip = d.tooltip;
  if (d.propagate !== undefined) out.propagate = d.propagate;
  return out;
}
