// UtilityProcess-side entry — Phase 7 commits 7.1 + 7.3.
//
// `createFileExplorerHost` wraps a native `FileExplorer` and owns the
// per-MessagePort `Session` map. Each attached port gets its own
// expansion set, viewport, knownIds (for delta filtering in 7.5), and
// request-id counter. Attach/detach lifecycle is testable end-to-end
// via Node `worker_threads` MessageChannels — the same shape Electron's
// `MessageChannelMain` produces.
//
// 7.3 adds message routing: handshake -> snapshot, setExpanded -> delta
// (empty mirror until wave 3), setViewport -> fire-and-forget, mutate ->
// dispatchMutation -> mutateResult, call -> dispatchCall -> callResult,
// dispose -> detach. Version gating + handshake-first sequencing are
// enforced; malformed or wrong-version frames produce an `error` frame.
// Bulk mirror/delta payloads land in wave 3 via a shared encoder.

import { FileExplorer, type Entry, type MirrorSnapshot } from './client.js';
import type { EntryId, ExplorerOptions } from './client.js';
import {
  applyDeltaToSession,
  computeSessionDelta,
  type SessionView,
} from './delta.js';
import { isFileSystemError } from './errors.js';
import type { ClientEntry } from './mirror.js';
import {
  frame,
  isCompatibleVersion,
  validateFrameVersion,
} from './protocol.js';
import type { Disposable, FileExplorerHost, MessagePortLike } from './types.js';

/**
 * Project a public `Entry` into the mirror-local `ClientEntry` shape.
 * The public Entry uses `undefined`-holes for optional fields; the
 * wire (JSON) representation needs explicit `null` so round-trips
 * don't lose the distinction between "absent" and "present-undefined".
 */
function entryToClient(e: Entry): ClientEntry {
  return {
    id: e.id,
    parentId: e.parentId,
    name: e.name,
    kind: e.kind,
    size: e.size,
    mtimeMs: e.mtimeMs,
    ctimeMs: e.ctimeMs,
    symlinkTargetIsDir: e.symlinkTargetIsDir ?? null,
    pathSegments: e.pathSegments !== undefined ? [...e.pathSegments] : null,
    isIgnored: e.isIgnored,
    isReadonly: e.isReadonly,
    isHidden: e.isHidden,
  };
}

/**
 * Walk the snapshot from the roots down and collect every entry. For
 * Phase 8 this ships the whole tree in the initial snapshot frame —
 * test trees are small enough that the JSON overhead is irrelevant.
 * Phase 12 will bound the walk by viewport + expansion.
 */
function collectAllEntries(snap: MirrorSnapshot): ClientEntry[] {
  const out: ClientEntry[] = [];
  const visited = new Set<number>();
  const stack: number[] = snap.roots().map((r) => r.id);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const e = snap.getById(id);
    if (!e) continue;
    out.push(entryToClient(e));
    const kids = snap.childrenOf(id);
    for (const kid of kids) stack.push(kid);
  }
  return out;
}

/**
 * Per-connection session state. Owned by the host, one per attached port.
 */
interface Session {
  readonly id: number;
  readonly port: MessagePortLike;
  /** Expansion set this client has declared via `setExpanded`. */
  expanded: Set<number>;
  /** Current viewport window the client has requested. */
  viewport: { offset: number; limit: number; overscan: number };
  /**
   * Entry ids this session has already been told about. Phase 7.5 uses
   * this to filter deltas down to the rows the client actually knows —
   * new entries outside the client's viewport stay off the wire until
   * the viewport moves to cover them.
   */
  knownIds: Set<number>;
  /** Next request id to use on outgoing host->client frames. */
  nextReqId: number;
  /** Whether the handshake frame has been observed. */
  handshook: boolean;
  /** Teardown for the message listener + port. Replaced during attach. */
  detach: () => void;
}

/**
 * Normalize a Node `worker_threads::MessagePort` (uses `.on`/`.off`) and
 * a DOM/Electron `MessagePort` (uses `addEventListener`) down to the
 * common `MessagePortLike` shape the rest of the host works against.
 *
 * Node's MessagePort wraps listeners with its own bookkeeping, so
 * `removeEventListener` here is currently a no-op — the session's
 * `detach` relies on `port.close()` to drop the listener instead. Phase
 * 7.10 tightens this with per-listener bookkeeping.
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
      // TODO(7.10): per-listener bookkeeping so removeEventListener
      // actually detaches. close() below covers the common case.
      removeEventListener: () => {
        /* no-op on Node MessagePort */
      },
      start: () => p.start?.(),
      close: () => p.close?.(),
    };
  }
  throw new Error('port does not satisfy MessagePortLike (no addEventListener or on)');
}

/**
 * 16ms ≈ one render frame. SPEC §4.9 sizes the coalescer + fan-out tick
 * so the host never spends more than one frame between draining changes
 * and posting deltas. Adjusting this in tests is intentionally not
 * supported — the tick is an implementation detail.
 */
const TICK_MS = 16;

class FileExplorerHostImpl implements FileExplorerHost {
  private readonly explorer: FileExplorer;
  private readonly sessions = new Map<number, Session>();
  private nextSessionId = 1;
  private disposed = false;
  /** setInterval handle for the fan-out tick. Null when idle. */
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  /**
   * Subtree roots flagged for coarse invalidation since the last tick.
   * Drained into each session's outgoing delta as `coarseSubtrees`.
   * Wired to the native watcher's Overflow signal in Phase 5 — exposed
   * now via `markSubtreeCoarse` so the protocol end is testable.
   */
  private pendingCoarseSubtrees: Set<number> = new Set();
  /**
   * Volatile-subtree markers per SPEC §4.9.10. A root cannot ride both
   * fields in the same delta — the mark* methods enforce the
   * dirty-xor-resynced invariant at enqueue time so the tick never has
   * to reconcile them.
   */
  private pendingSubtreeDirty: Set<number> = new Set();
  private pendingSubtreeResynced: Set<number> = new Set();
  /**
   * Serial promise chain all mutations hang off. SPEC §5.1's ordering
   * guarantee — delta fan-out to every session must precede the
   * initiator's mutateResult — falls out of enqueuing each mutation on
   * this single chain and awaiting inside the entry.
   */
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: ExplorerOptions) {
    this.explorer = new FileExplorer(options);
  }

  get local(): FileExplorer {
    return this.explorer;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  markSubtreeCoarse(rootId: number): void {
    this.pendingCoarseSubtrees.add(rootId);
  }

  markSubtreeDirty(rootId: number): void {
    this.pendingSubtreeDirty.add(rootId);
    // A root cannot be simultaneously dirty and resynced — the pair
    // maps to opposite transitions in VolatileTracker's flip/release
    // state machine. If a previous resynced hadn't drained yet, the
    // latest transition wins.
    this.pendingSubtreeResynced.delete(rootId);
  }

  markSubtreeResynced(rootId: number): void {
    this.pendingSubtreeResynced.add(rootId);
    this.pendingSubtreeDirty.delete(rootId);
  }

  attachPort(rawPort: MessagePortLike): Disposable {
    if (this.disposed) {
      throw new Error('FileExplorerHost is disposed');
    }
    const port = adaptPort(rawPort);
    const id = this.nextSessionId++;
    const session: Session = {
      id,
      port,
      expanded: new Set<number>(),
      viewport: { offset: 0, limit: 0, overscan: 0 },
      knownIds: new Set<number>(),
      nextReqId: 1,
      handshook: false,
      detach: () => {
        /* replaced below */
      },
    };

    const onMessage = (evt: { data: unknown }): void => {
      this.handleMessage(session, evt.data);
    };
    port.addEventListener('message', onMessage);
    port.start?.();

    session.detach = (): void => {
      port.removeEventListener('message', onMessage);
      port.close?.();
    };
    this.sessions.set(id, session);
    this.ensureTick();
    return { dispose: () => this.detachSession(id) };
  }

  /** Start the 16ms fan-out tick if it isn't already running. */
  private ensureTick(): void {
    if (this.tickHandle !== null || this.disposed) return;
    this.tickHandle = setInterval(() => this.tick(), TICK_MS);
    // Don't keep the process alive just for the tick. Node's default
    // setInterval ref() behaviour would otherwise prevent graceful
    // shutdown in host harnesses that rely on the event loop draining.
    const h = this.tickHandle as unknown as { unref?: () => void };
    h.unref?.();
  }

  /** Stop the tick if it's running — called once sessionCount hits 0. */
  private stopTick(): void {
    if (this.tickHandle === null) return;
    clearInterval(this.tickHandle);
    this.tickHandle = null;
  }

  /**
   * Drain one ChangeSet from the native and fan out per-session deltas.
   *
   * No-op fast path when the ChangeSet is empty (quiet ticks): Phase 7's
   * tick loop runs at 60Hz, so idle hosts pay only a single NAPI call
   * per 16ms. Wave 4 adds a dirty-flag bypass if even that shows up on a
   * flame graph.
   */
  private tick(): void {
    if (this.disposed || this.sessions.size === 0) return;
    const cs = this.explorer.takePendingChanges();
    const changeSetEmpty =
      cs.changedIds.length === 0 &&
      cs.childSetChanged.length === 0 &&
      cs.subtreeRootsChanged.length === 0 &&
      cs.reparentedIds.length === 0;

    // Drain pending subtree markers. Doing this once per tick (not once
    // per session) guarantees all attached sessions see the same marker
    // set in the delta they receive this frame.
    const coarse = this.pendingCoarseSubtrees.size > 0 ? [...this.pendingCoarseSubtrees] : [];
    const subtreeDirty =
      this.pendingSubtreeDirty.size > 0 ? [...this.pendingSubtreeDirty] : [];
    const subtreeResynced =
      this.pendingSubtreeResynced.size > 0 ? [...this.pendingSubtreeResynced] : [];
    if (coarse.length > 0) this.pendingCoarseSubtrees.clear();
    if (subtreeDirty.length > 0) this.pendingSubtreeDirty.clear();
    if (subtreeResynced.length > 0) this.pendingSubtreeResynced.clear();

    // Skip the tick entirely when there's nothing to report — neither
    // a ChangeSet nor any subtree markers. Keeps idle hosts quiet.
    if (
      changeSetEmpty &&
      coarse.length === 0 &&
      subtreeDirty.length === 0 &&
      subtreeResynced.length === 0
    ) {
      return;
    }

    // Freshest snapshot — used to lift ClientEntry records for any id
    // that moved (changed, added, or reparented) this tick.
    const snap = this.explorer.getSnapshot();

    for (const session of this.sessions.values()) {
      if (!session.handshook) continue;
      const view: SessionView = {
        expanded: session.expanded,
        knownIds: session.knownIds,
      };
      const delta = computeSessionDelta(cs, view);
      applyDeltaToSession(delta, view);
      // Prune coarse roots from this session's knownIds. Minimum viable
      // behaviour: drop the root itself so the client's subsequent
      // setExpanded re-query repopulates. Full subtree pruning requires
      // host-side parent-chain tracking (Phase 8).
      for (const rootId of coarse) {
        session.knownIds.delete(rootId);
      }

      // Bundle the ClientEntry payloads for every id whose record
      // changed. Also sweep in children of `childSetChanged` parents
      // that the session doesn't know about — expanded folders get live
      // updates when their child list grows (SPEC §4.9.5).
      const outEntries: ClientEntry[] = [];
      const outDirectChildCounts: Record<string, number> = {};
      const emitted = new Set<number>();
      for (const id of delta.changedIds) {
        if (emitted.has(id)) continue;
        const entry = snap.getById(id);
        if (!entry) continue;
        outEntries.push(entryToClient(entry));
        emitted.add(id);
        const c = snap.directChildCount(id);
        if (c !== null) outDirectChildCounts[String(id)] = c;
      }
      for (const parentId of delta.childSetChanged) {
        const pc = snap.directChildCount(parentId);
        if (pc !== null) outDirectChildCounts[String(parentId)] = pc;
        if (!session.expanded.has(parentId)) continue;
        for (const kidId of snap.childrenOf(parentId)) {
          if (session.knownIds.has(kidId) || emitted.has(kidId)) continue;
          const entry = snap.getById(kidId);
          if (!entry) continue;
          outEntries.push(entryToClient(entry));
          emitted.add(kidId);
          session.knownIds.add(kidId);
          const cc = snap.directChildCount(kidId);
          if (cc !== null) outDirectChildCounts[String(kidId)] = cc;
        }
      }

      this.send(
        session,
        frame('delta', {
          version: delta.version,
          changedIds: delta.changedIds,
          entriesJson: outEntries.length > 0 ? JSON.stringify(outEntries) : undefined,
          childSetChanged: delta.childSetChanged,
          removedIds: delta.removedIds,
          directChildCounts: outDirectChildCounts,
          newVisibleCount: 0,
          coarseSubtrees: coarse,
          subtreeDirty,
          subtreeResynced,
        }),
      );
    }
  }

  private handleMessage(session: Session, data: unknown): void {
    const f = validateFrameVersion(data);
    if (!f) {
      this.sendError(session, 'EINVAL', 'malformed frame');
      return;
    }
    if (!isCompatibleVersion(f.v)) {
      this.sendError(session, 'EUNSUPPORTED', `unsupported protocol v${f.v}`);
      return;
    }
    if (!session.handshook && f.type !== 'handshake') {
      this.sendError(session, 'EINVAL', 'expected handshake first');
      return;
    }
    switch (f.type) {
      case 'handshake':
        this.handleHandshake(session);
        return;
      case 'setExpanded':
        this.handleSetExpanded(session, f.body as { add?: number[]; remove?: number[] });
        return;
      case 'setViewport':
        this.handleSetViewport(
          session,
          f.body as { offset: number; limit: number; overscan?: number },
        );
        return;
      case 'mutate':
        this.handleMutate(
          session,
          f.body as { reqId: number; op: string; args: Record<string, unknown> },
        );
        return;
      case 'call':
        void this.handleCall(
          session,
          f.body as { reqId: number; method: string; args: unknown[] },
        );
        return;
      case 'dispose':
        this.detachSession(session.id);
        return;
      default:
        this.sendError(session, 'EINVAL', `unknown message type: ${f.type}`);
    }
  }

  private handleHandshake(session: Session): void {
    session.handshook = true;
    const snap = this.explorer.getSnapshot();
    const roots = snap.roots().map((e) => e.id);
    // Walk the whole tree so the client mirror starts hydrated. For
    // Phase 8 this is adequate — test trees have <100 entries. Phase
    // 12 bounds the walk by viewport (SPEC §4.9.1).
    const allEntries = collectAllEntries(snap);
    // Emit a directChildCount entry for every id we're shipping — the
    // twisty caret renders against this map on the client.
    const directChildCounts: Record<string, number> = {};
    for (const e of allEntries) {
      const c = snap.directChildCount(e.id);
      if (c !== null) directChildCounts[String(e.id)] = c;
      session.knownIds.add(e.id);
    }
    this.send(
      session,
      frame('snapshot', {
        version: snap.treeVersion,
        roots,
        // mirror/viewport ArrayBuffer fields were reserved for bincode
        // bulk payloads (Phase 12). Electron's utility↔renderer structured
        // clone drops messages that contain empty ArrayBuffers silently,
        // which hangs handshakes over MessagePortMain. Keep the field off
        // until a real payload is ready (then gate on length > 0).
        entriesJson: allEntries.length > 0 ? JSON.stringify(allEntries) : undefined,
        directChildCounts,
        visibleCount: allEntries.length,
      }),
    );
  }

  private handleSetExpanded(
    session: Session,
    body: { add?: number[]; remove?: number[] },
  ): void {
    for (const id of body.add ?? []) session.expanded.add(id);
    for (const id of body.remove ?? []) session.expanded.delete(id);

    // Ship child entries the client doesn't yet know about for each
    // newly-expanded folder. Phase 8 sends the whole tree at handshake
    // time so these are typically already covered — but newly-arrived
    // children (post-handshake walker discoveries) still need to land.
    const snap = this.explorer.getSnapshot();
    const addedEntries: ClientEntry[] = [];
    const newDirectChildCounts: Record<string, number> = {};
    const childSetIds: number[] = [];
    for (const id of body.add ?? []) {
      const kids = snap.childrenOf(id);
      if (kids.length > 0) childSetIds.push(id);
      for (const kidId of kids) {
        if (session.knownIds.has(kidId)) continue;
        const entry = snap.getById(kidId);
        if (!entry) continue;
        addedEntries.push(entryToClient(entry));
        session.knownIds.add(kidId);
        const c = snap.directChildCount(kidId);
        if (c !== null) newDirectChildCounts[String(kidId)] = c;
      }
    }

    this.send(
      session,
      frame('delta', {
        version: this.explorer.getTreeVersion(),
        changedIds: [],
        entriesJson: addedEntries.length > 0 ? JSON.stringify(addedEntries) : undefined,
        childSetChanged: childSetIds,
        removedIds: [],
        directChildCounts: newDirectChildCounts,
        newVisibleCount: 0,
        coarseSubtrees: [],
        subtreeDirty: [],
        subtreeResynced: [],
      }),
    );
  }

  private handleSetViewport(
    session: Session,
    body: { offset: number; limit: number; overscan?: number },
  ): void {
    session.viewport = {
      offset: body.offset,
      limit: body.limit,
      overscan: body.overscan ?? 0,
    };
    // No response — viewport is fire-and-forget. Wave 3 pushes a
    // viewport-patch delta if the window moved enough to matter.
  }

  private handleMutate(
    session: Session,
    body: { reqId: number; op: string; args: Record<string, unknown> },
  ): void {
    // SPEC §5.1 ordering: serialize every mutation on a single promise
    // chain. Inside the chain entry we
    //   1. dispatch the op against the local FileExplorer
    //   2. flush a delta to every session synchronously (before step 3)
    //   3. THEN post mutateResult back to the initiator
    // so a remote session observes the state change before the
    // initiator's own resolve — windows never disagree about "did that
    // rename happen yet?".
    //
    // The outer .catch() is essential: without it, a rejection inside
    // the entry would poison the chain and block every subsequent
    // mutation forever. We swallow (log) chain-level rejections but
    // keep the next mutation unblocked.
    this.mutationQueue = this.mutationQueue.then(async () => {
      try {
        const result = await this.dispatchMutation(body.op, body.args);
        // Fan out first, reply second.
        await this.flushTickNow();
        this.send(session, frame('mutateResult', { reqId: body.reqId, result }));
      } catch (e: unknown) {
        const err = toErrorPayload(e);
        // Still flush a delta: partial state (e.g. a rename that
        // created the target before failing on the source) may have
        // landed and other sessions need to see it.
        await this.flushTickNow();
        this.send(
          session,
          frame('mutateResult', { reqId: body.reqId, result: null, error: err }),
        );
      }
    }).catch((e: unknown) => {
      // Queue-level failure (e.g. flushTickNow threw). Don't let it
      // poison the chain for subsequent mutations from any session.
      // eslint-disable-next-line no-console
      console.error('[mille] mutation queue error:', e);
    });
  }

  /**
   * Immediate, out-of-band delta flush. Used by the mutation queue so
   * fan-out happens synchronously with the op rather than waiting for
   * the next 16ms tick boundary. A microtask yield after `tick()` lets
   * queued `postMessage` calls land before we reply to the initiator.
   */
  private async flushTickNow(): Promise<void> {
    this.tick();
    await new Promise<void>((resolve) => {
      // setImmediate is preferable to setTimeout(0) — it fires after
      // the current I/O phase, which is when MessagePort-postMessage
      // actually drops the message onto the peer's queue.
      setImmediate(resolve);
    });
  }

  private async dispatchMutation(op: string, args: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'create':
        return this.explorer.create(
          args.parentId as EntryId,
          args.name as string,
          args.kind as number,
        );
      case 'rename':
        return this.explorer.rename(args.id as EntryId, args.newName as string);
      case 'move':
        return this.explorer.move(
          args.id as EntryId,
          args.newParentId as EntryId,
          args.newName as string | undefined,
        );
      case 'delete':
        return this.explorer.delete(
          args.id as EntryId,
          args.options as { trash?: boolean; recursive?: boolean } | undefined,
        );
      case 'copy':
        return this.explorer.copy(
          args.id as EntryId,
          args.newParentId as EntryId,
          args.newName as string | undefined,
        );
      case 'readFile': {
        const buf = await this.explorer.readFile(args.id as EntryId);
        // Convert Uint8Array to a plain array so structured clone ships
        // it through the wire without being mistaken for a TypedArray.
        return Array.from(buf);
      }
      case 'readText':
        return this.explorer.readText(
          args.id as EntryId,
          args.encoding as string | undefined,
        );
      case 'writeFile':
        return this.explorer.writeFile(
          args.id as EntryId,
          new Uint8Array(args.data as ArrayLike<number>),
          args.options as { atomic?: boolean } | undefined,
        );
      default:
        throw new Error(`unknown op: ${op}`);
    }
  }

  private async handleCall(
    session: Session,
    body: { reqId: number; method: string; args: unknown[] },
  ): Promise<void> {
    try {
      const result = await this.dispatchCall(body.method, body.args);
      this.send(session, frame('callResult', { reqId: body.reqId, result }));
    } catch (e: unknown) {
      const err = toErrorPayload(e);
      this.send(
        session,
        frame('callResult', { reqId: body.reqId, result: null, error: err }),
      );
    }
  }

  private async dispatchCall(method: string, _args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'getTreeVersion':
        return this.explorer.getTreeVersion();
      case 'capabilities':
        return this.explorer.capabilities;
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  private send(session: Session, msg: unknown): void {
    try {
      session.port.postMessage(msg);
    } catch {
      // Port may be closed mid-flight. Detach this session quietly so
      // the host can keep serving other sessions.
      this.detachSession(session.id);
    }
  }

  private sendError(session: Session, code: string, message: string): void {
    this.send(session, frame('error', { code, message }));
  }

  private detachSession(id: number): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.detach();
    this.sessions.delete(id);
    if (this.sessions.size === 0) this.stopTick();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTick();
    for (const id of [...this.sessions.keys()]) {
      this.detachSession(id);
    }
    await this.explorer.dispose();
  }
}

function toErrorPayload(e: unknown): { code: string; message: string; path?: string } {
  if (isFileSystemError(e)) {
    const payload: { code: string; message: string; path?: string } = {
      code: e.code,
      message: e.message,
    };
    if (e.path !== undefined) payload.path = e.path;
    return payload;
  }
  const msg = (e as { message?: unknown } | null)?.message;
  return {
    code: 'EUNKNOWN',
    message: typeof msg === 'string' ? msg : String(e),
  };
}

/**
 * Construct a host around a native `FileExplorer`. Returns a handle
 * whose `attachPort` registers renderer sessions and whose `local`
 * exposes the explorer for same-process consumers (SCM providers,
 * background indexers) that don't need port indirection.
 */
export async function createFileExplorerHost(
  options: ExplorerOptions,
): Promise<FileExplorerHost> {
  return new FileExplorerHostImpl(options);
}

export type { FileExplorerHost, MessagePortLike } from './types.js';
